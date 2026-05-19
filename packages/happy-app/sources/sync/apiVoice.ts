import {
    VoiceAssistantRequestSchema,
    VoiceAssistantResponseSchema,
    VoiceConversationResponseSchema,
    VoiceUsageResponseSchema,
    type VoiceAssistantRequest,
    type VoiceAssistantResponse,
    type VoiceAssistantMessage,
    type VoiceAssistantToolCall,
    type VoiceAssistantToolDefinition,
    type VoiceConversationResponse,
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
    VoiceUsageResponse,
};

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
        throw new Error(`Local voice chat request failed: ${response.status}`);
    }

    return VoiceAssistantResponseSchema.parse(await response.json());
}

export async function synthesizeLocalVoiceSpeech(
    credentials: AuthCredentials,
    input: string,
): Promise<Blob> {
    const serverUrl = getServerUrl();
    const response = await fetch(`${serverUrl}/v1/voice/assistant/speech`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${credentials.token}`,
            'Content-Type': 'application/json',
            'X-Happy-Client': getHappyClientId(),
        },
        body: JSON.stringify({ input }),
    });

    if (!response.ok) {
        throw new Error(`Local voice speech request failed: ${response.status}`);
    }

    return response.blob();
}
