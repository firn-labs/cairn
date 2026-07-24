import { fail, redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { db, users } from '$lib/server/db';
import { userCount } from '$lib/server/auth/bootstrap';
import { enabledSsoProviders, ssoStartPath } from '$lib/server/auth/ssoProviders';
import { verifyPassword } from '$lib/server/auth/password';
import { createSession } from '$lib/server/auth/session';
import type { Actions, PageServerLoad } from './$types';

/** Only ever redirect to a local path — never to another origin. */
function safeTarget(raw: string | null): string {
	return raw && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';
}

export const load: PageServerLoad = async ({ locals }) => {
	if (locals.user) redirect(303, '/');
	const count = userCount();
	return {
		// Shown as a hint on the very first visit, and controls the signup link.
		signupOpen: count === 0 || env.CAIRN_ALLOW_SIGNUP === 'true',
		firstUser: count === 0,
		// One login button per enabled provider (issue #25). Labels and start
		// paths only — never any client config.
		ssoProviders: enabledSsoProviders().map((p) => ({
			label: p.label,
			startPath: ssoStartPath(p.id)
		}))
	};
};

export const actions: Actions = {
	default: async ({ request, cookies, url }) => {
		const form = await request.formData();
		const email = String(form.get('email') ?? '')
			.trim()
			.toLowerCase();
		const password = String(form.get('password') ?? '');

		if (!email || !password) return fail(400, { error: 'Enter your email and password.', email });

		const user = db.select().from(users).where(eq(users.email, email)).get();
		// Same message for unknown email and wrong password — don't leak which
		// addresses have an account.
		if (!user || !(await verifyPassword(password, user.passwordHash)))
			return fail(400, { error: 'Wrong email or password.', email });

		createSession(cookies, user.id);
		redirect(303, safeTarget(url.searchParams.get('redirectTo')));
	}
};
