<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();
</script>

<svelte:head><title>Sign up · Cairn</title></svelte:head>

<div class="auth-panel">
	<h1>Sign up</h1>

	{#if data.firstUser}
		<div class="banner info">
			You are creating the first account on this instance. It becomes the owner of everything set up
			so far: Product Owner of all existing teams and owner of all connected projects.
		</div>
	{/if}

	{#if form?.error}
		<div class="banner error">{form.error}</div>
	{/if}

	<form method="POST" class="card stack" use:enhance>
		<div class="field">
			<label for="name">Name</label>
			<input
				id="name"
				name="name"
				autocomplete="name"
				placeholder="Shown to teammates"
				value={form?.name ?? ''}
			/>
		</div>
		<div class="field">
			<label for="email">Email</label>
			<input
				id="email"
				name="email"
				type="email"
				required
				autocomplete="email"
				value={form?.email ?? ''}
			/>
		</div>
		<div class="field">
			<label for="password">Password (at least 8 characters)</label>
			<input
				id="password"
				name="password"
				type="password"
				required
				minlength="8"
				autocomplete="new-password"
			/>
		</div>
		<button type="submit">Create account</button>
	</form>

	<p class="muted">Already have an account? <a href="/login">Log in</a></p>
</div>

<style>
	.auth-panel {
		max-width: 26rem;
		margin: 3rem auto 0;
	}
</style>
