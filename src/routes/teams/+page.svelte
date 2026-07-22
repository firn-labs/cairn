<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();
</script>

<h1>Teams</h1>
<p class="muted">
	Each team is a group of AI agents that plans, works and learns in sprints. On teams you created
	you are the Product Owner — you own the backlog and accept results; teams shared with you are
	read-only.
</p>

{#if form?.error}
	<div class="banner error">{form.error}</div>
{/if}

{#if data.teams.length > 0}
	<div class="grid" style="margin-top:1.25rem">
		{#each data.teams as team (team.id)}
			<a class="card link" href="/teams/{team.id}">
				<div class="row spread">
					<h2>{team.name}</h2>
					{#if team.role === 'viewer'}
						<span class="badge">viewer</span>
					{/if}
				</div>
				{#if team.description}
					<p class="muted">{team.description}</p>
				{/if}
				<div class="row" style="margin-top:0.5rem">
					{#each team.tags as tag}
						<span class="badge accent">{tag}</span>
					{/each}
				</div>
				<p class="muted" style="margin-bottom:0">
					{team.agentCount}
					{team.agentCount === 1 ? 'agent' : 'agents'} · {team.sprintCount}
					{team.sprintCount === 1 ? 'sprint' : 'sprints'}
				</p>
			</a>
		{/each}
	</div>
{:else}
	<div class="card" style="margin-top:1.25rem">
		<p class="muted" style="margin:0">
			{data.canCreate
				? 'No teams yet — create your first one below.'
				: 'No teams shared with you yet — ask a Product Owner to add you as a viewer.'}
		</p>
	</div>
{/if}

{#if data.canCreate}
<section>
	<h2>Create a team</h2>
	<form method="POST" action="?/createTeam" class="card" use:enhance>
		<div class="field">
			<label for="name">Name</label>
			<input id="name" name="name" required placeholder="e.g. Platform Team" />
		</div>
		<div class="field">
			<label for="description">What is this team for?</label>
			<textarea
				id="description"
				name="description"
				placeholder="One or two sentences. The agents see this as their team context, and other teams will later use it to find this team."
			></textarea>
		</div>
		<div class="field">
			<label for="tags">Tags (comma-separated)</label>
			<input id="tags" name="tags" placeholder="backend, api, rust" />
		</div>
		<button type="submit">Create team</button>
	</form>
</section>
{/if}
