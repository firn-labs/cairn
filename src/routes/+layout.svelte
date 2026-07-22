<script lang="ts">
	import favicon from '$lib/assets/favicon.svg';
	import '../app.css';

	let { children } = $props();
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
	<nav class="row">
		<a href="/">Teams</a>
		<a href="/projects">Projects</a>
	</nav>
	<span class="crumbs" style="margin-left:auto">AI agent teams, run with SCRUM</span>
</header>

<main>
	{@render children()}
</main>
