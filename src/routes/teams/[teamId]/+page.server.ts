import { error, fail, redirect } from '@sveltejs/kit';
import { and, asc, desc, eq, inArray, isNull, ne } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
	db,
	agentMemories,
	agents,
	backlogItems,
	personalityRevisions,
	projects,
	sprints,
	teamMembers,
	teams,
	users
} from '$lib/server/db';
import { requireTeamMember, requireTeamPo } from '$lib/server/auth/access';
import { providerOptions } from '$lib/server/llm/providers';
import { PROVIDER_LABELS } from '$lib/server/hosting';
import { EXECUTOR_IDS, EXECUTOR_OPTIONS, parseExecutorConfig } from '$lib/server/engine/executor';
import { credentialStatus } from '$lib/server/executorCredentials';
import type { Actions, PageServerLoad } from './$types';

const MAX_TEAM_SIZE = 10;

export const load: PageServerLoad = async ({ params, locals }) => {
	const role = requireTeamMember(locals.user!.id, params.teamId);
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
	// PO looks at an old item, so fall back to a generic label. Cross-team
	// requests are attributed to the requesting TEAM, not its (foreign) agent.
	const teamNames = new Map(
		db
			.select({ id: teams.id, name: teams.name })
			.from(teams)
			.all()
			.map((t) => [t.id, t.name])
	);
	const agentName = (id: string | null) =>
		id ? (teamAgents.find((a) => a.id === id)?.name ?? 'a former agent') : null;
	const withProposer = <
		T extends { createdByAgentId: string | null; requestedByTeamId: string | null }
	>(
		item: T
	) => ({
		...item,
		proposedBy: agentName(item.createdByAgentId),
		requestedByTeam: item.requestedByTeamId
			? (teamNames.get(item.requestedByTeamId) ?? 'a former team')
			: null
	});

	return {
		role,
		members: db
			.select({
				userId: teamMembers.userId,
				role: teamMembers.role,
				email: users.email,
				name: users.name
			})
			.from(teamMembers)
			.innerJoin(users, eq(teamMembers.userId, users.id))
			.where(eq(teamMembers.teamId, team.id))
			.orderBy(asc(teamMembers.createdAt))
			.all(),
		team: { ...team, tags: JSON.parse(team.tags) as string[] },
		agents: teamAgents.map((agent) => ({
			...agent,
			memoryCount: db
				.select()
				.from(agentMemories)
				.where(and(eq(agentMemories.agentId, agent.id), isNull(agentMemories.archivedAt)))
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
		executorOptions: EXECUTOR_OPTIONS,
		executorConfig: (() => {
			const config = parseExecutorConfig(team.executorConfig);
			return {
				...config,
				extraEnvText: Object.entries(config.extraEnv ?? {})
					.map(([key, value]) => `${key}=${value}`)
					.join('\n')
			};
		})(),
		/** Which executor credentials the viewing user has stored (for hints). */
		myCredentialKinds: credentialStatus(locals.user!.id).map((c) => c.kind),
		// Only the viewing user's own projects — assignProject enforces the same.
		projects: db
			.select({ id: projects.id, name: projects.name, provider: projects.provider })
			.from(projects)
			.where(eq(projects.ownerUserId, locals.user!.id))
			.orderBy(asc(projects.name))
			.all()
			.map((p) => ({ ...p, providerLabel: PROVIDER_LABELS[p.provider] }))
	};
};

export const actions: Actions = {
	assignProject: async ({ params, request, locals }) => {
		requireTeamPo(locals.user!.id, params.teamId);
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
			// Only the PO's own projects — a project carries its owner's repo token.
			const project = db
				.select()
				.from(projects)
				.where(and(eq(projects.id, projectId), eq(projects.ownerUserId, locals.user!.id)))
				.get();
			if (!project) return fail(404, { error: 'Project not found.' });
		}

		db.update(teams)
			.set({ projectId: projectId || null })
			.where(eq(teams.id, params.teamId))
			.run();
		return { ok: true };
	},

	// Which executor implements backlog items for this team (issue #12), plus
	// its settings. Takes effect on the next work run; no sprint guard needed.
	saveExecutor: async ({ params, request, locals }) => {
		requireTeamPo(locals.user!.id, params.teamId);
		const form = await request.formData();
		const executor = String(form.get('executor') ?? '');
		if (executor !== '' && !EXECUTOR_IDS.includes(executor))
			return fail(400, { error: 'Unknown executor.' });

		const timeoutRaw = String(form.get('timeoutMinutes') ?? '').trim();
		const timeoutMinutes = timeoutRaw === '' ? undefined : Number(timeoutRaw);
		if (timeoutMinutes !== undefined && (!Number.isFinite(timeoutMinutes) || timeoutMinutes < 5))
			return fail(400, { error: 'The time limit must be at least 5 minutes.' });

		const extraEnv: Record<string, string> = {};
		for (const line of String(form.get('extraEnv') ?? '')
			.split(/\r?\n/)
			.map((l) => l.trim())
			.filter(Boolean)) {
			const idx = line.indexOf('=');
			const key = idx > 0 ? line.slice(0, idx).trim() : '';
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
				return fail(400, { error: `Invalid environment line "${line}" — use KEY=value.` });
			extraEnv[key] = line.slice(idx + 1);
		}

		const config = {
			model: String(form.get('model') ?? '').trim() || undefined,
			baseUrl: String(form.get('baseUrl') ?? '').trim() || undefined,
			timeoutMinutes,
			extraEnv: Object.keys(extraEnv).length > 0 ? extraEnv : undefined
		};
		db.update(teams)
			.set({ executor, executorConfig: JSON.stringify(config) })
			.where(eq(teams.id, params.teamId))
			.run();
		return { ok: true };
	},

	// The team's interface toward other teams: what it offers and how to phrase
	// a request. Shown to other teams' agents by the discoverTeams tool.
	saveInterface: async ({ params, request, locals }) => {
		requireTeamPo(locals.user!.id, params.teamId);
		const form = await request.formData();
		const value = String(form.get('interface') ?? '').trim();
		db.update(teams).set({ interface: value }).where(eq(teams.id, params.teamId)).run();
		return { ok: true };
	},

	addAgent: async ({ params, request, locals }) => {
		requireTeamPo(locals.user!.id, params.teamId);
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

	togglePin: async ({ params, request, locals }) => {
		requireTeamPo(locals.user!.id, params.teamId);
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

	addBacklogItem: async ({ params, request, locals }) => {
		requireTeamPo(locals.user!.id, params.teamId);
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
	approveProposal: async ({ params, request, locals }) => {
		requireTeamPo(locals.user!.id, params.teamId);
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

	rejectProposal: async ({ params, request, locals }) => {
		requireTeamPo(locals.user!.id, params.teamId);
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

	deleteBacklogItem: async ({ params, request, locals }) => {
		requireTeamPo(locals.user!.id, params.teamId);
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

	startSprint: async ({ params, request, locals }) => {
		requireTeamPo(locals.user!.id, params.teamId);
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
	},

	// Sharing: the PO invites existing users as read-only viewers. The PO role
	// itself is never granted here — exactly one PO per team, by construction.
	addMember: async ({ params, request, locals }) => {
		requireTeamPo(locals.user!.id, params.teamId);
		const form = await request.formData();
		const email = String(form.get('email') ?? '')
			.trim()
			.toLowerCase();

		const user = db.select().from(users).where(eq(users.email, email)).get();
		if (!user)
			return fail(404, {
				error: 'No user with this email — they need an account on this instance first.'
			});
		if (user.id === locals.user!.id)
			return fail(400, { error: 'You are already the Product Owner of this team.' });

		const existing = db
			.select()
			.from(teamMembers)
			.where(and(eq(teamMembers.teamId, params.teamId), eq(teamMembers.userId, user.id)))
			.get();
		if (existing) return fail(400, { error: 'Already a member of this team.' });

		db.insert(teamMembers)
			.values({ teamId: params.teamId, userId: user.id, role: 'viewer' })
			.run();
		return { ok: true };
	},

	removeMember: async ({ params, request, locals }) => {
		requireTeamPo(locals.user!.id, params.teamId);
		const form = await request.formData();
		const userId = String(form.get('userId') ?? '');

		// Only viewers can be removed — the PO row stays, so the team always
		// has exactly one Product Owner.
		const result = db
			.delete(teamMembers)
			.where(
				and(
					eq(teamMembers.teamId, params.teamId),
					eq(teamMembers.userId, userId),
					eq(teamMembers.role, 'viewer')
				)
			)
			.run();
		if (result.changes === 0) return fail(404, { error: 'Viewer not found.' });
		return { ok: true };
	}
};
