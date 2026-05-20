/**
 * Persistent device-local config for the direct-browser local voice path.
 * Uses its own MMKV instance so it survives logouts and is independent of
 * synced settings (which require auth) and EXPO_PUBLIC_* env vars (which
 * require a build).
 *
 * Priority for each value (highest → lowest):
 *  1. This MMKV store (set by the user in Settings → Voice → Direct Endpoints)
 *  2. __HAPPY_CONFIG__ runtime global  (set by the web host at deploy time)
 *  3. EXPO_PUBLIC_* env vars           (baked at build time)
 *  4. Hardcoded localhost defaults
 */

import { MMKV } from 'react-native-mmkv';

const store = new MMKV({ id: 'local-voice-config' });

// ─── keys ──────────────────────────────────────────────────────────────────

const KEY_LLM_URL      = 'llm-url';
const KEY_LLM_API_KEY  = 'llm-api-key';
const KEY_LLM_MODEL    = 'llm-model';
const KEY_ASR_URL      = 'asr-url';
const KEY_ASR_API_KEY  = 'asr-api-key';

// ─── helpers ───────────────────────────────────────────────────────────────

function get(key: string): string | null {
    return store.getString(key) ?? null;
}

function set(key: string, value: string | null): void {
    if (value?.trim()) {
        store.set(key, value.trim());
    } else {
        store.delete(key);
    }
}

// ─── LLM (chat/narration) ──────────────────────────────────────────────────

/**
 * Base URL for /chat/completions (and /audio/speech when no separate TTS URL
 * has been configured and the openai provider is selected).
 * Example: http://127.0.0.1:12434/v1
 */
export function getLocalVoiceLlmUrl(): string | null  { return get(KEY_LLM_URL);     }
export function setLocalVoiceLlmUrl(v: string | null): void { set(KEY_LLM_URL, v);  }

/** Optional Bearer token for the LLM endpoint. */
export function getLocalVoiceLlmApiKey(): string | null  { return get(KEY_LLM_API_KEY);     }
export function setLocalVoiceLlmApiKey(v: string | null): void { set(KEY_LLM_API_KEY, v);  }

/** Model name passed in the /chat/completions body. */
export function getLocalVoiceLlmModel(): string | null  { return get(KEY_LLM_MODEL);     }
export function setLocalVoiceLlmModel(v: string | null): void { set(KEY_LLM_MODEL, v);  }

// ─── ASR (speech-to-text) ──────────────────────────────────────────────────

/**
 * Base URL for /audio/transcriptions.
 * Falls back to the LLM URL when not set.
 * Example: http://127.0.0.1:5092/v1
 */
export function getLocalVoiceAsrUrl(): string | null  { return get(KEY_ASR_URL);     }
export function setLocalVoiceAsrUrl(v: string | null): void { set(KEY_ASR_URL, v);  }

/** Optional Bearer token for the ASR endpoint. Falls back to the LLM key. */
export function getLocalVoiceAsrApiKey(): string | null  { return get(KEY_ASR_API_KEY);     }
export function setLocalVoiceAsrApiKey(v: string | null): void { set(KEY_ASR_API_KEY, v);  }

// ─── snapshot (for UI display) ─────────────────────────────────────────────

export interface LocalVoiceConfigSnapshot {
    llmUrl:     string | null;
    llmApiKey:  string | null;
    llmModel:   string | null;
    asrUrl:     string | null;
    asrApiKey:  string | null;
}

export function getLocalVoiceConfigSnapshot(): LocalVoiceConfigSnapshot {
    return {
        llmUrl:    getLocalVoiceLlmUrl(),
        llmApiKey: getLocalVoiceLlmApiKey(),
        llmModel:  getLocalVoiceLlmModel(),
        asrUrl:    getLocalVoiceAsrUrl(),
        asrApiKey: getLocalVoiceAsrApiKey(),
    };
}
