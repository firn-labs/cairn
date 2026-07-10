import { generateObject } from 'ai';
import { z } from 'zod';
import { and, asc, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, agentMemories, backlogItems, meetings, sprints } from '../db';
import type { BacklogItem, Meeting } from '../db/schema';
import { getModel } from '../llm/providers';
import { agentSystemPrompt, renderTranscript, type AgentContext } from './prompts';
import { loadAgentContexts, loadSprintWorld, runDiscussion, type TranscriptEntry } from './meeting';

/**
 * Entry point used by the web layer. Runs in the background (the form action
 * does not await it); all outcomes — success or failure — are written to the
 * meeting row so the UI can poll for them.
 */
export async function runCeremony(
	type: Meeting['type'],
	meetingId: string,
	sprintId: string
): Promise<void> {
	try {
		if (type === 'planning') await planning(meetingId, sprintId);
		else if (type === 'review') await review(meetingId, sprintId);
		else if (type === 'retrospective') await retrospective(meetingId, sprintId);
		else throw new Error(`Unsupported ceremony type: ${type}`);
	} catch (err) {
		console.error(`Ceremony ${type} (${meetingId}) failed:`, err);
		db.update(meetings)
			.set({ status: 'failed', error: err instanceof Error ? err.message : String(err) })
			.where(eq(meetings.id, meetingId))
			.run();
	}
}

/** The Scrum Master (or first agent, as fallback) produces a structured decision. */
async function facilitatorDecision<T extends z.ZodType>(opts: {
	contexts: AgentContext[];
	sprintId: string;
	opening: string;
	transcript: TranscriptEntry[];
	instruction: string;
	schema: T;
}): Promise<z.infer<T>> {
	const facilitator =
		opts.contexts.find((c) => c.agent.role === 'scrum_master') ?? opts.contexts[0];

	const result = await generateObject({
		model: getModel(facilitator.agent.provider, facilitator.agent.model),
		system: agentSystemPrompt(facilitator),
		prompt: `${opts.opening}

## Discussion so far
${renderTranscript(opts.transcript)}

---
${opts.instruction}`,
		schema: opts.schema
	});

	db.update(sprints)
		.set({
			tokensUsed: sql`${sprints.tokensUsed} + ${
				(result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0)
			}`
		})
		.where(eq(sprints.id, opts.sprintId))
		.run();

	return result.object as z.infer<T>;
}

function completeMeeting(meetingId: string, summary: string) {
	db.update(meetings)
		.set({ status: 'completed', summary })
		.where(eq(meetings.id, meetingId))
		.run();
}

function renderItems(items: BacklogItem[], withStatus = false): string {
	if (items.length === 0) return '(empty)';
	return items
		.map((item, i) => {
			const head = `[${i + 1}] ${item.title}${withStatus ? ` — status: ${item.status}` : ''}`;
			const body = [
				item.description && `    ${item.description}`,
				item.acceptanceCriteria && `    Acceptance criteria: ${item.acceptanceCriteria}`
			]
				.filter(Boolean)
				.join('\n');
			return body ? `${head}\n${body}` : head;
		})
		.join('\n');
}

// ---------------------------------------------------------------------------
// Sprint Planning: the team pulls items from the product backlog and agrees
// on a sprint goal. Outcome: selected items, goal, sprint becomes active.
// ---------------------------------------------------------------------------
async function planning(meetingId: string, sprintId: string) {
	const { sprint, team } = loadSprintWorld(sprintId);
	if (sprint.status !== 'planning') throw new Error('Sprint is not in the planning phase.');

	const contexts = await loadAgentContexts(team);
	if (contexts.length === 0) throw new Error('The team has no agents yet.');

	const backlog = db
		.select()
		.from(backlogItems)
		.where(and(eq(backlogItems.teamId, team.id), eq(backlogItems.status, 'backlog')))
		.orderBy(asc(backlogItems.createdAt))
		.all();
	if (backlog.length === 0) throw new Error('The product backlog is empty — add items first.');

	const opening = `# Sprint Planning — Sprint ${sprint.number} of team "${team.name}"

The Product Owner has prioritized the following product backlog. Your job as a team:
1. Decide which items you can realistically complete this sprint.
2. Agree on a single, concrete sprint goal that ties the selection together.

## Product backlog
${renderItems(backlog)}

Consider dependencies between items, your past experience, and quality — an honest small commitment beats an overpromise.`;

	const transcript = await runDiscussion({
		contexts,
		meetingId,
		sprintId,
		opening,
		rounds: 2,
		turnInstruction: (round) =>
			round === 1
				? 'Round 1: Give your assessment — which items should be in the sprint, which not, and why. Propose a sprint goal if you have one.'
				: 'Round 2: React to your teammates and converge. State your final position: exact item numbers and the sprint goal you support.'
	});

	const decision = await facilitatorDecision({
		contexts,
		sprintId,
		opening,
		transcript,
		instruction:
			'As the facilitator, finalize the planning outcome the team converged on. Select the item numbers the team committed to and formulate the sprint goal. Summarize the meeting in 3-5 sentences, mentioning notable disagreements and how they were resolved.',
		schema: z.object({
			sprintGoal: z.string(),
			selectedItemNumbers: z.array(z.number().int().min(1)),
			summary: z.string()
		})
	});

	const selected = decision.selectedItemNumbers
		.map((n) => backlog[n - 1])
		.filter((item): item is BacklogItem => Boolean(item));
	if (selected.length === 0) throw new Error('Planning produced no selected items.');

	for (const item of selected) {
		db.update(backlogItems)
			.set({ sprintId, status: 'selected' })
			.where(eq(backlogItems.id, item.id))
			.run();
	}
	db.update(sprints)
		.set({ goal: decision.sprintGoal, status: 'active' })
		.where(eq(sprints.id, sprintId))
		.run();
	completeMeeting(meetingId, decision.summary);
}

// ---------------------------------------------------------------------------
// Sprint Review: the team walks through what was (and wasn't) achieved.
// The human PO accepts or rejects items afterwards in the UI.
// ---------------------------------------------------------------------------
async function review(meetingId: string, sprintId: string) {
	const { sprint, team } = loadSprintWorld(sprintId);
	if (sprint.status !== 'active') throw new Error('Sprint is not active.');

	const contexts = await loadAgentContexts(team);
	const items = db.select().from(backlogItems).where(eq(backlogItems.sprintId, sprintId)).all();

	const opening = `# Sprint Review — Sprint ${sprint.number} of team "${team.name}"

Sprint goal: ${sprint.goal || '(none was set)'}

## Sprint backlog and current state
${renderItems(items, true)}

Walk the Product Owner through the sprint: what was completed and how it meets the acceptance criteria, what was not completed and why, and whether the sprint goal was reached. The Product Owner will accept or reject each item after this meeting — be honest, an overclaimed item that gets rejected hurts the team more than an honest "not done".`;

	const transcript = await runDiscussion({
		contexts,
		meetingId,
		sprintId,
		opening,
		rounds: 1,
		turnInstruction: () =>
			'Present your view of the sprint results to the Product Owner. Cover the items you were closest to, and give your honest assessment of whether the sprint goal was reached.'
	});

	const decision = await facilitatorDecision({
		contexts,
		sprintId,
		opening,
		transcript,
		instruction:
			'Summarize the sprint review for the Product Owner in 4-8 sentences: what was delivered, what was not, whether the sprint goal was reached, and anything the PO should look at closely before accepting items.',
		schema: z.object({ summary: z.string() })
	});

	db.update(sprints).set({ status: 'review' }).where(eq(sprints.id, sprintId)).run();
	completeMeeting(meetingId, decision.summary);
}

// ---------------------------------------------------------------------------
// Retrospective: the team reflects, gives each other feedback, and then each
// agent distills the sprint into a few memories. Only these distilled
// insights survive — full transcripts are never carried into future sprints.
// ---------------------------------------------------------------------------
async function retrospective(meetingId: string, sprintId: string) {
	const { sprint, team } = loadSprintWorld(sprintId);
	if (sprint.status !== 'review') throw new Error('Run the sprint review first.');

	const contexts = await loadAgentContexts(team);
	const items = db.select().from(backlogItems).where(eq(backlogItems.sprintId, sprintId)).all();
	const accepted = items.filter((i) => i.status === 'accepted').length;

	const opening = `# Retrospective — Sprint ${sprint.number} of team "${team.name}"

Sprint goal: ${sprint.goal || '(none was set)'}
Outcome: ${accepted} of ${items.length} items accepted by the Product Owner.

## Final item states
${renderItems(items, true)}

This meeting is for the team, not the Product Owner. Reflect on how you worked together: what went well, what didn't, and what you will concretely change. Give direct, constructive feedback to individual teammates — that is how this team learns.`;

	const transcript = await runDiscussion({
		contexts,
		meetingId,
		sprintId,
		opening,
		rounds: 2,
		turnInstruction: (round) =>
			round === 1
				? 'Round 1: What went well this sprint, and what did not? Name at least one concrete observation about how the team (or a specific teammate) worked.'
				: 'Round 2: React to the feedback you received. Agree on concrete improvements for the next sprint, and thank or challenge teammates by name where deserved.'
	});

	const decision = await facilitatorDecision({
		contexts,
		sprintId,
		opening,
		transcript,
		instruction:
			'Summarize the retrospective in 3-6 sentences: main learnings, agreed improvements, and any interpersonal feedback worth recording.',
		schema: z.object({ summary: z.string() })
	});

	// Memory distillation: each agent compresses the sprint into 1-3 insights.
	for (const ctx of contexts) {
		const distilled = await generateObject({
			model: getModel(ctx.agent.provider, ctx.agent.model),
			system: agentSystemPrompt(ctx),
			prompt: `${opening}

## The full retrospective discussion
${renderTranscript(transcript)}

---
The sprint is over. Distill it into memories for your future self. Rules:
- 1 to 3 insights, each a single self-contained sentence in first person.
- Keep only what will genuinely change how you work in FUTURE sprints (lessons, feedback you received, what worked). Everything else is deliberately forgotten.
- Do not repeat memories you already have.`,
			schema: z.object({ insights: z.array(z.string()).min(1).max(3) })
		});

		db.update(sprints)
			.set({
				tokensUsed: sql`${sprints.tokensUsed} + ${
					(distilled.usage.inputTokens ?? 0) + (distilled.usage.outputTokens ?? 0)
				}`
			})
			.where(eq(sprints.id, sprintId))
			.run();

		for (const insight of distilled.object.insights) {
			db.insert(agentMemories)
				.values({
					id: randomUUID(),
					agentId: ctx.agent.id,
					sprintId,
					kind: 'retro_insight',
					content: insight
				})
				.run();
		}
	}

	db.update(sprints)
		.set({ status: 'completed', completedAt: new Date() })
		.where(eq(sprints.id, sprintId))
		.run();
	completeMeeting(meetingId, decision.summary);
}
