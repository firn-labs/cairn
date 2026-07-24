<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();

	const dateFmt = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' });
</script>

<svelte:head><title>Users · Admin · Cairn</title></svelte:head>

{#if form?.error}
	<div class="banner error">{form.error}</div>
{/if}

<p class="muted">
	Admins manage SSO providers, instance settings and this list. You cannot change your own admin
	flag, so there is always at least one admin left.
</p>

<div class="stack" style="margin-top:1rem">
	{#each data.users as user (user.id)}
		<div class="card row spread">
			<span>
				<strong>{user.name || user.email}</strong>
				{#if user.name}<span class="muted"> · {user.email}</span>{/if}
				<br />
				<span class="muted">
					since {dateFmt.format(user.createdAt)} ·
					{user.hasPassword ? 'password' : 'SSO-only'}{user.ssoLinks > 0
						? ` · ${user.ssoLinks} SSO ${user.ssoLinks === 1 ? 'identity' : 'identities'}`
						: ''}
				</span>
			</span>
			<span class="row">
				<span class="badge {user.role === 'member' ? 'accent' : ''}">{user.role}</span>
				{#if user.isAdmin}
					<span class="badge good">admin</span>
				{/if}
				{#if user.id !== data.user?.id}
					<form method="POST" action="?/setAdmin" use:enhance>
						<input type="hidden" name="userId" value={user.id} />
						<input type="hidden" name="isAdmin" value={user.isAdmin ? 'false' : 'true'} />
						<button class="ghost small" type="submit">
							{user.isAdmin ? 'Revoke admin' : 'Make admin'}
						</button>
					</form>
				{/if}
			</span>
		</div>
	{/each}
</div>
