import { and, eq } from 'drizzle-orm';
import { db, executorCredentials, teamMembers } from './db';
import type { ExecutorCredential } from './db/schema';
import { decryptSecret, encryptSecret } from './secrets';

/**
 * Per-user credentials for CLI executors (issue #12): the OAuth token from
 * `claude setup-token` (Claude subscription), the contents of ~/.codex/auth.json
 * (ChatGPT subscription), or plain API keys. Stored encrypted like hosting
 * tokens and decrypted only right before a work run injects them into the
 * disposable workspace container. All reads and writes go through this module.
 */

export type CredentialKind = ExecutorCredential['kind'];

export const CREDENTIAL_KINDS: Record<
	CredentialKind,
	{ label: string; hint: string; multiline: boolean }
> = {
	claude_code_oauth: {
		label: 'Claude Code OAuth token',
		hint: 'Run `claude setup-token` on your own machine (uses your Claude subscription) and paste the token.',
		multiline: false
	},
	anthropic_api_key: {
		label: 'Anthropic API key',
		hint: 'Used by the Claude Code executor when no OAuth token is set.',
		multiline: false
	},
	codex_auth_json: {
		label: 'Codex auth.json',
		hint: 'Run `codex login` on your own machine (uses your ChatGPT subscription) and paste the contents of ~/.codex/auth.json.',
		multiline: true
	},
	openai_api_key: {
		label: 'OpenAI API key',
		hint: 'Used by the Codex executor when no auth.json is set.',
		multiline: false
	}
};

export function isCredentialKind(value: string): value is CredentialKind {
	return value in CREDENTIAL_KINDS;
}

export function saveCredential(userId: string, kind: CredentialKind, secret: string): void {
	db.insert(executorCredentials)
		.values({ userId, kind, secretCiphertext: encryptSecret(secret), updatedAt: new Date() })
		.onConflictDoUpdate({
			target: [executorCredentials.userId, executorCredentials.kind],
			set: { secretCiphertext: encryptSecret(secret), updatedAt: new Date() }
		})
		.run();
}

export function deleteCredential(userId: string, kind: CredentialKind): void {
	db.delete(executorCredentials)
		.where(and(eq(executorCredentials.userId, userId), eq(executorCredentials.kind, kind)))
		.run();
}

/** What the settings UI shows: which kinds are set and when — never the secret. */
export function credentialStatus(
	userId: string
): { kind: CredentialKind; savedAt: Date }[] {
	return db
		.select()
		.from(executorCredentials)
		.where(eq(executorCredentials.userId, userId))
		.all()
		.map((row) => ({ kind: row.kind, savedAt: row.updatedAt ?? row.createdAt }));
}

/**
 * Decrypted credentials a team's work run may use: the team's Product Owner's.
 * Viewers' credentials are never touched — the PO owns the team's spend.
 */
export function credentialsForTeam(teamId: string): Partial<Record<CredentialKind, string>> {
	const po = db
		.select()
		.from(teamMembers)
		.where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.role, 'product_owner')))
		.get();
	if (!po) return {};

	const result: Partial<Record<CredentialKind, string>> = {};
	for (const row of db
		.select()
		.from(executorCredentials)
		.where(eq(executorCredentials.userId, po.userId))
		.all()) {
		result[row.kind] = decryptSecret(row.secretCiphertext);
	}
	return result;
}
