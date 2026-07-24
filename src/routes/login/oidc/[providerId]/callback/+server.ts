import { handleOidcCallback } from '$lib/server/auth/oidcFlow';
import type { RequestHandler } from './$types';

/** Callback for a DB-managed provider — the redirect URI to register at the
 *  IdP is <origin>/login/oidc/<providerId>/callback. */
export const GET: RequestHandler = (event) => handleOidcCallback(event, event.params.providerId);
