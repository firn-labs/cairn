import { generateObject } from 'ai';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, agents, personalityRevisions, sprints } from '../db';
import { getModel } from '../llm/providers';
import { retainedRatio } from '../../wordDiff';
import { agentSystemPrompt, renderTranscript, type AgentContext } from './prompts';
import { recordUsage, type TranscriptEntry } from './meeting';

/** Hard cap on a personality text, in characters. */
const MAX_PERSONALITY_CHARS = 1200;

/** At least this fraction of the old text must survive a revision (edit, not rewrite). */
const MIN_RETAINED = 0.5;

/** A revision may grow the text by at most 50% (with slack for short texts). */
function maxGrownLength(oldLength: number): number {
	return Math.min(MAX_PERSONALITY_CHARS, Math.max(Math.round(oldLength * 1.5), oldLength + 240));
}

const revisionSchema = z.object({
	revise: z
		.boolean()
		.describe('true only if you genuinely want to change your personality text this sprint'),
	personality: z
		.string()
		.describe('Your complete personality text after the edit (ignored when revise is false).'),
	rationale: z
		.string()
		.describe('One or two sentences for the Product Owner: what changed and why.')
});

/**
 * Personality evolution: after the retrospective, each unpinned agent may
 * propose a small revision of its own personality text based on the feedback
 * it received. Guardrails, in order:
 *
 * - Pinned agents (Product Owner decision) are skipped entirely.
 * - Proposals are metered like every other LLM call; when the sprint budget is
 *   exhausted, remaining agents are skipped.
 * - Bounded drift: a proposal is rejected unless most of the old text survives
 *   (word-level retention >= MIN_RETAINED) and it stays within the length caps.
 *   Growing an empty personality is allowed — that is development, not drift.
 * - Every applied revision is recorded in `personality_revisions` so the PO
 *   can review it as a diff on the team page.
 *
 * Failures here never fail the retrospective — evolution is best-effort.
 * Returns the names of agents whose personality changed.
 */
export async function evolvePersonalities(opts: {
	contexts: AgentContext[];
	sprintId: string;
	opening: string;
	transcript: TranscriptEntry[];
}): Promise<string[]> {
	const revisedNames: string[] = [];

	for (const ctx of opts.contexts) {
		const { agent } = ctx;
		if (agent.personalityPinned) continue;

		const sprint = db.select().from(sprints).where(eq(sprints.id, opts.sprintId)).get();
		if (!sprint || sprint.tokensUsed >= sprint.tokenBudget) break;

		const current = agent.personality.trim();
		try {
			const result = await generateObject({
				model: getModel(agent.provider, agent.model),
				system: agentSystemPrompt(ctx),
				prompt: `${opts.opening}

## The full retrospective discussion
${renderTranscript(opts.transcript)}

---
Your personality text is part of your identity: it is shown to you at the start of every future working session. Right now it reads:

"""
${current || '(empty — you have not written one yet)'}
"""

Based on the feedback you received in this retrospective and your memories, you MAY revise it. Rules:
- This is an EDIT, not a rewrite. Keep the text you still stand behind word for word and change only what this sprint actually changed about you. Large rewrites are rejected automatically.
- Keep it compact (at most ~150 words) and written in second person ("You are…", matching the current style).
- Most sprints change nothing about who you are. If that is the case, set revise to false — do not edit for the sake of editing.`,
				schema: revisionSchema
			});

			recordUsage(opts.sprintId, result.usage.inputTokens ?? 0, result.usage.outputTokens ?? 0);

			if (!result.object.revise) continue;
			const revised = result.object.personality.trim();
			if (!revised || revised === current) continue;

			// Bounded drift: reject rewrites and runaway growth instead of clamping,
			// so what the PO sees in the diff is exactly what the agent wrote.
			if (revised.length > maxGrownLength(current.length)) continue;
			if (current && retainedRatio(current, revised) < MIN_RETAINED) continue;

			db.update(agents).set({ personality: revised }).where(eq(agents.id, agent.id)).run();
			db.insert(personalityRevisions)
				.values({
					id: randomUUID(),
					agentId: agent.id,
					sprintId: opts.sprintId,
					previous: current,
					revised,
					rationale: result.object.rationale.trim()
				})
				.run();
			revisedNames.push(agent.name);
		} catch (err) {
			console.error(`Personality evolution for ${agent.name} failed:`, err);
		}
	}

	return revisedNames;
}
