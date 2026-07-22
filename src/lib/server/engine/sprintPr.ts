import { eq } from 'drizzle-orm';
import { db, backlogItems, sprints, teams } from '../db';
import { createPullRequest, remoteForTeam } from '../hosting';
import { teamBranch } from '../workspace/git';

/**
 * Open the sprint's pull request — team branch into the project's default
 * branch — and record its URL on the sprint. The sprint review IS the PR
 * review: the Product Owner reads, comments and merges on the hosting site;
 * Cairn itself never merges toward the default branch. Idempotent: if the
 * branch pair already has an open PR, its URL is reused.
 *
 * Cross-team items (issue #8) are merged into their shared collab branch, not
 * the team branch, so they get their own PR per collab branch. Both
 * participating teams call this at their reviews; idempotency means the first
 * one opens the PR and the second reuses it.
 */
export async function openSprintPr(sprintId: string, reviewSummary = ''): Promise<string> {
	const sprint = db.select().from(sprints).where(eq(sprints.id, sprintId)).get();
	if (!sprint) throw new Error('Sprint not found.');
	const team = db.select().from(teams).where(eq(teams.id, sprint.teamId)).get();
	if (!team) throw new Error('Team not found.');
	const remote = remoteForTeam(team);
	if (!remote) throw new Error('The team has no project connected.');

	const items = db.select().from(backlogItems).where(eq(backlogItems.sprintId, sprintId)).all();

	// One PR per collab branch that actually received work this sprint.
	const collabBranches = [
		...new Set(
			items
				.filter((i) => i.collabBranch && (i.status === 'done' || i.status === 'accepted'))
				.map((i) => i.collabBranch as string)
		)
	];
	const collabPrs: { branch: string; url: string }[] = [];
	const collabFailures: string[] = [];
	for (const branch of collabBranches) {
		const branchItems = items.filter((i) => i.collabBranch === branch);
		try {
			const pr = await createPullRequest(remote, {
				head: branch,
				title: `Collab: ${branchItems[0].title}`,
				body:
					`Shared cross-team branch \`${branch}\`, opened by Cairn at the sprint review of ` +
					`team "${team.name}" (sprint ${sprint.number}). It may also contain work from other teams.`
			});
			collabPrs.push({ branch, url: pr.url });
		} catch (err) {
			// Non-fatal: e.g. the branch received no commits after all. The team's
			// own sprint PR must still open; the failure is surfaced in its body.
			collabFailures.push(
				`- \`${branch}\` — no PR: ${err instanceof Error ? err.message : String(err)}`
			);
		}
	}

	const body = [
		`Sprint ${sprint.number} of team "${team.name}", opened by Cairn.`,
		sprint.goal && `**Sprint goal:** ${sprint.goal}`,
		items.length > 0 &&
			`**Sprint backlog:**\n${items.map((i) => `- ${i.title} — ${i.status}`).join('\n')}`,
		(collabPrs.length > 0 || collabFailures.length > 0) &&
			`**Cross-team collab branches** (separate pull requests):\n${[
				...collabPrs.map((c) => `- \`${c.branch}\` — ${c.url}`),
				...collabFailures
			].join('\n')}`,
		reviewSummary && `**Review summary:**\n${reviewSummary}`
	]
		.filter(Boolean)
		.join('\n\n');

	let url: string;
	try {
		const pr = await createPullRequest(remote, {
			head: teamBranch(team),
			title: `Sprint ${sprint.number}: ${sprint.goal || team.name}`,
			body
		});
		url = pr.url;
	} catch (err) {
		// A sprint of only collab items leaves the team branch untouched — the
		// hoster refuses an empty PR. The collab PR then IS the sprint's PR.
		if (collabPrs.length === 0) throw err;
		url = collabPrs[0].url;
	}
	db.update(sprints).set({ prUrl: url }).where(eq(sprints.id, sprintId)).run();
	return url;
}
