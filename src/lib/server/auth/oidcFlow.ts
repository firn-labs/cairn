import { error, redirect, type Cookies } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, oidcAccounts, users } from '../db';
import { adoptOrphans, userCount } from './bootstrap';
import { beginOidcLogin, completeOidcLogin, mapGroupsToRole, OIDC_FLOW_COOKIE } from './oidc';
import { createSession } from './session';
import { getSsoProvider, ssoCallbackPath, type SsoProvider } from './ssoProviders';

/**
 * The OIDC flow shared by every provider route (issue #25): the env-fallback
 * routes /login/oidc[/callback] and the per-provider routes
 * /login/oidc/<id>[/callback] both delegate here. Two modes, decided at start:
 *
 * - Login (default): authenticate, map groups to the instance role, find or
 *   create the account, start a session. Signup gating (CAIRN_ALLOW_SIGNUP)
 *   deliberately does not apply — the IdP and its group mapping decide.
 * - Link (?link=1, requires a session): attach the resulting subject to the
 *   LOGGED-IN user instead of logging anyone in, so an account whose IdP
 *   email differs can still get SSO (/account page). The flow cookie carries
 *   the user id, and the callback re-checks it against the live session.
 */

interface FlowState {
	providerId: string;
	state: string;
	codeVerifier: string;
	nonce: string;
	redirectTo: string;
	/** Set in link mode: the user this identity gets attached to. */
	linkUserId?: string;
}

interface FlowEvent {
	url: URL;
	cookies: Cookies;
	locals: App.Locals;
}

function resolveProvider(providerId: string): SsoProvider {
	const provider = getSsoProvider(providerId);
	if (!provider || !provider.enabled) error(404, 'This sign-on provider is not available.');
	return provider;
}

export async function startOidcFlow(event: FlowEvent, providerId: string): Promise<never> {
	const provider = resolveProvider(providerId);
	const linking = event.url.searchParams.get('link') === '1';
	if (linking && !event.locals.user) redirect(303, '/login');

	const redirectUri = `${event.url.origin}${ssoCallbackPath(provider.id)}`;
	const start = await beginOidcLogin(provider, redirectUri);

	const target = event.url.searchParams.get('redirectTo');
	const flow: FlowState = {
		providerId: provider.id,
		state: start.state,
		codeVerifier: start.codeVerifier,
		nonce: start.nonce,
		redirectTo: target && target.startsWith('/') && !target.startsWith('//') ? target : '/',
		...(linking ? { linkUserId: event.locals.user!.id } : {})
	};
	event.cookies.set(OIDC_FLOW_COOKIE, JSON.stringify(flow), {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		maxAge: 600
	});

	redirect(303, start.url);
}

export async function handleOidcCallback(event: FlowEvent, providerId: string): Promise<never> {
	const raw = event.cookies.get(OIDC_FLOW_COOKIE);
	event.cookies.delete(OIDC_FLOW_COOKIE, { path: '/' });

	let flow: FlowState | null = null;
	try {
		if (raw) flow = JSON.parse(raw) as FlowState;
	} catch {
		flow = null;
	}
	const linking = Boolean(flow?.linkUserId);
	const fail = (message: string): never =>
		redirect(303, `${linking ? '/account' : '/login'}?error=${encodeURIComponent(message)}`);

	if (!flow || flow.providerId !== providerId)
		return fail('The login attempt expired — try again.');
	const provider = resolveProvider(providerId);

	const params = event.url.searchParams;
	if (params.get('error'))
		return fail(
			params.get('error_description') || `The provider rejected the login (${params.get('error')}).`
		);
	const code = params.get('code');
	if (!code || params.get('state') !== flow.state)
		return fail('Invalid login response — try again.');

	let identity;
	try {
		identity = await completeOidcLogin(
			provider,
			`${event.url.origin}${ssoCallbackPath(provider.id)}`,
			code,
			flow.codeVerifier,
			flow.nonce
		);
	} catch (err) {
		return fail(err instanceof Error ? err.message : 'OIDC login failed.');
	}

	// ---- Link mode: attach the identity to the logged-in user ----
	if (flow.linkUserId) {
		// The IdP round-trip must complete within the SAME session that
		// started it — a stale link cookie must never attach identities.
		if (!event.locals.user || event.locals.user.id !== flow.linkUserId)
			return fail('The link attempt did not match your session — try again.');

		const existing = db
			.select()
			.from(oidcAccounts)
			.where(
				and(eq(oidcAccounts.providerId, provider.id), eq(oidcAccounts.subject, identity.subject))
			)
			.get();
		if (existing && existing.userId !== flow.linkUserId)
			return fail('This identity is already linked to a different account.');
		if (!existing) {
			db.insert(oidcAccounts)
				.values({
					userId: flow.linkUserId,
					providerId: provider.id,
					subject: identity.subject
				})
				.run();
		}
		redirect(303, `/account?linked=${encodeURIComponent(provider.label)}`);
	}

	// ---- Login mode ----
	if (!identity.email) return fail('The provider sent no email address for your account.');

	const role = mapGroupsToRole(provider, identity.groups);
	if (!role) return fail('Your account is in none of the groups allowed to use Cairn.');

	// Find by linked subject first, then by email (attaches SSO to an existing
	// account); otherwise create the user on first login.
	const link = db
		.select()
		.from(oidcAccounts)
		.where(
			and(eq(oidcAccounts.providerId, provider.id), eq(oidcAccounts.subject, identity.subject))
		)
		.get();
	let user = link
		? db.select().from(users).where(eq(users.id, link.userId)).get()
		: db.select().from(users).where(eq(users.email, identity.email)).get();

	if (user) {
		if (!link) {
			// First login through this provider for an email-matched account.
			db.insert(oidcAccounts)
				.values({
					userId: user.id,
					providerId: provider.id,
					subject: identity.subject
				})
				.run();
		}
		// Groups are the source of truth on every login: role changes in the
		// IdP propagate here, and the name follows the provider.
		db.update(users)
			.set({ role, name: identity.name || user.name })
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
			// The first user of an instance is its admin (issue #25).
			isAdmin: first,
			createdAt: new Date()
		};
		db.insert(users).values(user).run();
		db.insert(oidcAccounts)
			.values({
				userId: user.id,
				providerId: provider.id,
				subject: identity.subject
			})
			.run();
		if (first && role === 'member') adoptOrphans(user.id);
	}

	createSession(event.cookies, user.id);
	redirect(303, flow.redirectTo || '/');
}
