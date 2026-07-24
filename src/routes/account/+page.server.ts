import { fail } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { db, oidcAccounts, users } from '$lib/server/db';
import { hashPassword, verifyPassword } from '$lib/server/auth/password';
import {
	enabledSsoProviders,
	ENV_PROVIDER_ID,
	listSsoProviders,
	ssoStartPath
} from '$lib/server/auth/ssoProviders';
import type { Actions, PageServerLoad } from './$types';

/**
 * Account settings (issue #25): every user sees their linked SSO identities,
 * can link further providers (the OIDC flow with ?link=1 attaches the subject
 * to the logged-in user — the way in when the IdP email differs from the
 * account email), unlink them, and password users can change their password.
 */
export const load: PageServerLoad = async ({ locals }) => {
	const me = db.select().from(users).where(eq(users.id, locals.user!.id)).get()!;
	const links = db.select().from(oidcAccounts).where(eq(oidcAccounts.userId, me.id)).all();

	// Labels for linked rows: current providers first; rows pointing at the
	// no-longer-active env fallback still render, just marked inactive.
	const providers = listSsoProviders();
	const labelOf = (providerId: string): { label: string; active: boolean } => {
		const p = providers.find((p) => p.id === providerId);
		if (p) return { label: p.label, active: p.enabled };
		return {
			label: providerId === ENV_PROVIDER_ID ? 'Environment SSO (inactive)' : 'Removed provider',
			active: false
		};
	};

	const hasPassword = me.passwordHash !== 'oidc';
	return {
		hasPassword,
		linked: links.map((l) => ({
			providerId: l.providerId,
			subject: l.subject,
			createdAt: l.createdAt,
			...labelOf(l.providerId)
		})),
		linkable: enabledSsoProviders().map((p) => ({
			id: p.id,
			label: p.label,
			linkPath: `${ssoStartPath(p.id)}?link=1`
		})),
		// Unlinking must never remove the last way into the account.
		canUnlink: hasPassword || links.length > 1
	};
};

export const actions: Actions = {
	changePassword: async ({ request, locals }) => {
		const me = db.select().from(users).where(eq(users.id, locals.user!.id)).get()!;
		if (me.passwordHash === 'oidc')
			return fail(400, {
				error: 'This account has no password — it signs in via SSO.'
			});

		const form = await request.formData();
		const current = String(form.get('currentPassword') ?? '');
		const next = String(form.get('newPassword') ?? '');

		if (!(await verifyPassword(current, me.passwordHash)))
			return fail(400, { error: 'The current password is wrong.' });
		if (next.length < 8)
			return fail(400, {
				error: 'The new password needs at least 8 characters.'
			});

		db.update(users)
			.set({ passwordHash: await hashPassword(next) })
			.where(eq(users.id, me.id))
			.run();
		return { ok: true, message: 'Password changed.' };
	},

	unlink: async ({ request, locals }) => {
		const me = db.select().from(users).where(eq(users.id, locals.user!.id)).get()!;
		const form = await request.formData();
		const providerId = String(form.get('providerId') ?? '');
		const subject = String(form.get('subject') ?? '');

		const links = db.select().from(oidcAccounts).where(eq(oidcAccounts.userId, me.id)).all();
		const target = links.find((l) => l.providerId === providerId && l.subject === subject);
		if (!target)
			return fail(404, {
				error: 'This identity is not linked to your account.'
			});

		// Keep at least one way in: a password, or another linked identity.
		if (me.passwordHash === 'oidc' && links.length <= 1)
			return fail(400, {
				error:
					'This is the only way into your account — set a password or link another provider first.'
			});

		db.delete(oidcAccounts)
			.where(
				and(
					eq(oidcAccounts.userId, me.id),
					eq(oidcAccounts.providerId, providerId),
					eq(oidcAccounts.subject, subject)
				)
			)
			.run();
		return { ok: true, message: 'Identity unlinked.' };
	}
};
