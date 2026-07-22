import type { Agent, BacklogItem, Team } from '../db/schema';
import { cloneUrl, gitAuthHeader, type HostingRemote } from '../hosting';
import { execInWorkspace, type ExecResult, type WorkspaceHandle } from './docker';

/**
 * Git flow inside the workspace: each team owns a long-lived team branch; each
 * backlog item is worked on a short-lived task branch cut from the team-branch
 * tip and merged back with --no-ff when the item completes. Items run
 * sequentially, so merges cannot conflict by construction.
 *
 * With a project connected (issue #3) the repo is a clone of the hosting
 * remote: the team branch is pushed after every item merge, and the sprint
 * review opens a PR toward the default branch. Auth is injected per git
 * invocation via `-c http.extraHeader` — the token never lands in the
 * container's env, the repo config, or anywhere else agents can read, which
 * also means agents themselves cannot push (let alone force-push or touch the
 * default branch).
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

/** Auth for one git invocation against the hosting remote (see module docs). */
function authFlags(remote: HostingRemote): string[] {
	return ['-c', `http.extraHeader=${gitAuthHeader(remote)}`];
}

/** Network git operations get auth flags and a generous timeout. */
async function gitRemoteOk(
	handle: WorkspaceHandle,
	remote: HostingRemote,
	args: string[],
	cwd?: string
): Promise<ExecResult> {
	const result = await execInWorkspace(handle, ['git', ...authFlags(remote), ...args], {
		timeoutMs: 300_000,
		...(cwd ? { cwd } : {})
	});
	if (result.exitCode !== 0) {
		// Never echo the auth header back in errors.
		const detail = (result.stderr || result.stdout).replace(/Basic [A-Za-z0-9+/=]+/g, 'Basic ***');
		throw new Error(`git ${args.join(' ')} failed (exit ${result.exitCode}): ${detail}`);
	}
	return result;
}

async function branchExists(handle: WorkspaceHandle, branch: string): Promise<boolean> {
	const result = await git(handle, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
	return result.exitCode === 0;
}

async function remoteBranchExists(handle: WorkspaceHandle, branch: string): Promise<boolean> {
	const result = await git(handle, [
		'rev-parse',
		'--verify',
		'--quiet',
		`refs/remotes/origin/${branch}`
	]);
	return result.exitCode === 0;
}

/**
 * Initialize the repo on first use and make sure the team branch exists.
 * Without a remote this is a local `git init`; with one, a clone of the
 * project repo, synced with the remote team branch. If the volume holds a
 * repo for a different remote (the team's project was changed), it is wiped
 * and re-cloned — connecting a project means work happens in THAT repo.
 */
export async function ensureRepo(
	handle: WorkspaceHandle,
	team: Team,
	remote?: HostingRemote | null,
	log?: (msg: string) => void
): Promise<void> {
	// The volume is root-owned and shared across container generations.
	await git(handle, ['config', '--global', '--add', 'safe.directory', handle.repoDir]);

	let isRepo =
		(await execInWorkspace(handle, ['test', '-d', `${handle.repoDir}/.git`], { cwd: '/workspace' }))
			.exitCode === 0;

	if (remote) {
		const expectedUrl = cloneUrl(remote.project);
		if (isRepo) {
			const origin = await git(handle, ['remote', 'get-url', 'origin']);
			if (origin.exitCode !== 0 || origin.stdout.trim() !== expectedUrl) {
				log?.('Workspace repo does not match the connected project — re-cloning.');
				await execInWorkspace(handle, ['rm', '-rf', handle.repoDir], { cwd: '/workspace' });
				isRepo = false;
			}
		}
		if (!isRepo) {
			log?.(`Cloning ${remote.project.repoUrl}…`);
			await gitRemoteOk(handle, remote, ['clone', expectedUrl, handle.repoDir], '/workspace');
			await gitOk(handle, ['config', 'user.name', 'Cairn']);
			await gitOk(handle, ['config', 'user.email', 'cairn@local']);
		}
		await gitRemoteOk(handle, remote, ['fetch', '--prune', 'origin']);
		await syncTeamBranch(handle, team, remote);
		return;
	}

	if (!isRepo) {
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
 * Reconcile the local team branch with the remote one: create it from the
 * remote default branch on first contact (and push it so it exists on the
 * hoster), fast-forward it when the remote moved (e.g. PO pushed a fix), and
 * refuse to guess when histories diverged — that needs a human.
 */
async function syncTeamBranch(
	handle: WorkspaceHandle,
	team: Team,
	remote: HostingRemote
): Promise<void> {
	const branch = teamBranch(team);
	const hasLocal = await branchExists(handle, branch);
	const hasRemote = await remoteBranchExists(handle, branch);

	if (!hasLocal && hasRemote) {
		await gitOk(handle, ['branch', '--track', branch, `origin/${branch}`]);
		return;
	}
	if (!hasLocal && !hasRemote) {
		await gitOk(handle, ['branch', branch, `origin/${remote.project.defaultBranch}`]);
		await gitRemoteOk(handle, remote, ['push', '-u', 'origin', branch]);
		return;
	}
	if (hasLocal && !hasRemote) {
		// Local work exists but never reached the hoster (earlier push failed).
		await gitRemoteOk(handle, remote, ['push', '-u', 'origin', branch]);
		return;
	}

	// Both exist: fast-forward only. A leftover dirty tree would block the
	// checkout, and every item starts from a clean tree anyway.
	await gitOk(handle, ['reset', '--hard']);
	await gitOk(handle, ['clean', '-fd']);
	await gitOk(handle, ['checkout', branch]);
	const merge = await git(handle, ['merge', '--ff-only', `origin/${branch}`]);
	if (merge.exitCode !== 0)
		throw new Error(
			`The team branch ${branch} has diverged from the remote. Cairn never force-pushes — ` +
				`reconcile the branch on the hosting side (or delete it there to start fresh).`
		);
}

/** Push the team branch to the hosting remote. Never forced, never `main`. */
export async function pushTeamBranch(
	handle: WorkspaceHandle,
	team: Team,
	remote: HostingRemote
): Promise<void> {
	await gitRemoteOk(handle, remote, ['push', 'origin', teamBranch(team)]);
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
	// A previous item may have failed and left uncommitted files behind —
	// every item starts from a clean tree so work never bleeds across items.
	await gitOk(handle, ['reset', '--hard']);
	await gitOk(handle, ['clean', '-fd']);
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
