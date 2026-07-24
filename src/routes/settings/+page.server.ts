import { fail } from '@sveltejs/kit';
import {
	CREDENTIAL_KINDS,
	credentialStatus,
	deleteCredential,
	isCredentialKind,
	saveCredential
} from '$lib/server/executorCredentials';
import type { Actions, PageServerLoad } from './$types';

/**
 * Personal settings: credentials for CLI executors (issue #12). Secrets are
 * write-only from the UI's perspective — the page only ever shows WHETHER a
 * kind is stored and when, never the value.
 */
export const load: PageServerLoad = async ({ locals }) => {
	const stored = new Map(credentialStatus(locals.user!.id).map((c) => [c.kind, c.savedAt]));
	return {
		credentials: (Object.keys(CREDENTIAL_KINDS) as (keyof typeof CREDENTIAL_KINDS)[]).map(
			(kind) => ({
				kind,
				...CREDENTIAL_KINDS[kind],
				savedAt: stored.get(kind) ?? null
			})
		)
	};
};

export const actions: Actions = {
	save: async ({ request, locals }) => {
		const form = await request.formData();
		const kind = String(form.get('kind') ?? '');
		const secret = String(form.get('secret') ?? '').trim();
		if (!isCredentialKind(kind)) return fail(400, { error: 'Unknown credential kind.' });
		if (!secret) return fail(400, { error: 'The credential is empty.' });
		if (kind === 'codex_auth_json') {
			try {
				JSON.parse(secret);
			} catch {
				return fail(400, {
					error: 'That does not look like auth.json — paste the full JSON file contents.'
				});
			}
		}
		saveCredential(locals.user!.id, kind, secret);
		return { ok: true, saved: kind };
	},

	delete: async ({ request, locals }) => {
		const form = await request.formData();
		const kind = String(form.get('kind') ?? '');
		if (!isCredentialKind(kind)) return fail(400, { error: 'Unknown credential kind.' });
		deleteCredential(locals.user!.id, kind);
		return { ok: true };
	}
};
