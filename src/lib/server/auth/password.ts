import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Password hashing with Node's built-in scrypt — no native dependency, which
 * keeps the Docker build trivial. Parameters follow OWASP guidance
 * (N=2^16, r=8, p=1) and are stored inside the hash string so they can be
 * raised later without invalidating existing hashes.
 */

const N = 65536;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;
// scrypt needs 128 * N * r bytes; leave headroom above that.
const MAX_MEM = 128 * N * R * 2;

function scryptAsync(password: string, salt: Buffer, n: number, r: number, p: number) {
	return new Promise<Buffer>((resolve, reject) => {
		scrypt(password, salt, KEY_LENGTH, { N: n, r, p, maxmem: MAX_MEM }, (err, key) =>
			err ? reject(err) : resolve(key)
		);
	});
}

export async function hashPassword(password: string): Promise<string> {
	const salt = randomBytes(16);
	const key = await scryptAsync(password, salt, N, R, P);
	return `scrypt:${N}:${R}:${P}:${salt.toString('base64')}:${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const [scheme, n, r, p, salt, expected] = stored.split(':');
	if (scheme !== 'scrypt') return false;
	const expectedKey = Buffer.from(expected, 'base64');
	const key = await scryptAsync(password, Buffer.from(salt, 'base64'), Number(n), Number(r), Number(p));
	return key.length === expectedKey.length && timingSafeEqual(key, expectedKey);
}
