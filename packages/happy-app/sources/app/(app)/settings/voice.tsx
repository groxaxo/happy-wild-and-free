import React from 'react';
import { View, ActivityIndicator } from 'react-native';
import { Text } from '@/components/StyledText';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Switch } from '@/components/Switch';
import { UsageBar } from '@/components/usage/UsageBar';
import { useSettingMutable, useEntitlement, useLocalSetting, useLocalSettingMutable, useSetting } from '@/sync/storage';
import { useAuth } from '@/auth/AuthContext';
import { findLanguageByCode, getLanguageDisplayName, LANGUAGES } from '@/constants/Languages';
import { fetchVoiceUsage, type VoiceUsageResponse } from '@/sync/apiVoice';
import { t } from '@/text';
import { Modal } from '@/modal';
import { sync } from '@/sync/sync';
import { trackPaywallButtonClicked } from '@/track';
import { getVoiceExperimentStatus, getVoiceUpsellVariantLabel } from '@/realtime/voiceExperiment';
import { getVoiceLocalCounters, resetVoiceLocalCounters } from '@/sync/persistence';
import { config } from '@/config';
import {
    getLocalVoiceConfigSnapshot,
    setLocalVoiceLlmUrl,
    setLocalVoiceLlmApiKey,
    setLocalVoiceLlmModel,
    setLocalVoiceAsrUrl,
    setLocalVoiceAsrApiKey,
    type LocalVoiceConfigSnapshot,
} from '@/sync/localVoiceConfig';
import type { VoiceAsrProvider, VoiceSpeechProvider } from '@slopus/happy-wire';

const VOICE_TTS_PROVIDER_LABELS: Record<VoiceSpeechProvider, string> = {
    openai: 'OpenAI-compatible',
    xai: 'xAI Grok',
    chatterbox_multilingual: 'Chatterbox (local)',
    neutts: 'NeuTTS (local)',
};

const VOICE_ASR_PROVIDER_LABELS: Record<VoiceAsrProvider, string> = {
    browser: 'Browser Speech Recognition',
    local: 'Local ASR',
};

function formatVoiceTime(totalSeconds: number): string {
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins}m ${secs}s`;
}

export default React.memo(function VoiceSettingsScreen() {
    const router = useRouter();
    const auth = useAuth();
    const [voiceAssistantLanguage] = useSettingMutable('voiceAssistantLanguage');
    const [voiceCustomAgentId, setVoiceCustomAgentId] = useSettingMutable('voiceCustomAgentId');
    const [voiceBypassToken, setVoiceBypassToken] = useSettingMutable('voiceBypassToken');
    const [voiceUpsellOverride, setVoiceUpsellOverride] = useLocalSettingMutable('voiceUpsellOverride');
    const [voiceAsrProvider, setVoiceAsrProvider] = useLocalSettingMutable('voiceAsrProvider');
    const [voiceTtsProvider, setVoiceTtsProvider] = useLocalSettingMutable('voiceTtsProvider');
    const experiments = useSetting('experiments');
    const devModeEnabled = __DEV__ || useLocalSetting('devModeEnabled');
    const localVoiceEnabled = config.localVoiceEnabled ?? false;

    const [endpointConfig, setEndpointConfig] = React.useState<LocalVoiceConfigSnapshot>(
        () => getLocalVoiceConfigSnapshot()
    );

    const hasPro = useEntitlement('pro');

    const [usage, setUsage] = React.useState<VoiceUsageResponse | null>(null);
    const [usageLoading, setUsageLoading] = React.useState(true);
    const [voiceLocalCounters, setVoiceLocalCounters] = React.useState(() => getVoiceLocalCounters());

    React.useEffect(() => {
        if (localVoiceEnabled) {
            setUsageLoading(false);
            return;
        }
        if (!auth.credentials) return;
        fetchVoiceUsage(auth.credentials)
            .then(setUsage)
            .catch(() => {})
            .finally(() => setUsageLoading(false));
    }, [auth.credentials, localVoiceEnabled]);

    // Find current language or default to first option
    const currentLanguage = findLanguageByCode(voiceAssistantLanguage) || LANGUAGES[0];

    const handleSupportUs = React.useCallback(async () => {
        trackPaywallButtonClicked('voluntary_support');
        await sync.presentPaywall('voluntary_support');
    }, []);

    const handleCustomAgentId = React.useCallback(async () => {
        const value = await Modal.prompt(
            t('settingsVoice.customAgentId'),
            t('settingsVoice.customAgentIdDescription'),
            {
                defaultValue: voiceCustomAgentId ?? '',
                placeholder: t('settingsVoice.customAgentIdPlaceholder'),
            }
        );
        if (value !== null) {
            const trimmed = value.trim() || null;
            setVoiceCustomAgentId(trimmed);
            // Auto-toggle bypass when setting/clearing agent ID
            setVoiceBypassToken(trimmed !== null);
        }
    }, [voiceCustomAgentId, setVoiceCustomAgentId, setVoiceBypassToken]);

    const handleVoiceExperimentOverride = React.useCallback(() => {
        Modal.alert(
            'Voice Experiment Override',
            'Select a local override for the voice-upsell experiment.',
            [
                { text: 'No Override', onPress: () => setVoiceUpsellOverride(null) },
                { text: 'Control', onPress: () => setVoiceUpsellOverride('control') },
                { text: 'Soft Paywall', onPress: () => setVoiceUpsellOverride('show-paywall-before-first-voice-chat') },
                { text: 'Onboarding + Upsell', onPress: () => setVoiceUpsellOverride('voice-onboarding-and-upsell') },
            ],
        );
    }, [setVoiceUpsellOverride]);

    const handleVoiceAsrProvider = React.useCallback(() => {
        Modal.alert(
            'Input Provider',
            'Choose the speech-to-text provider used for local web voice input.',
            [
                { text: VOICE_ASR_PROVIDER_LABELS.local, onPress: () => setVoiceAsrProvider('local') },
                { text: VOICE_ASR_PROVIDER_LABELS.browser, onPress: () => setVoiceAsrProvider('browser') },
                { text: t('common.cancel'), style: 'cancel' },
            ],
        );
    }, [setVoiceAsrProvider]);

    const handleVoiceTtsProvider = React.useCallback(() => {
        Modal.alert(
            'Speech Provider',
            'Choose the text-to-speech backend for local web voice playback. OpenAI-compatible, Chatterbox, and NeuTTS use /audio/speech; xAI uses its own /tts API.',
            [
                { text: VOICE_TTS_PROVIDER_LABELS.openai, onPress: () => setVoiceTtsProvider('openai') },
                { text: VOICE_TTS_PROVIDER_LABELS.xai, onPress: () => setVoiceTtsProvider('xai') },
                { text: VOICE_TTS_PROVIDER_LABELS.chatterbox_multilingual, onPress: () => setVoiceTtsProvider('chatterbox_multilingual') },
                { text: VOICE_TTS_PROVIDER_LABELS.neutts, onPress: () => setVoiceTtsProvider('neutts') },
                { text: t('common.cancel'), style: 'cancel' },
            ],
        );
    }, [setVoiceTtsProvider]);

    const handleEditLlmUrl = React.useCallback(async () => {
        const value = await Modal.prompt(
            'LLM Base URL',
            'OpenAI-compatible base URL used for chat completions (and TTS/ASR when no separate URL is set).\nExample: http://127.0.0.1:12434/v1',
            { defaultValue: endpointConfig.llmUrl ?? '', placeholder: 'http://127.0.0.1:12434/v1' },
        );
        if (value !== null) {
            setLocalVoiceLlmUrl(value || null);
            setEndpointConfig(getLocalVoiceConfigSnapshot());
        }
    }, [endpointConfig.llmUrl]);

    const handleEditLlmApiKey = React.useCallback(async () => {
        const value = await Modal.prompt(
            'LLM API Key',
            'Optional Bearer token for the LLM endpoint. Leave blank if the server requires no auth.',
            { defaultValue: endpointConfig.llmApiKey ?? '', placeholder: 'sk-…' },
        );
        if (value !== null) {
            setLocalVoiceLlmApiKey(value || null);
            setEndpointConfig(getLocalVoiceConfigSnapshot());
        }
    }, [endpointConfig.llmApiKey]);

    const handleEditLlmModel = React.useCallback(async () => {
        const value = await Modal.prompt(
            'LLM Model',
            'Model name sent in the /chat/completions body.',
            { defaultValue: endpointConfig.llmModel ?? '', placeholder: 'qwen2.5-14b-instruct' },
        );
        if (value !== null) {
            setLocalVoiceLlmModel(value || null);
            setEndpointConfig(getLocalVoiceConfigSnapshot());
        }
    }, [endpointConfig.llmModel]);

    const handleEditAsrUrl = React.useCallback(async () => {
        const value = await Modal.prompt(
            'ASR Base URL',
            'Base URL for /audio/transcriptions. Leave blank to share the LLM URL.',
            { defaultValue: endpointConfig.asrUrl ?? '', placeholder: 'http://127.0.0.1:5092/v1' },
        );
        if (value !== null) {
            setLocalVoiceAsrUrl(value || null);
            setEndpointConfig(getLocalVoiceConfigSnapshot());
        }
    }, [endpointConfig.asrUrl]);

    const handleEditAsrApiKey = React.useCallback(async () => {
        const value = await Modal.prompt(
            'ASR API Key',
            'Optional Bearer token for the ASR endpoint. Leave blank to share the LLM key.',
            { defaultValue: endpointConfig.asrApiKey ?? '', placeholder: 'sk-…' },
        );
        if (value !== null) {
            setLocalVoiceAsrApiKey(value || null);
            setEndpointConfig(getLocalVoiceConfigSnapshot());
        }
    }, [endpointConfig.asrApiKey]);

    const handleResetVoiceCounters = React.useCallback(async () => {
        const confirmed = await Modal.confirm(
            'Reset Voice Counters',
            'Clear local voice counters used for onboarding and soft-paywall behavior on this device?',
            {
                confirmText: 'Reset',
                destructive: true,
            },
        );
        if (!confirmed) {
            return;
        }

        resetVoiceLocalCounters();
        setVoiceLocalCounters(getVoiceLocalCounters());
    }, []);

    const voiceExperimentStatus = React.useMemo(() => {
        return getVoiceExperimentStatus({
            voiceBypassToken,
            voiceCustomAgentId,
            voiceUpsellOverride,
            voiceUpsellOverrideEnabled: devModeEnabled,
        });
    }, [devModeEnabled, voiceBypassToken, voiceCustomAgentId, voiceUpsellOverride]);

    const developerExperimentSubtitle = React.useMemo(() => {
        const upsellVariant = getVoiceUpsellVariantLabel(voiceExperimentStatus.upsellVariant);
        const gatingMode = voiceExperimentStatus.gatingMode === 'direct-byo-agent'
            ? 'direct BYO agent bypass'
            : 'Huppie server gate';

        return [
            `voice-upsell: ${upsellVariant}`,
            `source: ${voiceExperimentStatus.upsellVariantSource}`,
            `gate: ${gatingMode}`,
            `experiments setting: ${experiments ? 'on' : 'off'}`,
        ].join('\n');
    }, [experiments, voiceExperimentStatus]);

    const developerOverrideLabel = React.useMemo(() => {
        if (!voiceUpsellOverride) {
            return 'No Override';
        }
        return getVoiceUpsellVariantLabel(voiceUpsellOverride);
    }, [voiceUpsellOverride]);

    const developerCountersSubtitle = React.useMemo(() => {
        return [
            `soft paywall shown: ${voiceLocalCounters.softPaywallShownCount}`,
            `onboarding prompt loads: ${voiceLocalCounters.onboardingPromptLoadCount}`,
            `voice messages: ${voiceLocalCounters.voiceMessageCount}`,
        ].join('\n');
    }, [voiceLocalCounters]);

    return (
        <ItemList style={{ paddingTop: 0 }}>
            {/* Voice Usage */}
            {!localVoiceEnabled && usageLoading ? (
                <View style={{ paddingVertical: 24, alignItems: 'center' }}>
                    <ActivityIndicator />
                </View>
            ) : !localVoiceEnabled && usage ? (
                <ItemGroup
                    title={t('settingsVoice.usageTitle')}
                    footer={t('settingsVoice.usageFooter')}
                >
                    <View style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
                        <UsageBar
                            label={t('settingsVoice.usageLabel')}
                            value={usage.usedSeconds}
                            maxValue={usage.limitSeconds}
                            color={usage.usedSeconds >= usage.limitSeconds ? '#FF3B30' : '#007AFF'}
                        />
                        <Text style={{ fontSize: 13, color: '#8E8E93', marginTop: 4 }}>
                            {formatVoiceTime(usage.usedSeconds)} / {formatVoiceTime(usage.limitSeconds)}
                        </Text>
                        <UsageBar
                            label={t('settingsVoice.conversationsLabel')}
                            value={usage.conversationCount}
                            maxValue={usage.conversationLimit}
                            color={usage.conversationCount >= usage.conversationLimit ? '#FF3B30' : '#007AFF'}
                        />
                        <Text style={{ fontSize: 13, color: '#8E8E93', marginTop: 4 }}>
                            {usage.conversationCount} / {usage.conversationLimit}
                        </Text>
                    </View>
                </ItemGroup>
            ) : null}

            {/* Support / Upgrade */}
            {!hasPro && (
                <ItemGroup>
                    <Item
                        title={t('settingsVoice.supportTitle')}
                        subtitle={t('settingsVoice.supportSubtitle')}
                        icon={<Ionicons name="heart-outline" size={29} color="#FF2D55" />}
                        onPress={handleSupportUs}
                    />
                </ItemGroup>
            )}

            {devModeEnabled && (
                <ItemGroup
                    title="Developer"
                    footer="Developer-only diagnostics and local override controls for the current voice rollout. The paid voice gate runs through Huppie server unless Direct Connection and a custom ElevenLabs agent are both enabled."
                >
                    <Item
                        title="Voice Experiment Override"
                        subtitle="Simple local override for the voice-upsell flag"
                        detail={developerOverrideLabel}
                        icon={<Ionicons name="options-outline" size={29} color="#007AFF" />}
                        onPress={handleVoiceExperimentOverride}
                    />
                    <Item
                        title="Voice Experiment Status"
                        subtitle={developerExperimentSubtitle}
                        subtitleLines={0}
                        icon={<Ionicons name="flask-outline" size={29} color="#5856D6" />}
                        showChevron={false}
                        copy={developerExperimentSubtitle}
                    />
                    <Item
                        title="Reset Voice Counters"
                        subtitle={developerCountersSubtitle}
                        subtitleLines={0}
                        icon={<Ionicons name="refresh-outline" size={29} color="#FF9500" />}
                        onPress={handleResetVoiceCounters}
                    />
                </ItemGroup>
            )}

            {localVoiceEnabled && (
                <ItemGroup
                    title="Local Speech"
                    footer="Local web voice connects directly from the browser to your configured STT, TTS, and LLM endpoints. Huppie auth and the Huppie server are not required for this path."
                >
                    <Item
                        title="Input Provider"
                        subtitle="Choose the local speech-to-text backend"
                        detail={VOICE_ASR_PROVIDER_LABELS[voiceAsrProvider]}
                        icon={<Ionicons name="mic-outline" size={29} color="#007AFF" />}
                        onPress={handleVoiceAsrProvider}
                    />
                    <Item
                        title="Speech Provider"
                        subtitle="Text-to-speech backend for local web voice playback"
                        detail={VOICE_TTS_PROVIDER_LABELS[voiceTtsProvider] ?? voiceTtsProvider}
                        icon={<Ionicons name="volume-high-outline" size={29} color="#34C759" />}
                        onPress={handleVoiceTtsProvider}
                    />
                </ItemGroup>
            )}

            {localVoiceEnabled && (
                <ItemGroup
                    title="Direct Endpoints"
                    footer="Set per-device LLM and ASR overrides for local web voice. The LLM URL also drives the OpenAI-compatible TTS provider when no separate EXPO_PUBLIC_OPENAI_API_BASE_URL is configured. xAI, Chatterbox, and NeuTTS use their own built-in defaults. Blank = fall back to env var or built-in default."
                >
                    <Item
                        title="LLM URL"
                        subtitle="Base URL for chat completions and OpenAI-compatible TTS"
                        detail={endpointConfig.llmUrl ?? 'env / default'}
                        icon={<Ionicons name="globe-outline" size={29} color="#007AFF" />}
                        onPress={handleEditLlmUrl}
                    />
                    <Item
                        title="LLM API Key"
                        subtitle="Bearer token for the LLM and OpenAI-compatible TTS endpoint"
                        detail={endpointConfig.llmApiKey ? '••••••••' : 'env / none'}
                        icon={<Ionicons name="key-outline" size={29} color="#FF9500" />}
                        onPress={handleEditLlmApiKey}
                    />
                    <Item
                        title="LLM Model"
                        subtitle="Model name sent in /chat/completions"
                        detail={endpointConfig.llmModel ?? 'env / default'}
                        icon={<Ionicons name="hardware-chip-outline" size={29} color="#5856D6" />}
                        onPress={handleEditLlmModel}
                    />
                    <Item
                        title="ASR URL"
                        subtitle="Base URL for /audio/transcriptions — blank = LLM URL"
                        detail={endpointConfig.asrUrl ?? 'same as LLM'}
                        icon={<Ionicons name="mic-circle-outline" size={29} color="#34C759" />}
                        onPress={handleEditAsrUrl}
                    />
                    <Item
                        title="ASR API Key"
                        subtitle="Bearer token for the ASR endpoint — blank = LLM key"
                        detail={endpointConfig.asrApiKey ? '••••••••' : 'same as LLM'}
                        icon={<Ionicons name="lock-closed-outline" size={29} color="#FF2D55" />}
                        onPress={handleEditAsrApiKey}
                    />
                </ItemGroup>
            )}

            {/* Language Settings */}
            <ItemGroup
                title={t('settingsVoice.languageTitle')}
                footer={t('settingsVoice.languageDescription')}
            >
                <Item
                    title={t('settingsVoice.preferredLanguage')}
                    subtitle={t('settingsVoice.preferredLanguageSubtitle')}
                    icon={<Ionicons name="language-outline" size={29} color="#007AFF" />}
                    detail={getLanguageDisplayName(currentLanguage)}
                    onPress={() => router.push('/settings/voice/language')}
                />
            </ItemGroup>

            {/* Bring Your Own Agent */}
            <ItemGroup
                title={t('settingsVoice.byoTitle')}
                footer={t('settingsVoice.byoDescription')}
            >
                <Item
                    title={t('settingsVoice.customAgentId')}
                    subtitle={voiceCustomAgentId ?? t('settingsVoice.customAgentIdNotSet')}
                    icon={<Ionicons name="key-outline" size={29} color="#FF9500" />}
                    onPress={handleCustomAgentId}
                />
                <Item
                    title={t('settingsVoice.bypassToken')}
                    subtitle={t('settingsVoice.bypassTokenSubtitle')}
                    icon={<Ionicons name="flash-outline" size={29} color="#FF3B30" />}
                    rightElement={
                        <Switch
                            value={voiceBypassToken}
                            onValueChange={setVoiceBypassToken}
                        />
                    }
                />
            </ItemGroup>

            {/* Prompt Guide — shown when custom agent is configured */}
            {voiceCustomAgentId && (
                <ItemGroup
                    title={t('settingsVoice.promptGuideTitle')}
                    footer={t('settingsVoice.promptGuideDescription')}
                >
                    <Item
                        title={t('settingsVoice.customAgentId')}
                        subtitle={voiceCustomAgentId}
                        copy={voiceCustomAgentId}
                    />
                </ItemGroup>
            )}
        </ItemList>
    );
});
