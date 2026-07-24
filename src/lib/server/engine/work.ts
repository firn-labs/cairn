import { and, asc, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, backlogItems, workItemRuns, workLogs, workRuns } from '../db';
import type { BacklogItem } from '../db/schema';
import { remoteForTeam, type HostingRemote } from '../hosting';
import { findWorkspace, startWorkspace, type WorkspaceHandle } from '../workspace/docker';
import {
	captureItemResult,
	ensureRepo,
	mergeItemBranch,
	pushBranch,
	startItemBranch,
	syncCollabBranch,
	taskBranch,
	teamBranch
} from '../workspace/git';
import { getExecutor, type Executor, type WorkLogger } from './executor';
import { BudgetExceededError, loadAgentContexts, loadSprintWorld, recordUsage } from './meeting';
import type { Team } from '../db/schema';
import type { AgentContext } from './prompts';

/**
 * The work phase: fire-and-forget background job (same shape as ceremonies —
 * outcome and errors are written to the work_runs row, the UI polls). Items
 * are worked SEQUENTIALLY: each task branch is cut from the current team
 * branch tip, so merging back cannot conflict.
 */
export async function runWorkPhase(workRunId: string, sprintId: string): Promise<void> {
	const logRun = makeLogger(workRunId, null);
	try {
		const { sprint, team } = loadSprintWorld(sprintId);
		if (sprint.status !== 'active')
			throw new Error(`Work phase requires an active sprint (status is "${sprint.status}").`);

		const items = db
			.select()
			.from(backlogItems)
			.where(
				and(
					eq(backlogItems.sprintId, sprintId),
					inArray(backlogItems.status, ['selected', 'in_progress'])
				)
			)
			.orderBy(asc(backlogItems.createdAt))
			.all();
		if (items.length === 0) throw new Error('No open items in the sprint backlog.');

		const developers = (await loadAgentContexts(team)).filter(
			(ctx) => ctx.agent.role === 'developer'
		);
		if (developers.length === 0) throw new Error('The team has no developer agents.');

		const executor = await getExecutor(team);
		const remote = remoteForTeam(team);

		logRun('status', 'Preparing the team workspace…');
		const workspace =
			(await findWorkspace(sprintId)) ??
			(await startWorkspace(team.id, sprintId, (msg) => logRun('status', msg)));
		db.update(workRuns)
			.set({ containerId: workspace.containerId })
			.where(eq(workRuns.id, workRunId))
			.run();
		await ensureRepo(workspace, team, remote, (msg) => logRun('status', msg));

		// Pre-create item runs so the UI can show the whole queue immediately.
		const itemRunIds = new Map<string, string>();
		items.forEach((item, index) => {
			const id = randomUUID();
			itemRunIds.set(item.id, id);
			db.insert(workItemRuns)
				.values({
					id,
					workRunId,
					backlogItemId: item.id,
					agentId: developers[index % developers.length].agent.id,
					executor: executor.id,
					branch: taskBranch(item)
				})
				.run();
		});

		let budgetExhausted = false;
		for (const [index, item] of items.entries()) {
			const itemRunId = itemRunIds.get(item.id)!;
			if (budgetExhausted) {
				db.update(workItemRuns)
					.set({ status: 'skipped', finishedAt: new Date() })
					.where(eq(workItemRuns.id, itemRunId))
					.run();
				continue;
			}
			budgetExhausted = await runItem({
				workRunId,
				itemRunId,
				workspace,
				executor,
				item,
				agentCtx: developers[index % developers.length],
				remainingItems: items.length - index,
				sprintId,
				team,
				remote
			});
		}

		logRun(
			'status',
			budgetExhausted ? 'Work stopped: sprint token budget exhausted.' : 'Work phase finished.'
		);
		db.update(workRuns)
			.set({ status: 'completed', finishedAt: new Date() })
			.where(eq(workRuns.id, workRunId))
			.run();
	} catch (err) {
		db.update(workRuns)
			.set({
				status: 'failed',
				error: err instanceof Error ? err.message : String(err),
				finishedAt: new Date()
			})
			.where(eq(workRuns.id, workRunId))
			.run();
		db.update(workItemRuns)
			.set({ status: 'skipped', finishedAt: new Date() })
			.where(and(eq(workItemRuns.workRunId, workRunId), eq(workItemRuns.status, 'pending')))
			.run();
	}
}

/** Work one item. Returns true if the sprint budget ran out. */
async function runItem(opts: {
	workRunId: string;
	itemRunId: string;
	workspace: WorkspaceHandle;
	executor: Executor;
	item: BacklogItem;
	agentCtx: AgentContext;
	remainingItems: number;
	sprintId: string;
	team: Team;
	remote: HostingRemote | null;
}): Promise<boolean> {
	const { itemRunId, workspace, item, agentCtx, team, executor } = opts;
	const log = makeLogger(opts.workRunId, itemRunId);

	db.update(workItemRuns).set({ status: 'running' }).where(eq(workItemRuns.id, itemRunId)).run();
	db.update(backlogItems).set({ status: 'in_progress' }).where(eq(backlogItems.id, item.id)).run();
	log('status', `${agentCtx.agent.name} starts working on "${item.title}"`);

	let baseCommit = '';
	try {
		// Cross-team items are based on their shared collab branch instead of the
		// team branch — but a shared branch only exists with a hosting remote. If
		// the project was disconnected since the request, fall back to the team
		// branch rather than silently working on a branch nobody else can see.
		let baseBranch = teamBranch(team);
		if (item.collabBranch && opts.remote) {
			await syncCollabBranch(workspace, item.collabBranch, opts.remote);
			baseBranch = item.collabBranch;
		} else if (item.collabBranch) {
			log(
				'status',
				`"${item.title}" is a cross-team item, but the team has no project connected — working on the team branch instead of ${item.collabBranch}.`
			);
		}

		({ baseCommit } = await startItemBranch(workspace, baseBranch, item));

		// Fair share of what's left of the sprint budget.
		const { sprint } = loadSprintWorld(opts.sprintId);
		const tokenAllowance = Math.max(
			0,
			Math.floor((sprint.tokenBudget - sprint.tokensUsed) / opts.remainingItems)
		);

		const outcome = await executor.runItem(
			{
				sprint,
				team,
				item,
				agentCtx,
				branch: taskBranch(item),
				itemRunId,
				tokenAllowance
			},
			workspace,
			log
		);
		if (!outcome.usage.billed)
			recordUsage(opts.sprintId, outcome.usage.inputTokens, outcome.usage.outputTokens);

		const artifacts = await captureItemResult(workspace, baseCommit);

		if (outcome.status === 'done') {
			await mergeItemBranch(workspace, baseBranch, item, agentCtx.agent);
			// Push failures throw and fail the item: work that never reached the
			// hoster must not be reported as done.
			if (opts.remote) await pushBranch(workspace, opts.remote, baseBranch);
			db.update(backlogItems).set({ status: 'done' }).where(eq(backlogItems.id, item.id)).run();
			log(
				'status',
				`"${item.title}" done — task branch merged into ${baseBranch}${opts.remote ? ' and pushed to the remote' : ''}.`
			);
		} else {
			log('status', `"${item.title}" not completed: ${outcome.resultNote.slice(0, 300)}`);
		}

		db.update(workItemRuns)
			.set({
				status: outcome.status,
				resultNote: outcome.resultNote,
				diff: artifacts.diff,
				diffStat: artifacts.diffStat,
				commitLog: artifacts.commitLog,
				inputTokens: outcome.usage.inputTokens,
				outputTokens: outcome.usage.outputTokens,
				usageApproximate: outcome.usage.approximate,
				finishedAt: new Date()
			})
			.where(eq(workItemRuns.id, itemRunId))
			.run();
		return false;
	} catch (err) {
		const budget = err instanceof BudgetExceededError;
		// Best-effort capture of partial work so the PO can still see it.
		const artifacts = baseCommit
			? await captureItemResult(workspace, baseCommit).catch(() => null)
			: null;
		db.update(workItemRuns)
			.set({
				status: 'failed',
				error: err instanceof Error ? err.message : String(err),
				diff: artifacts?.diff ?? '',
				diffStat: artifacts?.diffStat ?? '',
				commitLog: artifacts?.commitLog ?? '',
				finishedAt: new Date()
			})
			.where(eq(workItemRuns.id, itemRunId))
			.run();
		log(
			'status',
			budget
				? `Sprint token budget exhausted while working on "${item.title}".`
				: `"${item.title}" failed: ${err instanceof Error ? err.message : String(err)}`
		);
		return budget;
	}
}

function makeLogger(workRunId: string, workItemRunId: string | null): WorkLogger {
	return (kind, content, toolName) => {
		db.insert(workLogs)
			.values({
				id: randomUUID(),
				workRunId,
				workItemRunId,
				kind,
				toolName: toolName ?? null,
				content: content.slice(0, 8_000)
			})
			.run();
	};
}
