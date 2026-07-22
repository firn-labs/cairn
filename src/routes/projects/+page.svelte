<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();

	const tokenHints: Record<string, string> = {
		github: 'Fine-grained token with Contents: read/write and Pull requests: read/write.',
		gitlab: 'Project access token with the api and write_repository scopes.',
		codeberg: 'Access token with repository read/write scope (Gitea/Forgejo).'
	};
	let provider = $state('github');
</script>

<svelte:head><title>Projects · Cairn</title></svelte:head>

<h1>Projects</h1>
<p class="muted">
	A project connects a git repository on GitHub, GitLab or Codeberg. Assign a project to a team on
	the team's page: the team then works on its own long-lived branch, and each sprint review opens a
	pull request toward the default branch — which you, the Product Owner, review and merge. Agents
	never touch the default branch, and force-pushes never happen.
</p>

{#if form?.error}
	<div class="banner error">{form.error}</div>
{/if}

{#if data.projects.length > 0}
	<div class="grid" style="margin-top:1.25rem">
		{#each data.projects as project (project.id)}
			<div class="card">
				<div class="row spread">
					<strong>{project.name}</strong>
					<span class="badge accent">{project.providerLabel}</span>
				</div>
				<p class="muted" style="margin:0.35rem 0; word-break:break-all">
					<a href={project.repoUrl} target="_blank" rel="noreferrer">{project.repoUrl}</a>
				</p>
				<p class="muted" style="margin:0.35rem 0">
					Default branch: <span style="font-family:var(--mono)">{project.defaultBranch}</span>
				</p>
				{#if project.teams.length > 0}
					<div class="row">
						{#each project.teams as team}
							<span class="badge">{team}</span>
						{/each}
					</div>
				{:else}
					<p class="muted" style="margin:0.35rem 0">Not assigned to a team yet.</p>
				{/if}
				<details style="margin-top:0.5rem">
					<summary>Replace token</summary>
					<form method="POST" action="?/updateToken" class="row" style="margin-top:0.5rem" use:enhance>
						<input type="hidden" name="id" value={project.id} />
						<input
							name="token"
							type="password"
							required
							placeholder="New access token"
							autocomplete="off"
							style="flex:1"
						/>
						<button class="small" type="submit">Save</button>
					</form>
				</details>
				{#if project.teams.length === 0}
					<form method="POST" action="?/deleteProject" style="margin-top:0.5rem" use:enhance>
						<input type="hidden" name="id" value={project.id} />
						<button class="ghost small" type="submit">Delete project</button>
					</form>
				{/if}
			</div>
		{/each}
	</div>
{:else}
	<div class="card" style="margin-top:1.25rem">
		<p class="muted" style="margin:0">No projects yet — connect your first repository below.</p>
	</div>
{/if}

{#if data.canCreate}
<section>
	<h2>Connect a repository</h2>
	<form method="POST" action="?/createProject" class="card" use:enhance>
		<div class="field-row">
			<div class="field">
				<label for="name">Project name</label>
				<input id="name" name="name" required placeholder="e.g. Webshop" />
			</div>
			<div class="field">
				<label for="provider">Hosting</label>
				<select id="provider" name="provider" bind:value={provider}>
					<option value="github">GitHub</option>
					<option value="gitlab">GitLab</option>
					<option value="codeberg">Codeberg / Gitea</option>
				</select>
			</div>
		</div>
		<div class="field">
			<label for="repoUrl">Repository URL (https)</label>
			<input
				id="repoUrl"
				name="repoUrl"
				type="url"
				required
				placeholder="https://github.com/owner/repo"
			/>
		</div>
		<div class="field">
			<label for="token">Access token</label>
			<input id="token" name="token" type="password" required autocomplete="off" />
			<p class="muted" style="margin:0.35rem 0 0">
				{tokenHints[provider]} Stored encrypted; it is used only for git access and opening pull
				requests, and never enters the agents' workspace containers.
			</p>
		</div>
		<button type="submit">Connect repository</button>
	</form>
</section>
{/if}
