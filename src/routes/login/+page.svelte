<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';

	let { data, form } = $props();

	const redirectTo = $derived(page.url.searchParams.get('redirectTo'));
	const signupHref = $derived(
		redirectTo ? `/signup?redirectTo=${encodeURIComponent(redirectTo)}` : '/signup'
	);
	const ssoHref = (startPath: string) =>
		redirectTo ? `${startPath}?redirectTo=${encodeURIComponent(redirectTo)}` : startPath;
	// Set by the OIDC callback when a login attempt fails.
	const ssoError = $derived(page.url.searchParams.get('error'));
</script>

<svelte:head><title>Log in · Cairn</title></svelte:head>

<div class="auth-panel">
	<h1>Log in</h1>

	{#if data.firstUser}
		<div class="banner info">
			This Cairn instance has no users yet — <a href={signupHref}>create the first account</a> to
			become its owner.
		</div>
	{/if}

	{#if form?.error || ssoError}
		<div class="banner error">{form?.error ?? ssoError}</div>
	{/if}

	{#if data.ssoProviders.length > 0}
		<div class="stack">
			{#each data.ssoProviders as provider (provider.startPath)}
				<a href={ssoHref(provider.startPath)} class="card sso-button">{provider.label}</a>
			{/each}
		</div>
		<p class="muted" style="text-align:center">or use a local account</p>
	{/if}

	<form method="POST" class="card stack" use:enhance>
		<div class="field">
			<label for="email">Email</label>
			<input id="email" name="email" type="email" required autocomplete="email" value={form?.email ?? ''} />
		</div>
		<div class="field">
			<label for="password">Password</label>
			<input id="password" name="password" type="password" required autocomplete="current-password" />
		</div>
		<button type="submit">Log in</button>
	</form>

	{#if data.signupOpen && !data.firstUser}
		<p class="muted">No account yet? <a href={signupHref}>Sign up</a></p>
	{/if}
</div>

<style>
	.auth-panel {
		max-width: 26rem;
		margin: 3rem auto 0;
	}
	.sso-button {
		display: block;
		text-align: center;
		font-weight: 600;
		text-decoration: none;
	}
</style>
