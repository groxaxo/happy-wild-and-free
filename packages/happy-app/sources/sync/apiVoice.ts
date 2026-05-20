import {
    VoiceAssistantRequestSchema,
    VoiceAssistantResponseSchema,
    VoiceConversationResponseSchema,
    VoiceSpeechRequestSchema,
    VoiceTranscriptionResponseSchema,
    VoiceUsageResponseSchema,
    type VoiceAssistantRequest,
    type VoiceAssistantResponse,
    type VoiceAssistantMessage,
    type VoiceAssistantToolCall,
    type VoiceAssistantToolDefinition,
    type VoiceConversationResponse,
    type VoiceSpeechProvider,
    type VoiceTranscriptionResponse,
    type VoiceUsageResponse,
} from '@slopus/happy-wire';
import { AuthCredentials } from '@/auth/tokenStorage';
import { getServerUrl } from './serverConfig';
import { getHappyClientId } from './apiSocket';
import { config } from '@/config';
import {
    getLocalVoiceLlmUrl,
    getLocalVoiceLlmApiKey,
    getLocalVoiceLlmModel,
    getLocalVoiceAsrUrl,
    getLocalVoiceAsrApiKey,
} from './localVoiceConfig';

const LOCAL_VOICE_PROXY_HOST = '127.0.0.1';
const DEFAULT_OPENAI_API_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_LOCAL_LLM_BASE_URL = `http://${LOCAL_VOICE_PROXY_HOST}:12434/v1`;
const DEFAULT_LOCAL_LLM_MODEL = 'qwen2.5-14b-instruct';
const DEFAULT_OPENAI_RESPONSES_MODEL = 'gpt-4o';
const DEFAULT_LOCAL_ASR_BASE_URL = `http://${LOCAL_VOICE_PROXY_HOST}:5092/v1`;
const DEFAULT_LOCAL_ASR_MODEL = 'whisper-1';
const DEFAULT_XAI_API_BASE_URL = 'https://api.x.ai/v1';
const DEFAULT_XAI_TTS_VOICE = 'eve';
const DEFAULT_XAI_TTS_LANGUAGE = 'auto';
const XAI_TTS_MAX_INPUT_CHARS = 15000;
const DEFAULT_CHATTERBOX_MULTILINGUAL_TTS_BASE_URL = `http://${LOCAL_VOICE_PROXY_HOST}:8020/v1`;
const DEFAULT_CHATTERBOX_MULTILINGUAL_TTS_MODEL = 'tts-1-es';
const DEFAULT_CHATTERBOX_MULTILINGUAL_TTS_VOICE = 'latina';
const DEFAULT_CHATTERBOX_MULTILINGUAL_TTS_LANGUAGE = 'es';
const DEFAULT_CHATTERBOX_MULTILINGUAL_TTS_RESPONSE_FORMAT = 'mp3';
const DEFAULT_CHATTERBOX_MULTILINGUAL_TTS_AUDIO_PROMPT_PATH = '';
const DEFAULT_NEUTTS_SPANISH_TTS_BASE_URL = `http://${LOCAL_VOICE_PROXY_HOST}:12438/v1`;
const DEFAULT_NEUTTS_ENGLISH_TTS_BASE_URL = `http://${LOCAL_VOICE_PROXY_HOST}:12437/v1`;
const DEFAULT_OPENAI_TTS_MODEL = 'tts-1';
const DEFAULT_OPENAI_TTS_VOICE = 'alloy';
const DEFAULT_OPENAI_TTS_RESPONSE_FORMAT = 'mp3';
const DEFAULT_NEUTTS_TTS_MODEL = 'tts-1';
const DEFAULT_NEUTTS_SPANISH_TTS_VOICE = 'mateo';
const DEFAULT_NEUTTS_ENGLISH_TTS_VOICE = 'dave';
const DEFAULT_NEUTTS_TTS_RESPONSE_FORMAT = 'wav';
const DEFAULT_LOCAL_TTS_REQUEST_TIMEOUT_MS = 300_000;
const DEFAULT_LOCAL_LLM_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_LOCAL_ASR_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_LOCAL_LLM_BUSY_RETRIES = 6;

export type {
    VoiceAssistantMessage,
    VoiceAssistantResponse,
    VoiceAssistantToolCall,
    VoiceAssistantToolDefinition,
    VoiceConversationResponse,
    VoiceTranscriptionResponse,
    VoiceUsageResponse,
};

function readRuntimeValue(key: string): unknown {
    return (globalThis as { __HAPPY_CONFIG__?: Record<string, unknown> }).__HAPPY_CONFIG__?.[key];
}

function readOptionalStringConfig(key: string, envName: string): string | null {
    const runtimeValue = readRuntimeValue(key);
    if (typeof runtimeValue === 'string' && runtimeValue.trim()) {
        return runtimeValue.trim();
    }

    const envValue = (process.env as Record<string, string | undefined>)[envName];
    if (typeof envValue === 'string' && envValue.trim()) {
        return envValue.trim();
    }

    return null;
}

function readPositiveIntegerConfig(key: string, envName: string, fallback: number): number {
    const runtimeValue = readRuntimeValue(key);
    if (typeof runtimeValue === 'number' && Number.isFinite(runtimeValue) && runtimeValue > 0) {
        return Math.floor(runtimeValue);
    }

    const raw = readOptionalStringConfig(key, envName);
    if (!raw) {
        return fallback;
    }

    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }

    return Math.floor(parsed);
}

function stripTrailingSlash(url: string): string {
    return url.replace(/\/$/, '');
}

function getJsonHeaders(apiKey?: string | null): Record<string, string> {
    return {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        'Content-Type': 'application/json',
    };
}

function getAuthHeaders(apiKey?: string | null): Record<string, string> {
    return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, {
            ...init,
            signal: controller.signal,
        });
    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            throw new Error(`Request timed out after ${timeoutMs}ms`);
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

function getLocalLlmBaseUrl(): string {
    return stripTrailingSlash(
        getLocalVoiceLlmUrl()
        || readOptionalStringConfig('localLlmBaseUrl', 'EXPO_PUBLIC_LOCAL_LLM_BASE_URL')
        || readOptionalStringConfig('openAiApiBaseUrl', 'EXPO_PUBLIC_OPENAI_API_BASE_URL')
        || DEFAULT_LOCAL_LLM_BASE_URL,
    );
}

function getLocalLlmModel(): string {
    return getLocalVoiceLlmModel()
        || readOptionalStringConfig('localLlmModel', 'EXPO_PUBLIC_LOCAL_LLM_MODEL')
        || readOptionalStringConfig('openAiResponsesModel', 'EXPO_PUBLIC_OPENAI_RESPONSES_MODEL')
        || DEFAULT_LOCAL_LLM_MODEL
        || DEFAULT_OPENAI_RESPONSES_MODEL;
}

function getLocalLlmApiKey(): string | null {
    return getLocalVoiceLlmApiKey()
        || readOptionalStringConfig('localLlmApiKey', 'EXPO_PUBLIC_LOCAL_LLM_API_KEY')
        || readOptionalStringConfig('openAiApiKey', 'EXPO_PUBLIC_OPENAI_API_KEY');
}

function getLocalLlmRequestTimeoutMs(): number {
    return readPositiveIntegerConfig('localLlmRequestTimeoutMs', 'EXPO_PUBLIC_LOCAL_LLM_REQUEST_TIMEOUT_MS', DEFAULT_LOCAL_LLM_REQUEST_TIMEOUT_MS);
}

function getLocalLlmBusyRetries(): number {
    return readPositiveIntegerConfig('localLlmBusyRetries', 'EXPO_PUBLIC_LOCAL_LLM_BUSY_RETRIES', DEFAULT_LOCAL_LLM_BUSY_RETRIES);
}

function getOpenAiApiBaseUrl(): string {
    // Priority: __HAPPY_CONFIG__ / EXPO_PUBLIC_OPENAI_API_BASE_URL  →  MMKV LLM URL
    // (lets a single local server URL cover both chat and openai-compatible TTS/ASR)
    // →  cloud default.
    return stripTrailingSlash(
        readOptionalStringConfig('openAiApiBaseUrl', 'EXPO_PUBLIC_OPENAI_API_BASE_URL')
        || getLocalVoiceLlmUrl()
        || DEFAULT_OPENAI_API_BASE_URL,
    );
}

function getOpenAiApiKey(): string | null {
    return readOptionalStringConfig('openAiApiKey', 'EXPO_PUBLIC_OPENAI_API_KEY')
        || getLocalVoiceLlmApiKey();
}

function getOpenAiTtsModel(): string {
    return readOptionalStringConfig('openAiTtsModel', 'EXPO_PUBLIC_OPENAI_TTS_MODEL') || DEFAULT_OPENAI_TTS_MODEL;
}

function getOpenAiTtsVoice(): string {
    return readOptionalStringConfig('openAiTtsVoice', 'EXPO_PUBLIC_OPENAI_TTS_VOICE') || DEFAULT_OPENAI_TTS_VOICE;
}

function getOpenAiTtsResponseFormat(): string {
    return readOptionalStringConfig('openAiTtsResponseFormat', 'EXPO_PUBLIC_OPENAI_TTS_RESPONSE_FORMAT') || DEFAULT_OPENAI_TTS_RESPONSE_FORMAT;
}

function getLocalAsrBaseUrl(): string {
    return stripTrailingSlash(
        getLocalVoiceAsrUrl()
        || getLocalVoiceLlmUrl()
        || readOptionalStringConfig('localAsrBaseUrl', 'EXPO_PUBLIC_LOCAL_ASR_BASE_URL')
        || readOptionalStringConfig('openAiApiBaseUrl', 'EXPO_PUBLIC_OPENAI_API_BASE_URL')
        || DEFAULT_LOCAL_ASR_BASE_URL,
    );
}

function getLocalAsrModel(): string {
    return readOptionalStringConfig('localAsrModel', 'EXPO_PUBLIC_LOCAL_ASR_MODEL') || DEFAULT_LOCAL_ASR_MODEL;
}

function getLocalAsrApiKey(): string | null {
    return getLocalVoiceAsrApiKey()
        || getLocalVoiceLlmApiKey()
        || readOptionalStringConfig('localAsrApiKey', 'EXPO_PUBLIC_LOCAL_ASR_API_KEY')
        || getOpenAiApiKey();
}

function getLocalAsrRequestTimeoutMs(): number {
    return readPositiveIntegerConfig('localAsrRequestTimeoutMs', 'EXPO_PUBLIC_LOCAL_ASR_REQUEST_TIMEOUT_MS', DEFAULT_LOCAL_ASR_REQUEST_TIMEOUT_MS);
}

function getXaiApiBaseUrl(): string {
    return stripTrailingSlash(readOptionalStringConfig('xaiApiBaseUrl', 'EXPO_PUBLIC_XAI_API_BASE_URL') || DEFAULT_XAI_API_BASE_URL);
}

function getXaiApiKey(): string | null {
    return readOptionalStringConfig('xaiApiKey', 'EXPO_PUBLIC_XAI_API_KEY');
}

function getXaiTtsVoice(): string {
    return readOptionalStringConfig('xaiTtsVoice', 'EXPO_PUBLIC_XAI_TTS_VOICE') || DEFAULT_XAI_TTS_VOICE;
}

function normalizeXaiLanguage(language?: string | null): string | null {
    if (!language) {
        return null;
    }

    const normalized = language.trim();
    if (!normalized || normalized.toLowerCase() === 'auto') {
        return 'auto';
    }

    const lower = normalized.toLowerCase();
    const languageMap: Record<string, string> = {
        'en-us': 'en',
        'en-gb': 'en',
        'en-au': 'en',
        'en-ca': 'en',
        'fr-fr': 'fr',
        'fr-ca': 'fr',
        'de-de': 'de',
        'de-at': 'de',
        'it-it': 'it',
        'ru-ru': 'ru',
        'zh-cn': 'zh',
        'zh-tw': 'zh',
        'ja-jp': 'ja',
        'ko-kr': 'ko',
        'hi-in': 'hi',
        'id-id': 'id',
        'tr-tr': 'tr',
        'vi-vn': 'vi',
    };

    return languageMap[lower] || normalized;
}

function getXaiTtsLanguage(language?: string | null): string {
    return normalizeXaiLanguage(language)
        || readOptionalStringConfig('xaiTtsLanguage', 'EXPO_PUBLIC_XAI_TTS_LANGUAGE')
        || DEFAULT_XAI_TTS_LANGUAGE;
}

function getLocalTtsRequestTimeoutMs(): number {
    return readPositiveIntegerConfig('localTtsRequestTimeoutMs', 'EXPO_PUBLIC_LOCAL_TTS_REQUEST_TIMEOUT_MS', DEFAULT_LOCAL_TTS_REQUEST_TIMEOUT_MS);
}

function getChatterboxMultilingualTtsBaseUrl(): string {
    return stripTrailingSlash(
        readOptionalStringConfig('chatterboxMultilingualTtsBaseUrl', 'EXPO_PUBLIC_CHATTERBOX_MULTILINGUAL_TTS_BASE_URL')
        || DEFAULT_CHATTERBOX_MULTILINGUAL_TTS_BASE_URL,
    );
}

function getChatterboxMultilingualTtsModel(): string {
    return readOptionalStringConfig('chatterboxMultilingualTtsModel', 'EXPO_PUBLIC_CHATTERBOX_MULTILINGUAL_TTS_MODEL')
        || DEFAULT_CHATTERBOX_MULTILINGUAL_TTS_MODEL;
}

function getChatterboxMultilingualTtsVoice(): string {
    return readOptionalStringConfig('chatterboxMultilingualTtsVoice', 'EXPO_PUBLIC_CHATTERBOX_MULTILINGUAL_TTS_VOICE')
        || DEFAULT_CHATTERBOX_MULTILINGUAL_TTS_VOICE;
}

function getChatterboxMultilingualTtsAudioPromptPath(): string {
    return readOptionalStringConfig('chatterboxMultilingualTtsAudioPromptPath', 'EXPO_PUBLIC_CHATTERBOX_MULTILINGUAL_TTS_AUDIO_PROMPT_PATH')
        || DEFAULT_CHATTERBOX_MULTILINGUAL_TTS_AUDIO_PROMPT_PATH;
}

function normalizeChatterboxLanguage(language: string): string {
    const lower = language.trim().toLowerCase();
    if (!lower || lower === 'auto') {
        return DEFAULT_CHATTERBOX_MULTILINGUAL_TTS_LANGUAGE;
    }

    const languageMap: Record<string, string> = {
        'en-us': 'en',
        'en-gb': 'en',
        'en-au': 'en',
        'en-ca': 'en',
        'es-es': 'es',
        'es-mx': 'es',
        'es-ar': 'es',
        'fr-fr': 'fr',
        'fr-ca': 'fr',
        'de-de': 'de',
        'de-at': 'de',
        'it-it': 'it',
        'pt-br': 'pt',
        'pt-pt': 'pt',
        'ru-ru': 'ru',
        'zh-cn': 'zh',
        'zh-tw': 'zh',
        'ja-jp': 'ja',
        'ko-kr': 'ko',
        'ar-sa': 'ar',
        'hi-in': 'hi',
        'nl-nl': 'nl',
        'sv-se': 'sv',
        'no-no': 'no',
        'da-dk': 'da',
        'fi-fi': 'fi',
        'pl-pl': 'pl',
        'tr-tr': 'tr',
        'he-il': 'he',
        'vi-vn': 'vi',
        'id-id': 'id',
        'ms-my': 'ms',
        'uk-ua': 'uk',
        'cs-cz': 'cs',
        'hu-hu': 'hu',
        'ro-ro': 'ro',
        'bg-bg': 'bg',
        'el-gr': 'el',
        'hr-hr': 'hr',
        'sk-sk': 'sk',
        'sl-si': 'sl',
        'et-ee': 'et',
        'lv-lv': 'lv',
        'lt-lt': 'lt',
    };

    return languageMap[lower] || lower.split(/[-_]/)[0] || DEFAULT_CHATTERBOX_MULTILINGUAL_TTS_LANGUAGE;
}

function getChatterboxMultilingualTtsLanguage(language?: string | null): string {
    return normalizeChatterboxLanguage(
        language
        || readOptionalStringConfig('chatterboxMultilingualTtsLanguage', 'EXPO_PUBLIC_CHATTERBOX_MULTILINGUAL_TTS_LANGUAGE')
        || DEFAULT_CHATTERBOX_MULTILINGUAL_TTS_LANGUAGE,
    );
}

function getChatterboxMultilingualTtsResponseFormat(): 'mp3' | 'wav' {
    return readOptionalStringConfig('chatterboxMultilingualTtsResponseFormat', 'EXPO_PUBLIC_CHATTERBOX_MULTILINGUAL_TTS_RESPONSE_FORMAT') === 'wav'
        ? 'wav'
        : DEFAULT_CHATTERBOX_MULTILINGUAL_TTS_RESPONSE_FORMAT;
}

function getNeuttsTtsBaseUrl(language?: string | null): string {
    const normalizedLanguage = normalizeChatterboxLanguage(language || 'es');
    const fallback = normalizedLanguage === 'en'
        ? DEFAULT_NEUTTS_ENGLISH_TTS_BASE_URL
        : DEFAULT_NEUTTS_SPANISH_TTS_BASE_URL;

    return stripTrailingSlash(
        readOptionalStringConfig('neuttsTtsBaseUrl', 'EXPO_PUBLIC_NEUTTS_TTS_BASE_URL')
        || (normalizedLanguage === 'en'
            ? readOptionalStringConfig('neuttsEnglishTtsBaseUrl', 'EXPO_PUBLIC_NEUTTS_ENGLISH_TTS_BASE_URL')
            : readOptionalStringConfig('neuttsSpanishTtsBaseUrl', 'EXPO_PUBLIC_NEUTTS_SPANISH_TTS_BASE_URL'))
        || fallback,
    );
}

function getNeuttsTtsModel(): string {
    return readOptionalStringConfig('neuttsTtsModel', 'EXPO_PUBLIC_NEUTTS_TTS_MODEL') || DEFAULT_NEUTTS_TTS_MODEL;
}

function getNeuttsTtsVoice(language?: string | null): string {
    const normalizedLanguage = normalizeChatterboxLanguage(language || 'es');
    const fallback = normalizedLanguage === 'en' ? DEFAULT_NEUTTS_ENGLISH_TTS_VOICE : DEFAULT_NEUTTS_SPANISH_TTS_VOICE;

    return readOptionalStringConfig('neuttsTtsVoice', 'EXPO_PUBLIC_NEUTTS_TTS_VOICE')
        || (normalizedLanguage === 'en'
            ? readOptionalStringConfig('neuttsEnglishTtsVoice', 'EXPO_PUBLIC_NEUTTS_ENGLISH_TTS_VOICE')
            : readOptionalStringConfig('neuttsSpanishTtsVoice', 'EXPO_PUBLIC_NEUTTS_SPANISH_TTS_VOICE'))
        || fallback;
}

function getNeuttsTtsResponseFormat(): 'wav' {
    return DEFAULT_NEUTTS_TTS_RESPONSE_FORMAT;
}

function toOpenAiMessage(message: VoiceAssistantMessage) {
    if (message.role === 'assistant') {
        return {
            role: 'assistant',
            content: message.content,
            ...(message.toolCalls?.length ? {
                tool_calls: message.toolCalls.map((toolCall) => ({
                    id: toolCall.id,
                    type: 'function',
                    function: {
                        name: toolCall.name,
                        arguments: toolCall.arguments,
                    },
                })),
            } : {}),
        };
    }

    if (message.role === 'tool') {
        return {
            role: 'tool',
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

function extractChatCompletionText(content: unknown): string {
    if (typeof content === 'string') {
        return content;
    }

    if (!Array.isArray(content)) {
        return '';
    }

    return content.map((part) => {
        if (typeof part === 'string') {
            return part;
        }
        if (part && typeof part === 'object' && 'text' in part && typeof (part as { text?: unknown }).text === 'string') {
            return (part as { text: string }).text;
        }
        return '';
    }).join('');
}

function stringifyToolArguments(argumentsValue: unknown): string {
    if (typeof argumentsValue === 'string') {
        return argumentsValue;
    }
    if (argumentsValue && typeof argumentsValue === 'object') {
        return JSON.stringify(argumentsValue);
    }
    return '{}';
}

async function requestDirectAssistantCompletion(request: VoiceAssistantRequest): Promise<VoiceAssistantResponse> {
    const parsedRequest = VoiceAssistantRequestSchema.parse(request);
    const payload: Record<string, unknown> = {
        model: getLocalLlmModel(),
        messages: parsedRequest.messages.map(toOpenAiMessage),
        temperature: 0.1,
    };

    if (parsedRequest.tools.length > 0) {
        payload.tools = parsedRequest.tools;
        payload.tool_choice = 'auto';
        payload.parallel_tool_calls = false;
    }

    let lastStatus = 502;
    let lastDetail = 'Local voice chat request failed';

    for (let attempt = 0; attempt < getLocalLlmBusyRetries(); attempt++) {
        const response = await fetchWithTimeout(`${getLocalLlmBaseUrl()}/chat/completions`, {
            method: 'POST',
            headers: getJsonHeaders(getLocalLlmApiKey()),
            body: JSON.stringify(payload),
        }, getLocalLlmRequestTimeoutMs());

        if (response.ok) {
            const raw = await response.json() as {
                choices?: Array<{
                    message?: {
                        content?: unknown;
                        tool_calls?: Array<{
                            id?: string;
                            function?: {
                                name?: string;
                                arguments?: unknown;
                            };
                        }>;
                    };
                }>;
            };
            const message = raw.choices?.[0]?.message;
            const content = extractChatCompletionText(message?.content).trim();
            if (!content) {
                throw new Error('Local voice chat returned an empty response');
            }

            return VoiceAssistantResponseSchema.parse({
                message: {
                    role: 'assistant',
                    content,
                    toolCalls: (message?.tool_calls ?? []).map((toolCall) => ({
                        id: toolCall.id ?? '',
                        name: toolCall.function?.name ?? '',
                        arguments: stringifyToolArguments(toolCall.function?.arguments),
                    })),
                },
            });
        }

        lastStatus = response.status;
        lastDetail = await getResponseErrorMessage(response) || lastDetail;
        if (response.status !== 409 || attempt === getLocalLlmBusyRetries() - 1) {
            break;
        }

        await sleep(1000 * (attempt + 1));
    }

    throw new Error(`Local voice chat request failed: ${lastStatus}${lastDetail ? ` - ${lastDetail}` : ''}`);
}

async function requestOpenAiSpeech(input: string): Promise<Blob> {
    const text = input.trim();
    if (!text) {
        throw new Error('Speech input is empty');
    }

    const response = await fetchWithTimeout(`${getOpenAiApiBaseUrl()}/audio/speech`, {
        method: 'POST',
        headers: getJsonHeaders(getOpenAiApiKey()),
        body: JSON.stringify({
            model: getOpenAiTtsModel(),
            input: text,
            voice: getOpenAiTtsVoice(),
            response_format: getOpenAiTtsResponseFormat(),
        }),
    }, getLocalTtsRequestTimeoutMs());

    if (!response.ok) {
        await throwRequestError(response, 'Local voice speech request');
    }

    return response.blob();
}

async function requestXaiSpeech(input: string, language?: string | null): Promise<Blob> {
    const text = input.trim();
    if (!text) {
        throw new Error('Speech input is empty');
    }
    if (text.length > XAI_TTS_MAX_INPUT_CHARS) {
        throw new Error(`Speech input exceeds ${XAI_TTS_MAX_INPUT_CHARS} characters`);
    }

    const response = await fetchWithTimeout(`${getXaiApiBaseUrl()}/tts`, {
        method: 'POST',
        headers: getJsonHeaders(getXaiApiKey()),
        body: JSON.stringify({
            text,
            voice_id: getXaiTtsVoice(),
            language: getXaiTtsLanguage(language),
            output_format: {
                codec: 'mp3',
                sample_rate: 44100,
                bit_rate: 192000,
            },
        }),
    }, getLocalTtsRequestTimeoutMs());

    if (!response.ok) {
        await throwRequestError(response, 'Local voice speech request');
    }

    return response.blob();
}

async function requestChatterboxSpeech(input: string, language?: string | null): Promise<Blob> {
    const text = input.trim();
    if (!text) {
        throw new Error('Speech input is empty');
    }

    const response = await fetchWithTimeout(`${getChatterboxMultilingualTtsBaseUrl()}/audio/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
        await throwRequestError(response, 'Local voice speech request');
    }

    return response.blob();
}

async function requestNeuttsSpeech(input: string, language?: string | null): Promise<Blob> {
    const text = input.trim();
    if (!text) {
        throw new Error('Speech input is empty');
    }

    const response = await fetchWithTimeout(`${getNeuttsTtsBaseUrl(language)}/audio/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: getNeuttsTtsModel(),
            voice: getNeuttsTtsVoice(language),
            input: text,
            response_format: getNeuttsTtsResponseFormat(),
        }),
    }, getLocalTtsRequestTimeoutMs());

    if (!response.ok) {
        await throwRequestError(response, 'Local voice speech request');
    }

    return response.blob();
}

function getAudioFileExtension(mimeType: string): string {
    if (mimeType.includes('webm')) return 'webm';
    if (mimeType.includes('ogg')) return 'ogg';
    if (mimeType.includes('wav')) return 'wav';
    if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return 'mp3';
    if (mimeType.includes('mp4')) return 'mp4';
    return 'webm';
}

async function getResponseErrorMessage(response: Response): Promise<string> {
    try {
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
            const payload = await response.json() as { error?: unknown };
            return typeof payload.error === 'string' ? payload.error : JSON.stringify(payload);
        }

        return (await response.text()).trim();
    } catch {
        return '';
    }
}

async function throwRequestError(response: Response, label: string): Promise<never> {
    const detail = await getResponseErrorMessage(response);
    throw new Error(`${label} failed: ${response.status}${detail ? ` - ${detail}` : ''}`);
}

export async function fetchVoiceCredentials(
    credentials: AuthCredentials,
    sessionId: string
): Promise<VoiceConversationResponse> {
    const serverUrl = getServerUrl();

    const agentId = config.elevenLabsAgentId;

    if (!agentId) {
        throw new Error('Agent ID not configured');
    }

    const response = await fetch(`${serverUrl}/v1/voice/conversations`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${credentials.token}`,
            'Content-Type': 'application/json',
            'X-Happy-Client': getHappyClientId(),
        },
        body: JSON.stringify({
            agentId
        })
    });

    if (!response.ok) {
        throw new Error(`Voice token request failed: ${response.status}`);
    }

    return VoiceConversationResponseSchema.parse(await response.json());
}

export async function fetchVoiceUsage(
    credentials: AuthCredentials
): Promise<VoiceUsageResponse> {
    const serverUrl = getServerUrl();

    const response = await fetch(`${serverUrl}/v1/voice/usage`, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${credentials.token}`,
            'X-Happy-Client': getHappyClientId(),
        },
    });

    if (!response.ok) {
        throw new Error(`Voice usage request failed: ${response.status}`);
    }

    return VoiceUsageResponseSchema.parse(await response.json());
}

export async function fetchLocalVoiceAssistantResponse(
    request: VoiceAssistantRequest,
): Promise<VoiceAssistantResponse> {
    return requestDirectAssistantCompletion(request);
}

export async function synthesizeLocalVoiceSpeech(
    input: string,
    options: { provider?: VoiceSpeechProvider | null; language?: string | null } = {},
): Promise<Blob> {
    const parsedRequest = VoiceSpeechRequestSchema.parse({
        input,
        provider: options.provider ?? undefined,
        language: options.language ?? undefined,
    });

    switch (parsedRequest.provider ?? 'openai') {
        case 'openai':
            return requestOpenAiSpeech(parsedRequest.input);
        case 'xai':
            return requestXaiSpeech(parsedRequest.input, parsedRequest.language);
        case 'chatterbox_multilingual':
            return requestChatterboxSpeech(parsedRequest.input, parsedRequest.language);
        case 'neutts':
            return requestNeuttsSpeech(parsedRequest.input, parsedRequest.language);
    }
}

export async function transcribeLocalVoiceAudio(
    audio: Blob,
    options: { language?: string | null } = {},
): Promise<VoiceTranscriptionResponse> {
    const mimeType = audio.type || 'audio/webm';
    const formData = new FormData();
    formData.append('model', getLocalAsrModel());
    if (options.language?.trim()) {
        formData.append('language', options.language.trim());
    }
    formData.append('file', audio, `local-voice.${getAudioFileExtension(mimeType)}`);

    const response = await fetchWithTimeout(`${getLocalAsrBaseUrl()}/audio/transcriptions`, {
        method: 'POST',
        headers: getAuthHeaders(getLocalAsrApiKey()),
        body: formData,
    }, getLocalAsrRequestTimeoutMs());

    if (!response.ok) {
        await throwRequestError(response, 'Local voice transcription request');
    }

    const raw = await response.json() as { text?: unknown };
    return VoiceTranscriptionResponseSchema.parse({
        text: typeof raw.text === 'string' ? raw.text : '',
    });
}
