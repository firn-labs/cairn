<script lang="ts">
	import { page } from '$app/state';
</script>

<svelte:head><title>Error · Cairn</title></svelte:head>

<div class="error-panel">
	<h1>{page.status}</h1>
	<div class="banner error">{page.error?.message ?? 'Something went wrong.'}</div>
	{#if page.status >= 500}
		<p class="muted">Details are in the server logs.</p>
	{/if}
	<p class="muted"><a href="/">Back to the dashboard</a></p>
</div>

<style>
	.error-panel {
		max-width: 26rem;
		margin: 3rem auto 0;
	}
</style>
