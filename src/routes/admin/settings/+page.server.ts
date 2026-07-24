import { fail } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/auth/access';
import {
	FLAGS,
	LIMITS,
	PROVIDER_SETTINGS,
	getFlag,
	getLimit,
	getStringSetting,
	isLimitKey,
	isProviderSettingKey,
	providerSettingStatus,
	setFlag,
	setLimit,
	setProviderSetting,
	setStringSetting,
	type FlagKey,
	type LimitKey,
	type ProviderSettingKey
} from '$lib/server/settings';
import type { Actions, PageServerLoad } from './$types';

/**
 * Instance settings (issues #19, #23, #25): configurable limits and budgets,
 * the cross-team collaboration flag, cairn-wide LLM provider credentials and
 * the instance-default Ollama code-gen model. Admin-only in load AND actions;
 * secret values are write-only toward the UI.
 */
export const load: PageServerLoad = async ({ locals }) => {
	requireAdmin(locals.user);
	return {
		collaborationEnabled: getFlag('collaborationEnabled'),
		limits: (Object.keys(LIMITS) as LimitKey[]).map((key) => ({
			key,
			label: LIMITS[key].label,
			hint: LIMITS[key].hint,
			min: LIMITS[key].min,
			def: LIMITS[key].def,
			value: getLimit(key)
		})),
		providerSettings: (Object.keys(PROVIDER_SETTINGS) as ProviderSettingKey[]).map((key) => ({
			key,
			label: PROVIDER_SETTINGS[key].label,
			secret: PROVIDER_SETTINGS[key].secret,
			...providerSettingStatus(key)
		})),
		ollamaCodegenModel: getStringSetting('ollamaCodegenModel')
	};
};

export const actions: Actions = {
	setFlag: async ({ request, locals }) => {
		requireAdmin(locals.user);
		const form = await request.formData();
		const key = String(form.get('key') ?? '');
		if (!(key in FLAGS)) return fail(400, { error: 'Unknown setting.' });
		setFlag(key as FlagKey, String(form.get('value')) === 'true');
		return { ok: true };
	},

	saveLimits: async ({ request, locals }) => {
		requireAdmin(locals.user);
		const form = await request.formData();
		// Validate everything first so a save is all-or-nothing.
		const updates: [LimitKey, number][] = [];
		for (const key of Object.keys(LIMITS)) {
			if (!isLimitKey(key)) continue;
			const raw = form.get(key);
			if (raw === null) continue;
			const value = Number(String(raw));
			if (!Number.isFinite(value) || Math.round(value) < LIMITS[key].min)
				return fail(400, {
					error: `${LIMITS[key].label}: enter a number of at least ${LIMITS[key].min}.`
				});
			updates.push([key, value]);
		}
		for (const [key, value] of updates) setLimit(key, value);
		return {
			ok: true,
			message: 'Limits saved — they apply immediately, no restart needed.'
		};
	},

	saveProviderSetting: async ({ request, locals }) => {
		requireAdmin(locals.user);
		const form = await request.formData();
		const key = String(form.get('key') ?? '');
		if (!isProviderSettingKey(key)) return fail(400, { error: 'Unknown credential.' });
		setProviderSetting(key, String(form.get('value') ?? ''));
		return { ok: true };
	},

	clearProviderSetting: async ({ request, locals }) => {
		requireAdmin(locals.user);
		const form = await request.formData();
		const key = String(form.get('key') ?? '');
		if (!isProviderSettingKey(key)) return fail(400, { error: 'Unknown credential.' });
		setProviderSetting(key, '');
		return { ok: true };
	},

	saveOllamaModel: async ({ request, locals }) => {
		requireAdmin(locals.user);
		const form = await request.formData();
		setStringSetting('ollamaCodegenModel', String(form.get('value') ?? ''));
		return { ok: true };
	}
};
