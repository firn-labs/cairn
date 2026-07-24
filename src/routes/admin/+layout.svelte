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
<nav class="admin-tabs">
	{#each tabs as tab (tab.href)}
		<a href={tab.href} class:active={page.url.pathname === tab.href}>{tab.label}</a>
	{/each}
</nav>

{@render children()}

<style>
	.admin-tabs {
		display: inline-flex;
		gap: 0.25rem;
		margin: 0.8rem 0 1.4rem;
		padding: 0.3rem;
		background: rgba(255, 255, 255, 0.03);
		border: 1px solid var(--surface-border);
		border-radius: 999px;
	}
	.admin-tabs a {
		padding: 0.32rem 0.9rem;
		border-radius: 999px;
		color: var(--text-dim);
		font-size: 0.9rem;
		transition:
			background 0.15s,
			color 0.15s;
	}
	.admin-tabs a:hover {
		text-decoration: none;
		color: var(--text);
	}
	.admin-tabs a.active {
		font-weight: 600;
		color: var(--accent);
		background: color-mix(in srgb, var(--accent) 15%, transparent);
	}
</style>
