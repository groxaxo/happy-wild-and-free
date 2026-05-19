import { z } from "zod";
import * as crypto from "crypto";
import {
    VoiceAssistantRequestSchema,
    VoiceAssistantResponseSchema,
    VoiceConversationResponseSchema,
    VoiceUsageResponseSchema,
} from "@slopus/happy-wire";
import { type Fastify } from "../types";
import { log } from "@/utils/log";

const VOICE_FREE_LIMIT_SECONDS = 1200;  // 20 minutes free tier per 30 days (~$0.76 cost)
const VOICE_HARD_LIMIT_SECONDS = 18000; // 5 hours absolute cap per 30 days (even with subscription)
const VOICE_MAX_CONVERSATIONS = 100;    // Max conversations trackable per 30 days (ElevenLabs page_size limit)
const ELEVEN_LABS_API = "https://api.elevenlabs.io/v1/convai";
// Tailscale host for local voice proxies.
// GPU split on that host:
// - LLM proxy on :12434 reserves the RTX 3090s.
// - Chatterbox TTS proxy on :8020 is pinned to the RTX 3060 at GPU index 2.
// - ASR proxy on :5092 should stay off the RTX 3090s; the current parakeet proxy is CPU-backed.
const LOCAL_VOICE_PROXY_HOST = "100.85.200.51";
const DEFAULT_LOCAL_LLM_BASE_URL = `http://${LOCAL_VOICE_PROXY_HOST}:12434/v1`;
const DEFAULT_LOCAL_LLM_MODEL = "qwen36-35b-awq-instruct";
const DEFAULT_LOCAL_TTS_BASE_URL = `http://${LOCAL_VOICE_PROXY_HOST}:8020/v1`;
const DEFAULT_LOCAL_TTS_MODEL = "tts-1-es";
const DEFAULT_LOCAL_TTS_VOICE = "latina";
const DEFAULT_LOCAL_TTS_AUDIO_PROMPT_PATH = "/home/op/voxcpm2-server/reference_audio/newlatina_ref.wav";
const DEFAULT_LOCAL_ASR_BASE_URL = `http://${LOCAL_VOICE_PROXY_HOST}:5092/v1`;
const LOCAL_LLM_BUSY_RETRIES = 6;

function deriveElevenUserId(happyUserId: string): string {
    const hmac = crypto.createHmac("sha256", process.env.HANDY_MASTER_SECRET!);
    hmac.update(happyUserId);
    const digest = hmac.digest();
    const base64url = digest
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    return `u_${base64url}`;
}

/**
 * Get a user's voice usage in seconds over the last 30 days.
 * Queries ElevenLabs directly by user_id (set via participant_name on token mint).
 * ElevenLabs is the source of truth — no local DB needed.
 *
 * Returns { usedSeconds, conversationCount }.
 */
async function getVoiceUsage(
    elevenLabsApiKey: string,
    elevenUserId: string,
): Promise<{ usedSeconds: number; conversationCount: number }> {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400 * 1000).toISOString();

    // Query across all agents — usage is per-user, not per-agent
    const res = await fetch(
        `${ELEVEN_LABS_API}/conversations?user_id=${elevenUserId}&created_after=${thirtyDaysAgo}&page_size=100`,
        { headers: { "xi-api-key": elevenLabsApiKey } }
    );

    if (!res.ok) {
        log({ module: 'voice' }, `ElevenLabs conversations query failed: ${res.status}`);
        return { usedSeconds: 0, conversationCount: 0 };
    }

    const data = (await res.json()) as {
        conversations?: Array<{ call_duration_secs: number }>;
    };

    const conversations = data.conversations || [];
    let usedSeconds = 0;
    for (const c of conversations) {
        usedSeconds += c.call_duration_secs ?? 0;
    }
    return { usedSeconds, conversationCount: conversations.length };
}

async function hasActiveSubscription(userId: string): Promise<boolean> {
    const revenueCatApiKey = process.env.REVENUECAT_API_KEY;
    if (!revenueCatApiKey) return false;

    try {
        const response = await fetch(
            `https://api.revenuecat.com/v2/projects/proj493735ad/customers/${userId}/active_entitlements`,
            {
                method: "GET",
                headers: {
                    "Authorization": `Bearer ${revenueCatApiKey}`,
                },
            }
        );
        if (!response.ok) {
            log({ module: 'voice' }, `RevenueCat check failed for ${userId}: ${response.status}`);
            return false;
        }
        const data = (await response.json()) as { items?: Array<{ entitlement_id: string }> };
        return (data.items?.length ?? 0) > 0;
    } catch {
        return false;
    }
}

function getLocalLlmBaseUrl(): string {
    return (process.env.LOCAL_LLM_BASE_URL || DEFAULT_LOCAL_LLM_BASE_URL).replace(/\/$/, "");
}

function getLocalLlmModel(): string {
    return process.env.LOCAL_LLM_MODEL || DEFAULT_LOCAL_LLM_MODEL;
}

function getLocalTtsBaseUrl(): string {
    return (process.env.LOCAL_TTS_BASE_URL || DEFAULT_LOCAL_TTS_BASE_URL).replace(/\/$/, "");
}

function getLocalTtsModel(): string {
    return process.env.LOCAL_TTS_MODEL || DEFAULT_LOCAL_TTS_MODEL;
}

function getLocalTtsVoice(): string {
    return process.env.LOCAL_TTS_VOICE || DEFAULT_LOCAL_TTS_VOICE;
}

function getLocalTtsAudioPromptPath(): string {
    return process.env.LOCAL_TTS_AUDIO_PROMPT_PATH || DEFAULT_LOCAL_TTS_AUDIO_PROMPT_PATH;
}

function getLocalAsrBaseUrl(): string {
    return (process.env.LOCAL_ASR_BASE_URL || DEFAULT_LOCAL_ASR_BASE_URL).replace(/\/$/, "");
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function toOpenAiMessage(message: z.infer<typeof VoiceAssistantRequestSchema>["messages"][number]) {
    if (message.role === "assistant") {
        return {
            role: "assistant",
            content: message.content,
            ...(message.toolCalls?.length ? {
                tool_calls: message.toolCalls.map((toolCall: { id: string; name: string; arguments: string }) => ({
                    id: toolCall.id,
                    type: "function",
                    function: {
                        name: toolCall.name,
                        arguments: toolCall.arguments,
                    },
                })),
            } : {}),
        };
    }

    if (message.role === "tool") {
        return {
            role: "tool",
            content: message.content,
            tool_call_id: message.toolCallId,
            name: message.name,
        };
    }

    return {
        role: message.role,
        content: message.content,
    };
}

async function requestLocalAssistantCompletion(
    body: z.infer<typeof VoiceAssistantRequestSchema>,
): Promise<z.infer<typeof VoiceAssistantResponseSchema>> {
    const llmUrl = `${getLocalLlmBaseUrl()}/chat/completions`;
    const payload = {
        model: getLocalLlmModel(),
        messages: body.messages.map(toOpenAiMessage),
        tools: body.tools,
        tool_choice: "auto",
        parallel_tool_calls: false,
        temperature: 0.1,
    };

    let lastErrorText = "Local model request failed";
    let lastStatus = 502;

    for (let attempt = 0; attempt < LOCAL_LLM_BUSY_RETRIES; attempt++) {
        const response = await fetch(llmUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
        });

        if (response.ok) {
            const raw = await response.json() as {
                choices?: Array<{
                    message?: {
                        content?: string | null;
                        tool_calls?: Array<{
                            id?: string;
                            function?: {
                                name?: string;
                                arguments?: string;
                            };
                        }>;
                    };
                }>;
            };
            const message = raw.choices?.[0]?.message;
            return VoiceAssistantResponseSchema.parse({
                message: {
                    role: "assistant",
                    content: message?.content ?? "",
                    toolCalls: (message?.tool_calls ?? []).map((toolCall: {
                        id?: string;
                        function?: {
                            name?: string;
                            arguments?: string;
                        };
                    }) => ({
                        id: toolCall.id ?? "",
                        name: toolCall.function?.name ?? "",
                        arguments: toolCall.function?.arguments ?? "{}",
                    })),
                },
            });
        }

        lastStatus = response.status;
        lastErrorText = await response.text();
        if (response.status !== 409 || attempt === LOCAL_LLM_BUSY_RETRIES - 1) {
            break;
        }

        await sleep(1000 * (attempt + 1));
    }

    throw new Error(`[${lastStatus}] ${lastErrorText}`);
}

export function voiceRoutes(app: Fastify) {
    app.post('/v1/voice/conversations', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                agentId: z.string(),
            }),
            response: {
                200: VoiceConversationResponseSchema,
                500: z.object({ error: z.string() }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { agentId } = request.body;

        log({ module: 'voice' }, `Voice token request from user ${userId}`);

        const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
        if (!elevenLabsApiKey) {
            return reply.code(500).send({ error: 'ELEVENLABS_API_KEY not configured' });
        }
        if (!process.env.REVENUECAT_API_KEY) {
            return reply.code(500).send({ error: 'REVENUECAT_API_KEY not configured' });
        }

        const elevenUserId = deriveElevenUserId(userId);

        // Check usage from ElevenLabs directly
        const { usedSeconds, conversationCount } = await getVoiceUsage(elevenLabsApiKey, elevenUserId);
        log({ module: 'voice' }, `User ${userId}: ${usedSeconds}s used, ${conversationCount} convos (free=${VOICE_FREE_LIMIT_SECONDS}s, hard=${VOICE_HARD_LIMIT_SECONDS}s)`);

        // Conversation count cap — we can only track 100 per query (ElevenLabs page_size limit)
        if (conversationCount >= VOICE_MAX_CONVERSATIONS) {
            return reply.send({
                allowed: false as const,
                reason: 'voice_conversation_limit_reached' as const,
                usedSeconds,
                limitSeconds: VOICE_HARD_LIMIT_SECONDS,
                agentId,
            });
        }

        // Hard cap — 5 hours, no exceptions
        if (usedSeconds >= VOICE_HARD_LIMIT_SECONDS) {
            return reply.send({
                allowed: false as const,
                reason: 'voice_hard_limit_reached' as const,
                usedSeconds,
                limitSeconds: VOICE_HARD_LIMIT_SECONDS,
                agentId,
            });
        }

        // Free tier — 1 hour, then need subscription
        if (usedSeconds >= VOICE_FREE_LIMIT_SECONDS) {
            const subscribed = await hasActiveSubscription(userId);
            log({ module: 'voice' }, `User ${userId}: subscription check = ${subscribed}`);
            if (!subscribed) {
                return reply.send({
                    allowed: false as const,
                    reason: 'subscription_required' as const,
                    usedSeconds,
                    limitSeconds: VOICE_FREE_LIMIT_SECONDS,
                    agentId,
                });
            }
        }

        // Get conversation token (JWT for WebRTC) with user identity
        try {
            const tokenRes = await fetch(
                `${ELEVEN_LABS_API}/conversation/token?agent_id=${agentId}&participant_name=${elevenUserId}`,
                { headers: { 'xi-api-key': elevenLabsApiKey } }
            );

            if (!tokenRes.ok) {
                log({ module: 'voice' }, `Failed to get conversation token for user ${userId}: ${tokenRes.status}`);
                return reply.code(500).send({ error: 'Failed to get voice credentials' });
            }

            const { token: conversationToken } = (await tokenRes.json()) as { token: string };

            // Extract conversation_id from JWT payload (LiveKit room name contains it)
            const jwtPayload = JSON.parse(Buffer.from(conversationToken.split('.')[1], 'base64').toString());
            const conversationId = (jwtPayload.video?.room || '').match(/(conv_[a-zA-Z0-9]+)/)?.[0];

            if (!conversationId) {
                log({ module: 'voice' }, `No conversation_id in JWT for user ${userId}`);
                return reply.code(500).send({ error: 'Failed to get conversation ID' });
            }

            log({ module: 'voice' }, `Voice token issued for user ${userId}, conv=${conversationId}`);
            return reply.send({
                allowed: true as const,
                conversationToken,
                conversationId,
                agentId,
                elevenUserId,
                usedSeconds,
                limitSeconds: usedSeconds >= VOICE_FREE_LIMIT_SECONDS ? VOICE_HARD_LIMIT_SECONDS : VOICE_FREE_LIMIT_SECONDS,
            });
        } catch (error) {
            log({ module: 'voice' }, `ElevenLabs request error for user ${userId}: ${error}`);
            return reply.code(500).send({ error: 'Failed to get voice credentials' });
        }
    });

    /**
     * Returns voice usage for the authenticated user over the last 30 days.
     * Queries ElevenLabs directly — no local DB needed.
     */
    app.get('/v1/voice/usage', {
        preHandler: app.authenticate,
        schema: {
            response: {
                200: VoiceUsageResponseSchema,
                500: z.object({ error: z.string() }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;

        const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
        if (!elevenLabsApiKey) {
            return reply.code(500).send({ error: 'ELEVENLABS_API_KEY not configured' });
        }

        const elevenUserId = deriveElevenUserId(userId);

        try {
            const [{ usedSeconds, conversationCount }, subscribed] = await Promise.all([
                getVoiceUsage(elevenLabsApiKey, elevenUserId),
                hasActiveSubscription(userId),
            ]);
            return reply.send({
                usedSeconds,
                limitSeconds: subscribed ? VOICE_HARD_LIMIT_SECONDS : VOICE_FREE_LIMIT_SECONDS,
                conversationCount,
                conversationLimit: VOICE_MAX_CONVERSATIONS,
                elevenUserId,
            });
        } catch (error) {
            log({ module: 'voice' }, `Failed to get voice usage for user ${userId}: ${error}`);
            return reply.code(500).send({ error: 'Failed to get voice usage' });
        }
    });

    app.post('/v1/voice/assistant/chat', {
        preHandler: app.authenticate,
        schema: {
            body: VoiceAssistantRequestSchema,
            response: {
                200: VoiceAssistantResponseSchema,
                502: z.object({ error: z.string() }),
            },
        },
    }, async (request, reply) => {
        try {
            return reply.send(await requestLocalAssistantCompletion(request.body));
        } catch (error) {
            log({ module: 'voice-local' }, `Local voice chat failed for user ${request.userId}: ${error}`);
            return reply.code(502).send({
                error: error instanceof Error ? error.message : 'Local voice chat failed',
            });
        }
    });

    app.post('/v1/voice/assistant/speech', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                input: z.string().min(1),
            }),
        },
    }, async (request, reply) => {
        try {
            const response = await fetch(`${getLocalTtsBaseUrl()}/audio/speech`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    model: getLocalTtsModel(),
                    voice: getLocalTtsVoice(),
                    audio_prompt_path: getLocalTtsAudioPromptPath(),
                    language: "es",
                    input: request.body.input,
                    response_format: "mp3",
                }),
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`[${response.status}] ${errorText}`);
            }

            const audioBuffer = Buffer.from(await response.arrayBuffer());
            reply.header('content-type', response.headers.get('content-type') || 'audio/mpeg');
            return reply.send(audioBuffer);
        } catch (error) {
            log({ module: 'voice-local' }, `Local voice speech failed for user ${request.userId}: ${error}`);
            return reply.code(502).send({
                error: error instanceof Error ? error.message : 'Local voice speech failed',
            });
        }
    });
}
