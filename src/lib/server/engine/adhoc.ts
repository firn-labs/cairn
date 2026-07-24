import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, meetings, messages } from '../db';
import { getLimit } from '../settings';
import {
	agentTurn,
	assertBudget,
	loadAgentContexts,
	loadSprintWorld,
	runDiscussion
} from './meeting';

/**
 * Ad-hoc meetings: an agent calls a short discussion with named teammates
 * outside the SCRUM ceremonies, e.g. to get unblocked mid-work. This is the
 * single write path for `adhoc` meeting rows; both cost guards live here.
 *
 * Ad-hoc chatter is the main token-cost risk of agent-to-agent communication,
 * so it is double-capped: at most `adhocMeetingsPerSprint` meetings per
 * sprint, and each meeting's discussion stops once `adhocMeetingTokenCap`
 * tokens are spent (the requester's wrap-up still runs so there is always a
 * summary). Both caps are instance settings (issue #19), read at call time.
 */

const DISCUSSION_ROUNDS = 2;
const MAX_PURPOSE_CHARS = 1_000;

/** Every started ad-hoc meeting counts against the limit — including failed
 *  ones, which consumed budget too. */
export function adhocMeetingsUsed(sprintId: string): number {
	return db
		.select()
		.from(meetings)
		.where(and(eq(meetings.sprintId, sprintId), eq(meetings.type, 'adhoc')))
		.all().length;
}

/**
 * Runs an ad-hoc meeting to completion and returns its summary. Throws (after
 * marking the meeting row failed) when the request is invalid, the rate limit
 * is hit, or the sprint budget runs out mid-meeting.
 */
export async function runAdhocMeeting(opts: {
	sprintId: string;
	requesterAgentId: string;
	purpose: string;
	participantNames: string[];
}): Promise<string> {
	const purpose = opts.purpose.trim().slice(0, MAX_PURPOSE_CHARS);
	if (!purpose) throw new Error('An ad-hoc meeting needs a stated purpose.');

	const { sprint, team } = loadSprintWorld(opts.sprintId);
	assertBudget(sprint.id);

	const maxPerSprint = getLimit('adhocMeetingsPerSprint');
	const used = adhocMeetingsUsed(sprint.id);
	if (used >= maxPerSprint)
		throw new Error(
			`The ad-hoc meeting limit for this sprint is reached (${used}/${maxPerSprint}).`
		);

	const contexts = await loadAgentContexts(team);
	const requester = contexts.find((c) => c.agent.id === opts.requesterAgentId);
	if (!requester) throw new Error('The requesting agent is not on this team.');

	const wanted = new Set(opts.participantNames.map((n) => n.trim().toLowerCase()).filter(Boolean));
	const invited = contexts.filter(
		(c) => c.agent.id !== requester.agent.id && wanted.has(c.agent.name.toLowerCase())
	);
	if (invited.length === 0) {
		const names = contexts
			.filter((c) => c.agent.id !== requester.agent.id)
			.map((c) => c.agent.name)
			.join(', ');
		throw new Error(`No valid participants — invite at least one teammate by name (${names}).`);
	}

	const meetingId = randomUUID();
	db.insert(meetings).values({ id: meetingId, sprintId: sprint.id, type: 'adhoc' }).run();

	// The stated purpose opens the transcript as the requester's own words —
	// free (it is tool input, not an LLM call) and readable in the meeting UI.
	db.insert(messages)
		.values({
			id: randomUUID(),
			meetingId,
			agentId: requester.agent.id,
			authorName: requester.agent.name,
			content: `I've called this meeting. ${purpose}`
		})
		.run();

	const opening = `# Ad-hoc meeting — called by ${requester.agent.name}

The team is mid-sprint (Sprint ${sprint.number} of team "${team.name}"). This meeting interrupts work and costs budget, so keep it short and drive to a concrete outcome.

## Purpose, as stated by ${requester.agent.name}
${purpose}`;

	try {
		const transcript = await runDiscussion({
			contexts: [requester, ...invited],
			meetingId,
			sprintId: sprint.id,
			opening,
			rounds: DISCUSSION_ROUNDS,
			tokenCap: getLimit('adhocMeetingTokenCap'),
			turnInstruction: (round) =>
				round === 1
					? 'Round 1: Address the stated purpose directly — give your answer, concern or proposal. Nothing else is on the agenda.'
					: 'Round 2: Converge. React to the others and state the concrete answer or decision you support.'
		});

		const wrapUp = await agentTurn({
			ctx: requester,
			meetingId,
			sprintId: sprint.id,
			opening,
			transcript,
			instruction: `You called this meeting, ${requester.agent.name} — now close it. In 2-4 sentences, state the answer or decision the discussion produced (or that it stayed open, and why). This is what you take back to your work.`
		});

		db.update(meetings)
			.set({ status: 'completed', summary: wrapUp.content })
			.where(eq(meetings.id, meetingId))
			.run();
		return wrapUp.content;
	} catch (err) {
		db.update(meetings)
			.set({ status: 'failed', error: err instanceof Error ? err.message : String(err) })
			.where(eq(meetings.id, meetingId))
			.run();
		throw err;
	}
}
