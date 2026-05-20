import * as z from 'zod';

export const VoiceConversationGrantedSchema = z.object({
    allowed: z.literal(true),
    conversationToken: z.string(),
    conversationId: z.string(),
    agentId: z.string(),
    elevenUserId: z.string(),
    usedSeconds: z.number(),
    limitSeconds: z.number(),
});

export const VoiceConversationDeniedSchema = z.object({
    allowed: z.literal(false),
    reason: z.enum(['voice_hard_limit_reached', 'subscription_required', 'voice_conversation_limit_reached']),
    usedSeconds: z.number(),
    limitSeconds: z.number(),
    agentId: z.string(),
});

export const VoiceConversationResponseSchema = z.discriminatedUnion('allowed', [
    VoiceConversationGrantedSchema,
    VoiceConversationDeniedSchema,
]);

export type VoiceConversationResponse = z.infer<typeof VoiceConversationResponseSchema>;

export const VoiceUsageResponseSchema = z.object({
    usedSeconds: z.number(),
    limitSeconds: z.number(),
    conversationCount: z.number(),
    conversationLimit: z.number(),
    elevenUserId: z.string(),
});

export type VoiceUsageResponse = z.infer<typeof VoiceUsageResponseSchema>;

export const VoiceAssistantToolCallSchema = z.object({
    id: z.string(),
    name: z.string(),
    arguments: z.string(),
});

export type VoiceAssistantToolCall = z.infer<typeof VoiceAssistantToolCallSchema>;

export const VoiceAssistantMessageSchema = z.object({
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    content: z.string(),
    toolCallId: z.string().optional(),
    name: z.string().optional(),
    toolCalls: z.array(VoiceAssistantToolCallSchema).optional(),
});

export type VoiceAssistantMessage = z.infer<typeof VoiceAssistantMessageSchema>;

export const VoiceAssistantToolDefinitionSchema = z.object({
    type: z.literal('function'),
    function: z.object({
        name: z.string(),
        description: z.string(),
        parameters: z.record(z.string(), z.unknown()),
    }),
});

export type VoiceAssistantToolDefinition = z.infer<typeof VoiceAssistantToolDefinitionSchema>;

export const VoiceAssistantRequestSchema = z.object({
    messages: z.array(VoiceAssistantMessageSchema),
    tools: z.array(VoiceAssistantToolDefinitionSchema).default([]),
});

export type VoiceAssistantRequest = z.infer<typeof VoiceAssistantRequestSchema>;

export const VoiceAssistantResponseSchema = z.object({
    message: z.object({
        role: z.literal('assistant'),
        content: z.string(),
        toolCalls: z.array(VoiceAssistantToolCallSchema).default([]),
    }),
});

export type VoiceAssistantResponse = z.infer<typeof VoiceAssistantResponseSchema>;

export const VoiceSpeechProviderSchema = z.enum(['xai', 'chatterbox_multilingual', 'neutts']);

export type VoiceSpeechProvider = z.infer<typeof VoiceSpeechProviderSchema>;

export const VoiceAsrProviderSchema = z.enum(['browser', 'local']);

export type VoiceAsrProvider = z.infer<typeof VoiceAsrProviderSchema>;

export const VoiceSpeechRequestSchema = z.object({
    input: z.string().min(1),
    provider: VoiceSpeechProviderSchema.optional(),
    language: z.string().nullable().optional(),
});

export type VoiceSpeechRequest = z.infer<typeof VoiceSpeechRequestSchema>;

export const VoiceTranscriptionRequestSchema = z.object({
    audioBase64: z.string().min(1),
    mimeType: z.string().optional(),
    language: z.string().nullable().optional(),
});

export type VoiceTranscriptionRequest = z.infer<typeof VoiceTranscriptionRequestSchema>;

export const VoiceTranscriptionResponseSchema = z.object({
    text: z.string(),
});

export type VoiceTranscriptionResponse = z.infer<typeof VoiceTranscriptionResponseSchema>;
