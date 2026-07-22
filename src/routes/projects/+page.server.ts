import { fail } from '@sveltejs/kit';
import { desc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, projects, teams } from '$lib/server/db';
import { inspectRepo, parseRepoUrl, PROVIDER_LABELS } from '$lib/server/hosting';
import { encryptSecret } from '$lib/server/secrets';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const allProjects = db.select().from(projects).orderBy(desc(projects.createdAt)).all();
	const allTeams = db.select().from(teams).all();

	return {
		projects: allProjects.map((project) => ({
			id: project.id,
			name: project.name,
			provider: project.provider,
			providerLabel: PROVIDER_LABELS[project.provider],
			repoUrl: project.repoUrl,
			defaultBranch: project.defaultBranch,
			// The token (even encrypted) never leaves the server.
			teams: allTeams.filter((t) => t.projectId === project.id).map((t) => t.name)
		}))
	};
};

export const actions: Actions = {
	createProject: async ({ request }) => {
		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		const provider = String(form.get('provider') ?? '');
		const repoUrl = String(form.get('repoUrl') ?? '').trim();
		const token = String(form.get('token') ?? '').trim();

		if (!name || !repoUrl || !token)
			return fail(400, { error: 'The project needs a name, a repository URL and a token.' });
		if (provider !== 'github' && provider !== 'gitlab' && provider !== 'codeberg')
			return fail(400, { error: 'Invalid hosting provider.' });

		let defaultBranch: string;
		try {
			parseRepoUrl(repoUrl);
			({ defaultBranch } = await inspectRepo(provider, repoUrl, token));
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : String(err) });
		}

		db.insert(projects)
			.values({
				id: randomUUID(),
				name,
				provider,
				repoUrl,
				defaultBranch,
				tokenCiphertext: encryptSecret(token)
			})
			.run();
		return { ok: true };
	},

	updateToken: async ({ request }) => {
		const form = await request.formData();
		const id = String(form.get('id') ?? '');
		const token = String(form.get('token') ?? '').trim();

		const project = db.select().from(projects).where(eq(projects.id, id)).get();
		if (!project) return fail(404, { error: 'Project not found.' });
		if (!token) return fail(400, { error: 'Enter the new token.' });

		let defaultBranch: string;
		try {
			({ defaultBranch } = await inspectRepo(project.provider, project.repoUrl, token));
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : String(err) });
		}

		db.update(projects)
			.set({ tokenCiphertext: encryptSecret(token), defaultBranch })
			.where(eq(projects.id, id))
			.run();
		return { ok: true };
	},

	deleteProject: async ({ request }) => {
		const form = await request.formData();
		const id = String(form.get('id') ?? '');

		const assigned = db.select().from(teams).where(eq(teams.projectId, id)).all();
		if (assigned.length > 0)
			return fail(400, {
				error: `Unassign the project from ${assigned.map((t) => `"${t.name}"`).join(', ')} first.`
			});

		db.delete(projects).where(eq(projects.id, id)).run();
		return { ok: true };
	}
};
