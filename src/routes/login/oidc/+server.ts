import { startOidcFlow } from '$lib/server/auth/oidcFlow';
import { ENV_PROVIDER_ID } from '$lib/server/auth/ssoProviders';
import type { RequestHandler } from './$types';

/** Starts the flow for the env-var fallback provider (historic URL — DB
 *  providers use /login/oidc/<providerId>). */
export const GET: RequestHandler = (event) => startOidcFlow(event, ENV_PROVIDER_ID);
