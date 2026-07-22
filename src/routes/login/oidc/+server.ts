import { error, redirect } from '@sveltejs/kit';
import { beginOidcLogin, OIDC_FLOW_COOKIE, oidcSettings } from '$lib/server/auth/oidc';
import type { RequestHandler } from './$types';

/** Kicks off the Authorization Code + PKCE flow at the configured provider. */
export const GET: RequestHandler = async ({ url, cookies }) => {
	const cfg = oidcSettings();
	if (!cfg) error(404, 'OIDC is not configured on this instance.');

	const redirectUri = `${url.origin}/login/oidc/callback`;
	const start = await beginOidcLogin(cfg, redirectUri);

	const target = url.searchParams.get('redirectTo');
	cookies.set(
		OIDC_FLOW_COOKIE,
		JSON.stringify({
			state: start.state,
			codeVerifier: start.codeVerifier,
			nonce: start.nonce,
			redirectTo: target && target.startsWith('/') && !target.startsWith('//') ? target : '/'
		}),
		{ path: '/', httpOnly: true, sameSite: 'lax', maxAge: 600 }
	);

	redirect(303, start.url);
};
