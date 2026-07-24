import { generateObject } from 'ai';
import { z } from 'zod';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, agentMemories, sprints } from '../db';
import { getModel } from '../llm/providers';
import { agentSystemPrompt, type AgentContext } from './prompts';
import { memoryWindow, recordUsage } from './meeting';

/** A consolidation must compress the whole active set into at most this many
 *  memories — roughly half the prompt window, so there is room to grow again
 *  for many sprints before the next consolidation. */
const CONSOLIDATED_MAX = 12;

/** Hard cap on a single consolidated memory, in characters. A "memory" that
 *  needs more than this is a paragraph smuggling several memories. */
const MAX_MEMORY_CHARS = 300;

const consolidationSchema = z.object({
	memories: z
		.array(z.string())
		.min(1)
		.max(CONSOLIDATED_MAX)
		.describe('Your consolidated memories, each one self-contained sentence in first person.')
});

/**
 * Memory consolidation: once an agent's active memories outgrow the prompt
 * window (the memoryWindow instance setting), older ones would silently fall
 * out. Instead, after the retrospective's distillation, the agent merges its
 * entire active set into a smaller, denser set — keeping the first-person
 * voice — and the
 * originals are archived, never deleted. Guardrails, mirroring personality
 * evolution:
 *
 * - Only runs when the active set actually exceeds the window.
 * - Metered like every other LLM call; when the sprint budget is exhausted,
 *   remaining agents are skipped.
 * - The result must genuinely compress: it is rejected unless it is smaller
 *   than the input and every memory stays within MAX_MEMORY_CHARS.
 * - Archiving the originals and inserting the consolidated set happen in one
 *   transaction, so a crash can never lose memory.
 *
 * Failures never fail the retrospective — consolidation is best-effort and
 * simply retries after the next sprint. Returns the names of agents whose
 * memories were consolidated.
 */
export async function consolidateMemories(opts: {
	contexts: AgentContext[];
	sprintId: string;
}): Promise<string[]> {
	const consolidatedNames: string[] = [];

	for (const ctx of opts.contexts) {
		const { agent } = ctx;

		// Fresh read: the retrospective just distilled new memories, so the
		// context loaded at meeting start is stale by now.
		const active = db
			.select()
			.from(agentMemories)
			.where(and(eq(agentMemories.agentId, agent.id), isNull(agentMemories.archivedAt)))
			.orderBy(asc(agentMemories.createdAt))
			.all();
		if (active.length <= memoryWindow()) continue;

		const sprint = db.select().from(sprints).where(eq(sprints.id, opts.sprintId)).get();
		if (!sprint || sprint.tokensUsed >= sprint.tokenBudget) break;

		try {
			const result = await generateObject({
				model: getModel(agent.provider, agent.model),
				system: agentSystemPrompt(ctx),
				prompt: `You have accumulated ${active.length} memories, more than the ${memoryWindow()} that fit into your working context — without action, your oldest lessons will silently stop reaching you. Consolidate them.

## All your memories, oldest first
${active.map((m, i) => `${i + 1}. ${m.content}`).join('\n')}

---
Rewrite this entire list into at most ${CONSOLIDATED_MAX} memories for your future self. Rules:
- Merge related insights into one denser memory; drop duplicates and lessons that later memories superseded or that you have clearly internalized by now.
- Each memory is a single self-contained sentence in first person, just like the originals.
- Preserve what still shapes how you work: hard-won lessons, feedback about you specifically, and commitments you made to teammates.
- Do not invent anything that is not in the list above.`,
				schema: consolidationSchema
			});

			recordUsage(opts.sprintId, result.usage.inputTokens ?? 0, result.usage.outputTokens ?? 0);

			// A consolidation that does not compress, or that smuggles paragraphs
			// through as "memories", is rejected — the next retro tries again.
			const memories = result.object.memories.map((m) => m.trim()).filter(Boolean);
			if (memories.length === 0 || memories.length >= active.length) continue;
			if (memories.some((m) => m.length > MAX_MEMORY_CHARS)) continue;

			db.transaction((tx) => {
				const now = new Date();
				for (const original of active) {
					tx.update(agentMemories)
						.set({ archivedAt: now })
						.where(eq(agentMemories.id, original.id))
						.run();
				}
				for (const content of memories) {
					tx.insert(agentMemories)
						.values({
							id: randomUUID(),
							agentId: agent.id,
							sprintId: opts.sprintId,
							kind: 'consolidated',
							content
						})
						.run();
				}
			});
			consolidatedNames.push(agent.name);
		} catch (err) {
			console.error(`Memory consolidation for ${agent.name} failed:`, err);
		}
	}

	return consolidatedNames;
}
