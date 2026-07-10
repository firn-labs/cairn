<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();

	const sprintBadge: Record<string, string> = {
		planning: 'warn',
		active: 'accent',
		review: 'warn',
		completed: 'good'
	};

	// svelte-ignore state_referenced_locally -- intentionally only the initial value
	let selectedProvider = $state(data.providers.find((p) => p.configured)?.id ?? 'anthropic');
	let model = $state('');

	function providerDefault(id: string) {
		return data.providers.find((p) => p.id === id)?.defaultModel ?? '';
	}

	const hasScrumMaster = $derived(data.agents.some((a) => a.role === 'scrum_master'));
</script>

<svelte:head><title>{data.team.name} · Cairn</title></svelte:head>

<div class="row spread">
	<div>
		<h1>{data.team.name}</h1>
		{#if data.team.description}
			<p class="muted" style="margin-top:0">{data.team.description}</p>
		{/if}
		<div class="row">
			{#each data.team.tags as tag}
				<span class="badge accent">{tag}</span>
			{/each}
		</div>
	</div>
</div>

{#if form?.error}
	<div class="banner error" style="margin-top:1rem">{form.error}</div>
{/if}

<section>
	<h2>Sprints</h2>
	{#if data.sprints.length > 0}
		<div class="stack">
			{#each data.sprints as sprint (sprint.id)}
				<a class="card link" href="/teams/{data.team.id}/sprints/{sprint.id}">
					<div class="row spread">
						<strong>Sprint {sprint.number}</strong>
						<span class="badge {sprintBadge[sprint.status] ?? ''}">{sprint.status}</span>
					</div>
					{#if sprint.goal}
						<p class="muted" style="margin:0.35rem 0 0">{sprint.goal}</p>
					{/if}
				</a>
			{/each}
		</div>
	{:else}
		<p class="muted">No sprints yet.</p>
	{/if}

	<form
		method="POST"
		action="?/startSprint"
		class="card row"
		style="margin-top:1rem"
		use:enhance
	>
		<div style="flex:1;min-width:200px">
			<label for="tokenBudget">Token budget for the sprint (hard limit)</label>
			<input id="tokenBudget" name="tokenBudget" type="number" value="300000" min="10000" step="10000" />
		</div>
		<button type="submit" style="align-self:flex-end">Start new sprint</button>
	</form>
	{#if !hasScrumMaster && data.agents.length > 0}
		<p class="muted">
			Tip: add a Scrum Master agent — it facilitates the meetings. Without one, the first agent
			takes over facilitation.
		</p>
	{/if}
</section>

<section>
	<h2>Product backlog</h2>
	<p class="muted">
		Items ready for the team to pull into a sprint. Items already in a sprint appear on the sprint
		page instead.
	</p>
	{#if data.backlog.length > 0}
		<table>
			<thead>
				<tr><th>Item</th><th>Acceptance criteria</th><th></th></tr>
			</thead>
			<tbody>
				{#each data.backlog as item (item.id)}
					<tr>
						<td>
							<strong>{item.title}</strong>
							{#if item.description}<div class="muted">{item.description}</div>{/if}
						</td>
						<td class="muted">{item.acceptanceCriteria || '—'}</td>
						<td>
							<form method="POST" action="?/deleteBacklogItem" use:enhance>
								<input type="hidden" name="id" value={item.id} />
								<button class="ghost small" type="submit">Delete</button>
							</form>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{:else}
		<p class="muted">The backlog is empty.</p>
	{/if}

	<form method="POST" action="?/addBacklogItem" class="card" style="margin-top:1rem" use:enhance>
		<h3>Add backlog item</h3>
		<div class="field">
			<label for="title">Title</label>
			<input id="title" name="title" required placeholder="e.g. Users can reset their password" />
		</div>
		<div class="field">
			<label for="description">Description</label>
			<textarea id="description" name="description"></textarea>
		</div>
		<div class="field">
			<label for="acceptanceCriteria">Acceptance criteria</label>
			<textarea
				id="acceptanceCriteria"
				name="acceptanceCriteria"
				placeholder="How will you decide whether to accept this item in the sprint review?"
			></textarea>
		</div>
		<button type="submit">Add item</button>
	</form>
</section>

<section>
	<h2>Team members ({data.agents.length}/10)</h2>
	{#if data.agents.length > 0}
		<div class="grid">
			{#each data.agents as agent (agent.id)}
				<div class="card">
					<div class="row spread">
						<strong>{agent.name}</strong>
						<span class="badge {agent.role === 'scrum_master' ? 'accent' : ''}">
							{agent.role === 'scrum_master' ? 'Scrum Master' : 'Developer'}
						</span>
					</div>
					<p class="muted" style="margin:0.3rem 0">
						{agent.provider} · <span style="font-family:var(--mono)">{agent.model}</span>
					</p>
					{#if agent.personality}
						<p class="muted" style="margin:0.3rem 0">{agent.personality}</p>
					{/if}
					<span class="badge">{agent.memoryCount} memories</span>
				</div>
			{/each}
		</div>
	{:else}
		<p class="muted">No agents yet — build your team below.</p>
	{/if}

	<form method="POST" action="?/addAgent" class="card" style="margin-top:1rem" use:enhance>
		<h3>Add agent</h3>
		<div class="field-row">
			<div class="field">
				<label for="agent-name">Name</label>
				<input id="agent-name" name="name" required placeholder="e.g. Mira" />
			</div>
			<div class="field">
				<label for="agent-role">Role</label>
				<select id="agent-role" name="role">
					<option value="developer">Developer</option>
					<option value="scrum_master" disabled={hasScrumMaster}>Scrum Master</option>
				</select>
			</div>
		</div>
		<div class="field-row">
			<div class="field">
				<label for="agent-provider">Provider</label>
				<select
					id="agent-provider"
					name="provider"
					bind:value={selectedProvider}
					onchange={() => (model = providerDefault(selectedProvider))}
				>
					{#each data.providers as p (p.id)}
						<option value={p.id}>{p.label}{p.configured ? '' : ' (no API key set)'}</option>
					{/each}
				</select>
			</div>
			<div class="field">
				<label for="agent-model">Model</label>
				<input
					id="agent-model"
					name="model"
					required
					bind:value={model}
					placeholder={providerDefault(selectedProvider)}
				/>
			</div>
		</div>
		<div class="field">
			<label for="agent-personality">Personality (starting point — it develops over time)</label>
			<textarea
				id="agent-personality"
				name="personality"
				placeholder="e.g. Pragmatic and direct. Prefers small, well-tested increments. Allergic to overengineering."
			></textarea>
		</div>
		<button type="submit">Add agent</button>
	</form>
</section>
