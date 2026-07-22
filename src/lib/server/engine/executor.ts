import { env } from '$env/dynamic/private';
import type { BacklogItem, Sprint, Team, WorkLog } from '../db/schema';
import type { WorkspaceHandle } from '../workspace/docker';
import type { AgentContext } from './prompts';

/**
 * An executor is "the thing that implements one backlog item inside the
 * workspace". The built-in one is a metered AI SDK tool loop; issue #12 will
 * add CLI-based executors (Claude Code, Codex, …) behind this same interface.
 */

export interface WorkAssignment {
	sprint: Sprint;
	team: Team;
	item: BacklogItem;
	/** Assigned developer agent; null possible for future CLI executors. */
	agentCtx: AgentContext | null;
	/** Task branch the workspace is already checked out on. */
	branch: string;
	itemRunId: string;
	/** Soft per-item token allowance; executors should wrap up when exceeded. */
	tokenAllowance: number;
}

export interface ExecutorUsage {
	inputTokens: number;
	outputTokens: number;
	/** True when the numbers are estimates (e.g. CLI executors). */
	approximate: boolean;
	/** True when the executor already billed the sprint via recordUsage()
	 *  call-by-call; false means the caller must bill the totals once. */
	billed: boolean;
}

export interface ExecutorOutcome {
	status: 'done' | 'failed';
	/** Closing self-report: what was done, test results, open issues.
	 *  Shown in the review UI and fed to the review ceremony. */
	resultNote: string;
	usage: ExecutorUsage;
}

export type WorkLogger = (kind: WorkLog['kind'], content: string, toolName?: string) => void;

export interface Executor {
	readonly id: string;
	runItem(
		assignment: WorkAssignment,
		workspace: WorkspaceHandle,
		log: WorkLogger
	): Promise<ExecutorOutcome>;
}

export async function getExecutor(): Promise<Executor> {
	const id = env.CAIRN_EXECUTOR || 'tool-loop';
	switch (id) {
		case 'tool-loop':
			return (await import('./executors/toolLoop')).toolLoopExecutor;
		case 'mock':
			return (await import('./executors/mock')).mockExecutor;
		default:
			throw new Error(`Unknown executor "${id}" (CAIRN_EXECUTOR)`);
	}
}
