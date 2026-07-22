import { count, isNull } from 'drizzle-orm';
import { db, projects, teamMembers, teams, users } from '../db';

export const userCount = () => db.select({ n: count() }).from(users).get()?.n ?? 0;

/**
 * First-user adoption: everything created before auth existed (or whose owner
 * is otherwise gone) belongs to the instance's first account — it becomes
 * Product Owner of all teams and owner of all projects. Shared by password
 * signup and OIDC login.
 */
export function adoptOrphans(userId: string): void {
	for (const team of db.select({ id: teams.id }).from(teams).all()) {
		db.insert(teamMembers)
			.values({ teamId: team.id, userId, role: 'product_owner' })
			.onConflictDoNothing()
			.run();
	}
	db.update(projects).set({ ownerUserId: userId }).where(isNull(projects.ownerUserId)).run();
}
