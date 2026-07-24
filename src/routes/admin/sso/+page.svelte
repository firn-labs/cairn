<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();

	let showAdd = $state(false);
</script>

<svelte:head><title>SSO providers · Admin · Cairn</title></svelte:head>

{#if form?.error}
	<div class="banner error">{form.error}</div>
{:else if form?.ok && form?.message}
	<div class="banner info">{form.message}</div>
{/if}

<p class="muted">
	Users log in through any enabled provider below, next to the password form. Register each
	provider at your IdP as a confidential client with the callback URL shown on its card; the
	client secret is stored encrypted and never shown again.
</p>

{#if data.envActive}
	<div class="banner info">
		This instance currently uses the <strong>CAIRN_OIDC_*</strong> environment variables (shown
		below as "env fallback"). As soon as you add a provider here, the environment configuration is
		ignored — users who logged in through it can re-link the new provider on their account page,
		or keep using it if you configure the same issuer and client.
	</div>
{:else if data.envConfigured}
	<div class="banner info">
		CAIRN_OIDC_* environment variables are set but inactive — database providers take precedence.
	</div>
{/if}

<div class="stack" style="margin-top:1rem">
	{#each data.providers as provider (provider.id)}
		<div class="card">
			<div class="row spread">
				<strong>{provider.label}</strong>
				<span class="row">
					{#if provider.source === 'env'}
						<span class="badge warn">env fallback</span>
					{:else if provider.enabled}
						<span class="badge good">enabled</span>
					{:else}
						<span class="badge">disabled</span>
					{/if}
				</span>
			</div>
			<p class="muted" style="margin:0.3rem 0">
				Callback URL (register at the IdP): <code>{provider.callbackUrl}</code>
			</p>

			{#if provider.source === 'env'}
				<p class="muted" style="margin:0.3rem 0">
					Issuer <code>{provider.issuer}</code> — configured via environment variables; edit the
					<code>CAIRN_OIDC_*</code> vars and restart to change it, or add a database provider to
					replace it.
				</p>
				<form method="POST" action="?/test" use:enhance>
					<input type="hidden" name="id" value={provider.id} />
					<button class="ghost small" type="submit">Test issuer</button>
				</form>
			{:else}
				<form method="POST" action="?/update" class="stack" use:enhance>
					<input type="hidden" name="id" value={provider.id} />
					<div class="field-row">
						<div class="field">
							<label for="label-{provider.id}">Button label</label>
							<input id="label-{provider.id}" name="label" value={provider.label} required />
						</div>
						<div class="field">
							<label for="issuer-{provider.id}">Issuer URL</label>
							<input id="issuer-{provider.id}" name="issuer" value={provider.issuer} required />
						</div>
					</div>
					<div class="field-row">
						<div class="field">
							<label for="clientId-{provider.id}">Client id</label>
							<input id="clientId-{provider.id}" name="clientId" value={provider.clientId} required />
						</div>
						<div class="field">
							<label for="secret-{provider.id}">Client secret</label>
							<input
								id="secret-{provider.id}"
								name="clientSecret"
								type="password"
								autocomplete="off"
								placeholder={provider.hasSecret ? 'Stored — paste to replace' : 'None (public client)'}
							/>
						</div>
					</div>
					<div class="field-row">
						<div class="field">
							<label for="scopes-{provider.id}">Scopes</label>
							<input id="scopes-{provider.id}" name="scopes" value={provider.scopes} />
						</div>
						<div class="field">
							<label for="groupsClaim-{provider.id}">Groups claim</label>
							<input id="groupsClaim-{provider.id}" name="groupsClaim" value={provider.groupsClaim} />
						</div>
					</div>
					<div class="field-row">
						<div class="field">
							<label for="memberGroup-{provider.id}">Member group</label>
							<input
								id="memberGroup-{provider.id}"
								name="memberGroup"
								value={provider.memberGroup}
								placeholder="Empty = every user is a member"
							/>
						</div>
						<div class="field">
							<label for="viewerGroup-{provider.id}">Viewer group</label>
							<input
								id="viewerGroup-{provider.id}"
								name="viewerGroup"
								value={provider.viewerGroup}
								placeholder="Read-only guests"
							/>
						</div>
					</div>
					<div class="row">
						<button class="small" type="submit">Save</button>
					</div>
				</form>
				<div class="row" style="margin-top:0.5rem">
					<form method="POST" action="?/test" use:enhance>
						<input type="hidden" name="id" value={provider.id} />
						<button class="ghost small" type="submit">Test issuer</button>
					</form>
					<form method="POST" action="?/toggle" use:enhance>
						<input type="hidden" name="id" value={provider.id} />
						<input type="hidden" name="enabled" value={provider.enabled ? 'false' : 'true'} />
						<button class="ghost small" type="submit">
							{provider.enabled ? 'Disable' : 'Enable'}
						</button>
					</form>
					<form
						method="POST"
						action="?/delete"
						use:enhance={({ cancel }) => {
							if (
								!confirm(
									'Delete this provider? Its linked SSO identities are removed too — users keep their accounts but need a password or another provider to log in.'
								)
							)
								cancel();
						}}
					>
						<input type="hidden" name="id" value={provider.id} />
						<button class="ghost small" type="submit">Delete</button>
					</form>
				</div>
			{/if}
		</div>
	{:else}
		<p class="muted">No SSO providers yet — password login is the only way in.</p>
	{/each}
</div>

<section style="margin-top:1.5rem">
	{#if !showAdd}
		<button onclick={() => (showAdd = true)}>Add provider</button>
	{:else}
		<div class="card">
			<h2 style="margin-top:0">Add provider</h2>
			<form method="POST" action="?/create" class="stack" use:enhance>
				<div class="field-row">
					<div class="field">
						<label for="new-label">Button label</label>
						<input id="new-label" name="label" placeholder="e.g. Keycloak" required />
					</div>
					<div class="field">
						<label for="new-issuer">Issuer URL</label>
						<input
							id="new-issuer"
							name="issuer"
							placeholder="https://auth.example.com/realms/main"
							required
						/>
					</div>
				</div>
				<div class="field-row">
					<div class="field">
						<label for="new-clientId">Client id</label>
						<input id="new-clientId" name="clientId" required />
					</div>
					<div class="field">
						<label for="new-secret">Client secret</label>
						<input
							id="new-secret"
							name="clientSecret"
							type="password"
							autocomplete="off"
							placeholder="Empty for a public client"
						/>
					</div>
				</div>
				<div class="field-row">
					<div class="field">
						<label for="new-scopes">Scopes</label>
						<input id="new-scopes" name="scopes" placeholder="openid profile email" />
					</div>
					<div class="field">
						<label for="new-groupsClaim">Groups claim</label>
						<input id="new-groupsClaim" name="groupsClaim" placeholder="groups" />
					</div>
				</div>
				<div class="field-row">
					<div class="field">
						<label for="new-memberGroup">Member group</label>
						<input
							id="new-memberGroup"
							name="memberGroup"
							placeholder="Empty = every user is a member"
						/>
					</div>
					<div class="field">
						<label for="new-viewerGroup">Viewer group</label>
						<input id="new-viewerGroup" name="viewerGroup" placeholder="Read-only guests" />
					</div>
				</div>
				<div class="row">
					<button type="submit">Add provider</button>
					<button class="ghost" type="button" onclick={() => (showAdd = false)}>Cancel</button>
				</div>
			</form>
		</div>
	{/if}
</section>
