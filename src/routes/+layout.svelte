<script lang="ts">
	import favicon from '$lib/assets/favicon.svg';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import '../app.css';

	let { data, children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>Cairn</title>
</svelte:head>

{#if data.user}
	<div class="shell">
		<Sidebar user={data.user} />
		<div class="content">
			<main>
				{@render children()}
			</main>
		</div>
	</div>
{:else}
	<header class="topbar">
		<a href="/" class="wordmark">
			<span class="stones"><span></span><span></span><span></span></span>
			cairn
		</a>
		<span class="crumbs" style="margin-left:auto">AI agent teams, run with SCRUM</span>
	</header>
	<main>
		{@render children()}
	</main>
{/if}
