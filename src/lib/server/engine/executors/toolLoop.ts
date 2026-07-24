import { generateText, stepCountIs, tool, type ModelMessage, type ToolSet } from 'ai';
import { z } from 'zod';
import { getModel } from '../../llm/providers';
import { execInWorkspace, writeFileInWorkspace, type WorkspaceHandle } from '../../workspace/docker';
import { commitAs } from '../../workspace/git';
import { assertBudget, recordUsage } from '../meeting';
import { agentSystemPrompt } from '../prompts';
import { maxProposalsPerSource, proposeBacklogItem } from '../backlog';
import { runAdhocMeeting } from '../adhoc';
import { discoverTeams, maxTeamRequestsPerSource, requestTeamWork } from '../crossTeam';
import { collaborationEnabled } from '../../settings';
import type { Executor, WorkAssignment, WorkLogger } from '../executor';

/**
 * The built-in executor: a metered AI SDK tool loop. The assigned developer
 * agent gets file/terminal tools scoped to the workspace repo and iterates
 * until it reports completion. Billing is chunked — the sprint budget is
 * re-checked between chunks of at most CHUNK_STEPS tool steps, so the
 * worst-case overshoot is one chunk.
 */

const CHUNK_STEPS = 8;
const MAX_TOTAL_STEPS = 48;
const MAX_STEP_OUTPUT_TOKENS = 4096;
const READ_CAP_BYTES = 50 * 1024;
const LOG_SNIPPET = 2_000;

/** Resolve a model-supplied path against the repo, rejecting escapes. */
function repoPath(workspace: WorkspaceHandle, path: string): string {
	const cleaned = path.replace(/^\/+/, '').replace(/^workspace\/repo\/?/, '');
	const parts: string[] = [];
	for (const part of cleaned.split('/')) {
		if (part === '' || part === '.') continue;
		if (part === '..') throw new Error(`Path escapes the workspace: ${path}`);
		parts.push(part);
	}
	return `${workspace.repoDir}/${parts.join('/')}`;
}

function makeTools(assignment: WorkAssignment, workspace: WorkspaceHandle, log: WorkLogger): ToolSet {
	let proposalsMade = 0;
	let teamRequestsMade = 0;
	const tools: ToolSet = {
		listFiles: tool({
			description: 'List files in the repository (excludes .git and node_modules).',
			inputSchema: z.object({
				path: z.string().optional().describe('Directory relative to the repo root'),
				depth: z.number().int().min(1).max(3).optional().describe('Recursion depth, default 2')
			}),
			execute: async ({ path, depth }) => {
				const dir = path ? repoPath(workspace, path) : workspace.repoDir;
				const result = await execInWorkspace(
					workspace,
					[
						'find',
						dir,
						'-maxdepth',
						String(depth ?? 2),
						'-not',
						'-path',
						'*/.git*',
						'-not',
						'-path',
						'*/node_modules*'
					],
					{ maxOutputBytes: 32 * 1024 }
				);
				return result.exitCode === 0 ? result.stdout : `Error: ${result.stderr}`;
			}
		}),

		readFile: tool({
			description: 'Read a file from the repository.',
			inputSchema: z.object({ path: z.string().describe('File path relative to the repo root') }),
			execute: async ({ path }) => {
				const result = await execInWorkspace(workspace, ['cat', repoPath(workspace, path)], {
					maxOutputBytes: READ_CAP_BYTES
				});
				if (result.exitCode !== 0) return `Error: ${result.stderr || 'file not found'}`;
				return result.truncated ? `${result.stdout}\n…[file truncated]` : result.stdout;
			}
		}),

		writeFile: tool({
			description: 'Create or overwrite a file in the repository.',
			inputSchema: z.object({
				path: z.string().describe('File path relative to the repo root'),
				content: z.string()
			}),
			execute: async ({ path, content }) => {
				try {
					await writeFileInWorkspace(workspace, repoPath(workspace, path), content);
					return `Wrote ${path} (${content.length} chars).`;
				} catch (err) {
					return `Error: ${err instanceof Error ? err.message : String(err)}`;
				}
			}
		}),

		exec: tool({
			description:
				'Run a shell command in the repository root (e.g. build or test commands). ' +
				'Returns exit code and output.',
			inputSchema: z.object({
				command: z.string(),
				timeoutSeconds: z.number().int().min(1).max(300).optional().describe('Default 120')
			}),
			execute: async ({ command, timeoutSeconds }) => {
				const result = await execInWorkspace(workspace, ['sh', '-lc', command], {
					timeoutMs: (timeoutSeconds ?? 120) * 1000
				});
				const output = [result.stdout, result.stderr].filter(Boolean).join('\n--- stderr ---\n');
				return `exit code ${result.exitCode}${result.exitCode === 124 ? ' (timed out)' : ''}\n${output}`;
			}
		}),

		commit: tool({
			description: 'Commit all current changes in the repository with the given message.',
			inputSchema: z.object({ message: z.string() }),
			execute: async ({ message }) => {
				if (!assignment.agentCtx) return 'Error: no agent to commit as.';
				try {
					const hash = await commitAs(workspace, assignment.agentCtx.agent, message);
					return hash ? `Committed ${hash.slice(0, 10)}.` : 'Nothing to commit.';
				} catch (err) {
					return `Error: ${err instanceof Error ? err.message : String(err)}`;
				}
			}
		}),

		proposeBacklogItem: tool({
			description:
				'Propose a NEW item for the product backlog: tech debt, refactoring or tooling you ' +
				'noticed, or follow-up work you are blocked on. The Product Owner reviews it before ' +
				'it can be planned — it does NOT change or unblock your current task. Do not ' +
				'propose work that is part of the item you are implementing.',
			inputSchema: z.object({
				title: z.string().describe('Short, actionable title'),
				description: z.string().optional(),
				rationale: z
					.string()
					.optional()
					.describe('Why this matters — what you saw while working that prompted it')
			}),
			execute: async ({ title, description, rationale }) => {
				if (!assignment.agentCtx) return 'Error: no agent to attribute the proposal to.';
				if (proposalsMade >= maxProposalsPerSource())
					return `Error: proposal limit for this work item reached (${maxProposalsPerSource()}). Focus on your task.`;
				try {
					proposeBacklogItem(assignment.team.id, assignment.agentCtx.agent, {
						title,
						description,
						rationale
					});
					proposalsMade += 1;
					return `Proposed "${title}" — the Product Owner will review it. Continue with your current task.`;
				} catch (err) {
					return `Error: ${err instanceof Error ? err.message : String(err)}`;
				}
			}
		}),

		requestMeeting: tool({
			description:
				'Call a short ad-hoc meeting with named teammates and get its summary back. Use it ' +
				'ONLY when you are genuinely blocked or a decision truly needs a teammate — meetings ' +
				'cost sprint budget and are rate-limited per sprint. Try to solve it yourself first.',
			inputSchema: z.object({
				purpose: z
					.string()
					.describe('What you need decided or answered, with the context teammates need'),
				participants: z
					.array(z.string())
					.min(1)
					.describe('Names of the teammates you need (see "Your teammates")')
			}),
			execute: async ({ purpose, participants }) => {
				if (!assignment.agentCtx) return 'Error: no agent to call the meeting as.';
				log(
					'status',
					`${assignment.agentCtx.agent.name} calls an ad-hoc meeting: ${purpose.slice(0, 200)}`
				);
				try {
					const summary = await runAdhocMeeting({
						sprintId: assignment.sprint.id,
						requesterAgentId: assignment.agentCtx.agent.id,
						purpose,
						participantNames: participants
					});
					log('status', `Ad-hoc meeting finished: ${summary.slice(0, 300)}`);
					return `The meeting took place. Outcome:\n${summary}\n\nContinue with your task.`;
				} catch (err) {
					return `Error: ${err instanceof Error ? err.message : String(err)}`;
				}
			}
		})
	};

	// Cross-team tools exist only while the instance collaboration toggle
	// (issue #23) is on — when off, agents cannot even see them.
	if (!collaborationEnabled()) return tools;

	tools.discoverTeams = tool({
		description:
			'List the other teams in this organization: what each is for (description, tags), the ' +
			'interface it offers other teams, and whether it works on the same project as yours ' +
			'(only then is a shared collab branch possible). Costs no budget.',
		inputSchema: z.object({}),
		execute: async () => {
			const found = discoverTeams(assignment.team);
			if (found.length === 0) return 'There are no other teams in this organization.';
			return found
				.map((t) =>
					[
						`## ${t.name}${t.tags.length > 0 ? ` [${t.tags.join(', ')}]` : ''}`,
						t.description || '(no description)',
						t.interface && `How to work with this team: ${t.interface}`,
						t.sharesProject
							? 'Works on the SAME project as your team — a collab branch is possible.'
							: 'Works on a different project — no shared branch possible.'
					]
						.filter(Boolean)
						.join('\n')
				)
				.join('\n\n');
		}
	});

	tools.requestTeamWork = tool({
		description:
			'Request work from ANOTHER team (see discoverTeams). The request lands in that ' +
			"team's backlog and is reviewed by THEIR Product Owner — it will NOT be done during " +
			'your sprint, so never block your current task on it. Set collab=true only for a ' +
			'feature both teams must build in the same repository: that creates a shared collab ' +
			"branch and files the matching item for your own team's side too.",
		inputSchema: z.object({
			teamName: z.string().describe('Exact name of the target team (from discoverTeams)'),
			title: z.string().describe('Short, actionable title for the requested work'),
			description: z.string().optional(),
			acceptanceCriteria: z.string().optional(),
			rationale: z
				.string()
				.optional()
				.describe("Why your team needs this — shown to the other team's Product Owner"),
			collab: z
				.boolean()
				.optional()
				.describe('Request a shared collab branch (requires the same project)')
		}),
		execute: async ({ teamName, title, description, acceptanceCriteria, rationale, collab }) => {
			if (!assignment.agentCtx) return 'Error: no agent to attribute the request to.';
			if (teamRequestsMade >= maxTeamRequestsPerSource())
				return `Error: cross-team request limit for this work item reached (${maxTeamRequestsPerSource()}). Focus on your task.`;
			try {
				const outcome = requestTeamWork(assignment.team, assignment.agentCtx.agent, {
					teamName,
					title,
					description,
					acceptanceCriteria,
					rationale,
					collab
				});
				teamRequestsMade += 1;
				log('status', `${assignment.agentCtx.agent.name} requests work from "${teamName}": ${title}`);
				return `${outcome} Continue with your current task.`;
			} catch (err) {
				return `Error: ${err instanceof Error ? err.message : String(err)}`;
			}
		}
	});

	return tools;
}

function workInstructions(assignment: WorkAssignment): string {
	const { item, sprint, branch } = assignment;
	const collabParagraph = collaborationEnabled()
		? `
There are other teams in this organization (\`discoverTeams\` lists them). If this item
surfaces work that clearly belongs to another team's area, file it with \`requestTeamWork\` —
their Product Owner prioritizes it, it will NOT happen during your sprint, so never block
on it. Only use collab=true for a feature both teams must build together in the same
repository.
`
		: '';
	return `

## Work mode

You are NOT in a meeting. You are implementing a backlog item inside the team's workspace,
a Docker container with the team repository checked out on branch \`${branch}\`.
Use the tools to explore the repo, write code, run builds/tests with \`exec\`, and iterate
until the acceptance criteria are met. Commit meaningful progress with the \`commit\` tool —
uncommitted work is at risk. Work in small verified steps: after changing code, run the
relevant build or tests and fix failures before moving on.

If you notice tech debt, missing tooling or necessary follow-up work that is OUT of scope
for this item, propose it with \`proposeBacklogItem\` instead of fixing it now — the Product
Owner will prioritize it.

If you are blocked on something a teammate can resolve — an unclear design decision, a
conflict with work you believe someone else did — you can call an ad-hoc meeting with
\`requestMeeting\` and act on its outcome. Meetings cost sprint budget and are rate-limited,
so exhaust your own options first.
${collabParagraph}
When you are finished (or cannot get further), stop calling tools and reply with a short
plain-text report: what you implemented, how you verified it (test/build results), and
anything still open. Start the report with "DONE:" if the acceptance criteria are met,
or "INCOMPLETE:" if they are not.

## The backlog item

Title: ${item.title}
Description: ${item.description || '(none)'}
Acceptance criteria: ${item.acceptanceCriteria || '(none)'}
Sprint goal: ${sprint.goal || '(none)'}`;
}

export const toolLoopExecutor: Executor = {
	id: 'tool-loop',

	async runItem(assignment, workspace, log) {
		const ctx = assignment.agentCtx;
		if (!ctx) throw new Error('The tool-loop executor requires an assigned agent.');

		const system = agentSystemPrompt(ctx) + workInstructions(assignment);
		const tools = makeTools(assignment, workspace, log);
		const messages: ModelMessage[] = [
			{
				role: 'user',
				content:
					'Implement the backlog item described in your instructions. ' +
					'Start by exploring the repository.'
			}
		];

		let inputTokens = 0;
		let outputTokens = 0;
		let steps = 0;

		const usage = () => ({ inputTokens, outputTokens, approximate: false, billed: true });

		while (true) {
			assertBudget(assignment.sprint.id); // throws BudgetExceededError → work.ts handles it

			const result = await generateText({
				model: getModel(ctx.agent.provider, ctx.agent.model),
				system,
				messages,
				tools,
				stopWhen: stepCountIs(CHUNK_STEPS),
				maxOutputTokens: MAX_STEP_OUTPUT_TOKENS,
				onStepFinish: (step) => {
					steps += 1;
					if (step.text.trim()) log('assistant', step.text.trim().slice(0, LOG_SNIPPET));
					for (const call of step.toolCalls)
						log('tool_call', JSON.stringify(call.input).slice(0, LOG_SNIPPET), call.toolName);
					for (const toolResult of step.toolResults)
						log('tool_result', String(toolResult.output).slice(0, LOG_SNIPPET), toolResult.toolName);
				}
			});

			recordUsage(
				assignment.sprint.id,
				result.totalUsage.inputTokens ?? 0,
				result.totalUsage.outputTokens ?? 0
			);
			inputTokens += result.totalUsage.inputTokens ?? 0;
			outputTokens += result.totalUsage.outputTokens ?? 0;
			messages.push(...result.response.messages);

			// The agent stopped calling tools on its own: its last text is the report.
			if (result.finishReason === 'stop') {
				const note = result.text.trim();
				return {
					status: note.toUpperCase().startsWith('DONE') ? 'done' : 'failed',
					resultNote: note || 'The agent finished without a report.',
					usage: usage()
				};
			}

			// Out of steps or out of item allowance: force a wrap-up without tools.
			if (steps >= MAX_TOTAL_STEPS || inputTokens + outputTokens >= assignment.tokenAllowance) {
				log(
					'status',
					steps >= MAX_TOTAL_STEPS
						? 'Step limit reached — asking the agent to wrap up.'
						: 'Item token allowance used up — asking the agent to wrap up.'
				);
				assertBudget(assignment.sprint.id);
				const wrapUp = await generateText({
					model: getModel(ctx.agent.provider, ctx.agent.model),
					system,
					messages: [
						...messages,
						{
							role: 'user',
							content:
								'You are out of time for this item. Do not call any more tools. ' +
								'Reply with your final report ("DONE:" or "INCOMPLETE:"), honestly ' +
								'describing what works, what was verified, and what is missing.'
						}
					],
					maxOutputTokens: MAX_STEP_OUTPUT_TOKENS
				});
				recordUsage(
					assignment.sprint.id,
					wrapUp.totalUsage.inputTokens ?? 0,
					wrapUp.totalUsage.outputTokens ?? 0
				);
				inputTokens += wrapUp.totalUsage.inputTokens ?? 0;
				outputTokens += wrapUp.totalUsage.outputTokens ?? 0;
				const note = wrapUp.text.trim();
				return {
					status: note.toUpperCase().startsWith('DONE') ? 'done' : 'failed',
					resultNote: note || 'The agent ran out of budget without a report.',
					usage: usage()
				};
			}
		}
	}
};
