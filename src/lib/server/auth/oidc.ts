import { createHash, randomBytes } from 'node:crypto';
import { env } from '$env/dynamic/private';

/**
 * OIDC login (Authorization Code + PKCE), hand-rolled on fetch/node:crypto —
 * no dependency, works with any spec-compliant provider (Keycloak, Authentik,
 * Nextcloud, Azure AD, ...) via issuer discovery.
 *
 * The ID token's signature is deliberately NOT verified: we receive it over
 * the TLS channel of the token endpoint using client authentication, which
 * OpenID Connect Core 3.1.3.7 (step 6) explicitly allows in place of a
 * signature check. iss/aud/exp/nonce are validated below.
 *
 * Role mapping: the IdP's groups claim decides the instance role. Member wins
 * over viewer; when group vars are configured a user in neither group is
 * rejected. When NO group var is set, every authenticated user is a member.
 */

/** Short-lived cookie carrying state/PKCE verifier/nonce across the redirect. */
export const OIDC_FLOW_COOKIE = 'cairn_oidc_flow';

export interface OidcSettings {
	issuer: string;
	clientId: string;
	clientSecret: string;
	scopes: string;
	groupsClaim: string;
	memberGroup: string;
	viewerGroup: string;
	/** Login-button label, e.g. the company IdP's name. */
	label: string;
}

/** null = OIDC not configured; password login is the only way in. */
export function oidcSettings(): OidcSettings | null {
	if (!env.CAIRN_OIDC_ISSUER || !env.CAIRN_OIDC_CLIENT_ID) return null;
	return {
		issuer: env.CAIRN_OIDC_ISSUER.replace(/\/$/, ''),
		clientId: env.CAIRN_OIDC_CLIENT_ID,
		clientSecret: env.CAIRN_OIDC_CLIENT_SECRET ?? '',
		scopes: env.CAIRN_OIDC_SCOPES || 'openid profile email',
		groupsClaim: env.CAIRN_OIDC_GROUPS_CLAIM || 'groups',
		memberGroup: env.CAIRN_OIDC_GROUP_MEMBER ?? '',
		viewerGroup: env.CAIRN_OIDC_GROUP_VIEWER ?? '',
		label: env.CAIRN_OIDC_LABEL || 'Single sign-on'
	};
}

interface Discovery {
	issuer: string;
	authorization_endpoint: string;
	token_endpoint: string;
	userinfo_endpoint?: string;
}

let discoveryCache: { issuer: string; doc: Discovery; fetchedAt: number } | null = null;
const DISCOVERY_TTL_MS = 60 * 60 * 1000;

async function discover(issuer: string): Promise<Discovery> {
	if (
		discoveryCache &&
		discoveryCache.issuer === issuer &&
		Date.now() - discoveryCache.fetchedAt < DISCOVERY_TTL_MS
	)
		return discoveryCache.doc;

	const res = await fetch(`${issuer}/.well-known/openid-configuration`);
	if (!res.ok) throw new Error(`OIDC discovery failed (${res.status}) for ${issuer}`);
	const doc = (await res.json()) as Discovery;
	if (!doc.authorization_endpoint || !doc.token_endpoint)
		throw new Error('OIDC discovery document is missing endpoints.');
	discoveryCache = { issuer, doc, fetchedAt: Date.now() };
	return doc;
}

const b64url = (buf: Buffer) => buf.toString('base64url');

export interface OidcLoginStart {
	url: string;
	state: string;
	codeVerifier: string;
	nonce: string;
}

export async function beginOidcLogin(
	cfg: OidcSettings,
	redirectUri: string
): Promise<OidcLoginStart> {
	const doc = await discover(cfg.issuer);
	const state = b64url(randomBytes(24));
	const nonce = b64url(randomBytes(24));
	const codeVerifier = b64url(randomBytes(48));
	const challenge = b64url(createHash('sha256').update(codeVerifier).digest());

	const url = new URL(doc.authorization_endpoint);
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('client_id', cfg.clientId);
	url.searchParams.set('redirect_uri', redirectUri);
	url.searchParams.set('scope', cfg.scopes);
	url.searchParams.set('state', state);
	url.searchParams.set('nonce', nonce);
	url.searchParams.set('code_challenge', challenge);
	url.searchParams.set('code_challenge_method', 'S256');

	return { url: url.toString(), state, codeVerifier, nonce };
}

export interface OidcIdentity {
	subject: string;
	email: string;
	name: string;
	groups: string[];
}

export async function completeOidcLogin(
	cfg: OidcSettings,
	redirectUri: string,
	code: string,
	codeVerifier: string,
	nonce: string
): Promise<OidcIdentity> {
	const doc = await discover(cfg.issuer);

	const body = new URLSearchParams({
		grant_type: 'authorization_code',
		code,
		redirect_uri: redirectUri,
		client_id: cfg.clientId,
		code_verifier: codeVerifier
	});
	if (cfg.clientSecret) body.set('client_secret', cfg.clientSecret);

	const res = await fetch(doc.token_endpoint, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body
	});
	if (!res.ok) throw new Error(`OIDC token exchange failed (${res.status}).`);
	const tokens = (await res.json()) as { id_token?: string; access_token?: string };
	if (!tokens.id_token) throw new Error('The OIDC provider returned no ID token.');

	const parts = tokens.id_token.split('.');
	if (parts.length !== 3) throw new Error('Malformed ID token.');
	let claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as Record<
		string,
		unknown
	>;

	// iss may differ by a trailing slash from the configured issuer.
	if (String(claims.iss ?? '').replace(/\/$/, '') !== cfg.issuer)
		throw new Error('ID token issuer mismatch.');
	const aud = claims.aud;
	if (Array.isArray(aud) ? !aud.includes(cfg.clientId) : aud !== cfg.clientId)
		throw new Error('ID token audience mismatch.');
	if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now())
		throw new Error('ID token is expired.');
	if (claims.nonce !== nonce) throw new Error('ID token nonce mismatch.');
	if (typeof claims.sub !== 'string' || !claims.sub) throw new Error('ID token has no subject.');

	// Some providers (e.g. Keycloak without mappers) only expose email/groups
	// via the userinfo endpoint — merge it in, ID-token claims win.
	if (doc.userinfo_endpoint && tokens.access_token) {
		try {
			const info = await fetch(doc.userinfo_endpoint, {
				headers: { authorization: `Bearer ${tokens.access_token}` }
			});
			if (info.ok) claims = { ...((await info.json()) as Record<string, unknown>), ...claims };
		} catch {
			// userinfo is best-effort; the ID token alone may already be enough.
		}
	}

	const rawGroups = claims[cfg.groupsClaim];
	const groups = (Array.isArray(rawGroups) ? rawGroups : rawGroups != null ? [rawGroups] : [])
		.map((g) => String(g))
		// Keycloak group paths arrive as "/staff" — compare without the slash.
		.map((g) => g.replace(/^\//, ''));

	return {
		subject: String(claims.sub),
		email: String(claims.email ?? '')
			.trim()
			.toLowerCase(),
		name: String(claims.name ?? claims.preferred_username ?? ''),
		groups
	};
}

/** Groups → instance role; null = this user may not log in. */
export function mapGroupsToRole(cfg: OidcSettings, groups: string[]): 'member' | 'viewer' | null {
	if (!cfg.memberGroup && !cfg.viewerGroup) return 'member';
	if (cfg.memberGroup && groups.includes(cfg.memberGroup)) return 'member';
	if (cfg.viewerGroup && groups.includes(cfg.viewerGroup)) return 'viewer';
	return null;
}
