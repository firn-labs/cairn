<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();

	const dateFmt = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
</script>

<svelte:head><title>Settings · Cairn</title></svelte:head>

<h1>Settings</h1>

{#if form?.error}
	<div class="banner error" style="margin-top:1rem">{form.error}</div>
{/if}

<section>
	<h2>Executor credentials</h2>
	<p class="muted">
		Credentials for the CLI executors (Claude Code, Codex) of teams where you are the Product
		Owner. With an OAuth token or auth.json, work runs bill your subscription plan instead of an
		API key. Stored encrypted; injected only into the team's disposable workspace container for
		the duration of a work run.
	</p>
	<div class="banner info">
		A CLI executor necessarily carries its credential into the workspace container, where code
		written by the agents runs — the same exposure as running the CLI on your own machine. Only
		store credentials you would use in a normal Claude Code / Codex session.
	</div>

	<div class="stack" style="margin-top:1rem">
		{#each data.credentials as cred (cred.kind)}
			<div class="card">
				<div class="row spread">
					<strong>{cred.label}</strong>
					{#if cred.savedAt}
						<span class="badge good">set {dateFmt.format(cred.savedAt)}</span>
					{:else}
						<span class="badge">not set</span>
					{/if}
				</div>
				<p class="muted" style="margin:0.3rem 0">{cred.hint}</p>
				<form method="POST" action="?/save" class="row" use:enhance>
					<input type="hidden" name="kind" value={cred.kind} />
					{#if cred.multiline}
						<textarea
							name="secret"
							rows="3"
							style="flex:1;font-family:var(--mono)"
							placeholder={cred.savedAt ? 'Paste to replace the stored value' : 'Paste here'}
						></textarea>
					{:else}
						<input
							name="secret"
							type="password"
							style="flex:1"
							autocomplete="off"
							placeholder={cred.savedAt ? 'Paste to replace the stored value' : 'Paste here'}
						/>
					{/if}
					<button class="small" type="submit" style="align-self:flex-end">
						{cred.savedAt ? 'Replace' : 'Save'}
					</button>
				</form>
				{#if cred.savedAt}
					<form method="POST" action="?/delete" style="margin-top:0.4rem" use:enhance>
						<input type="hidden" name="kind" value={cred.kind} />
						<button class="ghost small" type="submit">Delete</button>
					</form>
				{/if}
			</div>
		{/each}
	</div>
</section>
