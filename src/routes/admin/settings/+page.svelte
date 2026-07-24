<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();
</script>

<svelte:head><title>Instance settings · Admin · Cairn</title></svelte:head>

{#if form?.error}
	<div class="banner error">{form.error}</div>
{:else if form?.ok && form?.message}
	<div class="banner info">{form.message}</div>
{/if}

<section>
	<h2>Collaboration</h2>
	<div class="card row spread">
		<span>
			<strong>Cross-team collaboration</strong>
			<br />
			<span class="muted">
				When enabled, agents can discover other teams of the same Product Owner and file work
				requests with them (including shared collab branches). When disabled, the discovery and
				request tools disappear from work runs entirely.
			</span>
		</span>
		<form method="POST" action="?/setFlag" use:enhance>
			<input type="hidden" name="key" value="collaborationEnabled" />
			<input type="hidden" name="value" value={data.collaborationEnabled ? 'false' : 'true'} />
			{#if data.collaborationEnabled}
				<span class="badge good">enabled</span>
				<button class="ghost small" type="submit">Disable</button>
			{:else}
				<span class="badge">disabled</span>
				<button class="small" type="submit">Enable</button>
			{/if}
		</form>
	</div>
</section>

<section style="margin-top:1.5rem">
	<h2>Limits &amp; budgets</h2>
	<p class="muted">
		Instance-wide caps on agent activity and LLM spend. Changes apply immediately to running sprints
		— already-started sprints keep the token budget they were created with.
	</p>
	<form method="POST" action="?/saveLimits" class="card stack" use:enhance>
		{#each data.limits as limit (limit.key)}
			<div class="field">
				<label for="limit-{limit.key}">
					{limit.label}
					<span class="muted">(default {limit.def})</span>
				</label>
				<input
					id="limit-{limit.key}"
					name={limit.key}
					type="number"
					min={limit.min}
					step="1"
					value={limit.value}
				/>
				<span class="muted">{limit.hint}</span>
			</div>
		{/each}
		<div class="row">
			<button type="submit">Save limits</button>
		</div>
	</form>
</section>

<section style="margin-top:1.5rem">
	<h2>LLM provider credentials</h2>
	<p class="muted">
		Cairn-wide credentials for the agents' LLM providers. A value stored here wins over the matching
		environment variable; API keys are stored encrypted and are write-only — the page only shows
		where the effective value comes from.
	</p>
	<div class="stack">
		{#each data.providerSettings as setting (setting.key)}
			<div class="card">
				<div class="row spread">
					<strong>{setting.label}</strong>
					{#if setting.source === 'db'}
						<span class="badge good">set here</span>
					{:else if setting.source === 'env'}
						<span class="badge accent">from environment</span>
					{:else}
						<span class="badge">not set</span>
					{/if}
				</div>
				<p class="muted" style="margin:0.3rem 0"><code>{setting.key}</code></p>
				<form method="POST" action="?/saveProviderSetting" class="row" use:enhance>
					<input type="hidden" name="key" value={setting.key} />
					<input
						name="value"
						type={setting.secret ? 'password' : 'text'}
						style="flex:1"
						autocomplete="off"
						value={setting.secret ? '' : (setting.visibleValue ?? '')}
						placeholder={setting.secret
							? setting.source === 'db'
								? 'Stored — paste to replace'
								: 'Paste to store'
							: 'e.g. http://localhost:11434'}
					/>
					<button class="small" type="submit" style="align-self:flex-end">Save</button>
				</form>
				{#if setting.source === 'db'}
					<form method="POST" action="?/clearProviderSetting" style="margin-top:0.4rem" use:enhance>
						<input type="hidden" name="key" value={setting.key} />
						<button class="ghost small" type="submit">
							Remove (fall back to the environment variable)
						</button>
					</form>
				{/if}
			</div>
		{/each}
	</div>
</section>

<section style="margin-top:1.5rem">
	<h2>Code generation</h2>
	<div class="card">
		<strong>Default Ollama model for the OpenCode executor</strong>
		<p class="muted" style="margin:0.3rem 0">
			Used by teams running the OpenCode (Ollama) executor that have not chosen a model of their
			own. Empty = the built-in default (qwen3).
		</p>
		<form method="POST" action="?/saveOllamaModel" class="row" use:enhance>
			<input
				name="value"
				style="flex:1"
				value={data.ollamaCodegenModel}
				placeholder="e.g. qwen3, deepseek-coder-v2"
			/>
			<button class="small" type="submit" style="align-self:flex-end">Save</button>
		</form>
	</div>
</section>
