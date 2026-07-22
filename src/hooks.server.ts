import type { ServerInit } from '@sveltejs/kit';
import { reconcileWorkspaces } from '$lib/server/workspace/docker';

// Runs once per server start: background jobs die with the process, so stale
// "running" work runs are marked failed and orphaned workspace containers are
// removed. Non-blocking and safe when Docker is unreachable.
export const init: ServerInit = () => {
	void reconcileWorkspaces();
};
