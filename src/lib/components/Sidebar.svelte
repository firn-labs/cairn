<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import Icon, { type IconName } from './Icon.svelte';

	let { user }: { user: { name: string | null; email: string; isAdmin: boolean } } = $props();

	type NavLink = { href: string; label: string; icon: IconName; exact?: boolean };

	const links: NavLink[] = [
		{ href: '/', label: 'Dashboard', icon: 'dashboard', exact: true },
		{ href: '/teams', label: 'Teams', icon: 'teams' },
		{ href: '/projects', label: 'Projects', icon: 'projects' },
		{ href: '/settings', label: 'Settings', icon: 'settings', exact: true }
	];

	let collapsed = $state(false);
	let ready = $state(false);

	onMount(() => {
		collapsed = localStorage.getItem('cairn.sidebar.collapsed') === '1';
		ready = true;
	});

	function toggle() {
		collapsed = !collapsed;
		localStorage.setItem('cairn.sidebar.collapsed', collapsed ? '1' : '0');
	}

	function isActive(link: NavLink): boolean {
		return link.exact ? page.url.pathname === link.href : page.url.pathname.startsWith(link.href);
	}

	const displayName = $derived(user.name || user.email);
	const initial = $derived(displayName.slice(0, 1).toUpperCase());
</script>

<aside class="sidebar" class:collapsed class:ready>
	<a href="/" class="wordmark" title="Cairn">
		<span class="stones"><span></span><span></span><span></span></span>
		<span class="label">cairn</span>
	</a>

	<nav>
		{#each links as link (link.href)}
			<a
				href={link.href}
				class="nav-link"
				class:active={isActive(link)}
				title={collapsed ? link.label : undefined}
			>
				<Icon name={link.icon} />
				<span class="label">{link.label}</span>
			</a>
		{/each}
		{#if user.isAdmin}
			<a
				href="/admin/sso"
				class="nav-link"
				class:active={page.url.pathname.startsWith('/admin')}
				title={collapsed ? 'Admin' : undefined}
			>
				<Icon name="shield" />
				<span class="label">Admin</span>
			</a>
		{/if}
	</nav>

	<div class="footer">
		<a
			href="/account"
			class="nav-link account"
			class:active={page.url.pathname === '/account'}
			title={collapsed ? displayName : undefined}
		>
			<span class="avatar">{initial}</span>
			<span class="label ellipsis">{displayName}</span>
		</a>
		<form method="POST" action="/logout" use:enhance>
			<button class="side-btn" type="submit" title={collapsed ? 'Log out' : undefined}>
				<Icon name="logout" />
				<span class="label">Log out</span>
			</button>
		</form>
		<button
			class="side-btn"
			type="button"
			onclick={toggle}
			title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
		>
			<Icon name={collapsed ? 'chevrons-right' : 'chevrons-left'} />
			<span class="label">Collapse</span>
		</button>
	</div>
</aside>

<style>
	.sidebar {
		position: sticky;
		top: 0;
		align-self: flex-start;
		flex: none;
		height: 100vh;
		width: 244px;
		display: flex;
		flex-direction: column;
		padding: 1rem 0.7rem 0.8rem;
		background: linear-gradient(180deg, rgba(23, 29, 40, 0.72), rgba(13, 17, 24, 0.72));
		backdrop-filter: blur(18px);
		-webkit-backdrop-filter: blur(18px);
		border-right: 1px solid var(--surface-border);
		box-shadow: inset -1px 0 0 rgba(255, 255, 255, 0.02);
		overflow: hidden;
		z-index: 10;
	}
	.sidebar.ready {
		transition: width 0.22s ease;
	}
	.sidebar.collapsed {
		width: 74px;
	}

	.wordmark {
		margin: 0.1rem 0.45rem 1.1rem;
	}
	.collapsed .wordmark {
		justify-content: center;
		margin-inline: 0;
	}

	nav {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		flex: 1;
	}

	.nav-link {
		display: flex;
		align-items: center;
		gap: 0.7rem;
		padding: 0.55rem 0.75rem;
		border-radius: 10px;
		color: var(--text-dim);
		font-weight: 500;
		font-size: 0.93rem;
		white-space: nowrap;
		transition:
			background 0.15s,
			color 0.15s;
	}
	.nav-link:hover {
		background: rgba(255, 255, 255, 0.05);
		color: var(--text);
		text-decoration: none;
	}
	.nav-link.active {
		background: linear-gradient(
			90deg,
			color-mix(in srgb, var(--accent) 17%, transparent),
			color-mix(in srgb, var(--accent) 7%, transparent)
		);
		color: var(--accent);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 25%, transparent);
	}
	.nav-link :global(svg) {
		flex: none;
	}

	.collapsed .label {
		display: none;
	}
	.collapsed .nav-link,
	.collapsed .side-btn {
		justify-content: center;
		padding-inline: 0;
	}

	.footer {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		border-top: 1px solid var(--surface-border);
		padding-top: 0.6rem;
		margin-top: 0.6rem;
	}

	.avatar {
		flex: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 26px;
		height: 26px;
		margin: -4px 0;
		border-radius: 50%;
		background: linear-gradient(135deg, var(--accent), var(--accent-2));
		color: #fff;
		font-size: 0.78rem;
		font-weight: 700;
	}
	.ellipsis {
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.side-btn {
		display: flex;
		align-items: center;
		gap: 0.7rem;
		width: 100%;
		padding: 0.55rem 0.75rem;
		border: none;
		border-radius: 10px;
		background: none;
		box-shadow: none;
		color: var(--text-dim);
		font-weight: 500;
		font-size: 0.93rem;
		white-space: nowrap;
		text-align: left;
	}
	.side-btn:hover {
		background: rgba(255, 255, 255, 0.05);
		color: var(--text);
		filter: none;
		transform: none;
		box-shadow: none;
	}

	@media (max-width: 760px) {
		.sidebar {
			width: 74px;
		}
		.label {
			display: none;
		}
		.nav-link,
		.side-btn {
			justify-content: center;
			padding-inline: 0;
		}
		.wordmark {
			justify-content: center;
			margin-inline: 0;
		}
	}
</style>
