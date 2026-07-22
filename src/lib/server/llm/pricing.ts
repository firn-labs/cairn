/**
 * Rough USD price sheet for the Product Owner dashboard's cost overview.
 * Prices are per MILLION tokens and deliberately coarse — they translate token
 * counts into an order-of-magnitude currency figure, not an invoice. Providers
 * change their pricing; update the tables as needed. Unknown models fall back
 * to their provider's default rate; unknown providers (and aggregators like
 * OpenRouter, where the model string doesn't identify one price) return null,
 * shown in the UI as "no estimate".
 */
export type Rate = { input: number; output: number };

/** Most specific match wins: first row whose provider matches and whose
 *  pattern tests true against the model id. */
const MODEL_RATES: Array<{ provider: string; match: RegExp; rate: Rate }> = [
	{ provider: 'anthropic', match: /opus/, rate: { input: 5, output: 25 } },
	{ provider: 'anthropic', match: /sonnet/, rate: { input: 3, output: 15 } },
	{ provider: 'anthropic', match: /haiku/, rate: { input: 1, output: 5 } },
	{ provider: 'openai', match: /mini|nano/, rate: { input: 0.25, output: 2 } },
	{ provider: 'openai', match: /^gpt-5/, rate: { input: 1.25, output: 10 } },
	{ provider: 'openai', match: /^gpt-4o/, rate: { input: 2.5, output: 10 } },
	{ provider: 'openai', match: /^o\d/, rate: { input: 2, output: 8 } },
	{ provider: 'mistral', match: /large/, rate: { input: 2, output: 6 } },
	{ provider: 'mistral', match: /medium/, rate: { input: 0.4, output: 2 } },
	{ provider: 'mistral', match: /small|ministral/, rate: { input: 0.1, output: 0.3 } }
];

const PROVIDER_DEFAULTS: Record<string, Rate | null> = {
	anthropic: { input: 3, output: 15 },
	openai: { input: 1.25, output: 10 },
	mistral: { input: 2, output: 6 },
	openrouter: null,
	ollama: { input: 0, output: 0 }
};

export function rateFor(provider: string, model: string): Rate | null {
	const hit = MODEL_RATES.find((r) => r.provider === provider && r.match.test(model));
	if (hit) return hit.rate;
	return PROVIDER_DEFAULTS[provider] ?? null;
}

/** Estimated USD cost, or null when no price is known for the provider/model. */
export function estimateCostUsd(
	provider: string,
	model: string,
	inputTokens: number,
	outputTokens: number
): number | null {
	const rate = rateFor(provider, model);
	if (!rate) return null;
	return (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;
}
