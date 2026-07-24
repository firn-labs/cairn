import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, oidcAccounts, oidcProviders } from '../db';
import { decryptSecret, encryptSecret } from '../secrets';
import { oidcSettings, type OidcSettings } from './oidc';

/**
 * Where OIDC provider configuration comes from (issue #25). DB rows
 * (`oidc_providers`, managed under /admin/sso) are authoritative; the
 * CAIRN_OIDC_* env vars remain a bootstrap fallback that applies ONLY while
 * the table is empty, so a pre-#25 instance keeps working unchanged. The env
 * fallback uses the sentinel id 'env' — its callback URL stays the historic
 * `/login/oidc/callback`, DB providers use `/login/oidc/<id>/callback`.
 */

export const ENV_PROVIDER_ID = 'env';

export interface SsoProvider extends OidcSettings {
	id: string;
	enabled: boolean;
	source: 'db' | 'env';
}

function fromRow(row: typeof oidcProviders.$inferSelect): SsoProvider {
	return {
		id: row.id,
		issuer: row.issuer.replace(/\/$/, ''),
		clientId: row.clientId,
		clientSecret: row.clientSecretCiphertext ? decryptSecret(row.clientSecretCiphertext) : '',
		scopes: row.scopes || 'openid profile email',
		groupsClaim: row.groupsClaim || 'groups',
		memberGroup: row.memberGroup,
		viewerGroup: row.viewerGroup,
		label: row.label,
		enabled: row.enabled,
		source: 'db'
	};
}

function envProvider(): SsoProvider | null {
	const cfg = oidcSettings();
	return cfg ? { ...cfg, id: ENV_PROVIDER_ID, enabled: true, source: 'env' } : null;
}

/**
 * All providers, enabled or not (for the admin UI). Contains decrypted
 * client secrets — strictly server-side; page loads must pick fields.
 */
export function listSsoProviders(): SsoProvider[] {
	const rows = db.select().from(oidcProviders).all();
	if (rows.length === 0) {
		const env = envProvider();
		return env ? [env] : [];
	}
	return rows.map(fromRow);
}

/** The providers offered on the login page. */
export function enabledSsoProviders(): SsoProvider[] {
	return listSsoProviders().filter((p) => p.enabled);
}

/** Resolve a provider id from a login/link URL; null = unknown or not offered. */
export function getSsoProvider(id: string): SsoProvider | null {
	if (id === ENV_PROVIDER_ID) {
		// The env fallback exists only while no DB providers are configured.
		const rows = db.select({ id: oidcProviders.id }).from(oidcProviders).all();
		return rows.length === 0 ? envProvider() : null;
	}
	const row = db.select().from(oidcProviders).where(eq(oidcProviders.id, id)).get();
	return row ? fromRow(row) : null;
}

/** The path that starts the OIDC flow for a provider. */
export function ssoStartPath(providerId: string): string {
	return providerId === ENV_PROVIDER_ID ? '/login/oidc' : `/login/oidc/${providerId}`;
}

/** The redirect URI path registered at the IdP for a provider. */
export function ssoCallbackPath(providerId: string): string {
	return providerId === ENV_PROVIDER_ID
		? '/login/oidc/callback'
		: `/login/oidc/${providerId}/callback`;
}

// ---- Admin CRUD (only ever called behind requireAdmin) -------------------

export interface SsoProviderInput {
	label: string;
	issuer: string;
	clientId: string;
	scopes: string;
	groupsClaim: string;
	memberGroup: string;
	viewerGroup: string;
}

function validate(input: SsoProviderInput): SsoProviderInput {
	const label = input.label.trim();
	const issuer = input.issuer.trim().replace(/\/$/, '');
	const clientId = input.clientId.trim();
	if (!label) throw new Error('The provider needs a label (it becomes the login button).');
	if (!/^https:\/\/.+/.test(issuer) && !issuer.startsWith('http://localhost'))
		throw new Error('The issuer must be an https:// URL.');
	if (!clientId) throw new Error('The provider needs a client id.');
	return {
		label,
		issuer,
		clientId,
		scopes: input.scopes.trim() || 'openid profile email',
		groupsClaim: input.groupsClaim.trim() || 'groups',
		memberGroup: input.memberGroup.trim(),
		viewerGroup: input.viewerGroup.trim()
	};
}

export function createSsoProvider(input: SsoProviderInput, clientSecret: string): string {
	const v = validate(input);
	const id = randomUUID();
	db.insert(oidcProviders)
		.values({
			id,
			label: v.label,
			issuer: v.issuer,
			clientId: v.clientId,
			clientSecretCiphertext: clientSecret.trim() ? encryptSecret(clientSecret.trim()) : '',
			scopes: v.scopes,
			groupsClaim: v.groupsClaim,
			memberGroup: v.memberGroup,
			viewerGroup: v.viewerGroup
		})
		.run();
	return id;
}

/** `clientSecret` empty = keep the stored secret (write-only UI field). */
export function updateSsoProvider(id: string, input: SsoProviderInput, clientSecret: string): void {
	const v = validate(input);
	const patch: Record<string, unknown> = {
		label: v.label,
		issuer: v.issuer,
		clientId: v.clientId,
		scopes: v.scopes,
		groupsClaim: v.groupsClaim,
		memberGroup: v.memberGroup,
		viewerGroup: v.viewerGroup
	};
	if (clientSecret.trim()) patch.clientSecretCiphertext = encryptSecret(clientSecret.trim());
	db.update(oidcProviders).set(patch).where(eq(oidcProviders.id, id)).run();
}

export function setSsoProviderEnabled(id: string, enabled: boolean): void {
	db.update(oidcProviders).set({ enabled }).where(eq(oidcProviders.id, id)).run();
}

/** Deleting a provider also removes its account links — those subjects are
 *  meaningless without the provider's issuer/client context. */
export function deleteSsoProvider(id: string): void {
	db.delete(oidcAccounts).where(eq(oidcAccounts.providerId, id)).run();
	db.delete(oidcProviders).where(eq(oidcProviders.id, id)).run();
}
