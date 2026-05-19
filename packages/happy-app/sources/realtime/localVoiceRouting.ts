export type VoicePermissionDecision = 'allow' | 'deny';

interface SessionLike {
    agentState?: {
        requests?: Record<string, unknown> | null;
    } | null;
}

export interface PendingVoicePermissionRequest {
    sessionId: string;
    requestId: string;
}

function normalizeTranscript(input: string): string {
    return input
        .toLowerCase()
        .replace(/[^a-z0-9\s']/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

const ALLOW_PATTERNS = [
    /\ballow\b/,
    /\bapprove\b/,
    /\bapproved\b/,
    /\byes\b/,
    /\byeah\b/,
    /\byep\b/,
    /\bgo ahead\b/,
    /\bdo it\b/,
    /\baccept\b/,
];

const DENY_PATTERNS = [
    /\bdeny\b/,
    /\breject\b/,
    /\bdecline\b/,
    /\bblock\b/,
    /\bno\b/,
    /\bnope\b/,
    /\bdon't allow\b/,
    /\bdont allow\b/,
    /\bdo not allow\b/,
];

export function extractPermissionDecision(input: string): VoicePermissionDecision | null {
    const normalized = normalizeTranscript(input);
    if (!normalized) {
        return null;
    }

    if (
        normalized.includes("don't allow")
        || normalized.includes('dont allow')
        || normalized.includes('do not allow')
    ) {
        return 'deny';
    }

    const hasAllow = ALLOW_PATTERNS.some((pattern) => pattern.test(normalized));
    const hasDeny = DENY_PATTERNS.some((pattern) => pattern.test(normalized));

    if (hasAllow === hasDeny) {
        return null;
    }

    return hasAllow ? 'allow' : 'deny';
}

export function findPendingPermissionRequest(
    sessions: Record<string, SessionLike>,
    preferredSessionId?: string | null,
): PendingVoicePermissionRequest | null {
    const pickFirstRequest = (sessionId: string): PendingVoicePermissionRequest | null => {
        const requests = sessions[sessionId]?.agentState?.requests;
        const requestId = requests ? Object.keys(requests)[0] : undefined;
        return requestId ? { sessionId, requestId } : null;
    };

    if (preferredSessionId) {
        const preferred = pickFirstRequest(preferredSessionId);
        if (preferred) {
            return preferred;
        }
    }

    const pending: PendingVoicePermissionRequest[] = [];
    for (const [sessionId, session] of Object.entries(sessions)) {
        for (const requestId of Object.keys(session.agentState?.requests ?? {})) {
            pending.push({ sessionId, requestId });
        }
    }

    return pending.length === 1 ? pending[0] : null;
}
