import { startOidcFlow } from '$lib/server/auth/oidcFlow';
import type { RequestHandler } from './$types';

/** Starts the flow for a DB-managed provider (issue #25). With ?link=1 and a
 *  live session, the identity is linked to the logged-in user instead. */
export const GET: RequestHandler = (event) => startOidcFlow(event, event.params.providerId);
