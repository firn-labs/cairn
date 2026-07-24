import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createMistral } from '@ai-sdk/mistral';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import { providerSetting } from '../settings';

export const PROVIDERS = {
	anthropic: {
		label: 'Anthropic',
		envVar: 'ANTHROPIC_API_KEY',
		defaultModel: 'claude-sonnet-5'
	},
	openai: {
		label: 'OpenAI',
		envVar: 'OPENAI_API_KEY',
		defaultModel: 'gpt-5.1'
	},
	mistral: {
		label: 'Mistral',
		envVar: 'MISTRAL_API_KEY',
		defaultModel: 'mistral-large-latest'
	},
	openrouter: {
		label: 'OpenRouter',
		envVar: 'OPENROUTER_API_KEY',
		defaultModel: 'openrouter/auto'
	},
	ollama: {
		label: 'Ollama (local)',
		envVar: 'OLLAMA_BASE_URL',
		defaultModel: 'qwen3'
	},
	// Any OpenAI-compatible endpoint — a self-hosted LiteLLM proxy (issue #27),
	// vLLM, LM Studio, … Cairn does not ship a proxy of its own: API-call
	// harmonization already happens in-process via the AI SDK, and subscription
	// plans are served by the CLI executors (issue #12), which a proxy cannot do.
	'openai-compatible': {
		label: 'OpenAI-compatible (LiteLLM, vLLM, …)',
		envVar: 'OPENAI_COMPATIBLE_BASE_URL',
		defaultModel: ''
	}
} as const;

export type ProviderId = keyof typeof PROVIDERS;

// Credentials resolve through the instance settings (issue #25): a value the
// admin stored under /admin/settings wins over the environment variable of
// the same name.
export function isProviderConfigured(id: ProviderId): boolean {
	return Boolean(providerSetting(PROVIDERS[id].envVar));
}

/** Providers usable right now, for the agent-creation UI. */
export function providerOptions() {
	return (Object.keys(PROVIDERS) as ProviderId[]).map((id) => ({
		id,
		label: PROVIDERS[id].label,
		defaultModel: PROVIDERS[id].defaultModel,
		configured: isProviderConfigured(id)
	}));
}

export function getModel(provider: string, modelId: string): LanguageModel {
	switch (provider as ProviderId) {
		case 'anthropic':
			return createAnthropic({ apiKey: providerSetting('ANTHROPIC_API_KEY') })(modelId);
		case 'openai':
			return createOpenAI({ apiKey: providerSetting('OPENAI_API_KEY') })(modelId);
		case 'mistral':
			return createMistral({ apiKey: providerSetting('MISTRAL_API_KEY') })(modelId);
		case 'openrouter':
			return createOpenAICompatible({
				name: 'openrouter',
				baseURL: 'https://openrouter.ai/api/v1',
				apiKey: providerSetting('OPENROUTER_API_KEY')
			})(modelId);
		case 'ollama':
			return createOpenAICompatible({
				name: 'ollama',
				baseURL: `${(providerSetting('OLLAMA_BASE_URL') || 'http://localhost:11434').replace(/\/$/, '')}/v1`,
				apiKey: 'ollama'
			})(modelId);
		case 'openai-compatible': {
			const baseUrl = providerSetting('OPENAI_COMPATIBLE_BASE_URL');
			if (!baseUrl) throw new Error('OPENAI_COMPATIBLE_BASE_URL is not set.');
			return createOpenAICompatible({
				name: 'openai-compatible',
				baseURL: baseUrl.replace(/\/$/, ''),
				apiKey: providerSetting('OPENAI_COMPATIBLE_API_KEY') || 'unused'
			})(modelId);
		}
		default:
			throw new Error(`Unknown provider: ${provider}`);
	}
}
