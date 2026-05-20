import { z } from "zod";
import { spawn } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
    VoiceAssistantRequestSchema,
    VoiceAssistantResponseSchema,
    VoiceConversationResponseSchema,
    VoiceSpeechProviderSchema,
    VoiceSpeechRequestSchema,
    VoiceTranscriptionRequestSchema,
    VoiceTranscriptionResponseSchema,
    VoiceUsageResponseSchema,
} from "@slopus/happy-wire";
import { type Fastify } from "../types";
import { log } from "@/utils/log";

const VOICE_FREE_LIMIT_SECONDS = 1200;  // 20 minutes free tier per 30 days (~$0.76 cost)
const VOICE_HARD_LIMIT_SECONDS = 18000; // 5 hours absolute cap per 30 days (even with subscription)
const VOICE_MAX_CONVERSATIONS = 100;    // Max conversations trackable per 30 days (ElevenLabs page_size limit)
const ELEVEN_LABS_API = "https://api.elevenlabs.io/v1/convai";
const LOCAL_VOICE_PROXY_HOST = "127.0.0.1";
const DEFAULT_LOCAL_LLM_BASE_URL = `http://${LOCAL_VOICE_PROXY_HOST}:12434/v1`;
const DEFAULT_LOCAL_LLM_MODEL = "qwen2.5-14b-instruct";
const DEFAULT_LOCAL_ASR_BASE_URL = `http://${LOCAL_VOICE_PROXY_HOST}:5092/v1`;
const DEFAULT_LOCAL_ASR_MODEL = "whisper-1";
const DEFAULT_CODEX_EXEC_MODEL = "gpt-5.3-codex-spark";
const DEFAULT_CODEX_EXEC_REASONING_EFFORT = "high";
const DEFAULT_CODEX_EXEC_TIMEOUT_MS = 45_000;
const DEFAULT_OPENAI_API_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OPENAI_RESPONSES_MODEL = "gpt-5.3-codex-spark";
const DEFAULT_OPENAI_RESPONSES_REASONING_EFFORT = "high";
const DEFAULT_OPENAI_RESPONSES_MAX_OUTPUT_TOKENS = 4096;
const DEFAULT_XAI_API_BASE_URL = "https://api.x.ai/v1";
const DEFAULT_XAI_RESPONSES_MODEL = "grok-4.20-0309-non-reasoning";
const DEFAULT_XAI_RESPONSES_MAX_OUTPUT_TOKENS = 1000000;
const DEFAULT_XAI_TTS_VOICE = "eve";
const DEFAULT_XAI_TTS_LANGUAGE = "auto";
const XAI_TTS_MAX_INPUT_CHARS = 15000;
const XAI_REQUEST_RETRIES = 3;
const OPENAI_REQUEST_RETRIES = 3;
const DEFAULT_CHATTERBOX_MULTILINGUAL_TTS_BASE_URL = `http://${LOCAL_VOICE_PROXY_HOST}:8020/v1`;
const DEFAULT_CHATTERBOX_MULTILINGUAL_TTS_MODEL = "tts-1-es";
const DEFAULT_CHATTERBOX_MULTILINGUAL_TTS_VOICE = "latina";
const DEFAULT_CHATTERBOX_MULTILINGUAL_TTS_LANGUAGE = "es";
const DEFAULT_CHATTERBOX_MULTILINGUAL_TTS_RESPONSE_FORMAT = "mp3";
const DEFAULT_CHATTERBOX_MULTILINGUAL_TTS_AUDIO_PROMPT_PATH = "";
const DEFAULT_NEUTTS_SPANISH_TTS_BASE_URL = `http://${LOCAL_VOICE_PROXY_HOST}:12438/v1`;
const DEFAULT_NEUTTS_ENGLISH_TTS_BASE_URL = `http://${LOCAL_VOICE_PROXY_HOST}:12437/v1`;
const DEFAULT_OPENAI_TTS_MODEL = "tts-1";
const DEFAULT_OPENAI_TTS_VOICE = "alloy";
const DEFAULT_OPENAI_TTS_RESPONSE_FORMAT = "mp3";
const DEFAULT_NEUTTS_TTS_MODEL = "tts-1";
const DEFAULT_NEUTTS_SPANISH_TTS_VOICE = "mateo";
const DEFAULT_NEUTTS_ENGLISH_TTS_VOICE = "dave";
const DEFAULT_NEUTTS_TTS_RESPONSE_FORMAT = "wav";
const LOCAL_LLM_BUSY_RETRIES = 6;
const LOCAL_LLM_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_LOCAL_TTS_REQUEST_TIMEOUT_MS = 300_000;
const LOCAL_ASR_REQUEST_TIMEOUT_MS = 60_000;
const LOCAL_ASR_MAX_AUDIO_BYTES = 15 * 1024 * 1024;
const LOCAL_ASR_REQUEST_BODY_LIMIT_BYTES = Math.ceil(LOCAL_ASR_MAX_AUDIO_BYTES * 1.5);

type VoiceAssistantRequest = z.infer<typeof VoiceAssistantRequestSchema>;
type VoiceAssistantResponse = z.infer<typeof VoiceAssistantResponseSchema>;
type VoiceAssistantMessage = VoiceAssistantRequest["messages"][number];
type VoiceSpeechProvider = z.infer<typeof VoiceSpeechProviderSchema>;
type VoiceLlmProvider = "codex" | "openai" | "xai" | "local";
type OpenAiReasoningEffort = "low" | "medium" | "high" | "xhigh";

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

function readCodexOpenAiApiKey(): string | null {
    if (process.env.NODE_ENV === "production") {
        return null;
    }

    const authPath = process.env.CODEX_AUTH_FILE || path.join(os.homedir(), ".codex", "auth.json");
    try {
        const parsed = JSON.parse(fs.readFileSync(authPath, "utf-8")) as { OPENAI_API_KEY?: unknown };
        return typeof parsed.OPENAI_API_KEY === "string" && parsed.OPENAI_API_KEY.trim()
            ? parsed.OPENAI_API_KEY.trim()
            : null;
    } catch {
        return null;
    }
}

function getOpenAiApiKey(): string {
    const apiKey = process.env.OPENAI_API_KEY?.trim()
        || process.env.CODEX_OPENAI_API_KEY?.trim()
        || readCodexOpenAiApiKey();
    if (!apiKey) {
        throw new Error("OPENAI_API_KEY not configured");
    }
    return apiKey;
}

function getOpenAiApiBaseUrl(): string {
    return (process.env.OPENAI_API_BASE_URL || DEFAULT_OPENAI_API_BASE_URL).replace(/\/$/, "");
}

function getOpenAiResponsesModel(): string {
    return process.env.OPENAI_RESPONSES_MODEL || DEFAULT_OPENAI_RESPONSES_MODEL;
}

function getOpenAiResponsesReasoningEffort(): OpenAiReasoningEffort {
    const raw = process.env.OPENAI_RESPONSES_REASONING_EFFORT;
    if (raw === "low" || raw === "medium" || raw === "high" || raw === "xhigh") {
        return raw;
    }
    return DEFAULT_OPENAI_RESPONSES_REASONING_EFFORT;
}

function getOpenAiResponsesMaxOutputTokens(): number {
    return getPositiveIntegerEnv("OPENAI_RESPONSES_MAX_OUTPUT_TOKENS", DEFAULT_OPENAI_RESPONSES_MAX_OUTPUT_TOKENS);
}

function getCodexExecCommand(): string {
    return process.env.CODEX_EXEC_COMMAND || "codex";
}

function getCodexExecModel(): string {
    return process.env.CODEX_EXEC_MODEL || DEFAULT_CODEX_EXEC_MODEL;
}

function getCodexExecReasoningEffort(): OpenAiReasoningEffort {
    const raw = process.env.CODEX_EXEC_REASONING_EFFORT;
    if (raw === "low" || raw === "medium" || raw === "high" || raw === "xhigh") {
        return raw;
    }
    return DEFAULT_CODEX_EXEC_REASONING_EFFORT;
}

function getCodexExecTimeoutMs(): number {
    return getPositiveIntegerEnv("CODEX_EXEC_TIMEOUT_MS", DEFAULT_CODEX_EXEC_TIMEOUT_MS);
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

function getDefaultLocalTtsProvider(): VoiceSpeechProvider {
    const parsed = VoiceSpeechProviderSchema.safeParse(
        process.env.LOCAL_VOICE_TTS_PROVIDER || process.env.LOCAL_TTS_PROVIDER,
    );
    return parsed.success ? parsed.data : "openai";
}

function getOpenAiTtsModel(): string {
    return process.env.OPENAI_TTS_MODEL || DEFAULT_OPENAI_TTS_MODEL;
}

function getOpenAiTtsVoice(): string {
    return process.env.OPENAI_TTS_VOICE || DEFAULT_OPENAI_TTS_VOICE;
}

function getOpenAiTtsResponseFormat(): string {
    return process.env.OPENAI_TTS_RESPONSE_FORMAT || DEFAULT_OPENAI_TTS_RESPONSE_FORMAT;
}

function getLocalVoiceLlmProvider(): VoiceLlmProvider {
    if (process.env.LOCAL_VOICE_LLM_PROVIDER === "codex") {
        return "codex";
    }
    if (process.env.LOCAL_VOICE_LLM_PROVIDER === "xai") {
        return "xai";
    }
    if (process.env.LOCAL_VOICE_LLM_PROVIDER === "local") {
        return "local";
    }
    if (process.env.LOCAL_VOICE_LLM_PROVIDER === "openai") {
        return "openai";
    }
    return "codex";
}

function getLocalLlmBaseUrl(): string {
    return (process.env.LOCAL_LLM_BASE_URL || DEFAULT_LOCAL_LLM_BASE_URL).replace(/\/$/, "");
}

function getLocalLlmModel(): string {
    return process.env.LOCAL_LLM_MODEL || DEFAULT_LOCAL_LLM_MODEL;
}

function getLocalAsrBaseUrl(): string {
    return (process.env.LOCAL_ASR_BASE_URL || DEFAULT_LOCAL_ASR_BASE_URL).replace(/\/$/, "");
}

function getLocalAsrModel(): string {
    return process.env.LOCAL_ASR_MODEL || DEFAULT_LOCAL_ASR_MODEL;
}

function getXaiTtsLanguage(language?: string | null): string {
    return normalizeXaiLanguage(language) || process.env.XAI_TTS_LANGUAGE || DEFAULT_XAI_TTS_LANGUAGE;
}

function getXaiJsonHeaders(): Record<string, string> {
    return {
        "Authorization": `Bearer ${getXaiApiKey()}`,
        "Content-Type": "application/json",
    };
}

function getOpenAiJsonHeaders(): Record<string, string> {
    return {
        "Authorization": `Bearer ${getOpenAiApiKey()}`,
        "Content-Type": "application/json",
    };
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function getPositiveIntegerEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) {
        return fallback;
    }

    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }

    return Math.floor(parsed);
}

function getLocalTtsRequestTimeoutMs(): number {
    return getPositiveIntegerEnv("LOCAL_TTS_REQUEST_TIMEOUT_MS", DEFAULT_LOCAL_TTS_REQUEST_TIMEOUT_MS);
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, {
            ...init,
            signal: controller.signal as any,
        });
    } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
            throw new Error(`Request timed out after ${timeoutMs}ms`);
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

function isTransientStatus(status: number): boolean {
    return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function normalizeXaiLanguage(language?: string | null): string | null {
    if (!language) {
        return null;
    }

    const normalized = language.trim();
    if (!normalized || normalized.toLowerCase() === "auto") {
        return "auto";
    }

    const lower = normalized.toLowerCase();
    const languageMap: Record<string, string> = {
        "en-us": "en",
        "en-gb": "en",
        "en-au": "en",
        "en-ca": "en",
        "fr-fr": "fr",
        "fr-ca": "fr",
        "de-de": "de",
        "de-at": "de",
        "it-it": "it",
        "ru-ru": "ru",
        "zh-cn": "zh",
        "zh-tw": "zh",
        "ja-jp": "ja",
        "ko-kr": "ko",
        "hi-in": "hi",
        "id-id": "id",
        "tr-tr": "tr",
        "vi-vn": "vi",
    };

    return languageMap[lower] || normalized;
}

function getChatterboxMultilingualTtsBaseUrl(): string {
    return (process.env.CHATTERBOX_MULTILINGUAL_TTS_BASE_URL || DEFAULT_CHATTERBOX_MULTILINGUAL_TTS_BASE_URL).replace(/\/$/, "");
}

function getChatterboxMultilingualTtsModel(): string {
    return process.env.CHATTERBOX_MULTILINGUAL_TTS_MODEL || DEFAULT_CHATTERBOX_MULTILINGUAL_TTS_MODEL;
}

function getChatterboxMultilingualTtsVoice(): string {
    return process.env.CHATTERBOX_MULTILINGUAL_TTS_VOICE || DEFAULT_CHATTERBOX_MULTILINGUAL_TTS_VOICE;
}

function getChatterboxMultilingualTtsAudioPromptPath(): string {
    return process.env.CHATTERBOX_MULTILINGUAL_TTS_AUDIO_PROMPT_PATH || DEFAULT_CHATTERBOX_MULTILINGUAL_TTS_AUDIO_PROMPT_PATH;
}

function getChatterboxMultilingualTtsLanguage(language?: string | null): string {
    return normalizeChatterboxLanguage(language || process.env.CHATTERBOX_MULTILINGUAL_TTS_LANGUAGE || DEFAULT_CHATTERBOX_MULTILINGUAL_TTS_LANGUAGE);
}

function getChatterboxMultilingualTtsResponseFormat(): "mp3" | "wav" {
    return process.env.CHATTERBOX_MULTILINGUAL_TTS_RESPONSE_FORMAT === "wav" ? "wav" : DEFAULT_CHATTERBOX_MULTILINGUAL_TTS_RESPONSE_FORMAT;
}

function getNeuttsTtsBaseUrl(language?: string | null): string {
    const normalizedLanguage = normalizeChatterboxLanguage(language || "es");
    const fallback = normalizedLanguage === "en" ? DEFAULT_NEUTTS_ENGLISH_TTS_BASE_URL : DEFAULT_NEUTTS_SPANISH_TTS_BASE_URL;
    return (process.env.NEUTTS_TTS_BASE_URL || fallback).replace(/\/$/, "");
}

function getNeuttsTtsModel(): string {
    return process.env.NEUTTS_TTS_MODEL || DEFAULT_NEUTTS_TTS_MODEL;
}

function getNeuttsTtsVoice(language?: string | null): string {
    const normalizedLanguage = normalizeChatterboxLanguage(language || "es");
    const fallback = normalizedLanguage === "en" ? DEFAULT_NEUTTS_ENGLISH_TTS_VOICE : DEFAULT_NEUTTS_SPANISH_TTS_VOICE;
    return process.env.NEUTTS_TTS_VOICE || fallback;
}

function getNeuttsTtsResponseFormat(): "wav" {
    return DEFAULT_NEUTTS_TTS_RESPONSE_FORMAT;
}

function normalizeChatterboxLanguage(language: string): string {
    const lower = language.trim().toLowerCase();
    if (!lower || lower === "auto") {
        return DEFAULT_CHATTERBOX_MULTILINGUAL_TTS_LANGUAGE;
    }

    const languageMap: Record<string, string> = {
        "en-us": "en",
        "en-gb": "en",
        "en-au": "en",
        "en-ca": "en",
        "es-es": "es",
        "es-mx": "es",
        "es-ar": "es",
        "fr-fr": "fr",
        "fr-ca": "fr",
        "de-de": "de",
        "de-at": "de",
        "it-it": "it",
        "pt-br": "pt",
        "pt-pt": "pt",
        "ru-ru": "ru",
        "zh-cn": "zh",
        "zh-tw": "zh",
        "ja-jp": "ja",
        "ko-kr": "ko",
        "ar-sa": "ar",
        "hi-in": "hi",
        "nl-nl": "nl",
        "sv-se": "sv",
        "no-no": "no",
        "da-dk": "da",
        "fi-fi": "fi",
        "pl-pl": "pl",
        "tr-tr": "tr",
        "he-il": "he",
        "vi-vn": "vi",
        "id-id": "id",
        "ms-my": "ms",
        "uk-ua": "uk",
        "cs-cz": "cs",
        "hu-hu": "hu",
        "ro-ro": "ro",
        "bg-bg": "bg",
        "el-gr": "el",
        "hr-hr": "hr",
        "sk-sk": "sk",
        "sl-si": "sl",
        "et-ee": "et",
        "lv-lv": "lv",
        "lt-lt": "lt",
    };

    return languageMap[lower] || lower.split(/[-_]/)[0] || DEFAULT_CHATTERBOX_MULTILINGUAL_TTS_LANGUAGE;
}

async function fetchXaiWithRetries(path: string, init: RequestInit): Promise<Response> {
    let lastError: unknown;

    for (let attempt = 0; attempt < XAI_REQUEST_RETRIES; attempt++) {
        try {
            const response = await fetch(`${getXaiApiBaseUrl()}${path}`, init);
            if (!isTransientStatus(response.status) || attempt === XAI_REQUEST_RETRIES - 1) {
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

async function fetchOpenAiWithRetries(path: string, init: RequestInit): Promise<Response> {
    let lastError: unknown;

    for (let attempt = 0; attempt < OPENAI_REQUEST_RETRIES; attempt++) {
        try {
            const response = await fetch(`${getOpenAiApiBaseUrl()}${path}`, init);
            if (!isTransientStatus(response.status) || attempt === OPENAI_REQUEST_RETRIES - 1) {
                return response;
            }

            await response.arrayBuffer().catch(() => undefined);
        } catch (error) {
            lastError = error;
            if (attempt === OPENAI_REQUEST_RETRIES - 1) {
                throw error;
            }
        }

        await sleep(500 * (2 ** attempt));
    }

    throw lastError instanceof Error ? lastError : new Error("OpenAI request failed");
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

function toOpenAiMessage(message: VoiceAssistantMessage) {
    if (message.role === "assistant") {
        return {
            role: "assistant",
            content: message.content,
            ...(message.toolCalls?.length ? {
                tool_calls: message.toolCalls.map((toolCall) => ({
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

function extractOpenAiToolCalls(raw: unknown): VoiceAssistantResponse["message"]["toolCalls"] {
    if (!isRecord(raw) || !Array.isArray(raw.output)) {
        return [];
    }

    const toolCalls: VoiceAssistantResponse["message"]["toolCalls"] = [];
    for (const item of raw.output) {
        if (!isRecord(item) || item.type !== "function_call") {
            continue;
        }
        toolCalls.push({
            id: typeof item.call_id === "string" ? item.call_id : typeof item.id === "string" ? item.id : "",
            name: typeof item.name === "string" ? item.name : "",
            arguments: typeof item.arguments === "string" ? item.arguments : "{}",
        });
    }
    return toolCalls;
}

async function readXaiResponsesText(response: Response): Promise<string> {
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("text/event-stream")) {
        return readXaiResponsesStream(response);
    }

    return extractXaiOutputText(await response.json());
}

function formatCodexMessage(message: VoiceAssistantMessage): string {
    const role = message.role.toUpperCase();
    if (message.role === "tool") {
        const label = message.name || message.toolCallId || "tool";
        return `TOOL RESULT (${label}):\n${message.content}`;
    }
    return `${role}:\n${message.content}`;
}

function buildCodexNarrationPrompt(body: VoiceAssistantRequest): string {
    return [
        "You are running as Huppie's web voice narrator.",
        "Return only the final spoken narration text. Do not use markdown, code blocks, or tool calls.",
        ...body.messages.map(formatCodexMessage),
    ].join("\n\n");
}

function runCodexExec(prompt: string, outputPath: string): Promise<{ stdout: string; stderr: string }> {
    const args = [
        "exec",
        "--model", getCodexExecModel(),
        "-c", `model_reasoning_effort=${JSON.stringify(getCodexExecReasoningEffort())}`,
        "-c", "approval_policy=\"never\"",
        "--sandbox", "read-only",
        "--skip-git-repo-check",
        "--ignore-rules",
        "--ephemeral",
        "--output-last-message", outputPath,
        "-",
    ];

    return new Promise((resolve, reject) => {
        const child = spawn(getCodexExecCommand(), args, {
            cwd: os.tmpdir(),
            env: process.env,
            stdio: ["pipe", "pipe", "pipe"],
        });
        const timeout = setTimeout(() => {
            child.kill("SIGTERM");
            reject(new Error(`Codex narrator timed out after ${getCodexExecTimeoutMs()}ms`));
        }, getCodexExecTimeoutMs());
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];

        child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
        child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
        child.on("error", (error) => {
            clearTimeout(timeout);
            reject(error);
        });
        child.on("close", (code, signal) => {
            clearTimeout(timeout);
            const stdoutText = Buffer.concat(stdout).toString("utf-8");
            const stderrText = Buffer.concat(stderr).toString("utf-8");
            if (code === 0) {
                resolve({ stdout: stdoutText, stderr: stderrText });
                return;
            }
            reject(new Error(`Codex narrator failed (${signal || code}): ${stderrText || stdoutText}`));
        });

        child.stdin.end(prompt);
    });
}

async function requestCodexAssistantCompletion(body: VoiceAssistantRequest): Promise<VoiceAssistantResponse> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "happy-narrator-"));
    const outputPath = path.join(tmpDir, "last-message.txt");
    try {
        const result = await runCodexExec(buildCodexNarrationPrompt(body), outputPath);
        const content = (fs.existsSync(outputPath)
            ? fs.readFileSync(outputPath, "utf-8")
            : result.stdout
        ).trim();
        if (!content) {
            throw new Error("Codex returned an empty narration response");
        }

        return VoiceAssistantResponseSchema.parse({
            message: {
                role: "assistant",
                content,
                toolCalls: [],
            },
        });
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

async function requestOpenAiAssistantCompletion(body: VoiceAssistantRequest): Promise<VoiceAssistantResponse> {
    const tools = body.tools ?? [];
    const payload: Record<string, unknown> = {
        model: getOpenAiResponsesModel(),
        max_output_tokens: getOpenAiResponsesMaxOutputTokens(),
        store: false,
        input: body.messages.map(toXaiResponsesInputMessage),
        reasoning: {
            effort: getOpenAiResponsesReasoningEffort(),
        },
    };

    if (tools.length > 0) {
        payload.tools = tools.map((tool) => ({
            type: "function",
            name: tool.function.name,
            description: tool.function.description,
            parameters: tool.function.parameters,
        }));
        payload.tool_choice = "auto";
        payload.parallel_tool_calls = false;
    }

    const response = await fetchOpenAiWithRetries("/responses", {
        method: "POST",
        headers: getOpenAiJsonHeaders(),
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        throw new Error(`[${response.status}] ${await response.text()}`);
    }

    const raw = await response.json() as unknown;
    const content = extractXaiOutputText(raw).trim();
    if (!content) {
        throw new Error("OpenAI returned an empty narration response");
    }

    return VoiceAssistantResponseSchema.parse({
        message: {
            role: "assistant",
            content,
            toolCalls: extractOpenAiToolCalls(raw),
        },
    });
}

async function requestXaiAssistantCompletion(body: VoiceAssistantRequest): Promise<VoiceAssistantResponse> {
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

async function requestProxyAssistantCompletion(body: VoiceAssistantRequest): Promise<VoiceAssistantResponse> {
    const llmUrl = `${getLocalLlmBaseUrl()}/chat/completions`;
    const tools = body.tools ?? [];
    const payload: Record<string, unknown> = {
        model: getLocalLlmModel(),
        messages: body.messages.map(toOpenAiMessage),
        temperature: 0.1,
    };
    if (tools.length > 0) {
        payload.tools = tools;
        payload.tool_choice = "auto";
        payload.parallel_tool_calls = false;
    }

    let lastErrorText = "Local model request failed";
    let lastStatus = 502;

    for (let attempt = 0; attempt < LOCAL_LLM_BUSY_RETRIES; attempt++) {
        const response = await fetchWithTimeout(llmUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
        }, LOCAL_LLM_REQUEST_TIMEOUT_MS);

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
                    toolCalls: (message?.tool_calls ?? []).map((toolCall) => ({
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

async function requestLocalAssistantCompletion(body: VoiceAssistantRequest): Promise<VoiceAssistantResponse> {
    switch (getLocalVoiceLlmProvider()) {
        case "codex":
            return requestCodexAssistantCompletion(body);
        case "openai":
            return requestOpenAiAssistantCompletion(body);
        case "xai":
            return requestXaiAssistantCompletion(body);
        case "local":
            return requestProxyAssistantCompletion(body);
    }
}

async function requestOpenAiSpeech(input: string): Promise<{ audioBuffer: Buffer; contentType: string }> {
    const text = input.trim();
    if (!text) {
        throw new Error("Speech input is empty");
    }

    const response = await fetchOpenAiWithRetries("/audio/speech", {
        method: "POST",
        headers: getOpenAiJsonHeaders(),
        body: JSON.stringify({
            model: getOpenAiTtsModel(),
            input: text,
            voice: getOpenAiTtsVoice(),
            response_format: getOpenAiTtsResponseFormat(),
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

async function requestXaiSpeech(input: string, language?: string | null): Promise<{ audioBuffer: Buffer; contentType: string }> {
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
            language: getXaiTtsLanguage(language),
            output_format: {
                codec: "mp3",
                sample_rate: 44100,
                bit_rate: 192000,
            },
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

async function requestChatterboxMultilingualSpeech(input: string, language?: string | null): Promise<{ audioBuffer: Buffer; contentType: string }> {
    const text = input.trim();
    if (!text) {
        throw new Error("Speech input is empty");
    }

    const response = await fetchWithTimeout(`${getChatterboxMultilingualTtsBaseUrl()}/audio/speech`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: getChatterboxMultilingualTtsModel(),
            voice: getChatterboxMultilingualTtsVoice(),
            audio_prompt_path: getChatterboxMultilingualTtsAudioPromptPath(),
            language: getChatterboxMultilingualTtsLanguage(language),
            input: text,
            response_format: getChatterboxMultilingualTtsResponseFormat(),
        }),
    }, getLocalTtsRequestTimeoutMs());

    if (!response.ok) {
        throw new Error(`[${response.status}] ${await response.text()}`);
    }

    return {
        audioBuffer: Buffer.from(await response.arrayBuffer()),
        contentType: response.headers.get("content-type") || "audio/mpeg",
    };
}

async function requestNeuttsSpeech(input: string, language?: string | null): Promise<{ audioBuffer: Buffer; contentType: string }> {
    const text = input.trim();
    if (!text) {
        throw new Error("Speech input is empty");
    }

    const response = await fetchWithTimeout(`${getNeuttsTtsBaseUrl(language)}/audio/speech`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: getNeuttsTtsModel(),
            voice: getNeuttsTtsVoice(language),
            input: text,
            response_format: getNeuttsTtsResponseFormat(),
        }),
    }, getLocalTtsRequestTimeoutMs());

    if (!response.ok) {
        throw new Error(`[${response.status}] ${await response.text()}`);
    }

    return {
        audioBuffer: Buffer.from(await response.arrayBuffer()),
        contentType: response.headers.get("content-type") || "audio/wav",
    };
}

async function requestLocalSpeech(
    input: string,
    provider: VoiceSpeechProvider,
    language?: string | null,
): Promise<{ audioBuffer: Buffer; contentType: string }> {
    switch (provider) {
        case "openai":
            return requestOpenAiSpeech(input);
        case "xai":
            return requestXaiSpeech(input, language);
        case "chatterbox_multilingual":
            return requestChatterboxMultilingualSpeech(input, language);
        case "neutts":
            return requestNeuttsSpeech(input, language);
    }

    throw new Error(`Unsupported speech provider: ${provider}`);
}

function getAudioFileExtension(mimeType: string): string {
    if (mimeType.includes("webm")) return "webm";
    if (mimeType.includes("ogg")) return "ogg";
    if (mimeType.includes("wav")) return "wav";
    if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3";
    if (mimeType.includes("mp4")) return "mp4";
    return "webm";
}

async function requestLocalTranscription(
    body: z.infer<typeof VoiceTranscriptionRequestSchema>,
): Promise<z.infer<typeof VoiceTranscriptionResponseSchema>> {
    const audioBuffer = Buffer.from(body.audioBase64, "base64");
    if (audioBuffer.length === 0) {
        throw new Error("Transcription audio is empty");
    }
    if (audioBuffer.length > LOCAL_ASR_MAX_AUDIO_BYTES) {
        throw new Error(`Transcription audio exceeds ${LOCAL_ASR_MAX_AUDIO_BYTES} bytes`);
    }

    const mimeType = body.mimeType || "audio/webm";
    const formData = new FormData();
    formData.append("model", getLocalAsrModel());
    if (body.language?.trim()) {
        formData.append("language", body.language.trim());
    }
    formData.append(
        "file",
        new Blob([audioBuffer], { type: mimeType }),
        `local-voice.${getAudioFileExtension(mimeType)}`,
    );

    const response = await fetchWithTimeout(`${getLocalAsrBaseUrl()}/audio/transcriptions`, {
        method: "POST",
        body: formData as any,
    }, LOCAL_ASR_REQUEST_TIMEOUT_MS);

    if (!response.ok) {
        throw new Error(`[${response.status}] ${await response.text()}`);
    }

    const raw = await response.json() as { text?: unknown };
    return VoiceTranscriptionResponseSchema.parse({
        text: typeof raw.text === "string" ? raw.text : "",
    });
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
            body: VoiceSpeechRequestSchema,
        },
    }, async (request, reply) => {
        try {
            const provider = request.body.provider ?? getDefaultLocalTtsProvider();
            const { audioBuffer, contentType } = await requestLocalSpeech(
                request.body.input,
                provider,
                request.body.language,
            );
            reply.header('content-type', contentType);
            return reply.send(audioBuffer);
        } catch (error) {
            log({ module: 'voice-local' }, `Local voice speech failed for user ${request.userId}: ${error}`);
            return reply.code(502).send({
                error: error instanceof Error ? error.message : 'Local voice speech failed',
            });
        }
    });

    app.post('/v1/voice/assistant/transcriptions', {
        preHandler: app.authenticate,
        bodyLimit: LOCAL_ASR_REQUEST_BODY_LIMIT_BYTES,
        schema: {
            body: VoiceTranscriptionRequestSchema,
            response: {
                200: VoiceTranscriptionResponseSchema,
                502: z.object({ error: z.string() }),
            },
        },
    }, async (request, reply) => {
        try {
            return reply.send(await requestLocalTranscription(request.body));
        } catch (error) {
            log({ module: 'voice-local' }, `Local voice transcription failed for user ${request.userId}: ${error}`);
            return reply.code(502).send({
                error: error instanceof Error ? error.message : 'Local voice transcription failed',
            });
        }
    });
}
