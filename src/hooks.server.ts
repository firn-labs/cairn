import { redirect, type Handle, type ServerInit } from '@sveltejs/kit';
import { reconcileWorkspaces } from '$lib/server/workspace/docker';
import { validateSession } from '$lib/server/auth/session';

// Runs once per server start: background jobs die with the process, so stale
// "running" work runs are marked failed and orphaned workspace containers are
// removed. Non-blocking and safe when Docker is unreachable.
export const init: ServerInit = () => {
	void reconcileWorkspaces();
};

/** Routes reachable without a session. */
const PUBLIC_ROUTES = new Set(['/login', '/signup']);

/** All OIDC flow routes are public: /login/oidc[/callback] for the env-var
 *  fallback provider, /login/oidc/<providerId>[/callback] for DB providers
 *  (issue #25). Link-mode starts additionally require a session and check it
 *  themselves. */
function isPublic(pathname: string): boolean {
	return (
		PUBLIC_ROUTES.has(pathname) ||
		pathname === '/login/oidc' ||
		/^\/login\/oidc\/[^/]+(\/callback)?$/.test(pathname)
	);
}

// Every request resolves the session cookie; everything except the public
// routes requires a user. This also covers form actions — POSTs without a
// session are redirected before any action runs.
export const handle: Handle = async ({ event, resolve }) => {
	const user = validateSession(event.cookies);
	event.locals.user = user
		? { id: user.id, email: user.email, name: user.name, role: user.role, isAdmin: user.isAdmin }
		: null;

	if (!event.locals.user && !isPublic(event.url.pathname)) {
		const target = event.url.pathname + event.url.search;
		redirect(303, target === '/' ? '/login' : `/login?redirectTo=${encodeURIComponent(target)}`);
	}

	return resolve(event);
};
