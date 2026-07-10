<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();
</script>

<h1>Teams</h1>
<p class="muted">
	You are the Product Owner. Each team is a group of AI agents that plans, works and learns in
	sprints — you own their backlogs and accept their results.
</p>

{#if form?.error}
	<div class="banner error">{form.error}</div>
{/if}

{#if data.teams.length > 0}
	<div class="grid" style="margin-top:1.25rem">
		{#each data.teams as team (team.id)}
			<a class="card link" href="/teams/{team.id}">
				<h2>{team.name}</h2>
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
		<p class="muted" style="margin:0">No teams yet — create your first one below.</p>
	</div>
{/if}

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
