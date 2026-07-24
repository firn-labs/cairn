import { fail } from '@sveltejs/kit';
import { asc, eq } from 'drizzle-orm';
import { requireAdmin } from '$lib/server/auth/access';
import { db, oidcAccounts, users } from '$lib/server/db';
import type { Actions, PageServerLoad } from './$types';

/**
 * User administration (issue #25): grant/revoke the instance-admin flag.
 * Admins can never change their OWN flag — so revoking always leaves at least
 * the acting admin, and an instance cannot lock itself out.
 */
export const load: PageServerLoad = async ({ locals }) => {
	requireAdmin(locals.user);
	const links = db.select().from(oidcAccounts).all();
	return {
		users: db
			.select()
			.from(users)
			.orderBy(asc(users.createdAt))
			.all()
			.map((u) => ({
				id: u.id,
				email: u.email,
				name: u.name,
				role: u.role,
				isAdmin: u.isAdmin,
				hasPassword: u.passwordHash !== 'oidc',
				ssoLinks: links.filter((l) => l.userId === u.id).length,
				createdAt: u.createdAt
			}))
	};
};

export const actions: Actions = {
	setAdmin: async ({ request, locals }) => {
		requireAdmin(locals.user);
		const form = await request.formData();
		const userId = String(form.get('userId') ?? '');
		const makeAdmin = String(form.get('isAdmin')) === 'true';

		if (userId === locals.user!.id)
			return fail(400, { error: 'You cannot change your own admin flag.' });
		const target = db.select().from(users).where(eq(users.id, userId)).get();
		if (!target) return fail(404, { error: 'Unknown user.' });

		// Defense in depth: the self-check above already guarantees the acting
		// admin remains, but never demote the last admin regardless.
		if (!makeAdmin) {
			const admins = db.select({ id: users.id }).from(users).where(eq(users.isAdmin, true)).all();
			if (admins.length <= 1 && admins.some((a) => a.id === userId))
				return fail(400, { error: 'The last admin cannot be demoted.' });
		}

		db.update(users).set({ isAdmin: makeAdmin }).where(eq(users.id, userId)).run();
		return { ok: true };
	}
};
