import React from 'react';
import { config } from '@/config';
import { LocalRealtimeVoiceSession } from './LocalRealtimeVoiceSession.web';
import { RealtimeVoiceSession } from './RealtimeVoiceSession';
import { useVoiceSessionGeneration } from '@/sync/storage';

export const RealtimeProvider = ({ children }: { children: React.ReactNode }) => {
    // Web SDK (@elevenlabs/react) uses a plain WebSocket — no LiveKit Room to
    // go stale — so this re-key is mostly defensive. Kept symmetric with native.
    const generation = useVoiceSessionGeneration();
    const VoiceSessionComponent = config.localVoiceEnabled ? LocalRealtimeVoiceSession : RealtimeVoiceSession;
    return (
        <>
            <VoiceSessionComponent key={generation} />
            {children}
        </>
    );
};
