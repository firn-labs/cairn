import { error, fail } from '@sveltejs/kit';
import { and, asc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, backlogItems, meetings, messages, sprints, teams } from '$lib/server/db';
import { runCeremony } from '$lib/server/engine/ceremonies';
import type { Meeting } from '$lib/server/db/schema';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
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

	return {
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
		}))
	};
};

/** Which ceremony is allowed in which sprint state. */
const CEREMONY_FOR_STATUS: Record<string, Meeting['type']> = {
	planning: 'planning',
	active: 'review',
	review: 'retrospective'
};

export const actions: Actions = {
	runCeremony: async ({ params, request }) => {
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

	setItemStatus: async ({ params, request }) => {
		const form = await request.formData();
		const id = String(form.get('id') ?? '');
		const status = String(form.get('status') ?? '');

		if (!['selected', 'in_progress', 'done'].includes(status))
			return fail(400, { error: 'Invalid status.' });

		db.update(backlogItems)
			.set({ status: status as 'selected' | 'in_progress' | 'done' })
			.where(and(eq(backlogItems.id, id), eq(backlogItems.sprintId, params.sprintId)))
			.run();
		return { ok: true };
	},

	decideItem: async ({ params, request }) => {
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
						status: 'backlog'
					})
					.run();
			}
		} else {
			return fail(400, { error: 'Invalid decision.' });
		}
		return { ok: true };
	}
};
