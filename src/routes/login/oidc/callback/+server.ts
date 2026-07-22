import { redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, users } from '$lib/server/db';
import { adoptOrphans, userCount } from '$lib/server/auth/bootstrap';
import {
	completeOidcLogin,
	mapGroupsToRole,
	OIDC_FLOW_COOKIE,
	oidcSettings
} from '$lib/server/auth/oidc';
import { createSession } from '$lib/server/auth/session';
import type { RequestHandler } from './$types';

function failLogin(message: string): never {
	redirect(303, `/login?error=${encodeURIComponent(message)}`);
}

/**
 * Provider redirect target. Signup gating (CAIRN_ALLOW_SIGNUP) deliberately
 * does NOT apply here: whoever may log in is decided by the IdP and the group
 * mapping, and accounts are created on first login.
 */
export const GET: RequestHandler = async ({ url, cookies }) => {
	const cfg = oidcSettings();
	if (!cfg) failLogin('OIDC is not configured on this instance.');

	const raw = cookies.get(OIDC_FLOW_COOKIE);
	cookies.delete(OIDC_FLOW_COOKIE, { path: '/' });
	if (!raw) failLogin('The login attempt expired — try again.');
	let flow: { state: string; codeVerifier: string; nonce: string; redirectTo: string };
	try {
		flow = JSON.parse(raw);
	} catch {
		failLogin('The login attempt expired — try again.');
	}

	if (url.searchParams.get('error'))
		failLogin(
			url.searchParams.get('error_description') ||
				`The provider rejected the login (${url.searchParams.get('error')}).`
		);
	const code = url.searchParams.get('code');
	if (!code || url.searchParams.get('state') !== flow.state)
		failLogin('Invalid login response — try again.');

	let identity;
	try {
		identity = await completeOidcLogin(
			cfg,
			`${url.origin}/login/oidc/callback`,
			code,
			flow.codeVerifier,
			flow.nonce
		);
	} catch (err) {
		failLogin(err instanceof Error ? err.message : 'OIDC login failed.');
	}
	if (!identity.email) failLogin('The provider sent no email address for your account.');

	const role = mapGroupsToRole(cfg, identity.groups);
	if (!role) failLogin('Your account is in none of the groups allowed to use Cairn.');

	// Link by subject first, then by email (attaches SSO to an existing
	// password account); otherwise create the user on first login.
	let user =
		db.select().from(users).where(eq(users.oidcSubject, identity.subject)).get() ??
		db.select().from(users).where(eq(users.email, identity.email)).get();

	if (user) {
		// Groups are the source of truth on every login: role changes in the
		// IdP propagate here, and the linked subject/name follow the provider.
		db.update(users)
			.set({ oidcSubject: identity.subject, role, name: identity.name || user.name })
			.where(eq(users.id, user.id))
			.run();
	} else {
		const first = userCount() === 0;
		user = {
			id: randomUUID(),
			email: identity.email,
			name: identity.name,
			// Sentinel, never verifiable — OIDC accounts have no password.
			passwordHash: 'oidc',
			role,
			oidcSubject: identity.subject,
			createdAt: new Date()
		};
		db.insert(users).values(user).run();
		if (first && role === 'member') adoptOrphans(user.id);
	}

	createSession(cookies, user.id);
	redirect(303, flow.redirectTo || '/');
};
