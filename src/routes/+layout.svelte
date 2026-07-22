<script lang="ts">
	import { enhance } from '$app/forms';
	import favicon from '$lib/assets/favicon.svg';
	import '../app.css';

	let { data, children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>Cairn</title>
</svelte:head>

<header class="topbar">
	<a href="/" class="wordmark">
		<span class="stones"><span></span><span></span><span></span></span>
		cairn
	</a>
	{#if data.user}
		<nav class="row">
			<a href="/">Dashboard</a>
			<a href="/teams">Teams</a>
			<a href="/projects">Projects</a>
		</nav>
		<span class="row" style="margin-left:auto">
			<span class="crumbs">{data.user.name || data.user.email}</span>
			<form method="POST" action="/logout" use:enhance>
				<button class="ghost small" type="submit">Log out</button>
			</form>
		</span>
	{:else}
		<span class="crumbs" style="margin-left:auto">AI agent teams, run with SCRUM</span>
	{/if}
</header>

<main>
	{@render children()}
</main>
