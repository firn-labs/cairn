import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/** /admin itself has no content — the SSO page is the natural landing tab. */
export const load: PageServerLoad = async () => {
	redirect(303, '/admin/sso');
};
