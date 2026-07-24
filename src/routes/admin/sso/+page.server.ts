import { fail } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/auth/access';
import { oidcSettings, testOidcIssuer } from '$lib/server/auth/oidc';
import {
	createSsoProvider,
	deleteSsoProvider,
	ENV_PROVIDER_ID,
	listSsoProviders,
	setSsoProviderEnabled,
	ssoCallbackPath,
	updateSsoProvider,
	type SsoProviderInput
} from '$lib/server/auth/ssoProviders';
import { db, oidcProviders } from '$lib/server/db';
import { eq } from 'drizzle-orm';

import type { Actions, PageServerLoad } from './$types';

/**
 * SSO provider management (issue #25). Admin-only in load AND every action:
 * changing an issuer redirects future logins, which is an account-takeover
 * primitive if it ever leaks to non-admins. Client secrets are write-only —
 * the page payload never contains one.
 */
export const load: PageServerLoad = async ({ locals, url }) => {
	requireAdmin(locals.user);
	const providers = listSsoProviders();
	return {
		providers: providers.map((p) => ({
			id: p.id,
			label: p.label,
			issuer: p.issuer,
			clientId: p.clientId,
			scopes: p.scopes,
			groupsClaim: p.groupsClaim,
			memberGroup: p.memberGroup,
			viewerGroup: p.viewerGroup,
			enabled: p.enabled,
			source: p.source,
			hasSecret: Boolean(p.clientSecret),
			callbackUrl: `${url.origin}${ssoCallbackPath(p.id)}`
		})),
		// Bootstrap fallback state: env config exists, and whether it is active
		// (it applies only while no DB providers are configured).
		envConfigured: oidcSettings() !== null,
		envActive: providers.some((p) => p.source === 'env')
	};
};

function providerInput(form: FormData): SsoProviderInput {
	return {
		label: String(form.get('label') ?? ''),
		issuer: String(form.get('issuer') ?? ''),
		clientId: String(form.get('clientId') ?? ''),
		scopes: String(form.get('scopes') ?? ''),
		groupsClaim: String(form.get('groupsClaim') ?? ''),
		memberGroup: String(form.get('memberGroup') ?? ''),
		viewerGroup: String(form.get('viewerGroup') ?? '')
	};
}

export const actions: Actions = {
	create: async ({ request, locals }) => {
		requireAdmin(locals.user);
		const form = await request.formData();
		try {
			createSsoProvider(providerInput(form), String(form.get('clientSecret') ?? ''));
		} catch (err) {
			return fail(400, {
				error: err instanceof Error ? err.message : String(err)
			});
		}
		return {
			ok: true,
			message: 'Provider added — register its callback URL at the IdP.'
		};
	},

	update: async ({ request, locals }) => {
		requireAdmin(locals.user);
		const form = await request.formData();
		const id = String(form.get('id') ?? '');
		if (!db.select().from(oidcProviders).where(eq(oidcProviders.id, id)).get())
			return fail(404, { error: 'Unknown provider.' });
		try {
			updateSsoProvider(id, providerInput(form), String(form.get('clientSecret') ?? ''));
		} catch (err) {
			return fail(400, {
				error: err instanceof Error ? err.message : String(err)
			});
		}
		return { ok: true, message: 'Provider saved.' };
	},

	toggle: async ({ request, locals }) => {
		requireAdmin(locals.user);
		const form = await request.formData();
		const id = String(form.get('id') ?? '');
		if (!db.select().from(oidcProviders).where(eq(oidcProviders.id, id)).get())
			return fail(404, { error: 'Unknown provider.' });
		setSsoProviderEnabled(id, String(form.get('enabled')) === 'true');
		return { ok: true };
	},

	delete: async ({ request, locals }) => {
		requireAdmin(locals.user);
		const form = await request.formData();
		deleteSsoProvider(String(form.get('id') ?? ''));
		return {
			ok: true,
			message: 'Provider deleted (its account links were removed too).'
		};
	},

	test: async ({ request, locals }) => {
		requireAdmin(locals.user);
		const form = await request.formData();
		const id = String(form.get('id') ?? '');
		const issuer =
			id === ENV_PROVIDER_ID
				? oidcSettings()?.issuer
				: db.select().from(oidcProviders).where(eq(oidcProviders.id, id)).get()?.issuer;
		if (!issuer) return fail(404, { error: 'Unknown provider.' });
		try {
			const result = await testOidcIssuer(issuer);
			return {
				ok: true,
				message: `Discovery OK — the issuer answers (token endpoint: ${result.tokenEndpoint}).`
			};
		} catch (err) {
			return fail(400, {
				error: `Discovery failed: ${err instanceof Error ? err.message : String(err)}`
			});
		}
	}
};
