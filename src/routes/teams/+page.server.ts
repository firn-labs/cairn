import { fail, redirect } from '@sveltejs/kit';
import { desc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, agents, sprints, teamMembers, teams } from '$lib/server/db';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const myTeams = db
		.select({ team: teams, role: teamMembers.role })
		.from(teamMembers)
		.innerJoin(teams, eq(teamMembers.teamId, teams.id))
		.where(eq(teamMembers.userId, locals.user!.id))
		.orderBy(desc(teams.createdAt))
		.all();

	return {
		// Instance viewers (OIDC group mapping) only consume shared teams.
		canCreate: locals.user!.role === 'member',
		teams: myTeams.map(({ team, role }) => ({
			...team,
			role,
			tags: JSON.parse(team.tags) as string[],
			agentCount: db.select().from(agents).where(eq(agents.teamId, team.id)).all().length,
			sprintCount: db.select().from(sprints).where(eq(sprints.teamId, team.id)).all().length
		}))
	};
};

export const actions: Actions = {
	createTeam: async ({ request, locals }) => {
		if (locals.user!.role !== 'member') return fail(403, { error: 'Viewers cannot create teams.' });
		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		const description = String(form.get('description') ?? '').trim();
		const tags = String(form.get('tags') ?? '')
			.split(',')
			.map((t) => t.trim())
			.filter(Boolean);

		if (!name) return fail(400, { error: 'The team needs a name.' });

		const id = randomUUID();
		db.insert(teams)
			.values({ id, name, description, tags: JSON.stringify(tags) })
			.run();
		// The creator is the team's one and only Product Owner.
		db.insert(teamMembers)
			.values({ teamId: id, userId: locals.user!.id, role: 'product_owner' })
			.run();

		redirect(303, `/teams/${id}`);
	}
};
