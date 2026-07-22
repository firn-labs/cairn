// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			/** Set by the session handle in hooks.server.ts; null only on public
			 *  routes (/login, /signup, /login/oidc/*) — everything else redirects
			 *  first. `role` is the instance role: viewers create nothing. */
			user: { id: string; email: string; name: string; role: 'member' | 'viewer' } | null;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
