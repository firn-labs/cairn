import { error } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { db, teamMembers } from '../db';
import type { TeamMember } from '../db/schema';

/**
 * Team authorization. Loads require membership, mutations require the
 * `product_owner` role — always enforce here on the server; hiding buttons in
 * the UI is only polish. A non-member gets 404 (not 403) so the existence of
 * other users' teams is not leaked.
 */

export function getTeamRole(userId: string, teamId: string): TeamMember['role'] | null {
	const row = db
		.select({ role: teamMembers.role })
		.from(teamMembers)
		.where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
		.get();
	return row?.role ?? null;
}

export function requireTeamMember(userId: string, teamId: string): TeamMember['role'] {
	const role = getTeamRole(userId, teamId);
	if (!role) error(404, 'Team not found');
	return role;
}

export function requireTeamPo(userId: string, teamId: string): void {
	if (requireTeamMember(userId, teamId) !== 'product_owner')
		error(403, 'Only the Product Owner can do this.');
}

/**
 * Instance-admin gate for /admin (issue #25). Like teams, non-admins get 404
 * so the admin area's existence is not advertised. Call it in every /admin
 * load AND every /admin form action — actions run before loads, so a layout
 * guard alone would not stop a forged POST.
 */
export function requireAdmin(user: App.Locals['user']): void {
	if (!user?.isAdmin) error(404, 'Not found');
}
