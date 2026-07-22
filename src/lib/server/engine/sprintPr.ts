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
 */
export async function openSprintPr(sprintId: string, reviewSummary = ''): Promise<string> {
	const sprint = db.select().from(sprints).where(eq(sprints.id, sprintId)).get();
	if (!sprint) throw new Error('Sprint not found.');
	const team = db.select().from(teams).where(eq(teams.id, sprint.teamId)).get();
	if (!team) throw new Error('Team not found.');
	const remote = remoteForTeam(team);
	if (!remote) throw new Error('The team has no project connected.');

	const items = db.select().from(backlogItems).where(eq(backlogItems.sprintId, sprintId)).all();
	const body = [
		`Sprint ${sprint.number} of team "${team.name}", opened by Cairn.`,
		sprint.goal && `**Sprint goal:** ${sprint.goal}`,
		items.length > 0 &&
			`**Sprint backlog:**\n${items.map((i) => `- ${i.title} — ${i.status}`).join('\n')}`,
		reviewSummary && `**Review summary:**\n${reviewSummary}`
	]
		.filter(Boolean)
		.join('\n\n');

	const pr = await createPullRequest(remote, {
		head: teamBranch(team),
		title: `Sprint ${sprint.number}: ${sprint.goal || team.name}`,
		body
	});
	db.update(sprints).set({ prUrl: pr.url }).where(eq(sprints.id, sprintId)).run();
	return pr.url;
}
