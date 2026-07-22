import type { Agent, BacklogItem, Team } from '../db/schema';
import { execInWorkspace, type ExecResult, type WorkspaceHandle } from './docker';

/**
 * Git flow inside the workspace (local only — remotes arrive with issue #3):
 * `main` holds the root; each team owns a long-lived team branch; each backlog
 * item is worked on a short-lived task branch cut from the team-branch tip and
 * merged back with --no-ff when the item completes. Items run sequentially, so
 * merges cannot conflict by construction.
 */

const DIFF_CAP_BYTES = 256 * 1024;

function slug(text: string): string {
	return (
		text
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 40) || 'x'
	);
}

export function teamBranch(team: Team): string {
	return `team/${slug(team.name)}-${team.id.slice(0, 8)}`;
}

export function taskBranch(item: BacklogItem): string {
	return `task/${slug(item.title)}-${item.id.slice(0, 8)}`;
}

async function git(handle: WorkspaceHandle, args: string[]): Promise<ExecResult> {
	return execInWorkspace(handle, ['git', ...args], { timeoutMs: 60_000 });
}

async function gitOk(handle: WorkspaceHandle, args: string[]): Promise<ExecResult> {
	const result = await git(handle, args);
	if (result.exitCode !== 0)
		throw new Error(
			`git ${args.join(' ')} failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`
		);
	return result;
}

async function branchExists(handle: WorkspaceHandle, branch: string): Promise<boolean> {
	const result = await git(handle, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
	return result.exitCode === 0;
}

/** Initialize the repo on first use, or just make sure the team branch exists. */
export async function ensureRepo(handle: WorkspaceHandle, team: Team): Promise<void> {
	// The volume is root-owned and shared across container generations.
	await git(handle, ['config', '--global', '--add', 'safe.directory', handle.repoDir]);

	const isRepo = await execInWorkspace(handle, ['test', '-d', `${handle.repoDir}/.git`], {
		cwd: '/workspace'
	});
	if (isRepo.exitCode !== 0) {
		await execInWorkspace(handle, ['mkdir', '-p', handle.repoDir], { cwd: '/workspace' });
		await gitOk(handle, ['init', '-b', 'main']);
		await gitOk(handle, ['config', 'user.name', 'Cairn']);
		await gitOk(handle, ['config', 'user.email', 'cairn@local']);
		await gitOk(handle, ['commit', '--allow-empty', '-m', 'Initial commit']);
	}

	const branch = teamBranch(team);
	if (!(await branchExists(handle, branch))) {
		await gitOk(handle, ['branch', branch, 'main']);
	}
}

/**
 * Cut (or reset) the task branch for an item from the current team-branch tip.
 * `-B` deliberately discards any stale branch from an earlier failed or
 * rejected attempt — re-work starts fresh on top of the current team state.
 */
export async function startItemBranch(
	handle: WorkspaceHandle,
	team: Team,
	item: BacklogItem
): Promise<{ baseCommit: string }> {
	await gitOk(handle, ['checkout', teamBranch(team)]);
	await gitOk(handle, ['checkout', '-B', taskBranch(item)]);
	const head = await gitOk(handle, ['rev-parse', 'HEAD']);
	return { baseCommit: head.stdout.trim() };
}

/** Commit everything in the working tree, authored by the given agent.
 *  Returns the new commit hash, or null if there was nothing to commit. */
export async function commitAs(
	handle: WorkspaceHandle,
	agent: Agent,
	message: string
): Promise<string | null> {
	await gitOk(handle, ['add', '-A']);
	const status = await gitOk(handle, ['status', '--porcelain']);
	if (status.stdout.trim() === '') return null;
	await gitOk(handle, [
		'-c',
		`user.name=${agent.name}`,
		'-c',
		`user.email=${agent.id.slice(0, 8)}@cairn.local`,
		'commit',
		'-m',
		message
	]);
	const head = await gitOk(handle, ['rev-parse', 'HEAD']);
	return head.stdout.trim();
}

/**
 * Capture the review artifacts for an item: full diff, diffstat and commit log
 * against the team-branch tip the task branch started from. Called on the task
 * branch BEFORE merging (and best-effort for failed items).
 */
export async function captureItemResult(
	handle: WorkspaceHandle,
	baseCommit: string
): Promise<{ diff: string; diffStat: string; commitLog: string }> {
	const diff = await execInWorkspace(handle, ['git', 'diff', baseCommit, 'HEAD'], {
		timeoutMs: 60_000,
		maxOutputBytes: DIFF_CAP_BYTES
	});
	const stat = await git(handle, ['diff', '--stat', baseCommit, 'HEAD']);
	const log = await git(handle, ['log', '--oneline', `${baseCommit}..HEAD`]);
	return {
		diff: diff.exitCode === 0 ? diff.stdout : '',
		diffStat: stat.exitCode === 0 ? stat.stdout.trim() : '',
		commitLog: log.exitCode === 0 ? log.stdout.trim() : ''
	};
}

/**
 * Merge the item's task branch back into the team branch (--no-ff, so each
 * item stays visible as one merge bubble). Uncommitted leftovers are
 * safety-committed first so nothing silently leaks into the next item.
 */
export async function mergeItemBranch(
	handle: WorkspaceHandle,
	team: Team,
	item: BacklogItem,
	agent: Agent | null
): Promise<void> {
	const status = await gitOk(handle, ['status', '--porcelain']);
	if (status.stdout.trim() !== '') {
		if (agent) await commitAs(handle, agent, `chore: uncommitted work for "${item.title}"`);
		else {
			await gitOk(handle, ['add', '-A']);
			await gitOk(handle, ['commit', '-m', `chore: uncommitted work for "${item.title}"`]);
		}
	}
	await gitOk(handle, ['checkout', teamBranch(team)]);
	const merge = await git(handle, [
		'merge',
		'--no-ff',
		'-m',
		`Merge ${taskBranch(item)}: ${item.title}`,
		taskBranch(item)
	]);
	if (merge.exitCode !== 0) {
		await git(handle, ['merge', '--abort']);
		throw new Error(`Merge of ${taskBranch(item)} failed: ${merge.stderr || merge.stdout}`);
	}
}
