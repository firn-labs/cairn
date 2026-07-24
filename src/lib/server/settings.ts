import { eq } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { db, appSettings } from './db';
import { decryptSecret, encryptSecret } from './secrets';

/**
 * Instance-wide settings (issues #19, #23, #25), stored in `app_settings` and
 * edited by instance admins under /admin/settings. This module is the ONLY
 * read/write path for that table: every key is declared in a registry below
 * with its type, default and (for provider credentials) whether the value is
 * stored encrypted. Unset keys fall back to their default — or, for provider
 * credentials, to the matching environment variable — so a fresh instance
 * behaves exactly as before this table existed.
 */

function rawGet(key: string): string | null {
	const row = db.select().from(appSettings).where(eq(appSettings.key, key)).get();
	return row?.value ?? null;
}

function rawSet(key: string, value: string): void {
	db.insert(appSettings)
		.values({ key, value, updatedAt: new Date() })
		.onConflictDoUpdate({
			target: appSettings.key,
			set: { value, updatedAt: new Date() }
		})
		.run();
}

function rawDelete(key: string): void {
	db.delete(appSettings).where(eq(appSettings.key, key)).run();
}

// ---- Numeric limits & budgets (issue #19) --------------------------------

export interface LimitSpec {
	label: string;
	hint: string;
	def: number;
	min: number;
}

/**
 * Every configurable limit, with the pre-#19 hardcoded value as its default.
 * The consuming module reads through `getLimit` at use time, so changes apply
 * immediately without a restart.
 */
export const LIMITS = {
	defaultSprintTokenBudget: {
		label: 'Default sprint token budget',
		hint: 'Pre-filled when a Product Owner starts a sprint (input + output tokens).',
		def: 300_000,
		min: 10_000
	},
	maxSprintTokenBudget: {
		label: 'Maximum sprint token budget',
		hint: 'Hard ceiling a Product Owner can set on a single sprint. 0 = no ceiling.',
		def: 0,
		min: 0
	},
	adhocMeetingsPerSprint: {
		label: 'Ad-hoc meetings per sprint',
		hint: 'How many ad-hoc meetings the agents of one sprint may call in total.',
		def: 3,
		min: 0
	},
	adhocMeetingTokenCap: {
		label: 'Ad-hoc meeting token cap',
		hint: 'Discussion tokens after which a single ad-hoc meeting is wrapped up.',
		def: 12_000,
		min: 1_000
	},
	memoryWindow: {
		label: 'Agent memory window',
		hint: 'Most recent active memories included in an agent prompt; outgrowing it triggers consolidation.',
		def: 25,
		min: 5
	},
	maxTeamSize: {
		label: 'Maximum team size',
		hint: 'Agents per team.',
		def: 10,
		min: 1
	},
	maxProposalsPerSource: {
		label: 'Backlog proposals per work item',
		hint: 'Backlog items one agent may propose while working a single item.',
		def: 3,
		min: 0
	},
	maxTeamRequestsPerSource: {
		label: 'Cross-team requests per work item',
		hint: 'Work requests to other teams one agent may file while working a single item.',
		def: 2,
		min: 0
	}
} satisfies Record<string, LimitSpec>;

export type LimitKey = keyof typeof LIMITS;

export function isLimitKey(key: string): key is LimitKey {
	return key in LIMITS;
}

export function getLimit(key: LimitKey): number {
	const raw = rawGet(`limit.${key}`);
	const parsed = raw === null ? NaN : Number(raw);
	return Number.isFinite(parsed) ? Math.max(LIMITS[key].min, Math.round(parsed)) : LIMITS[key].def;
}

export function setLimit(key: LimitKey, value: number): void {
	if (!Number.isFinite(value)) throw new Error(`${LIMITS[key].label}: not a number.`);
	const v = Math.round(value);
	if (v < LIMITS[key].min) throw new Error(`${LIMITS[key].label}: minimum is ${LIMITS[key].min}.`);
	rawSet(`limit.${key}`, String(v));
}

// ---- Feature flags -------------------------------------------------------

export const FLAGS = {
	/** Cross-team collaboration (issue #23): when off, agents neither discover
	 *  other teams nor file cross-team work requests. */
	collaborationEnabled: { def: true }
} satisfies Record<string, { def: boolean }>;

export type FlagKey = keyof typeof FLAGS;

export function getFlag(key: FlagKey): boolean {
	const raw = rawGet(`flag.${key}`);
	return raw === null ? FLAGS[key].def : raw === 'true';
}

export function setFlag(key: FlagKey, value: boolean): void {
	rawSet(`flag.${key}`, value ? 'true' : 'false');
}

/** Convenience for the #23 gate — read at use time, applies without restart. */
export const collaborationEnabled = () => getFlag('collaborationEnabled');

// ---- Plain string settings -----------------------------------------------

export const STRING_SETTINGS = {
	/** Instance-wide default model for the OpenCode (Ollama) code-gen executor;
	 *  a team's own executorConfig.model still wins. Empty = built-in default. */
	ollamaCodegenModel: { def: '' }
} satisfies Record<string, { def: string }>;

export type StringSettingKey = keyof typeof STRING_SETTINGS;

export function getStringSetting(key: StringSettingKey): string {
	return rawGet(`str.${key}`) ?? STRING_SETTINGS[key].def;
}

export function setStringSetting(key: StringSettingKey, value: string): void {
	const v = value.trim();
	if (v) rawSet(`str.${key}`, v);
	else rawDelete(`str.${key}`);
}

// ---- Provider credentials (issue #25) ------------------------------------

/**
 * Cairn-wide LLM provider credentials, keyed by the environment variable they
 * override. A DB value (set under /admin/settings) wins over the env var; API
 * keys are AES-256-GCM encrypted at rest and write-only toward the UI, base
 * URLs are stored in plain text so the admin can see what is configured.
 */
export const PROVIDER_SETTINGS = {
	ANTHROPIC_API_KEY: { label: 'Anthropic API key', secret: true },
	OPENAI_API_KEY: { label: 'OpenAI API key', secret: true },
	MISTRAL_API_KEY: { label: 'Mistral API key', secret: true },
	OPENROUTER_API_KEY: { label: 'OpenRouter API key', secret: true },
	OLLAMA_BASE_URL: { label: 'Ollama base URL', secret: false },
	OPENAI_COMPATIBLE_BASE_URL: {
		label: 'OpenAI-compatible base URL',
		secret: false
	},
	OPENAI_COMPATIBLE_API_KEY: {
		label: 'OpenAI-compatible API key',
		secret: true
	}
} satisfies Record<string, { label: string; secret: boolean }>;

export type ProviderSettingKey = keyof typeof PROVIDER_SETTINGS;

export function isProviderSettingKey(key: string): key is ProviderSettingKey {
	return key in PROVIDER_SETTINGS;
}

/** Resolved credential: DB override first, then the environment variable. */
export function providerSetting(key: ProviderSettingKey): string | undefined {
	const stored = rawGet(`provider.${key}`);
	if (stored !== null) {
		return PROVIDER_SETTINGS[key].secret ? decryptSecret(stored) : stored;
	}
	return env[key] || undefined;
}

/** Empty value deletes the override (the env var, if any, applies again). */
export function setProviderSetting(key: ProviderSettingKey, value: string): void {
	const v = value.trim();
	if (!v) {
		rawDelete(`provider.${key}`);
		return;
	}
	rawSet(`provider.${key}`, PROVIDER_SETTINGS[key].secret ? encryptSecret(v) : v);
}

/** For the admin UI: where the effective value comes from — never the value
 *  itself for secrets. */
export function providerSettingStatus(key: ProviderSettingKey): {
	source: 'db' | 'env' | 'none';
	/** Plain-text values (base URLs) may be shown; secrets never. */
	visibleValue: string | null;
} {
	const stored = rawGet(`provider.${key}`);
	if (stored !== null)
		return {
			source: 'db',
			visibleValue: PROVIDER_SETTINGS[key].secret ? null : stored
		};
	if (env[key]) return { source: 'env', visibleValue: null };
	return { source: 'none', visibleValue: null };
}
