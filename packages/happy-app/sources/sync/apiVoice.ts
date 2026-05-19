import {
    VoiceAssistantRequestSchema,
    VoiceAssistantResponseSchema,
    VoiceConversationResponseSchema,
    VoiceSpeechRequestSchema,
    VoiceTranscriptionRequestSchema,
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

export type {
    VoiceAssistantMessage,
    VoiceAssistantResponse,
    VoiceAssistantToolCall,
    VoiceAssistantToolDefinition,
    VoiceConversationResponse,
    VoiceTranscriptionResponse,
    VoiceUsageResponse,
};

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
    credentials: AuthCredentials,
    request: VoiceAssistantRequest,
): Promise<VoiceAssistantResponse> {
    const serverUrl = getServerUrl();
    const response = await fetch(`${serverUrl}/v1/voice/assistant/chat`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${credentials.token}`,
            'Content-Type': 'application/json',
            'X-Happy-Client': getHappyClientId(),
        },
        body: JSON.stringify(VoiceAssistantRequestSchema.parse(request)),
    });

    if (!response.ok) {
        await throwRequestError(response, 'Local voice chat request');
    }

    return VoiceAssistantResponseSchema.parse(await response.json());
}

export async function synthesizeLocalVoiceSpeech(
    credentials: AuthCredentials,
    input: string,
    options: { provider?: VoiceSpeechProvider | null; language?: string | null } = {},
): Promise<Blob> {
    const serverUrl = getServerUrl();
    const response = await fetch(`${serverUrl}/v1/voice/assistant/speech`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${credentials.token}`,
            'Content-Type': 'application/json',
            'X-Happy-Client': getHappyClientId(),
        },
        body: JSON.stringify(VoiceSpeechRequestSchema.parse({
            input,
            provider: options.provider ?? undefined,
            language: options.language ?? undefined,
        })),
    });

    if (!response.ok) {
        await throwRequestError(response, 'Local voice speech request');
    }

    return response.blob();
}

function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error ?? new Error('Failed to read audio blob'));
        reader.onload = () => {
            const result = reader.result;
            if (typeof result !== 'string') {
                reject(new Error('Failed to encode audio blob'));
                return;
            }
            resolve(result.split(',', 2)[1] ?? '');
        };
        reader.readAsDataURL(blob);
    });
}

export async function transcribeLocalVoiceAudio(
    credentials: AuthCredentials,
    audio: Blob,
    options: { language?: string | null } = {},
): Promise<VoiceTranscriptionResponse> {
    const serverUrl = getServerUrl();
    const response = await fetch(`${serverUrl}/v1/voice/assistant/transcriptions`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${credentials.token}`,
            'Content-Type': 'application/json',
            'X-Happy-Client': getHappyClientId(),
        },
        body: JSON.stringify(VoiceTranscriptionRequestSchema.parse({
            audioBase64: await blobToBase64(audio),
            mimeType: audio.type || 'audio/webm',
            language: options.language ?? undefined,
        })),
    });

    if (!response.ok) {
        await throwRequestError(response, 'Local voice transcription request');
    }

    return VoiceTranscriptionResponseSchema.parse(await response.json());
}
