import { fail, redirect } from '@sveltejs/kit';
import { desc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, agents, sprints, teams } from '$lib/server/db';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const allTeams = db.select().from(teams).orderBy(desc(teams.createdAt)).all();

	return {
		teams: allTeams.map((team) => ({
			...team,
			tags: JSON.parse(team.tags) as string[],
			agentCount: db.select().from(agents).where(eq(agents.teamId, team.id)).all().length,
			sprintCount: db.select().from(sprints).where(eq(sprints.teamId, team.id)).all().length
		}))
	};
};

export const actions: Actions = {
	createTeam: async ({ request }) => {
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

		redirect(303, `/teams/${id}`);
	}
};
