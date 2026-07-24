import { fail, redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { db, users } from '$lib/server/db';
import { adoptOrphans, userCount } from '$lib/server/auth/bootstrap';
import { hashPassword } from '$lib/server/auth/password';
import { createSession } from '$lib/server/auth/session';
import type { Actions, PageServerLoad } from './$types';

/**
 * Signup is open while the instance has no users (the first account becomes
 * the owner and adopts everything created before auth existed). After that it
 * is closed unless CAIRN_ALLOW_SIGNUP=true — on a shared deployment, provider
 * API keys are still server-global (issue #9 follow-up), so open signup would
 * let strangers spend them.
 */
function signupOpen(): boolean {
	return userCount() === 0 || env.CAIRN_ALLOW_SIGNUP === 'true';
}

export const load: PageServerLoad = async ({ locals }) => {
	if (locals.user) redirect(303, '/');
	if (!signupOpen()) redirect(303, '/login');
	return { firstUser: userCount() === 0 };
};

export const actions: Actions = {
	default: async ({ request, cookies, url }) => {
		if (!signupOpen())
			return fail(403, { error: 'Signup is closed on this instance.', email: '', name: '' });

		const form = await request.formData();
		const email = String(form.get('email') ?? '')
			.trim()
			.toLowerCase();
		const name = String(form.get('name') ?? '').trim();
		const password = String(form.get('password') ?? '');

		if (!/^\S+@\S+\.\S+$/.test(email))
			return fail(400, { error: 'Enter a valid email address.', email, name });
		if (password.length < 8)
			return fail(400, { error: 'The password needs at least 8 characters.', email, name });
		if (db.select().from(users).where(eq(users.email, email)).get())
			return fail(400, { error: 'This email is already registered.', email, name });

		const first = userCount() === 0;
		const userId = randomUUID();
		// The first user of an instance is its admin (issue #25).
		db.insert(users)
			.values({ id: userId, email, name, passwordHash: await hashPassword(password), isAdmin: first })
			.run();

		if (first) adoptOrphans(userId);

		createSession(cookies, userId);
		const target = url.searchParams.get('redirectTo');
		redirect(303, target && target.startsWith('/') && !target.startsWith('//') ? target : '/');
	}
};
