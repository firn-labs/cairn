import type { SubmitFunction } from '@sveltejs/kit';

/**
 * Like plain `use:enhance`, but failures that never produce a form action
 * result — the CSRF 403 when ORIGIN does not match the browser address, a
 * proxy error, a crashed server — are reported through `setError` as a banner
 * on the form instead of dumping the user on the generic error page.
 * `fail()` results and redirects behave exactly like default enhance.
 */
export function reportUnexpectedErrors(setError: (message: string | null) => void): SubmitFunction {
	return () =>
		async ({ result, update }) => {
			if (result.type === 'error') {
				const status = 'status' in result && result.status ? ` (HTTP ${result.status})` : '';
				setError(
					`Submitting failed before it reached Cairn${status}. On a Docker or reverse-proxy ` +
						`deployment this usually means the ORIGIN environment variable does not match the ` +
						`address in your browser bar — see "Deploying" in the README. Details are in the ` +
						`server logs.`
				);
				return;
			}
			setError(null);
			await update();
		};
}
