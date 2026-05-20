import React, { useEffect, useRef } from 'react';
import { Modal } from '@/modal';
import { t } from '@/text';
import { storage } from '@/sync/storage';
import {
    fetchLocalVoiceAssistantResponse,
    synthesizeLocalVoiceSpeech,
    transcribeLocalVoiceAudio,
} from '@/sync/apiVoice';
import { getCurrentRealtimeSessionId, registerVoiceSession } from './RealtimeSession';
import { realtimeClientTools } from './realtimeClientTools';
import type { VoiceSession, VoiceSessionConfig } from './types';
import { extractPermissionDecision, findPendingPermissionRequest } from './localVoiceRouting';
import type { VoiceAsrProvider } from '@slopus/happy-wire';

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
        webkitAudioContext?: typeof AudioContext;
    }
}

const LOCAL_NARRATION_SYSTEM_PROMPT = [
    'You are Huppie\'s local narration voice for the user\'s coding session.',
    'The coding work itself is performed by the coding session, not by you.',
    'You only narrate already-decided events and confirmations.',
    'Rules:',
    '- Speak in one short sentence.',
    '- Never mention internal session ids, request ids, or opaque labels.',
    '- Never invent work, file names, commands, or outcomes.',
    '- If the update is a permission request, clearly ask whether to allow or deny it.',
    '- If the update is a forwarding acknowledgement, briefly confirm it was sent.',
].join('\n');

const LOCAL_ASR_MIME_TYPES = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
];
const LOCAL_ASR_TIMESLICE_MS = 250;
const LOCAL_ASR_PREROLL_MS = 750;
const LOCAL_ASR_SILENCE_MS = 900;
const LOCAL_ASR_MIN_UTTERANCE_MS = 350;
const LOCAL_ASR_RMS_THRESHOLD = 0.025;

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

function getBestLocalAsrMimeType(): string | undefined {
    if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
        return undefined;
    }

    return LOCAL_ASR_MIME_TYPES.find((mimeType) => MediaRecorder.isTypeSupported(mimeType));
}

function getAudioContextConstructor(): typeof AudioContext | null {
    if (typeof window === 'undefined') {
        return null;
    }
    return window.AudioContext ?? window.webkitAudioContext ?? null;
}

function canUseLocalAsr(): boolean {
    return typeof navigator !== 'undefined'
        && !!navigator.mediaDevices?.getUserMedia
        && typeof MediaRecorder !== 'undefined'
        && !!getAudioContextConstructor();
}

class LocalRealtimeVoiceSessionImpl implements VoiceSession {
    private recognition: SpeechRecognitionLike | null = null;
    private inputProvider: VoiceAsrProvider = 'browser';
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
    private mediaStream: MediaStream | null = null;
    private mediaRecorder: MediaRecorder | null = null;
    private audioContext: AudioContext | null = null;
    private analyser: AnalyserNode | null = null;
    private vadFrame: number | null = null;
    private localAsrActive = false;
    private localAsrSpeechActive = false;
    private localAsrSilenceStartedAt: number | null = null;
    private localAsrSpeechStartedAt = 0;
    private localAsrChunks: Blob[] = [];
    private localAsrPreRoll: Array<{ blob: Blob; at: number }> = [];

    async startSession(config: VoiceSessionConfig): Promise<string | null> {
        await this.endSession();

        this.inputProvider = storage.getState().localSettings.voiceAsrProvider;
        if (this.inputProvider === 'browser' && !getSpeechRecognitionConstructor()) {
            throw new Error('Speech recognition is not available in this browser');
        }
        if (this.inputProvider === 'local' && !canUseLocalAsr()) {
            throw new Error('Local speech recognition is not available in this browser');
        }

        this.sessionActive = true;
        this.restartRecognition = true;
        this.conversationId = crypto.randomUUID();
        this.focusedSessionId = config.sessionId;
        this.initialContext = config.initialContext?.trim() ? compactText(config.initialContext, 4000) : null;
        this.contextualUpdates = [];

        if (this.inputProvider === 'local') {
            await this.ensureLocalAsr();
        } else {
            this.ensureRecognition();
        }
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

        this.stopBrowserRecognition();
        this.stopLocalAsr(true);

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
        recognition.lang = storage.getState().settings.voiceAssistantLanguage ?? 'en-US';

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
        if (this.inputProvider === 'local') {
            if (delayMs > 0) {
                window.setTimeout(() => this.startLocalAsr(), delayMs);
                return;
            }
            this.startLocalAsr();
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
        if (this.inputProvider === 'local') {
            this.stopLocalAsr(false);
            return;
        }
        this.stopBrowserRecognition();
    }

    private stopBrowserRecognition(): void {
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

    private async ensureLocalAsr(): Promise<void> {
        if (this.mediaRecorder && this.analyser) {
            return;
        }

        const AudioContextConstructor = getAudioContextConstructor();
        if (!AudioContextConstructor || !navigator.mediaDevices?.getUserMedia) {
            throw new Error('Local speech recognition is not available in this browser');
        }

        const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
            },
        });
        const audioContext = new AudioContextConstructor();
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0.2;

        const source = audioContext.createMediaStreamSource(stream);
        source.connect(analyser);

        const mimeType = getBestLocalAsrMimeType();
        const mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        mediaRecorder.ondataavailable = (event) => this.handleLocalAsrData(event.data);
        mediaRecorder.onerror = (event) => {
            console.warn('Local ASR recorder error:', event);
            storage.getState().setRealtimeStatus('error');
            storage.getState().setRealtimeMode('idle', true);
        };

        this.mediaStream = stream;
        this.audioContext = audioContext;
        this.analyser = analyser;
        this.mediaRecorder = mediaRecorder;
    }

    private startLocalAsr(): void {
        if (this.inputProvider !== 'local' || !this.sessionActive || !this.restartRecognition || this.processingTurn || this.activeAudio) {
            return;
        }
        if (!this.mediaRecorder || !this.analyser || this.localAsrActive) {
            return;
        }

        void this.audioContext?.resume().catch((error) => {
            console.warn('Failed to resume local ASR audio context:', error);
        });

        this.localAsrActive = true;
        this.localAsrSpeechActive = false;
        this.localAsrSilenceStartedAt = null;
        this.localAsrSpeechStartedAt = 0;
        this.localAsrChunks = [];
        this.localAsrPreRoll = [];

        try {
            if (this.mediaRecorder.state === 'inactive') {
                this.mediaRecorder.start(LOCAL_ASR_TIMESLICE_MS);
            }
        } catch (error) {
            this.localAsrActive = false;
            console.warn('Failed to start local ASR recorder:', error);
            storage.getState().setRealtimeStatus('error');
            return;
        }

        this.pollLocalAsrVad();
    }

    private stopLocalAsr(release: boolean): void {
        this.localAsrActive = false;
        this.localAsrSpeechActive = false;
        this.localAsrSilenceStartedAt = null;
        this.localAsrSpeechStartedAt = 0;
        this.localAsrChunks = [];
        this.localAsrPreRoll = [];

        if (this.vadFrame !== null) {
            window.cancelAnimationFrame(this.vadFrame);
            this.vadFrame = null;
        }

        if (this.mediaRecorder?.state === 'recording') {
            try {
                this.mediaRecorder.stop();
            } catch {
                // Ignore shutdown races from MediaRecorder.
            }
        }

        if (!release) {
            return;
        }

        if (this.mediaRecorder) {
            this.mediaRecorder.ondataavailable = null;
            this.mediaRecorder.onerror = null;
            this.mediaRecorder = null;
        }
        if (this.mediaStream) {
            for (const track of this.mediaStream.getTracks()) {
                track.stop();
            }
            this.mediaStream = null;
        }
        if (this.audioContext) {
            void this.audioContext.close().catch(() => undefined);
            this.audioContext = null;
        }
        this.analyser = null;
    }

    private handleLocalAsrData(blob: Blob): void {
        if (!this.localAsrActive || blob.size === 0) {
            return;
        }

        if (this.localAsrSpeechActive) {
            this.localAsrChunks.push(blob);
            return;
        }

        const now = Date.now();
        this.localAsrPreRoll.push({ blob, at: now });
        this.localAsrPreRoll = this.localAsrPreRoll.filter((entry) => now - entry.at <= LOCAL_ASR_PREROLL_MS);
    }

    private pollLocalAsrVad(): void {
        if (!this.localAsrActive || !this.sessionActive || this.processingTurn || this.activeAudio || !this.analyser) {
            return;
        }

        const samples = new Uint8Array(this.analyser.fftSize);
        this.analyser.getByteTimeDomainData(samples);

        let sumSquares = 0;
        for (const sample of samples) {
            const normalized = (sample - 128) / 128;
            sumSquares += normalized * normalized;
        }
        const rms = Math.sqrt(sumSquares / samples.length);
        const now = Date.now();

        if (rms >= LOCAL_ASR_RMS_THRESHOLD) {
            if (!this.localAsrSpeechActive) {
                this.startLocalAsrSpeech(now);
            }
            this.localAsrSilenceStartedAt = null;
            storage.getState().setRealtimeMode('user-speaking', true);
        } else if (this.localAsrSpeechActive) {
            this.localAsrSilenceStartedAt ??= now;
            if (now - this.localAsrSilenceStartedAt >= LOCAL_ASR_SILENCE_MS) {
                this.finishLocalAsrSpeech(now);
            } else {
                storage.getState().setRealtimeMode('user-speaking', true);
            }
        } else {
            storage.getState().setRealtimeMode('idle');
        }

        if (this.localAsrActive) {
            this.vadFrame = window.requestAnimationFrame(() => this.pollLocalAsrVad());
        }
    }

    private startLocalAsrSpeech(now: number): void {
        this.localAsrSpeechActive = true;
        this.localAsrSilenceStartedAt = null;
        this.localAsrSpeechStartedAt = now;
        this.localAsrChunks = this.localAsrPreRoll.map((entry) => entry.blob);
        this.localAsrPreRoll = [];
    }

    private finishLocalAsrSpeech(now: number): void {
        const durationMs = now - this.localAsrSpeechStartedAt;
        const chunks = this.localAsrChunks;
        const mimeType = this.mediaRecorder?.mimeType || getBestLocalAsrMimeType() || 'audio/webm';

        this.localAsrSpeechActive = false;
        this.localAsrSilenceStartedAt = null;
        this.localAsrSpeechStartedAt = 0;
        this.localAsrChunks = [];
        this.localAsrPreRoll = [];
        storage.getState().setRealtimeMode('idle');

        if (durationMs < LOCAL_ASR_MIN_UTTERANCE_MS || chunks.length === 0) {
            return;
        }

        const audioBlob = new Blob(chunks, { type: mimeType });
        this.stopLocalAsr(false);
        this.enqueueWork(() => this.runLocalAsrTurn(audioBlob));
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

    private async runLocalAsrTurn(audioBlob: Blob): Promise<void> {
        const { voiceAssistantLanguage } = storage.getState().settings;
        const response = await transcribeLocalVoiceAudio(audioBlob, {
            language: voiceAssistantLanguage,
        });
        const transcript = response.text.trim();
        if (!transcript) {
            return;
        }

        await this.runUserTurn(transcript);
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

        const response = await fetchLocalVoiceAssistantResponse({
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

        storage.getState().setRealtimeMode('agent-speaking', true);

        const { voiceAssistantLanguage } = storage.getState().settings;
        const { voiceTtsProvider } = storage.getState().localSettings;
        const blob = await synthesizeLocalVoiceSpeech(trimmed, {
            provider: voiceTtsProvider,
            language: voiceAssistantLanguage,
        });
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
