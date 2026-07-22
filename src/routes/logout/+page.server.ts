import { redirect } from '@sveltejs/kit';
import { destroySession } from '$lib/server/auth/session';
import type { Actions, PageServerLoad } from './$types';

// Logout is POST-only (the topbar form); a stray GET just goes home.
export const load: PageServerLoad = async () => {
	redirect(303, '/');
};

export const actions: Actions = {
	default: async ({ cookies }) => {
		destroySession(cookies);
		redirect(303, '/login');
	}
};
