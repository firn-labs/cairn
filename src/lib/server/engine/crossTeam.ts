import { ne } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, backlogItems, teams } from '../db';
import type { Agent, Team } from '../db/schema';
import { collabBranchName } from '../workspace/git';

/**
 * Cross-team collaboration (issue #8). Teams describe themselves via tags,
 * description and an explicit interface ("what we offer, how to ask us");
 * agents discover other teams through that and can request work from them.
 *
 * A request lands in the TARGET team as a `proposed` backlog item — the same
 * funnel as agent proposals, so the receiving team's Product Owner gates it
 * and sprint planning cannot see it before approval. This is the single write
 * path for cross-team requests; keep the invariant here.
 *
 * When both teams work on the same project, a request may establish a shared
 * collab branch: the same `collab/...` branch name is stored on the target
 * item AND on a mirror item in the requesting team, so both sides plan their
 * half and their work runs on the shared branch instead of the team branch.
 */

/** Ceiling per source (one work item run) so an over-eager agent cannot
 *  flood other teams' Product Owners with requests. */
export const MAX_TEAM_REQUESTS_PER_SOURCE = 2;

export interface DiscoveredTeam {
	name: string;
	description: string;
	tags: string[];
	/** The team's self-declared interface; empty if the PO has not written one. */
	interface: string;
	/** True when this team works on the same project — a collab branch is possible. */
	sharesProject: boolean;
}

/** All other teams, as the requesting team's agents are allowed to see them. */
export function discoverTeams(ownTeam: Team): DiscoveredTeam[] {
	return db
		.select()
		.from(teams)
		.where(ne(teams.id, ownTeam.id))
		.all()
		.map((t) => ({
			name: t.name,
			description: t.description,
			tags: JSON.parse(t.tags) as string[],
			interface: t.interface,
			sharesProject: t.projectId !== null && t.projectId === ownTeam.projectId
		}));
}

export interface TeamWorkRequest {
	/** Name of the target team, as returned by discovery. */
	teamName: string;
	title: string;
	description?: string;
	acceptanceCriteria?: string;
	/** Why the requesting team needs this — shown to the receiving PO. */
	rationale?: string;
	/** Ask for a shared collab branch (requires a shared project). */
	collab?: boolean;
}

/**
 * File a work request with another team. Returns a human-readable outcome the
 * requesting agent can act on. Throws on invalid input (unknown team, missing
 * title) — rate limiting is the caller's job, per source.
 */
export function requestTeamWork(ownTeam: Team, agent: Agent, request: TeamWorkRequest): string {
	const title = request.title.trim().slice(0, 200);
	if (!title) throw new Error('A work request needs a title.');

	const wanted = request.teamName.trim().toLowerCase();
	const target = db
		.select()
		.from(teams)
		.where(ne(teams.id, ownTeam.id))
		.all()
		.find((t) => t.name.toLowerCase() === wanted);
	if (!target) {
		const names = db
			.select({ name: teams.name })
			.from(teams)
			.where(ne(teams.id, ownTeam.id))
			.all()
			.map((t) => t.name);
		throw new Error(
			names.length > 0
				? `No team named "${request.teamName}". Teams you can request work from: ${names.join(', ')}.`
				: 'There are no other teams to request work from.'
		);
	}

	const canCollab = ownTeam.projectId !== null && ownTeam.projectId === target.projectId;
	const targetItemId = randomUUID();
	// Derived from the target item so both teams' items carry the identical name.
	const collabBranch = request.collab && canCollab ? collabBranchName(title, targetItemId) : null;

	db.insert(backlogItems)
		.values({
			id: targetItemId,
			teamId: target.id,
			title,
			description: request.description?.trim() ?? '',
			acceptanceCriteria: request.acceptanceCriteria?.trim() ?? '',
			status: 'proposed',
			createdByAgentId: agent.id,
			proposalRationale: request.rationale?.trim() ?? '',
			requestedByTeamId: ownTeam.id,
			collabBranch
		})
		.run();

	if (collabBranch) {
		// The requesting team's half of the feature: same title, same branch,
		// gated by its OWN Product Owner like any other proposal.
		db.insert(backlogItems)
			.values({
				id: randomUUID(),
				teamId: ownTeam.id,
				title,
				description: [
					`Our side of the cross-team feature with team "${target.name}" (shared branch ${collabBranch}).`,
					request.description?.trim() ?? ''
				]
					.filter(Boolean)
					.join('\n\n'),
				acceptanceCriteria: request.acceptanceCriteria?.trim() ?? '',
				status: 'proposed',
				createdByAgentId: agent.id,
				proposalRationale: request.rationale?.trim() ?? '',
				collabBranch
			})
			.run();
	}

	const collabNote = collabBranch
		? ` A shared collab branch ${collabBranch} was set up, and a matching proposal for your own team's side was filed with your Product Owner.`
		: request.collab
			? ' No collab branch was created — the teams do not work on the same project, so there is no shared repository to branch in.'
			: '';
	return (
		`Request "${title}" filed with team "${target.name}". Their Product Owner reviews it ` +
		`before their planning can pick it up — it will not be worked immediately.${collabNote}`
	);
}
