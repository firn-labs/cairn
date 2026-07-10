import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createMistral } from '@ai-sdk/mistral';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { env } from '$env/dynamic/private';
import type { LanguageModel } from 'ai';

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
	}
} as const;

export type ProviderId = keyof typeof PROVIDERS;

export function isProviderConfigured(id: ProviderId): boolean {
	return Boolean(env[PROVIDERS[id].envVar]);
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
			return createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })(modelId);
		case 'openai':
			return createOpenAI({ apiKey: env.OPENAI_API_KEY })(modelId);
		case 'mistral':
			return createMistral({ apiKey: env.MISTRAL_API_KEY })(modelId);
		case 'openrouter':
			return createOpenAICompatible({
				name: 'openrouter',
				baseURL: 'https://openrouter.ai/api/v1',
				apiKey: env.OPENROUTER_API_KEY
			})(modelId);
		case 'ollama':
			return createOpenAICompatible({
				name: 'ollama',
				baseURL: `${(env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/$/, '')}/v1`,
				apiKey: 'ollama'
			})(modelId);
		default:
			throw new Error(`Unknown provider: ${provider}`);
	}
}
