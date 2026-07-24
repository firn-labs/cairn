<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';

	let { data, form } = $props();

	// Set by the OIDC callback after a link attempt.
	const linkedLabel = $derived(page.url.searchParams.get('linked'));
	const linkError = $derived(page.url.searchParams.get('error'));

	const dateFmt = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' });
</script>

<svelte:head><title>Account · Cairn</title></svelte:head>

<h1>Account</h1>

{#if form?.error || linkError}
	<div class="banner error" style="margin-top:1rem">{form?.error ?? linkError}</div>
{:else if form?.ok && form?.message}
	<div class="banner info" style="margin-top:1rem">{form.message}</div>
{:else if linkedLabel}
	<div class="banner info" style="margin-top:1rem">Linked {linkedLabel} to your account.</div>
{/if}

<section>
	<h2>Sign-in methods</h2>
	<p class="muted">
		{data.hasPassword
			? 'You can sign in with your password'
			: 'This account has no password'}{data.linked.length > 0
			? ` and ${data.linked.length} linked SSO ${data.linked.length === 1 ? 'identity' : 'identities'}.`
			: '.'}
	</p>

	<div class="stack" style="margin-top:0.8rem">
		{#each data.linked as link (link.providerId + link.subject)}
			<div class="card row spread">
				<span>
					<strong>{link.label}</strong>
					{#if !link.active}<span class="badge warn">inactive</span>{/if}
					<br />
					<span class="muted">linked {dateFmt.format(link.createdAt)}</span>
				</span>
				{#if data.canUnlink}
					<form method="POST" action="?/unlink" use:enhance>
						<input type="hidden" name="providerId" value={link.providerId} />
						<input type="hidden" name="subject" value={link.subject} />
						<button class="ghost small" type="submit">Unlink</button>
					</form>
				{:else}
					<span class="muted">Only way in — cannot unlink</span>
				{/if}
			</div>
		{/each}
	</div>

	{#if data.linkable.length > 0}
		<div class="row" style="margin-top:0.8rem">
			{#each data.linkable as provider (provider.id)}
				<a href={provider.linkPath} class="card sso-link">Link {provider.label}</a>
			{/each}
		</div>
		<p class="muted">
			Linking signs you in at the provider and attaches that identity to THIS account — use it
			when your identity provider email differs from your account email.
		</p>
	{/if}
</section>

{#if data.hasPassword}
	<section style="margin-top:1.5rem">
		<h2>Change password</h2>
		<form method="POST" action="?/changePassword" class="card stack" style="max-width:26rem" use:enhance>
			<div class="field">
				<label for="currentPassword">Current password</label>
				<input
					id="currentPassword"
					name="currentPassword"
					type="password"
					required
					autocomplete="current-password"
				/>
			</div>
			<div class="field">
				<label for="newPassword">New password</label>
				<input
					id="newPassword"
					name="newPassword"
					type="password"
					required
					minlength="8"
					autocomplete="new-password"
				/>
			</div>
			<button type="submit">Change password</button>
		</form>
	</section>
{/if}

<style>
	.sso-link {
		text-decoration: none;
		font-weight: 600;
		padding: 0.5rem 0.9rem;
	}
</style>
