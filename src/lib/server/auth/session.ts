import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Cookies } from '@sveltejs/kit';
import { db, sessions, users } from '../db';
import type { User } from '../db/schema';

/**
 * Server-side sessions, Lucia-style: the cookie carries a random token, the
 * database stores only its SHA-256 — a leaked database yields no usable
 * sessions. Sessions live 30 days and slide: any request in the second half
 * of the lifetime extends it by another 30 days.
 */

export const SESSION_COOKIE = 'cairn_session';
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export function createSession(cookies: Cookies, userId: string): void {
	const token = randomBytes(32).toString('base64url');
	db.insert(sessions)
		.values({
			id: hashToken(token),
			userId,
			expiresAt: new Date(Date.now() + SESSION_LIFETIME_MS)
		})
		.run();
	cookies.set(SESSION_COOKIE, token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		maxAge: SESSION_LIFETIME_MS / 1000
	});
}

/** Resolve the request's session cookie to a user; renews sliding expiry. */
export function validateSession(cookies: Cookies): User | null {
	const token = cookies.get(SESSION_COOKIE);
	if (!token) return null;

	const id = hashToken(token);
	const row = db
		.select({ session: sessions, user: users })
		.from(sessions)
		.innerJoin(users, eq(sessions.userId, users.id))
		.where(eq(sessions.id, id))
		.get();
	if (!row) return null;

	const now = Date.now();
	if (row.session.expiresAt.getTime() <= now) {
		db.delete(sessions).where(eq(sessions.id, id)).run();
		return null;
	}
	if (row.session.expiresAt.getTime() - now < SESSION_LIFETIME_MS / 2) {
		db.update(sessions)
			.set({ expiresAt: new Date(now + SESSION_LIFETIME_MS) })
			.where(eq(sessions.id, id))
			.run();
	}
	return row.user;
}

export function destroySession(cookies: Cookies): void {
	const token = cookies.get(SESSION_COOKIE);
	if (token) db.delete(sessions).where(eq(sessions.id, hashToken(token))).run();
	cookies.delete(SESSION_COOKIE, { path: '/' });
}
