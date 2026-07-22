import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { env } from '$env/dynamic/private';

/**
 * At-rest encryption for hosting access tokens (AES-256-GCM). The key comes
 * from CAIRN_TOKEN_KEY (64 hex chars) or, by default, from a key file that is
 * auto-generated next to the SQLite database on first use — so a plain
 * `npm run dev` works without setup, and a DB file leaked on its own does not
 * expose tokens. Ciphertext layout: base64(iv ‖ authTag ‖ ciphertext).
 */

const IV_BYTES = 12;
const TAG_BYTES = 16;

let cachedKey: Buffer | null = null;

function loadKey(): Buffer {
	if (cachedKey) return cachedKey;

	if (env.CAIRN_TOKEN_KEY) {
		const key = Buffer.from(env.CAIRN_TOKEN_KEY.trim(), 'hex');
		if (key.length !== 32)
			throw new Error('CAIRN_TOKEN_KEY must be 64 hex characters (32 bytes).');
		cachedKey = key;
		return key;
	}

	const keyPath = join(dirname(env.DATABASE_PATH || './data/cairn.db'), 'token.key');
	try {
		const key = Buffer.from(readFileSync(keyPath, 'utf8').trim(), 'hex');
		if (key.length === 32) {
			cachedKey = key;
			return key;
		}
		throw new Error(`Key file ${keyPath} is corrupt — expected 64 hex characters.`);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
	}

	const key = randomBytes(32);
	mkdirSync(dirname(keyPath), { recursive: true });
	writeFileSync(keyPath, key.toString('hex') + '\n', { mode: 0o600 });
	cachedKey = key;
	return key;
}

export function encryptSecret(plaintext: string): string {
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv('aes-256-gcm', loadKey(), iv);
	const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}

export function decryptSecret(encoded: string): string {
	const raw = Buffer.from(encoded, 'base64');
	if (raw.length < IV_BYTES + TAG_BYTES) throw new Error('Stored secret is corrupt.');
	const decipher = createDecipheriv('aes-256-gcm', loadKey(), raw.subarray(0, IV_BYTES));
	decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
	return Buffer.concat([
		decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
		decipher.final()
	]).toString('utf8');
}
