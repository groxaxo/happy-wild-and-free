import { describe, expect, it } from 'vitest';
import { extractPermissionDecision, findPendingPermissionRequest } from './localVoiceRouting';

describe('extractPermissionDecision', () => {
    it('detects allow phrases', () => {
        expect(extractPermissionDecision('Yeah, go ahead and allow that')).toBe('allow');
    });

    it('detects deny phrases', () => {
        expect(extractPermissionDecision("No, don't allow that")).toBe('deny');
    });

    it('returns null for ambiguous input', () => {
        expect(extractPermissionDecision('allow it or deny it')).toBeNull();
    });
});

describe('findPendingPermissionRequest', () => {
    it('prefers the focused session when it has a request', () => {
        expect(findPendingPermissionRequest({
            alpha: { agentState: { requests: { reqA: {} } } },
            beta: { agentState: { requests: { reqB: {} } } },
        }, 'beta')).toEqual({ sessionId: 'beta', requestId: 'reqB' });
    });

    it('returns the only pending request across sessions', () => {
        expect(findPendingPermissionRequest({
            alpha: { agentState: { requests: {} } },
            beta: { agentState: { requests: { reqB: {} } } },
        }, 'alpha')).toEqual({ sessionId: 'beta', requestId: 'reqB' });
    });

    it('returns null when multiple sessions have pending requests and none is preferred', () => {
        expect(findPendingPermissionRequest({
            alpha: { agentState: { requests: { reqA: {} } } },
            beta: { agentState: { requests: { reqB: {} } } },
        }, null)).toBeNull();
    });
});
