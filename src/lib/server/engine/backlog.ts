import { randomUUID } from 'node:crypto';
import { db, backlogItems } from '../db';
import type { Agent } from '../db/schema';

/**
 * Agent-created backlog items. Every proposal enters the funnel as `proposed`
 * — never `backlog`, never attached to a sprint — so it is invisible to sprint
 * planning until the Product Owner approves it on the team page. This is the
 * single write path for agent proposals; keep the invariant here.
 */

/** Ceiling per source (one work item run / one retrospective) to keep an
 *  over-eager agent from flooding the PO's review queue. */
export const MAX_PROPOSALS_PER_SOURCE = 3;

export interface BacklogProposal {
	title: string;
	description?: string;
	acceptanceCriteria?: string;
	rationale?: string;
}

export function proposeBacklogItem(teamId: string, agent: Agent, proposal: BacklogProposal): void {
	const title = proposal.title.trim().slice(0, 200);
	if (!title) throw new Error('A backlog proposal needs a title.');

	db.insert(backlogItems)
		.values({
			id: randomUUID(),
			teamId,
			title,
			description: proposal.description?.trim() ?? '',
			acceptanceCriteria: proposal.acceptanceCriteria?.trim() ?? '',
			status: 'proposed',
			createdByAgentId: agent.id,
			proposalRationale: proposal.rationale?.trim() ?? ''
		})
		.run();
}
