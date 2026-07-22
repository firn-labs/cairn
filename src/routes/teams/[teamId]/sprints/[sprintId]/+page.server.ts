import { error, fail } from '@sveltejs/kit';
import { and, asc, desc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
	db,
	agents,
	backlogItems,
	meetings,
	messages,
	sprints,
	teams,
	workItemRuns,
	workLogs,
	workRuns
} from '$lib/server/db';
import { requireTeamMember, requireTeamPo } from '$lib/server/auth/access';
import { runCeremony } from '$lib/server/engine/ceremonies';
import { openSprintPr } from '$lib/server/engine/sprintPr';
import { runWorkPhase } from '$lib/server/engine/work';
import { isDockerAvailable } from '$lib/server/workspace/docker';
import type { Meeting } from '$lib/server/db/schema';
import type { Actions, PageServerLoad } from './$types';

function runningWorkRun(sprintId: string) {
	return db
		.select()
		.from(workRuns)
		.where(and(eq(workRuns.sprintId, sprintId), eq(workRuns.status, 'running')))
		.get();
}

export const load: PageServerLoad = async ({ params, locals }) => {
	const role = requireTeamMember(locals.user!.id, params.teamId);
	const sprint = db
		.select()
		.from(sprints)
		.where(and(eq(sprints.id, params.sprintId), eq(sprints.teamId, params.teamId)))
		.get();
	if (!sprint) error(404, 'Sprint not found');

	const team = db.select().from(teams).where(eq(teams.id, params.teamId)).get();
	if (!team) error(404, 'Team not found');

	const sprintMeetings = db
		.select()
		.from(meetings)
		.where(eq(meetings.sprintId, sprint.id))
		.orderBy(asc(meetings.createdAt))
		.all();

	const sprintWorkRuns = db
		.select()
		.from(workRuns)
		.where(eq(workRuns.sprintId, sprint.id))
		.orderBy(asc(workRuns.createdAt))
		.all();

	return {
		role,
		sprint,
		team,
		items: db
			.select()
			.from(backlogItems)
			.where(eq(backlogItems.sprintId, sprint.id))
			.orderBy(asc(backlogItems.createdAt))
			.all(),
		meetings: sprintMeetings.map((meeting) => ({
			...meeting,
			messages: db
				.select()
				.from(messages)
				.where(eq(messages.meetingId, meeting.id))
				.orderBy(asc(messages.createdAt))
				.all()
		})),
		workRuns: sprintWorkRuns.map((run) => ({
			...run,
			itemRuns: db
				.select()
				.from(workItemRuns)
				.where(eq(workItemRuns.workRunId, run.id))
				.orderBy(asc(workItemRuns.createdAt))
				.all(),
			// Newest entries first in the query, re-reversed for display.
			logs: db
				.select()
				.from(workLogs)
				.where(eq(workLogs.workRunId, run.id))
				.orderBy(desc(workLogs.createdAt))
				.limit(40)
				.all()
				.reverse()
		})),
		dockerAvailable: await isDockerAvailable(),
		hasDevelopers:
			db
				.select()
				.from(agents)
				.where(and(eq(agents.teamId, team.id), eq(agents.role, 'developer')))
				.all().length > 0
	};
};

/** Which ceremony is allowed in which sprint state. */
const CEREMONY_FOR_STATUS: Record<string, Meeting['type']> = {
	planning: 'planning',
	active: 'review',
	review: 'retrospective'
};

export const actions: Actions = {
	runCeremony: async ({ params, request, locals }) => {
		requireTeamPo(locals.user!.id, params.teamId);
		const form = await request.formData();
		const type = String(form.get('type') ?? '') as Meeting['type'];

		const sprint = db.select().from(sprints).where(eq(sprints.id, params.sprintId)).get();
		if (!sprint) return fail(404, { error: 'Sprint not found.' });

		if (CEREMONY_FOR_STATUS[sprint.status] !== type)
			return fail(400, {
				error: `A ${type} meeting is not possible while the sprint is in "${sprint.status}".`
			});

		const running = db
			.select()
			.from(meetings)
			.where(and(eq(meetings.sprintId, sprint.id), eq(meetings.status, 'running')))
			.all();
		if (running.length > 0) return fail(400, { error: 'A meeting is already running.' });

		if (runningWorkRun(sprint.id))
			return fail(400, { error: 'The team is still working — wait for the work phase to finish.' });

		if (type === 'retrospective') {
			const undecided = db
				.select()
				.from(backlogItems)
				.where(eq(backlogItems.sprintId, sprint.id))
				.all()
				.filter((i) => i.status !== 'accepted' && i.status !== 'rejected');
			if (undecided.length > 0)
				return fail(400, {
					error: 'Accept or reject every sprint item before the retrospective.'
				});
		}

		const meetingId = randomUUID();
		db.insert(meetings).values({ id: meetingId, sprintId: sprint.id, type }).run();

		// Fire and forget: the ceremony runs in the background and writes its
		// outcome to the meeting row; the page polls while status is 'running'.
		void runCeremony(type, meetingId, sprint.id);

		return { ok: true };
	},

	startWork: async ({ params, locals }) => {
		requireTeamPo(locals.user!.id, params.teamId);
		const sprint = db.select().from(sprints).where(eq(sprints.id, params.sprintId)).get();
		if (!sprint) return fail(404, { error: 'Sprint not found.' });
		if (sprint.status !== 'active')
			return fail(400, { error: 'The work phase is only available while the sprint is active.' });

		const meetingRunning = db
			.select()
			.from(meetings)
			.where(and(eq(meetings.sprintId, sprint.id), eq(meetings.status, 'running')))
			.all();
		if (meetingRunning.length > 0) return fail(400, { error: 'A meeting is running.' });
		if (runningWorkRun(sprint.id)) return fail(400, { error: 'A work run is already running.' });

		const openItems = db
			.select()
			.from(backlogItems)
			.where(eq(backlogItems.sprintId, sprint.id))
			.all()
			.filter((i) => i.status === 'selected' || i.status === 'in_progress');
		if (openItems.length === 0)
			return fail(400, { error: 'No open items in the sprint backlog.' });

		const developers = db
			.select()
			.from(agents)
			.where(and(eq(agents.teamId, sprint.teamId), eq(agents.role, 'developer')))
			.all();
		if (developers.length === 0)
			return fail(400, { error: 'The team needs at least one developer agent.' });

		if (!(await isDockerAvailable()))
			return fail(400, {
				error: 'Docker is not reachable — start Docker, or track item status manually below.'
			});

		const workRunId = randomUUID();
		db.insert(workRuns).values({ id: workRunId, sprintId: sprint.id }).run();

		// Fire and forget: the job writes its outcome to the work_runs row;
		// the page polls while status is 'running'.
		void runWorkPhase(workRunId, sprint.id);

		return { ok: true };
	},

	openPr: async ({ params, locals }) => {
		requireTeamPo(locals.user!.id, params.teamId);
		const sprint = db.select().from(sprints).where(eq(sprints.id, params.sprintId)).get();
		if (!sprint) return fail(404, { error: 'Sprint not found.' });
		if (sprint.status !== 'review' && sprint.status !== 'completed')
			return fail(400, { error: 'The pull request is opened with the sprint review.' });

		// A quick hosting API call — fine to await in the action (unlike LLM work).
		try {
			await openSprintPr(sprint.id);
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : String(err) });
		}
		return { ok: true };
	},

	setItemStatus: async ({ params, request, locals }) => {
		requireTeamPo(locals.user!.id, params.teamId);
		const form = await request.formData();
		const id = String(form.get('id') ?? '');
		const status = String(form.get('status') ?? '');

		if (!['selected', 'in_progress', 'done'].includes(status))
			return fail(400, { error: 'Invalid status.' });

		if (runningWorkRun(params.sprintId))
			return fail(400, { error: 'Item status is managed by the running work phase.' });

		db.update(backlogItems)
			.set({ status: status as 'selected' | 'in_progress' | 'done' })
			.where(and(eq(backlogItems.id, id), eq(backlogItems.sprintId, params.sprintId)))
			.run();
		return { ok: true };
	},

	decideItem: async ({ params, request, locals }) => {
		requireTeamPo(locals.user!.id, params.teamId);
		const form = await request.formData();
		const id = String(form.get('id') ?? '');
		const decision = String(form.get('decision') ?? '');

		const sprint = db.select().from(sprints).where(eq(sprints.id, params.sprintId)).get();
		if (!sprint || sprint.status !== 'review')
			return fail(400, { error: 'Items are accepted or rejected after the sprint review.' });

		if (decision === 'accept') {
			db.update(backlogItems)
				.set({ status: 'accepted' })
				.where(and(eq(backlogItems.id, id), eq(backlogItems.sprintId, params.sprintId)))
				.run();
		} else if (decision === 'reject') {
			// Rejected items keep their sprint reference for the retrospective;
			// a copy returns to the product backlog for re-planning.
			const item = db.select().from(backlogItems).where(eq(backlogItems.id, id)).get();
			if (item) {
				db.update(backlogItems).set({ status: 'rejected' }).where(eq(backlogItems.id, id)).run();
				db.insert(backlogItems)
					.values({
						id: randomUUID(),
						teamId: item.teamId,
						title: item.title,
						description: item.description,
						acceptanceCriteria: item.acceptanceCriteria,
						status: 'backlog',
						createdByAgentId: item.createdByAgentId,
						proposalRationale: item.proposalRationale
					})
					.run();
			}
		} else {
			return fail(400, { error: 'Invalid decision.' });
		}
		return { ok: true };
	}
};
