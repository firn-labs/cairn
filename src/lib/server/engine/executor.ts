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

/**
 * Executor settings the Product Owner edits on the team page, stored as JSON
 * in `teams.executorConfig`. All fields are optional; unknown keys are dropped.
 */
export interface TeamExecutorConfig {
	/** Model the CLI tool should use (its own naming, e.g. `gpt-5-codex`). */
	model?: string;
	/** For OpenCode: the Ollama server URL as seen FROM the container
	 *  (default http://host.docker.internal:11434). */
	baseUrl?: string;
	/** Wall-clock limit per backlog item (default 30, clamped 5–180). */
	timeoutMinutes?: number;
	/** Extra environment for the CLI run, e.g. proxy settings. */
	extraEnv?: Record<string, string>;
}

export function parseExecutorConfig(json: string): TeamExecutorConfig {
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(json || '{}');
	} catch {
		return {};
	}
	const config: TeamExecutorConfig = {};
	if (typeof raw.model === 'string' && raw.model.trim()) config.model = raw.model.trim();
	if (typeof raw.baseUrl === 'string' && raw.baseUrl.trim()) config.baseUrl = raw.baseUrl.trim();
	if (typeof raw.timeoutMinutes === 'number' && Number.isFinite(raw.timeoutMinutes))
		config.timeoutMinutes = raw.timeoutMinutes;
	if (raw.extraEnv && typeof raw.extraEnv === 'object') {
		config.extraEnv = {};
		for (const [key, value] of Object.entries(raw.extraEnv as Record<string, unknown>))
			if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === 'string')
				config.extraEnv[key] = value;
	}
	return config;
}

/** The selectable executors, in UI order. `credential` names what the team
 *  PO should store under Settings for subscription-plan use. */
export const EXECUTOR_OPTIONS = [
	{
		id: 'tool-loop',
		label: 'Built-in tool loop',
		description:
			"The agent's own provider/model drives a metered tool loop. API keys stay on the server."
	},
	{
		id: 'claude-code',
		label: 'Claude Code CLI',
		description:
			'Runs Claude Code inside the workspace. Uses your Claude subscription (OAuth token) or an Anthropic API key.'
	},
	{
		id: 'codex',
		label: 'Codex CLI',
		description:
			'Runs OpenAI Codex inside the workspace. Uses your ChatGPT subscription (auth.json) or an OpenAI API key.'
	},
	{
		id: 'opencode',
		label: 'OpenCode + Ollama',
		description:
			'Runs the open-source OpenCode CLI against your own Ollama server. No credential needed.'
	},
	{
		id: 'mock',
		label: 'Mock (no LLM)',
		description: 'Writes a marker file per item — for testing the pipeline without any model.'
	}
] as const;

export const EXECUTOR_IDS = EXECUTOR_OPTIONS.map((o) => o.id as string);

/**
 * Resolve the executor for a team: the team's own choice first, then the
 * instance default (CAIRN_EXECUTOR), then the built-in tool loop.
 */
export async function getExecutor(team?: Team): Promise<Executor> {
	const id = team?.executor || env.CAIRN_EXECUTOR || 'tool-loop';
	switch (id) {
		case 'tool-loop':
			return (await import('./executors/toolLoop')).toolLoopExecutor;
		case 'mock':
			return (await import('./executors/mock')).mockExecutor;
		case 'claude-code':
		case 'codex':
		case 'opencode':
			return (await import('./executors/cli')).makeCliExecutor(id);
		default:
			throw new Error(`Unknown executor "${id}" (team setting or CAIRN_EXECUTOR)`);
	}
}
