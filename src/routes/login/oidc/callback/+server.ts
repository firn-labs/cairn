import { handleOidcCallback } from '$lib/server/auth/oidcFlow';
import { ENV_PROVIDER_ID } from '$lib/server/auth/ssoProviders';
import type { RequestHandler } from './$types';

/** Callback of the env-var fallback provider. This exact path is what
 *  existing IdP client registrations have as their redirect URI — keep it. */
export const GET: RequestHandler = (event) => handleOidcCallback(event, ENV_PROVIDER_ID);
