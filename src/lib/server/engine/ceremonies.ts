import { generateObject } from 'ai';
import { z } from 'zod';
import { and, asc, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, agentMemories, backlogItems, meetings, sprints, workItemRuns, workRuns } from '../db';
import type { BacklogItem, Meeting, WorkItemRun } from '../db/schema';
import { getModel } from '../llm/providers';
import { destroyWorkspace } from '../workspace/docker';
import { agentSystemPrompt, renderTranscript, type AgentContext } from './prompts';
import { loadAgentContexts, loadSprintWorld, runDiscussion, type TranscriptEntry } from './meeting';
import { remoteForTeam } from '../hosting';
import { openSprintPr } from './sprintPr';
import { evolvePersonalities } from './personality';
import { consolidateMemories } from './consolidation';
import { maxProposalsPerSource, proposeBacklogItem } from './backlog';

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
	db.update(meetings).set({ status: 'completed', summary }).where(eq(meetings.id, meetingId)).run();
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

/**
 * Real evidence from the work phase for the review discussion: per item the
 * outcome, commit log, diffstat, the agent's self-report and a diff excerpt.
 * Capped so a big sprint cannot blow up the prompt.
 */
function renderWorkEvidence(sprintId: string, items: BacklogItem[]): string {
	const DIFF_EXCERPT = 3_000;
	const TOTAL_CAP = 24_000;

	const runs = db
		.select({ itemRun: workItemRuns })
		.from(workItemRuns)
		.innerJoin(workRuns, eq(workItemRuns.workRunId, workRuns.id))
		.where(eq(workRuns.sprintId, sprintId))
		.orderBy(asc(workItemRuns.createdAt))
		.all();
	if (runs.length === 0) return '';

	// Newest run per item wins.
	const latest = new Map<string, WorkItemRun>();
	for (const { itemRun } of runs) latest.set(itemRun.backlogItemId, itemRun);

	let total = 0;
	const sections: string[] = [];
	items.forEach((item, i) => {
		const run = latest.get(item.id);
		if (!run) return;
		const diffExcerpt =
			run.diff.length > DIFF_EXCERPT
				? `${run.diff.slice(0, DIFF_EXCERPT)}\n…[diff truncated]`
				: run.diff;
		const section = [
			`### [${i + 1}] ${item.title} — work result: ${run.status}`,
			run.resultNote && `Agent's report: ${run.resultNote}`,
			run.commitLog && `Commits:\n${run.commitLog}`,
			run.diffStat && `Diffstat:\n${run.diffStat}`,
			run.error && `Error: ${run.error}`,
			diffExcerpt && `Diff excerpt:\n\`\`\`\n${diffExcerpt}\n\`\`\``
		]
			.filter(Boolean)
			.join('\n');
		if (total + section.length > TOTAL_CAP) return;
		total += section.length;
		sections.push(section);
	});
	if (sections.length === 0) return '';

	return `\n## Recorded work results (from the team workspace)\n${sections.join('\n\n')}\n`;
}

// ---------------------------------------------------------------------------
// Sprint Review: the team walks through what was (and wasn't) achieved.
// The human PO accepts or rejects items afterwards in the UI.
// ---------------------------------------------------------------------------
async function review(meetingId: string, sprintId: string) {
	const { sprint, team } = loadSprintWorld(sprintId);
	if (sprint.status !== 'active') throw new Error('Sprint is not active.');

	// The workspace is disposable and lives only for the work phase: the review
	// starting is the moment it dies. Best-effort — a missing Docker daemon
	// must never block the ceremony; reconciliation cleans up later.
	await destroyWorkspace(sprintId).catch(() => {});

	const contexts = await loadAgentContexts(team);
	const items = db.select().from(backlogItems).where(eq(backlogItems.sprintId, sprintId)).all();

	const opening = `# Sprint Review — Sprint ${sprint.number} of team "${team.name}"

Sprint goal: ${sprint.goal || '(none was set)'}

## Sprint backlog and current state
${renderItems(items, true)}
${renderWorkEvidence(sprintId, items)}
Walk the Product Owner through the sprint: what was completed and how it meets the acceptance criteria, what was not completed and why, and whether the sprint goal was reached. Base your claims on the recorded work results above where they exist. The Product Owner will accept or reject each item after this meeting — be honest, an overclaimed item that gets rejected hurts the team more than an honest "not done".`;

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

	// With a project connected, the sprint review IS the PR review: open the
	// pull request (team branch → default branch) for the Product Owner now.
	// Non-fatal — a hosting hiccup must not fail the ceremony; the sprint page
	// offers a retry.
	let summary = decision.summary;
	if (remoteForTeam(team)) {
		try {
			const url = await openSprintPr(sprintId, decision.summary);
			summary += `\n\nPull request for this sprint: ${url}`;
		} catch (err) {
			summary += `\n\n(Opening the pull request failed: ${
				err instanceof Error ? err.message : String(err)
			} — you can retry from this page.)`;
		}
	}
	completeMeeting(meetingId, summary);
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

This meeting is for the team, not the Product Owner. Reflect on how you worked together: what went well, what didn't, and what you will concretely change. Give direct, constructive feedback to individual teammates — that is how this team learns.

If the sprint surfaced concrete work the codebase needs — tech debt, refactoring, tooling — name it: the team may propose it as new product backlog items for the Product Owner to prioritize.`;

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
		instruction: `Summarize the retrospective in 3-6 sentences: main learnings, agreed improvements, and any interpersonal feedback worth recording.

Additionally, extract the backlog items the team proposed during the discussion (tech debt, refactoring, tooling — NOT process changes, those belong in the summary). Only include work someone actually raised; attribute each to the teammate who raised it. An empty list is a perfectly fine outcome.`,
		schema: z.object({
			summary: z.string(),
			backlogProposals: z
				.array(
					z.object({
						title: z.string(),
						description: z.string(),
						rationale: z.string().describe('Why the team wants this, in one sentence'),
						proposedByName: z.string().describe('Name of the teammate who raised it')
					})
				)
				.max(maxProposalsPerSource())
		})
	});

	// Agent proposals land as `proposed` for the PO to review — planning never
	// sees them until approved. Attribution falls back to the facilitator when
	// the extracted name matches nobody.
	const facilitator = contexts.find((c) => c.agent.role === 'scrum_master') ?? contexts[0];
	const proposals = decision.backlogProposals.filter((p) => p.title.trim());
	for (const proposal of proposals) {
		const proposer =
			contexts.find(
				(c) => c.agent.name.toLowerCase() === proposal.proposedByName.trim().toLowerCase()
			) ?? facilitator;
		proposeBacklogItem(team.id, proposer.agent, proposal);
	}

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

	// Memory consolidation: agents whose active memories now exceed the prompt
	// window merge them into a smaller, denser set (originals are archived).
	// Best-effort — see engine/consolidation.ts.
	const consolidated = await consolidateMemories({ contexts, sprintId });

	// Personality evolution: with the sprint distilled into memories, each
	// unpinned agent may propose a small edit to its own personality text.
	// Best-effort and guarded against drift — see engine/personality.ts.
	const revised = await evolvePersonalities({ contexts, sprintId, opening, transcript });

	db.update(sprints)
		.set({ status: 'completed', completedAt: new Date() })
		.where(eq(sprints.id, sprintId))
		.run();

	let summary = decision.summary;
	if (proposals.length > 0) {
		summary += `\n\nThe team proposed ${proposals.length} new backlog item${
			proposals.length === 1 ? '' : 's'
		} — review them on the team page.`;
	}
	if (consolidated.length > 0) {
		summary += `\n\nMemory consolidation: ${consolidated.join(', ')} compacted their memories into a denser set.`;
	}
	if (revised.length > 0) {
		summary += `\n\nPersonality updates: ${revised.join(', ')} revised their personality — review the diff on the team page.`;
	}
	completeMeeting(meetingId, summary);
}
