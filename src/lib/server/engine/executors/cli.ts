import { env } from '$env/dynamic/private';
import { execInWorkspace, writeFileInWorkspace, type WorkspaceHandle } from '../../workspace/docker';
import { commitAs } from '../../workspace/git';
import { credentialsForTeam, type CredentialKind } from '../../executorCredentials';
import { getStringSetting } from '../../settings';
import { assertBudget } from '../meeting';
import { agentSystemPrompt } from '../prompts';
import { parseExecutorConfig, type Executor, type TeamExecutorConfig, type WorkAssignment, type WorkLogger } from '../executor';

/**
 * CLI executors (issue #12): instead of the built-in AI SDK tool loop, a
 * coding CLI (Claude Code, Codex, OpenCode) runs INSIDE the workspace
 * container and implements the backlog item with its own tools. The CLI is
 * installed into the container on first use and driven non-interactively;
 * its JSONL output is streamed into the work logs.
 *
 * Credentials come from the team PO's encrypted store (executorCredentials.ts)
 * — an OAuth token from the user's subscription plan or an API key — with the
 * server's own env keys as fallback. They are injected per exec call (and, for
 * Codex, as a file in the container-local home dir), never into the container
 * config, and they die with the disposable container.
 *
 * Trust model: the credential is necessarily readable by whatever the CLI
 * executes in the container — the same exposure as running the CLI on your
 * own machine. That is the price of subscription-plan support; the built-in
 * tool loop keeps keys server-side.
 *
 * Usage metering is best-effort: real numbers when the CLI reports them
 * (Claude Code always does, Codex usually), a chars/4 estimate otherwise —
 * flagged via `usage.approximate`. The sprint budget is checked before the
 * run and billed once afterwards, so a single item can overshoot the budget
 * by at most its own run.
 */

const PROMPT_PATH = '/tmp/cairn/prompt.txt';
const INSTALL_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_TIMEOUT_MINUTES = 30;
const MAX_TIMEOUT_MINUTES = 180;
const LOG_SNIPPET = 2_000;
const NOTE_SNIPPET = 8_000;

/** POSIX single-quote escaping for values interpolated into `sh -lc`. */
function shq(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/** Mutable state a parser fills while the CLI's stdout streams by. */
interface ParseState {
	inputTokens: number;
	outputTokens: number;
	/** True once real token numbers were reported by the CLI. */
	sawUsage: boolean;
	/** The CLI's final message — becomes the item's result note. */
	resultText: string;
}

interface CliAdapter {
	id: string;
	label: string;
	/** Binary to look for and the npm package that provides it. */
	binary: string;
	npmPackage: string;
	/** Credential kinds in preference order, mapped to the env var each fills.
	 *  Empty = the tool needs no credential (e.g. OpenCode against Ollama). */
	credentialEnv: { kind: CredentialKind; envVar: string }[];
	/** Server-env fallback var when the PO stored no credential (or null). */
	fallbackEnvVar: string | null;
	/** Extra static env for every run of this tool. */
	staticEnv: string[];
	/** Write tool config/auth files into the container home (best-effort paths
	 *  are container-local, NOT on the /workspace volume). */
	prepareFiles?(
		workspace: WorkspaceHandle,
		config: TeamExecutorConfig,
		credentials: Partial<Record<CredentialKind, string>>
	): Promise<void>;
	/** Shell command reading the prompt from PROMPT_PATH. */
	command(config: TeamExecutorConfig): string;
	/** Per-line stdout parser: log progress, collect usage and the final text. */
	parseLine(line: string, state: ParseState, log: WorkLogger): void;
}

/** Compact a tool-result/content payload into a loggable string. */
function contentToText(content: unknown): string {
	if (typeof content === 'string') return content;
	if (Array.isArray(content))
		return content
			.map((part) =>
				typeof part === 'string' ? part : ((part as { text?: string })?.text ?? '')
			)
			.join(' ');
	return JSON.stringify(content ?? '');
}

const claudeCode: CliAdapter = {
	id: 'claude-code',
	label: 'Claude Code',
	binary: 'claude',
	npmPackage: '@anthropic-ai/claude-code',
	credentialEnv: [
		{ kind: 'claude_code_oauth', envVar: 'CLAUDE_CODE_OAUTH_TOKEN' },
		{ kind: 'anthropic_api_key', envVar: 'ANTHROPIC_API_KEY' }
	],
	fallbackEnvVar: 'ANTHROPIC_API_KEY',
	// IS_SANDBOX: the container IS the sandbox — allows --dangerously-skip-
	// permissions as root, which non-interactive mode needs to use tools.
	staticEnv: ['IS_SANDBOX=1', 'DISABLE_AUTOUPDATER=1', 'DISABLE_TELEMETRY=1'],
	command(config) {
		const model = config.model ? ` --model ${shq(config.model)}` : '';
		return (
			`claude -p --output-format stream-json --verbose ` +
			`--dangerously-skip-permissions --max-turns 100${model} < ${PROMPT_PATH}`
		);
	},
	parseLine(line, state, log) {
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(line);
		} catch {
			return; // non-JSON noise
		}
		if (event.type === 'system' && event.subtype === 'init') {
			log('status', `Claude Code session started (model ${(event as { model?: string }).model ?? '?'}).`);
			return;
		}
		if (event.type === 'assistant') {
			const message = event.message as { content?: unknown[] } | undefined;
			for (const part of message?.content ?? []) {
				const block = part as { type?: string; text?: string; name?: string; input?: unknown };
				if (block.type === 'text' && block.text?.trim())
					log('assistant', block.text.trim().slice(0, LOG_SNIPPET));
				if (block.type === 'tool_use')
					log('tool_call', JSON.stringify(block.input ?? {}).slice(0, LOG_SNIPPET), block.name);
			}
			return;
		}
		if (event.type === 'user') {
			const message = event.message as { content?: unknown[] } | undefined;
			for (const part of message?.content ?? []) {
				const block = part as { type?: string; content?: unknown };
				if (block.type === 'tool_result')
					log('tool_result', contentToText(block.content).slice(0, LOG_SNIPPET));
			}
			return;
		}
		if (event.type === 'result') {
			const usage = event.usage as
				| {
						input_tokens?: number;
						cache_creation_input_tokens?: number;
						cache_read_input_tokens?: number;
						output_tokens?: number;
				  }
				| undefined;
			if (usage) {
				// Cache tokens count toward the sprint budget too — cheaper per
				// token, but the budget is a token ceiling, not a cost ledger.
				state.inputTokens =
					(usage.input_tokens ?? 0) +
					(usage.cache_creation_input_tokens ?? 0) +
					(usage.cache_read_input_tokens ?? 0);
				state.outputTokens = usage.output_tokens ?? 0;
				state.sawUsage = true;
			}
			if (typeof event.result === 'string') state.resultText = event.result;
			const cost = (event as { total_cost_usd?: number }).total_cost_usd;
			if (typeof cost === 'number') log('status', `Claude Code reports $${cost.toFixed(4)} total cost.`);
		}
	}
};

const codex: CliAdapter = {
	id: 'codex',
	label: 'Codex',
	binary: 'codex',
	npmPackage: '@openai/codex',
	credentialEnv: [{ kind: 'openai_api_key', envVar: 'OPENAI_API_KEY' }],
	fallbackEnvVar: 'OPENAI_API_KEY',
	staticEnv: [],
	// A stored auth.json (ChatGPT-plan login) beats the API key: it is written
	// into the container-local home, which vanishes with the container.
	async prepareFiles(workspace, _config, credentials) {
		if (credentials.codex_auth_json)
			await writeFileInWorkspace(workspace, '/root/.codex/auth.json', credentials.codex_auth_json);
	},
	command(config) {
		const model = config.model ? ` -m ${shq(config.model)}` : '';
		// The container is the sandbox; Codex's own Landlock/seccomp sandbox is
		// not available inside an unprivileged container.
		return `codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check${model} - < ${PROMPT_PATH}`;
	},
	parseLine(line, state, log) {
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}
		// Codex's --json event stream has changed shape across releases; parse
		// the known variants best-effort and ignore everything else.
		const item = event.item as { item_type?: string; type?: string; text?: string; command?: string } | undefined;
		if ((event.type === 'item.completed' || event.type === 'item.started') && item) {
			const kind = item.item_type ?? item.type;
			if (kind === 'agent_message' && item.text) {
				state.resultText = item.text;
				if (event.type === 'item.completed') log('assistant', item.text.slice(0, LOG_SNIPPET));
			} else if (kind === 'command_execution' && item.command && event.type === 'item.started') {
				log('tool_call', item.command.slice(0, LOG_SNIPPET), 'exec');
			}
		}
		const msg = event.msg as { type?: string; message?: string; info?: unknown } | undefined;
		if (msg?.type === 'agent_message' && msg.message) {
			state.resultText = msg.message;
			log('assistant', msg.message.slice(0, LOG_SNIPPET));
		}
		const usage =
			(event.usage as Record<string, number> | undefined) ??
			((msg?.info as { total_token_usage?: Record<string, number> } | undefined)
				?.total_token_usage);
		if (usage && (usage.input_tokens !== undefined || usage.output_tokens !== undefined)) {
			// Reported totals are cumulative in every known shape — replace.
			state.inputTokens = (usage.input_tokens ?? 0) + (usage.cached_input_tokens ?? 0);
			state.outputTokens = usage.output_tokens ?? 0;
			state.sawUsage = true;
		}
	}
};

/** Model precedence for OpenCode: the team's own executor config, then the
 *  instance-wide default (admin settings, issue #25), then the built-in. */
function openCodeModel(config: TeamExecutorConfig): string {
	return config.model || getStringSetting('ollamaCodegenModel') || 'qwen3';
}

const openCode: CliAdapter = {
	id: 'opencode',
	label: 'OpenCode (Ollama)',
	binary: 'opencode',
	npmPackage: 'opencode-ai',
	credentialEnv: [],
	fallbackEnvVar: null,
	staticEnv: [],
	// Point OpenCode at the Ollama server via its OpenAI-compatible endpoint.
	async prepareFiles(workspace, config) {
		const baseUrl = (config.baseUrl || 'http://host.docker.internal:11434').replace(/\/$/, '');
		const model = openCodeModel(config);
		await writeFileInWorkspace(
			workspace,
			'/root/.config/opencode/opencode.json',
			JSON.stringify(
				{
					$schema: 'https://opencode.ai/config.json',
					provider: {
						ollama: {
							npm: '@ai-sdk/openai-compatible',
							name: 'Ollama',
							options: { baseURL: `${baseUrl}/v1` },
							models: { [model]: { name: model } }
						}
					}
				},
				null,
				'\t'
			)
		);
	},
	command(config) {
		return `opencode run -m ${shq(`ollama/${openCodeModel(config)}`)} "$(cat ${PROMPT_PATH})"`;
	},
	parseLine(line, state, log) {
		// OpenCode prints the response as plain text; keep the whole tail as the
		// result note and surface lines as they come.
		log('assistant', line.slice(0, LOG_SNIPPET));
		state.resultText = state.resultText ? `${state.resultText}\n${line}` : line;
		state.resultText = state.resultText.slice(-NOTE_SNIPPET);
	}
};

const ADAPTERS: Record<string, CliAdapter> = {
	'claude-code': claudeCode,
	codex: codex,
	opencode: openCode
};

function cliWorkInstructions(assignment: WorkAssignment): string {
	const { item, sprint, branch, tokenAllowance } = assignment;
	return `

## Work mode

You are working non-interactively inside the team's workspace container. The current
directory is the team repository, already checked out on branch \`${branch}\`. Implement
the backlog item below: explore the repo, write code, run builds/tests, and iterate until
the acceptance criteria are met.

Rules:
- Commit meaningful progress with git as you go — uncommitted work is at risk.
- Stay on branch \`${branch}\`. Never switch branches, never push, never touch git remotes.
- Work in small verified steps: after changing code, run the relevant build or tests and
  fix failures before moving on.
- Be economical: aim to stay under roughly ${tokenAllowance.toLocaleString('en-US')} tokens for this item.

End with a short plain-text report: what you implemented, how you verified it
(test/build results), and anything still open. Start the report with "DONE:" if the
acceptance criteria are met, or "INCOMPLETE:" if they are not.

## The backlog item

Title: ${item.title}
Description: ${item.description || '(none)'}
Acceptance criteria: ${item.acceptanceCriteria || '(none)'}
Sprint goal: ${sprint.goal || '(none)'}`;
}

async function ensureInstalled(
	workspace: WorkspaceHandle,
	adapter: CliAdapter,
	log: WorkLogger
): Promise<void> {
	const check = await execInWorkspace(workspace, ['sh', '-lc', `command -v ${adapter.binary}`], {
		timeoutMs: 30_000
	});
	if (check.exitCode === 0) return;

	log('status', `Installing ${adapter.label} into the workspace (npm i -g ${adapter.npmPackage})…`);
	const install = await execInWorkspace(
		workspace,
		['sh', '-lc', `npm install -g ${adapter.npmPackage} --no-fund --no-audit`],
		{ timeoutMs: INSTALL_TIMEOUT_MS }
	);
	if (install.exitCode !== 0)
		throw new Error(
			`Could not install ${adapter.label} in the workspace (exit ${install.exitCode}). ` +
				`The container needs network access (WORKSPACE_NETWORK must not be "none"). ` +
				`${(install.stderr || install.stdout).slice(-500)}`
		);
	log('status', `${adapter.label} installed.`);
}

export function makeCliExecutor(id: string): Executor {
	const adapter = ADAPTERS[id];
	if (!adapter) throw new Error(`Unknown CLI executor "${id}".`);

	return {
		id: adapter.id,

		async runItem(assignment, workspace, log) {
			const ctx = assignment.agentCtx;
			if (!ctx) throw new Error(`The ${adapter.label} executor requires an assigned agent.`);
			assertBudget(assignment.sprint.id);

			const config = parseExecutorConfig(assignment.team.executorConfig);
			await ensureInstalled(workspace, adapter, log);

			// Credentials: the PO's stored secret per preference order, else the
			// server's own env var. File-based auth is handled in prepareFiles.
			const credentials = credentialsForTeam(assignment.team.id);
			const runEnv = [...adapter.staticEnv];
			let authNote = '';
			for (const { kind, envVar } of adapter.credentialEnv) {
				if (credentials[kind]) {
					runEnv.push(`${envVar}=${credentials[kind]}`);
					authNote = `the Product Owner's ${kind.replace(/_/g, ' ')}`;
					break;
				}
			}
			const hasFileAuth = adapter.id === 'codex' && Boolean(credentials.codex_auth_json);
			if (hasFileAuth) authNote = "the Product Owner's Codex auth.json (subscription)";
			if (!authNote && adapter.fallbackEnvVar) {
				const fallback = env[adapter.fallbackEnvVar];
				if (!fallback)
					throw new Error(
						`No credential for ${adapter.label}: the Product Owner has none stored ` +
							`(Settings → Executor credentials) and ${adapter.fallbackEnvVar} is not set on the server.`
					);
				runEnv.push(`${adapter.fallbackEnvVar}=${fallback}`);
				authNote = `the server's ${adapter.fallbackEnvVar}`;
			}
			for (const [key, value] of Object.entries(config.extraEnv ?? {}))
				runEnv.push(`${key}=${value}`);
			log('status', `Running ${adapter.label}${authNote ? ` with ${authNote}` : ''}…`);

			await adapter.prepareFiles?.(workspace, config, credentials);

			const prompt = agentSystemPrompt(ctx) + cliWorkInstructions(assignment);
			await writeFileInWorkspace(workspace, PROMPT_PATH, prompt);

			// CLI git commits should be attributed to the working agent.
			await execInWorkspace(workspace, ['git', 'config', 'user.name', ctx.agent.name]);
			await execInWorkspace(workspace, [
				'git',
				'config',
				'user.email',
				`${ctx.agent.id.slice(0, 8)}@cairn.local`
			]);

			const timeoutMinutes = Math.min(
				Math.max(config.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES, 5),
				MAX_TIMEOUT_MINUTES
			);
			const state: ParseState = { inputTokens: 0, outputTokens: 0, sawUsage: false, resultText: '' };

			let result;
			try {
				result = await execInWorkspace(workspace, ['sh', '-lc', adapter.command(config)], {
					timeoutMs: timeoutMinutes * 60_000,
					maxOutputBytes: 4 * 1024 * 1024,
					env: runEnv,
					onStdoutLine: (line) => adapter.parseLine(line, state, log)
				});
			} finally {
				// Prompt and injected auth material are container-local; still, don't
				// leave them lying around between items.
				await execInWorkspace(workspace, ['rm', '-f', PROMPT_PATH, '/root/.codex/auth.json'], {
					timeoutMs: 30_000
				}).catch(() => {});
			}

			// Whatever the CLI left uncommitted still belongs to the item.
			await commitAs(workspace, ctx.agent, `chore: uncommitted work for "${assignment.item.title}"`).catch(
				() => null
			);

			if (!state.sawUsage) {
				state.inputTokens = estimateTokens(prompt);
				state.outputTokens = estimateTokens(result.stdout);
			}
			const usage = {
				inputTokens: state.inputTokens,
				outputTokens: state.outputTokens,
				approximate: !state.sawUsage,
				billed: false // work.ts bills the totals once after the run
			};

			if (result.exitCode === 124)
				return {
					status: 'failed',
					resultNote: `${adapter.label} hit the ${timeoutMinutes}-minute time limit.${
						state.resultText ? ` Last message:\n${state.resultText.slice(0, NOTE_SNIPPET)}` : ''
					}`,
					usage
				};
			if (result.exitCode !== 0)
				return {
					status: 'failed',
					resultNote:
						`${adapter.label} exited with code ${result.exitCode}. ` +
						(state.resultText || result.stderr || result.stdout).slice(-NOTE_SNIPPET),
					usage
				};

			const note = state.resultText.trim() || result.stdout.trim().slice(-NOTE_SNIPPET);
			return {
				status: note.toUpperCase().startsWith('DONE') ? 'done' : 'failed',
				resultNote: note || `${adapter.label} finished without a report.`,
				usage
			};
		}
	};
}
