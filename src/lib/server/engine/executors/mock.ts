import { writeFileInWorkspace } from '../../workspace/docker';
import { commitAs } from '../../workspace/git';
import type { Executor } from '../executor';

/**
 * No-LLM executor (CAIRN_EXECUTOR=mock): writes a marker file and commits it.
 * Lets the whole Docker + git + work-run pipeline be exercised end-to-end
 * without an API key, and doubles as the reference executor implementation.
 */
export const mockExecutor: Executor = {
	id: 'mock',

	async runItem(assignment, workspace, log) {
		const { item, agentCtx } = assignment;
		const file = `ITEM-${item.id.slice(0, 8)}.md`;
		log('status', `mock executor: writing ${file}`);

		await writeFileInWorkspace(
			workspace,
			`${workspace.repoDir}/${file}`,
			`# ${item.title}\n\n${item.description}\n\n## Acceptance criteria\n\n${item.acceptanceCriteria}\n`
		);
		if (agentCtx) {
			await commitAs(workspace, agentCtx.agent, `feat: ${item.title} (mock)`);
			log('status', `mock executor: committed ${file} as ${agentCtx.agent.name}`);
		}

		return {
			status: 'done' as const,
			resultNote: `Mock executor wrote ${file}; no real implementation.`,
			usage: { inputTokens: 0, outputTokens: 0, approximate: false, billed: true }
		};
	}
};
