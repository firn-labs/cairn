<script lang="ts">
	import { page } from '$app/state';

	let { children } = $props();

	const tabs = [
		{ href: '/admin/sso', label: 'SSO providers' },
		{ href: '/admin/users', label: 'Users' },
		{ href: '/admin/settings', label: 'Instance settings' }
	];
</script>

<h1>Administration</h1>
<nav class="row admin-tabs">
	{#each tabs as tab (tab.href)}
		<a href={tab.href} class:active={page.url.pathname === tab.href}>{tab.label}</a>
	{/each}
</nav>

{@render children()}

<style>
	.admin-tabs {
		margin: 0.8rem 0 1.4rem;
		gap: 1rem;
		border-bottom: 1px solid var(--border, #333);
		padding-bottom: 0.6rem;
	}
	.admin-tabs a.active {
		font-weight: 600;
		color: var(--accent);
	}
</style>
