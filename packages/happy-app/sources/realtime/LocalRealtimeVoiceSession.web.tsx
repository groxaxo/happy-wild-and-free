import React, { useEffect, useRef } from 'react';
import { TokenStorage } from '@/auth/tokenStorage';
import { Modal } from '@/modal';
import { t } from '@/text';
import { storage } from '@/sync/storage';
import {
    fetchLocalVoiceAssistantResponse,
    synthesizeLocalVoiceSpeech,
} from '@/sync/apiVoice';
import { getCurrentRealtimeSessionId, registerVoiceSession } from './RealtimeSession';
import { realtimeClientTools } from './realtimeClientTools';
import type { VoiceSession, VoiceSessionConfig } from './types';
import { extractPermissionDecision, findPendingPermissionRequest } from './localVoiceRouting';

interface SpeechRecognitionAlternativeLike {
    transcript: string;
}

interface SpeechRecognitionResultLike {
    isFinal: boolean;
    length: number;
    [index: number]: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionEventLike extends Event {
    resultIndex: number;
    results: {
        length: number;
        [index: number]: SpeechRecognitionResultLike;
    };
}

interface SpeechRecognitionErrorEventLike extends Event {
    error: string;
    message?: string;
}

interface SpeechRecognitionLike extends EventTarget {
    continuous: boolean;
    interimResults: boolean;
    lang: string;
    onend: ((event: Event) => void) | null;
    onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
    onresult: ((event: SpeechRecognitionEventLike) => void) | null;
    onspeechend: ((event: Event) => void) | null;
    onspeechstart: ((event: Event) => void) | null;
    start(): void;
    stop(): void;
    abort(): void;
}

interface SpeechRecognitionConstructorLike {
    new (): SpeechRecognitionLike;
}

declare global {
    interface Window {
        SpeechRecognition?: SpeechRecognitionConstructorLike;
        webkitSpeechRecognition?: SpeechRecognitionConstructorLike;
    }
}

const LOCAL_NARRATION_SYSTEM_PROMPT = [
    'You are Happy\'s local narration voice for the user\'s coding session.',
    'The coding work itself is performed by the coding session, not by you.',
    'You only narrate already-decided events and confirmations.',
    'Rules:',
    '- Speak in one short sentence.',
    '- Never mention internal session ids, request ids, or opaque labels.',
    '- Never invent work, file names, commands, or outcomes.',
    '- If the update is a permission request, clearly ask whether to allow or deny it.',
    '- If the update is a forwarding acknowledgement, briefly confirm it was sent.',
].join('\n');

function compactText(input: string, maxLength: number): string {
    const trimmed = input.trim();
    if (trimmed.length <= maxLength) {
        return trimmed;
    }
    return `${trimmed.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function getSpeechRecognitionConstructor(): SpeechRecognitionConstructorLike | null {
    if (typeof window === 'undefined') {
        return null;
    }
    return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

class LocalRealtimeVoiceSessionImpl implements VoiceSession {
    private recognition: SpeechRecognitionLike | null = null;
    private sessionActive = false;
    private restartRecognition = false;
    private startingRecognition = false;
    private processingTurn = false;
    private activeAudio: HTMLAudioElement | null = null;
    private conversationId: string | null = null;
    private turnQueue: Promise<void> = Promise.resolve();
    private focusedSessionId: string | null = null;
    private initialContext: string | null = null;
    private contextualUpdates: string[] = [];

    async startSession(config: VoiceSessionConfig): Promise<string | null> {
        if (!getSpeechRecognitionConstructor()) {
            throw new Error('Speech recognition is not available in this browser');
        }

        await this.endSession();

        this.sessionActive = true;
        this.restartRecognition = true;
        this.conversationId = crypto.randomUUID();
        this.focusedSessionId = config.sessionId;
        this.initialContext = config.initialContext?.trim() ? compactText(config.initialContext, 4000) : null;
        this.contextualUpdates = [];

        this.ensureRecognition();
        storage.getState().setRealtimeStatus('connected');
        storage.getState().setRealtimeMode('idle', true);

        if (config.firstMessage?.trim()) {
            void this.playAssistantText(config.firstMessage.trim()).finally(() => {
                this.maybeStartRecognition();
            });
        } else {
            this.maybeStartRecognition();
        }

        return this.conversationId;
    }

    async endSession(): Promise<void> {
        this.sessionActive = false;
        this.restartRecognition = false;
        this.processingTurn = false;
        this.conversationId = null;
        this.focusedSessionId = null;
        this.initialContext = null;
        this.contextualUpdates = [];

        this.stopRecognition();

        if (this.activeAudio) {
            this.activeAudio.pause();
            this.activeAudio.src = '';
            this.activeAudio = null;
        }

        storage.getState().setRealtimeStatus('disconnected');
        storage.getState().setRealtimeMode('idle', true);
    }

    sendTextMessage(message: string): void {
        const trimmed = message.trim();
        if (!trimmed || !this.sessionActive) {
            return;
        }
        this.enqueueWork(() => this.runNarratedEvent(trimmed));
    }

    sendContextualUpdate(update: string): void {
        const trimmed = update.trim();
        if (!trimmed || !this.sessionActive) {
            return;
        }

        this.contextualUpdates.push(compactText(trimmed, 1200));
        if (this.contextualUpdates.length > 12) {
            this.contextualUpdates = this.contextualUpdates.slice(-12);
        }
    }

    private ensureRecognition(): void {
        if (this.recognition) {
            return;
        }

        const SpeechRecognition = getSpeechRecognitionConstructor();
        if (!SpeechRecognition) {
            throw new Error('Speech recognition is not available in this browser');
        }

        const recognition = new SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = 'en-US';

        recognition.onspeechstart = () => {
            if (!this.processingTurn && !this.activeAudio) {
                storage.getState().setRealtimeMode('user-speaking', true);
            }
        };

        recognition.onspeechend = () => {
            if (!this.processingTurn && !this.activeAudio) {
                storage.getState().setRealtimeMode('idle');
            }
        };

        recognition.onresult = (event) => {
            let finalTranscript = '';
            let sawInterim = false;

            for (let index = event.resultIndex; index < event.results.length; index++) {
                const result = event.results[index];
                const transcript = result[0]?.transcript?.trim() ?? '';
                if (!transcript) {
                    continue;
                }
                if (result.isFinal) {
                    finalTranscript += `${transcript} `;
                } else {
                    sawInterim = true;
                }
            }

            if (sawInterim) {
                storage.getState().setRealtimeMode('user-speaking', true);
            }

            const trimmed = finalTranscript.trim();
            if (!trimmed) {
                return;
            }

            this.enqueueWork(() => this.runUserTurn(trimmed));
        };

        recognition.onerror = (event) => {
            if (event.error === 'aborted' || event.error === 'no-speech') {
                storage.getState().setRealtimeMode('idle', true);
                this.maybeStartRecognition(300);
                return;
            }

            console.warn('Local voice recognition error:', event.error, event.message);
            storage.getState().setRealtimeStatus('error');
            storage.getState().setRealtimeMode('idle', true);
        };

        recognition.onend = () => {
            this.startingRecognition = false;
            if (!this.processingTurn && !this.activeAudio) {
                storage.getState().setRealtimeMode('idle', true);
            }
            this.maybeStartRecognition(300);
        };

        this.recognition = recognition;
    }

    private maybeStartRecognition(delayMs: number = 0): void {
        if (!this.sessionActive || !this.restartRecognition || this.processingTurn || this.activeAudio) {
            return;
        }
        if (delayMs > 0) {
            window.setTimeout(() => this.startRecognition(), delayMs);
            return;
        }
        this.startRecognition();
    }

    private startRecognition(): void {
        if (!this.recognition || !this.sessionActive || !this.restartRecognition || this.processingTurn || this.activeAudio) {
            return;
        }
        if (this.startingRecognition) {
            return;
        }

        this.startingRecognition = true;
        try {
            this.recognition.start();
        } catch (error) {
            this.startingRecognition = false;
            const message = error instanceof Error ? error.message : String(error);
            if (!message.includes('already started')) {
                console.warn('Failed to start local voice recognition:', error);
            }
        }
    }

    private stopRecognition(): void {
        this.startingRecognition = false;
        if (!this.recognition) {
            return;
        }
        try {
            this.recognition.stop();
        } catch {
            try {
                this.recognition.abort();
            } catch {
                // Ignore shutdown races from the browser speech engine.
            }
        }
    }

    private enqueueWork(work: () => Promise<void>): void {
        this.turnQueue = this.turnQueue
            .then(async () => {
                if (!this.sessionActive) {
                    return;
                }

                this.processingTurn = true;
                this.restartRecognition = false;
                this.stopRecognition();
                storage.getState().setRealtimeMode('agent-speaking', true);

                try {
                    await work();
                    if (this.sessionActive) {
                        storage.getState().setRealtimeStatus('connected');
                    }
                } catch (error) {
                    console.error('Local voice turn failed:', error);
                    storage.getState().setRealtimeStatus('error');
                    if (this.sessionActive) {
                        Modal.alert(t('common.error'), t('errors.voiceServiceUnavailable'));
                    }
                } finally {
                    this.processingTurn = false;
                    if (this.sessionActive) {
                        storage.getState().setRealtimeMode('idle', true);
                        this.restartRecognition = true;
                        this.maybeStartRecognition(300);
                    }
                }
            })
            .catch((error) => {
                console.error('Failed to queue local voice work:', error);
            });
    }

    private async runUserTurn(input: string): Promise<void> {
        const trimmed = input.trim();
        if (!trimmed) {
            return;
        }

        const targetSessionId = this.getTargetSessionId();
        const pendingRequest = findPendingPermissionRequest(storage.getState().sessions, targetSessionId);
        const decision = extractPermissionDecision(trimmed);

        if (decision && pendingRequest) {
            await realtimeClientTools.processPermissionRequest({
                requestId: pendingRequest.requestId,
                decision,
            });
            this.sendContextualUpdate(`The user ${decision === 'allow' ? 'approved' : 'denied'} a pending permission request.`);

            const spokenReply = await this.generateNarration([
                `A pending permission request for the focused coding session was already ${decision === 'allow' ? 'approved' : 'denied'}.`,
                'Confirm that to the user in one short spoken sentence.',
            ].join('\n\n'));
            if (spokenReply) {
                await this.playAssistantText(spokenReply);
            }
            return;
        }

        if (!targetSessionId) {
            await this.playAssistantText('No active coding session is ready yet.');
            return;
        }

        await realtimeClientTools.sendMessageToSession({
            sessionId: targetSessionId,
            message: trimmed,
        });
        this.sendContextualUpdate('The user just sent a spoken request to the focused coding session.');

        const spokenReply = await this.generateNarration([
            'The user\'s spoken request was already forwarded verbatim to the focused coding session.',
            'Acknowledge that in one short spoken sentence without paraphrasing the full request.',
        ].join('\n\n'));
        if (spokenReply) {
            await this.playAssistantText(spokenReply);
        }
    }

    private async runNarratedEvent(update: string): Promise<void> {
        const spokenReply = await this.generateNarration([
            'Narrate this coding-session update for the user in one short spoken sentence.',
            compactText(update, 1600),
        ].join('\n\n'));

        if (spokenReply) {
            await this.playAssistantText(spokenReply);
        }
    }

    private getTargetSessionId(): string | null {
        return getCurrentRealtimeSessionId()
            ?? storage.getState().currentViewingSessionId
            ?? this.focusedSessionId;
    }

    private async generateNarration(instruction: string): Promise<string> {
        const credentials = await TokenStorage.getCredentials();
        if (!credentials) {
            throw new Error('Missing auth credentials for local voice narration');
        }

        const messages: Array<{ role: 'system' | 'user'; content: string }> = [
            { role: 'system', content: LOCAL_NARRATION_SYSTEM_PROMPT },
        ];

        if (this.initialContext) {
            messages.push({
                role: 'system',
                content: `Current coding context:\n${this.initialContext}`,
            });
        }

        if (this.contextualUpdates.length > 0) {
            messages.push({
                role: 'system',
                content: `Recent coding updates:\n${this.contextualUpdates.slice(-6).join('\n\n')}`,
            });
        }

        messages.push({
            role: 'user',
            content: instruction,
        });

        const response = await fetchLocalVoiceAssistantResponse(credentials, {
            messages,
            tools: [],
        });

        return response.message.content.trim();
    }

    private async playAssistantText(text: string): Promise<void> {
        const trimmed = text.trim();
        if (!trimmed || !this.sessionActive) {
            return;
        }

        const credentials = await TokenStorage.getCredentials();
        if (!credentials) {
            throw new Error('Missing auth credentials for local voice speech');
        }

        storage.getState().setRealtimeMode('agent-speaking', true);

        const blob = await synthesizeLocalVoiceSpeech(credentials, trimmed);
        if (!this.sessionActive) {
            return;
        }

        const objectUrl = URL.createObjectURL(blob);
        const audio = new Audio(objectUrl);
        this.activeAudio = audio;

        try {
            await new Promise<void>((resolve, reject) => {
                audio.onended = () => resolve();
                audio.onerror = () => reject(new Error('Audio playback failed'));
                audio.play().then(() => undefined).catch(reject);
            });
        } finally {
            URL.revokeObjectURL(objectUrl);
            if (this.activeAudio === audio) {
                this.activeAudio = null;
            }
        }
    }
}

export const LocalRealtimeVoiceSession: React.FC = () => {
    const hasRegistered = useRef(false);
    const sessionRef = useRef<LocalRealtimeVoiceSessionImpl | null>(null);

    useEffect(() => {
        if (!hasRegistered.current) {
            sessionRef.current = new LocalRealtimeVoiceSessionImpl();
            registerVoiceSession(sessionRef.current);
            hasRegistered.current = true;
        }
        return () => {
            void sessionRef.current?.endSession();
        };
    }, []);

    return null;
};
