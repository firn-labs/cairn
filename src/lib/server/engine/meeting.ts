import { generateText } from 'ai';
import { and, eq, desc, inArray, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, agents, agentMemories, messages, sprints, teams } from '../db';
import type { Sprint, Team } from '../db/schema';
import { getModel } from '../llm/providers';
import { getLimit } from '../settings';
import { agentSystemPrompt, renderTranscript, type AgentContext } from './prompts';

/** Only the most recent active memories go into the prompt. This is the
 *  "memory overload" guard: memory is curated, not unbounded. Once an agent's
 *  active set outgrows this window, consolidation (engine/consolidation.ts)
 *  compacts it so old lessons are merged instead of silently falling out.
 *  Instance setting (issue #19), read at call time. */
export const memoryWindow = () => getLimit('memoryWindow');

/** Cap on a single meeting contribution, to keep discussions tight. */
const MAX_TURN_TOKENS = 800;

export class BudgetExceededError extends Error {
	constructor(sprint: Sprint) {
		super(
			`Sprint token budget exhausted (${sprint.tokensUsed}/${sprint.tokenBudget}). ` +
				'Raise the budget or complete the sprint.'
		);
	}
}

export async function loadAgentContexts(team: Team): Promise<AgentContext[]> {
	const teamAgents = db.select().from(agents).where(eq(agents.teamId, team.id)).all();
	if (teamAgents.length === 0) return [];

	const allMemories = db
		.select()
		.from(agentMemories)
		.where(
			and(
				inArray(
					agentMemories.agentId,
					teamAgents.map((a) => a.id)
				),
				isNull(agentMemories.archivedAt)
			)
		)
		.orderBy(desc(agentMemories.createdAt))
		.all();

	return teamAgents.map((agent) => ({
		agent,
		team,
		teammates: teamAgents,
		memories: allMemories.filter((m) => m.agentId === agent.id).slice(0, memoryWindow())
	}));
}

export function recordUsage(sprintId: string, inputTokens: number, outputTokens: number) {
	db.update(sprints)
		.set({ tokensUsed: sql`${sprints.tokensUsed} + ${inputTokens + outputTokens}` })
		.where(eq(sprints.id, sprintId))
		.run();
}

export function assertBudget(sprintId: string): Sprint {
	const sprint = db.select().from(sprints).where(eq(sprints.id, sprintId)).get();
	if (!sprint) throw new Error(`Sprint ${sprintId} not found`);
	if (sprint.tokensUsed >= sprint.tokenBudget) throw new BudgetExceededError(sprint);
	return sprint;
}

/** Tokens (input + output) spent in one meeting so far, from its messages. */
export function meetingTokens(meetingId: string): number {
	const row = db
		.select({
			total: sql<number>`coalesce(sum(${messages.inputTokens} + ${messages.outputTokens}), 0)`
		})
		.from(messages)
		.where(eq(messages.meetingId, meetingId))
		.get();
	return row?.total ?? 0;
}

export interface TranscriptEntry {
	agentId: string | null;
	authorName: string;
	content: string;
}

/**
 * One agent takes a turn in a meeting: it sees the opening statement and the
 * transcript so far, speaks, and its contribution is persisted and billed
 * against the sprint budget.
 */
export async function agentTurn(opts: {
	ctx: AgentContext;
	meetingId: string;
	sprintId: string;
	opening: string;
	transcript: TranscriptEntry[];
	instruction: string;
}): Promise<TranscriptEntry> {
	assertBudget(opts.sprintId);

	const { agent } = opts.ctx;
	const result = await generateText({
		model: getModel(agent.provider, agent.model),
		system: agentSystemPrompt(opts.ctx),
		prompt: `${opts.opening}

## Discussion so far
${renderTranscript(opts.transcript)}

---
${opts.instruction}`,
		maxOutputTokens: MAX_TURN_TOKENS
	});

	const entry: TranscriptEntry = {
		agentId: agent.id,
		authorName: agent.name,
		content: result.text.trim()
	};

	db.insert(messages)
		.values({
			id: randomUUID(),
			meetingId: opts.meetingId,
			agentId: agent.id,
			authorName: agent.name,
			content: entry.content,
			inputTokens: result.totalUsage.inputTokens ?? 0,
			outputTokens: result.totalUsage.outputTokens ?? 0
		})
		.run();
	recordUsage(
		opts.sprintId,
		result.totalUsage.inputTokens ?? 0,
		result.totalUsage.outputTokens ?? 0
	);

	return entry;
}

/**
 * Runs a round-robin discussion: every agent speaks once per round, seeing
 * everything said before their turn. The Scrum Master (if present) speaks
 * last in each round so it can steer.
 */
export async function runDiscussion(opts: {
	contexts: AgentContext[];
	meetingId: string;
	sprintId: string;
	opening: string;
	rounds: number;
	turnInstruction: (round: number, totalRounds: number) => string;
	/** Per-meeting spend ceiling: once the meeting's messages have consumed this
	 *  many tokens, remaining turns are skipped (worst-case overshoot: one turn). */
	tokenCap?: number;
}): Promise<TranscriptEntry[]> {
	const speakers = [
		...opts.contexts.filter((c) => c.agent.role !== 'scrum_master'),
		...opts.contexts.filter((c) => c.agent.role === 'scrum_master')
	];

	const transcript: TranscriptEntry[] = [];
	for (let round = 1; round <= opts.rounds; round++) {
		for (const ctx of speakers) {
			if (opts.tokenCap !== undefined && meetingTokens(opts.meetingId) >= opts.tokenCap)
				return transcript;
			const entry = await agentTurn({
				ctx,
				meetingId: opts.meetingId,
				sprintId: opts.sprintId,
				opening: opts.opening,
				transcript,
				instruction: `${opts.turnInstruction(round, opts.rounds)}\n\nIt is now your turn to speak, ${ctx.agent.name}. Reply with only your contribution.`
			});
			transcript.push(entry);
		}
	}
	return transcript;
}

/** Convenience loader used by every ceremony. */
export function loadSprintWorld(sprintId: string) {
	const sprint = db.select().from(sprints).where(eq(sprints.id, sprintId)).get();
	if (!sprint) throw new Error(`Sprint ${sprintId} not found`);
	const team = db.select().from(teams).where(eq(teams.id, sprint.teamId)).get();
	if (!team) throw new Error(`Team ${sprint.teamId} not found`);
	return { sprint, team };
}
