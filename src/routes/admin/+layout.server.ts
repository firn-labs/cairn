import { requireAdmin } from '$lib/server/auth/access';
import type { LayoutServerLoad } from './$types';

/**
 * Gates every GET under /admin (issue #25). Form actions run BEFORE loads, so
 * this alone is not the gate — every /admin action calls requireAdmin itself,
 * same as the requireTeamPo pattern on team pages.
 */
export const load: LayoutServerLoad = async ({ locals }) => {
	requireAdmin(locals.user);
	return {};
};
