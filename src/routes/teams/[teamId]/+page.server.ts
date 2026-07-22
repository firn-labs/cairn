import { error, fail, redirect } from '@sveltejs/kit';
import { and, asc, desc, eq, inArray, ne } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
	db,
	agentMemories,
	agents,
	backlogItems,
	personalityRevisions,
	projects,
	sprints,
	teams
} from '$lib/server/db';
import { providerOptions } from '$lib/server/llm/providers';
import { PROVIDER_LABELS } from '$lib/server/hosting';
import type { Actions, PageServerLoad } from './$types';

const MAX_TEAM_SIZE = 10;

export const load: PageServerLoad = async ({ params }) => {
	const team = db.select().from(teams).where(eq(teams.id, params.teamId)).get();
	if (!team) error(404, 'Team not found');

	const teamAgents = db
		.select()
		.from(agents)
		.where(eq(agents.teamId, team.id))
		.orderBy(asc(agents.createdAt))
		.all();

	// Personality revision history with the sprint number each change came from,
	// so the PO can review every change as a diff on the agent card.
	const revisions =
		teamAgents.length === 0
			? []
			: db
					.select({
						revision: personalityRevisions,
						sprintNumber: sprints.number
					})
					.from(personalityRevisions)
					.leftJoin(sprints, eq(personalityRevisions.sprintId, sprints.id))
					.where(
						inArray(
							personalityRevisions.agentId,
							teamAgents.map((a) => a.id)
						)
					)
					.orderBy(desc(personalityRevisions.createdAt))
					.all();

	// Attribution for agent-created items; agents may be gone by the time the
	// PO looks at an old item, so fall back to a generic label.
	const agentName = (id: string | null) =>
		id ? (teamAgents.find((a) => a.id === id)?.name ?? 'a former agent') : null;
	const withProposer = <T extends { createdByAgentId: string | null }>(item: T) => ({
		...item,
		proposedBy: agentName(item.createdByAgentId)
	});

	return {
		team: { ...team, tags: JSON.parse(team.tags) as string[] },
		agents: teamAgents.map((agent) => ({
			...agent,
			memoryCount: db
				.select()
				.from(agentMemories)
				.where(eq(agentMemories.agentId, agent.id))
				.all().length,
			revisions: revisions
				.filter((r) => r.revision.agentId === agent.id)
				.map((r) => ({ ...r.revision, sprintNumber: r.sprintNumber }))
		})),
		backlog: db
			.select()
			.from(backlogItems)
			.where(and(eq(backlogItems.teamId, team.id), eq(backlogItems.status, 'backlog')))
			.orderBy(asc(backlogItems.createdAt))
			.all()
			.map(withProposer),
		proposals: db
			.select()
			.from(backlogItems)
			.where(and(eq(backlogItems.teamId, team.id), eq(backlogItems.status, 'proposed')))
			.orderBy(asc(backlogItems.createdAt))
			.all()
			.map(withProposer),
		sprints: db
			.select()
			.from(sprints)
			.where(eq(sprints.teamId, team.id))
			.orderBy(desc(sprints.number))
			.all(),
		providers: providerOptions(),
		projects: db
			.select({ id: projects.id, name: projects.name, provider: projects.provider })
			.from(projects)
			.orderBy(asc(projects.name))
			.all()
			.map((p) => ({ ...p, providerLabel: PROVIDER_LABELS[p.provider] }))
	};
};

export const actions: Actions = {
	assignProject: async ({ params, request }) => {
		const form = await request.formData();
		const projectId = String(form.get('projectId') ?? '');

		// Switching repos mid-sprint would rip the workspace out from under the
		// team (the volume is wiped and re-cloned on mismatch) — only allow it
		// between sprints.
		const open = db
			.select()
			.from(sprints)
			.where(and(eq(sprints.teamId, params.teamId), ne(sprints.status, 'completed')))
			.all();
		if (open.length > 0)
			return fail(400, { error: 'Finish the current sprint before changing the project.' });

		if (projectId) {
			const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
			if (!project) return fail(404, { error: 'Project not found.' });
		}

		db.update(teams)
			.set({ projectId: projectId || null })
			.where(eq(teams.id, params.teamId))
			.run();
		return { ok: true };
	},

	addAgent: async ({ params, request }) => {
		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		const role = String(form.get('role') ?? 'developer');
		const provider = String(form.get('provider') ?? '');
		const model = String(form.get('model') ?? '').trim();
		const personality = String(form.get('personality') ?? '').trim();

		if (!name || !provider || !model)
			return fail(400, { error: 'Agent needs a name, a provider and a model.' });
		if (role !== 'developer' && role !== 'scrum_master')
			return fail(400, { error: 'Invalid role.' });

		const existing = db.select().from(agents).where(eq(agents.teamId, params.teamId)).all();
		if (existing.length >= MAX_TEAM_SIZE)
			return fail(400, { error: `A SCRUM team has at most ${MAX_TEAM_SIZE} members.` });
		if (role === 'scrum_master' && existing.some((a) => a.role === 'scrum_master'))
			return fail(400, { error: 'This team already has a Scrum Master.' });

		db.insert(agents)
			.values({ id: randomUUID(), teamId: params.teamId, name, role, provider, model, personality })
			.run();
		return { ok: true };
	},

	togglePin: async ({ params, request }) => {
		const form = await request.formData();
		const agentId = String(form.get('agentId') ?? '');
		const agent = db
			.select()
			.from(agents)
			.where(and(eq(agents.id, agentId), eq(agents.teamId, params.teamId)))
			.get();
		if (!agent) return fail(404, { error: 'Agent not found.' });

		db.update(agents)
			.set({ personalityPinned: !agent.personalityPinned })
			.where(eq(agents.id, agent.id))
			.run();
		return { ok: true };
	},

	addBacklogItem: async ({ params, request }) => {
		const form = await request.formData();
		const title = String(form.get('title') ?? '').trim();
		const description = String(form.get('description') ?? '').trim();
		const acceptanceCriteria = String(form.get('acceptanceCriteria') ?? '').trim();

		if (!title) return fail(400, { error: 'The backlog item needs a title.' });

		db.insert(backlogItems)
			.values({ id: randomUUID(), teamId: params.teamId, title, description, acceptanceCriteria })
			.run();
		return { ok: true };
	},

	// PO review of agent proposals: approving moves the item into the product
	// backlog (only then can planning see it), rejecting removes it.
	approveProposal: async ({ params, request }) => {
		const form = await request.formData();
		const id = String(form.get('id') ?? '');
		const result = db
			.update(backlogItems)
			.set({ status: 'backlog' })
			.where(
				and(
					eq(backlogItems.id, id),
					eq(backlogItems.teamId, params.teamId),
					eq(backlogItems.status, 'proposed')
				)
			)
			.run();
		if (result.changes === 0) return fail(404, { error: 'Proposal not found.' });
		return { ok: true };
	},

	rejectProposal: async ({ params, request }) => {
		const form = await request.formData();
		const id = String(form.get('id') ?? '');
		db.delete(backlogItems)
			.where(
				and(
					eq(backlogItems.id, id),
					eq(backlogItems.teamId, params.teamId),
					eq(backlogItems.status, 'proposed')
				)
			)
			.run();
		return { ok: true };
	},

	deleteBacklogItem: async ({ params, request }) => {
		const form = await request.formData();
		const id = String(form.get('id') ?? '');
		db.delete(backlogItems)
			.where(
				and(
					eq(backlogItems.id, id),
					eq(backlogItems.teamId, params.teamId),
					eq(backlogItems.status, 'backlog')
				)
			)
			.run();
		return { ok: true };
	},

	startSprint: async ({ params, request }) => {
		const form = await request.formData();
		const tokenBudget = Math.max(10000, Number(form.get('tokenBudget') ?? 300000) || 300000);

		const teamAgents = db.select().from(agents).where(eq(agents.teamId, params.teamId)).all();
		if (teamAgents.length < 2)
			return fail(400, { error: 'Add at least two agents before starting a sprint.' });

		const open = db
			.select()
			.from(sprints)
			.where(and(eq(sprints.teamId, params.teamId), ne(sprints.status, 'completed')))
			.all();
		if (open.length > 0)
			return fail(400, { error: 'Finish the current sprint before starting a new one.' });

		const backlog = db
			.select()
			.from(backlogItems)
			.where(and(eq(backlogItems.teamId, params.teamId), eq(backlogItems.status, 'backlog')))
			.all();
		if (backlog.length === 0)
			return fail(400, { error: 'The product backlog is empty — the team has nothing to plan.' });

		const previous = db
			.select()
			.from(sprints)
			.where(eq(sprints.teamId, params.teamId))
			.orderBy(desc(sprints.number))
			.all();
		const number = (previous[0]?.number ?? 0) + 1;

		const id = randomUUID();
		db.insert(sprints).values({ id, teamId: params.teamId, number, tokenBudget }).run();

		redirect(303, `/teams/${params.teamId}/sprints/${id}`);
	}
};
