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
const DEFAULT_XAI_API_BASE_URL = "https://api.x.ai/v1";
const DEFAULT_XAI_RESPONSES_MODEL = "grok-4.20-0309-non-reasoning";
const DEFAULT_XAI_RESPONSES_MAX_OUTPUT_TOKENS = 1000000;
const DEFAULT_XAI_TTS_VOICE = "eve";
const DEFAULT_XAI_TTS_LANGUAGE = "auto";
const XAI_TTS_MAX_INPUT_CHARS = 15000;
const XAI_REQUEST_RETRIES = 3;

type VoiceAssistantRequest = z.infer<typeof VoiceAssistantRequestSchema>;
type VoiceAssistantResponse = z.infer<typeof VoiceAssistantResponseSchema>;
type VoiceAssistantMessage = VoiceAssistantRequest["messages"][number];

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

function getXaiApiKey(): string {
    const apiKey = process.env.XAI_API_KEY?.trim();
    if (!apiKey) {
        throw new Error("XAI_API_KEY not configured");
    }
    return apiKey;
}

function getXaiApiBaseUrl(): string {
    return (process.env.XAI_API_BASE_URL || DEFAULT_XAI_API_BASE_URL).replace(/\/$/, "");
}

function getXaiResponsesModel(): string {
    return process.env.XAI_RESPONSES_MODEL || DEFAULT_XAI_RESPONSES_MODEL;
}

function getXaiResponsesMaxOutputTokens(): number {
    const raw = process.env.XAI_RESPONSES_MAX_OUTPUT_TOKENS;
    if (!raw) {
        return DEFAULT_XAI_RESPONSES_MAX_OUTPUT_TOKENS;
    }

    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return DEFAULT_XAI_RESPONSES_MAX_OUTPUT_TOKENS;
    }

    return Math.floor(parsed);
}

function getXaiTtsVoice(): string {
    return process.env.XAI_TTS_VOICE || DEFAULT_XAI_TTS_VOICE;
}

function getXaiTtsLanguage(): string {
    return process.env.XAI_TTS_LANGUAGE || DEFAULT_XAI_TTS_LANGUAGE;
}

function getXaiJsonHeaders(): Record<string, string> {
    return {
        "Authorization": `Bearer ${getXaiApiKey()}`,
        "Content-Type": "application/json",
    };
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientXaiStatus(status: number): boolean {
    return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

async function fetchXaiWithRetries(path: string, init: RequestInit): Promise<Response> {
    let lastError: unknown;

    for (let attempt = 0; attempt < XAI_REQUEST_RETRIES; attempt++) {
        try {
            const response = await fetch(`${getXaiApiBaseUrl()}${path}`, init);
            if (!isTransientXaiStatus(response.status) || attempt === XAI_REQUEST_RETRIES - 1) {
                return response;
            }

            await response.arrayBuffer().catch(() => undefined);
        } catch (error) {
            lastError = error;
            if (attempt === XAI_REQUEST_RETRIES - 1) {
                throw error;
            }
        }

        await sleep(500 * (2 ** attempt));
    }

    throw lastError instanceof Error ? lastError : new Error("xAI request failed");
}

function toXaiResponsesInputMessage(message: VoiceAssistantMessage): { role: "system" | "user" | "assistant"; content: string } {
    if (message.role === "tool") {
        const label = message.name || message.toolCallId || "tool";
        return {
            role: "user",
            content: `Tool result from ${label}:\n${message.content}`,
        };
    }

    return {
        role: message.role,
        content: message.content,
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function extractXaiOutputText(raw: unknown): string {
    if (!isRecord(raw)) {
        return "";
    }

    if (typeof raw.output_text === "string") {
        return raw.output_text;
    }

    const output = raw.output;
    if (!Array.isArray(output)) {
        return "";
    }

    const parts: string[] = [];
    for (const item of output) {
        if (!isRecord(item) || !Array.isArray(item.content)) {
            continue;
        }

        for (const content of item.content) {
            if (!isRecord(content)) {
                continue;
            }
            if (content.type === "output_text" && typeof content.text === "string") {
                parts.push(content.text);
            }
        }
    }

    return parts.join("");
}

function extractXaiErrorMessage(raw: unknown): string | null {
    if (!isRecord(raw)) {
        return null;
    }

    if (typeof raw.message === "string") {
        return raw.message;
    }

    if (isRecord(raw.error)) {
        return extractXaiErrorMessage(raw.error);
    }

    return null;
}

function processXaiResponsesSseFrame(
    frame: string,
    state: { text: string; completedText: string | null },
): void {
    const lines = frame.split(/\r?\n/);
    const eventType = lines
        .find((line) => line.startsWith("event:"))
        ?.slice("event:".length)
        .trim();
    const data = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trimStart())
        .join("\n")
        .trim();

    if (!data || data === "[DONE]") {
        return;
    }

    const parsed = JSON.parse(data) as unknown;
    if (!isRecord(parsed)) {
        return;
    }

    const type = typeof parsed.type === "string" ? parsed.type : eventType;
    if (type === "error" || parsed.error) {
        throw new Error(extractXaiErrorMessage(parsed) || "xAI responses stream failed");
    }

    if (
        (type === "response.output_text.delta" || type === "response.text.delta")
        && typeof parsed.delta === "string"
    ) {
        state.text += parsed.delta;
        return;
    }

    if (
        (type === "response.output_text.done" || type === "response.text.done")
        && typeof parsed.text === "string"
    ) {
        state.completedText = parsed.text;
        return;
    }

    if (type === "response.completed" || type === "response.done") {
        const response = isRecord(parsed.response) ? parsed.response : parsed;
        const extracted = extractXaiOutputText(response);
        if (extracted) {
            state.completedText = extracted;
        }
    }
}

async function readXaiResponsesStream(response: Response): Promise<string> {
    if (!response.body) {
        throw new Error("xAI responses stream did not include a body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const state = { text: "", completedText: null as string | null };
    let buffer = "";

    while (true) {
        const { done, value } = await reader.read();
        if (value) {
            buffer += decoder.decode(value, { stream: !done });
            const frames = buffer.split(/\r?\n\r?\n/);
            buffer = frames.pop() ?? "";
            for (const frame of frames) {
                processXaiResponsesSseFrame(frame, state);
            }
        }

        if (done) {
            buffer += decoder.decode();
            break;
        }
    }

    if (buffer.trim()) {
        processXaiResponsesSseFrame(buffer, state);
    }

    return state.completedText || state.text;
}

async function readXaiResponsesText(response: Response): Promise<string> {
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("text/event-stream")) {
        return readXaiResponsesStream(response);
    }

    return extractXaiOutputText(await response.json());
}

async function requestLocalAssistantCompletion(body: VoiceAssistantRequest): Promise<VoiceAssistantResponse> {
    const tools = body.tools ?? [];
    const payload: Record<string, unknown> = {
        model: getXaiResponsesModel(),
        max_output_tokens: getXaiResponsesMaxOutputTokens(),
        stream: true,
        store: false,
        input: body.messages.map(toXaiResponsesInputMessage),
        temperature: 0.1,
    };

    if (tools.length > 0) {
        payload.tools = tools;
        payload.tool_choice = "auto";
        payload.parallel_tool_calls = false;
    }

    const response = await fetchXaiWithRetries("/responses", {
        method: "POST",
        headers: getXaiJsonHeaders(),
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        throw new Error(`[${response.status}] ${await response.text()}`);
    }

    const content = (await readXaiResponsesText(response)).trim();
    if (!content) {
        throw new Error("xAI returned an empty narration response");
    }

    return VoiceAssistantResponseSchema.parse({
        message: {
            role: "assistant",
            content,
            toolCalls: [],
        },
    });
}

async function requestXaiSpeech(input: string): Promise<{ audioBuffer: Buffer; contentType: string }> {
    const text = input.trim();
    if (!text) {
        throw new Error("Speech input is empty");
    }
    if (text.length > XAI_TTS_MAX_INPUT_CHARS) {
        throw new Error(`Speech input exceeds ${XAI_TTS_MAX_INPUT_CHARS} characters`);
    }

    const response = await fetchXaiWithRetries("/tts", {
        method: "POST",
        headers: getXaiJsonHeaders(),
        body: JSON.stringify({
            text,
            voice_id: getXaiTtsVoice(),
            language: getXaiTtsLanguage(),
        }),
    });

    if (!response.ok) {
        throw new Error(`[${response.status}] ${await response.text()}`);
    }

    return {
        audioBuffer: Buffer.from(await response.arrayBuffer()),
        contentType: response.headers.get("content-type") || "audio/mpeg",
    };
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
            const { audioBuffer, contentType } = await requestXaiSpeech(request.body.input);
            reply.header('content-type', contentType);
            return reply.send(audioBuffer);
        } catch (error) {
            log({ module: 'voice-local' }, `Local voice speech failed for user ${request.userId}: ${error}`);
            return reply.code(502).send({
                error: error instanceof Error ? error.message : 'Local voice speech failed',
            });
        }
    });
}
