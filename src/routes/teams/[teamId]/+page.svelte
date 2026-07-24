<script lang="ts">
	import { enhance } from '$app/forms';
	import { wordDiff } from '$lib/wordDiff';

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
	// Viewers get the full picture but no controls; the server enforces the
	// same rule on every action.
	const isPo = $derived(data.role === 'product_owner');

	// svelte-ignore state_referenced_locally -- intentionally only the initial value
	let selectedExecutor = $state(data.team.executor);
	const executorDescription = $derived(
		data.executorOptions.find((o) => o.id === selectedExecutor)?.description ??
			'Whatever the instance is configured with (CAIRN_EXECUTOR, default: built-in tool loop).'
	);
	// Which of the PO's stored credentials the selected CLI executor would use.
	const executorCredentialHint = $derived.by(() => {
		if (selectedExecutor === 'claude-code') {
			if (data.myCredentialKinds.includes('claude_code_oauth'))
				return 'Uses your stored Claude Code OAuth token (subscription).';
			if (data.myCredentialKinds.includes('anthropic_api_key'))
				return 'Uses your stored Anthropic API key.';
			return "You have no Claude credential stored — the server's ANTHROPIC_API_KEY is used, if set.";
		}
		if (selectedExecutor === 'codex') {
			if (data.myCredentialKinds.includes('codex_auth_json'))
				return 'Uses your stored Codex auth.json (subscription).';
			if (data.myCredentialKinds.includes('openai_api_key'))
				return 'Uses your stored OpenAI API key.';
			return "You have no Codex credential stored — the server's OPENAI_API_KEY is used, if set.";
		}
		return '';
	});
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
	{#if !isPo}
		<span class="badge" title="You have read-only access to this team.">viewer</span>
	{/if}
</div>

{#if form?.error}
	<div class="banner error" style="margin-top:1rem">{form.error}</div>
{/if}

<section>
	<h2>Project</h2>
	{#if !isPo}
		<p class="muted">
			{data.team.projectId
				? 'This team works on a git repository connected by its Product Owner.'
				: 'No git repository connected — the team works in a local-only workspace.'}
		</p>
	{:else if data.projects.length > 0}
		<form method="POST" action="?/assignProject" class="card row" use:enhance>
			<div style="flex:1;min-width:200px">
				<label for="projectId">Git repository this team works on</label>
				<select id="projectId" name="projectId" value={data.team.projectId ?? ''}>
					<option value="">No project (local-only workspace)</option>
					{#each data.projects as project (project.id)}
						<option value={project.id}>{project.name} ({project.providerLabel})</option>
					{/each}
				</select>
			</div>
			<button type="submit" style="align-self:flex-end">Save</button>
		</form>
		<p class="muted">
			With a project connected, the team pushes its team branch to the repository and each sprint
			review opens a pull request for you. Changing the project is only possible between sprints
			and replaces the team's workspace repo.
		</p>
	{:else}
		<p class="muted">
			No projects yet — <a href="/projects">connect a repository</a> to let this team work on a
			real codebase. Without one, the team works in a local-only workspace repo.
		</p>
	{/if}
</section>

<section>
	<h2>Work executor</h2>
	<p class="muted">
		What implements backlog items during the work phase: the built-in metered tool loop, or a
		coding CLI (Claude Code, Codex, OpenCode) running inside the team's workspace container.
		CLI executors can use your subscription plan — store the credential under
		<a href="/settings">Settings</a>.
	</p>
	{#if isPo}
		<form method="POST" action="?/saveExecutor" class="card" use:enhance>
			<div class="field-row">
				<div class="field">
					<label for="executor">Executor</label>
					<select id="executor" name="executor" bind:value={selectedExecutor}>
						<option value="">Instance default</option>
						{#each data.executorOptions as opt (opt.id)}
							<option value={opt.id}>{opt.label}</option>
						{/each}
					</select>
				</div>
				<div class="field">
					<label for="executor-model">Model (optional, the tool's own naming)</label>
					<input
						id="executor-model"
						name="model"
						value={data.executorConfig.model ?? ''}
						placeholder={selectedExecutor === 'opencode' ? 'e.g. qwen3' : 'tool default'}
					/>
				</div>
			</div>
			<p class="muted" style="margin:0.2rem 0 0.6rem">
				{executorDescription}
				{#if executorCredentialHint}<br />{executorCredentialHint}{/if}
			</p>
			{#if selectedExecutor === 'opencode'}
				<div class="field">
					<label for="executor-baseurl">Ollama URL, as seen from inside the container</label>
					<input
						id="executor-baseurl"
						name="baseUrl"
						value={data.executorConfig.baseUrl ?? ''}
						placeholder="http://host.docker.internal:11434"
					/>
				</div>
			{:else}
				<input type="hidden" name="baseUrl" value={data.executorConfig.baseUrl ?? ''} />
			{/if}
			<div class="field-row">
				<div class="field">
					<label for="executor-timeout">Time limit per item (minutes)</label>
					<input
						id="executor-timeout"
						name="timeoutMinutes"
						type="number"
						min="5"
						max="180"
						value={data.executorConfig.timeoutMinutes ?? ''}
						placeholder="30"
					/>
				</div>
				<div class="field">
					<label for="executor-env">Extra environment (one KEY=value per line)</label>
					<textarea
						id="executor-env"
						name="extraEnv"
						rows="2"
						placeholder="e.g. HTTPS_PROXY=http://proxy:3128">{data.executorConfig.extraEnvText}</textarea
					>
				</div>
			</div>
			<button type="submit">Save executor</button>
		</form>
	{:else}
		<p class="card muted" style="margin:0">
			{data.executorOptions.find((o) => o.id === data.team.executor)?.label ??
				'Instance default'}
		</p>
	{/if}
</section>

<section>
	<h2>Team interface</h2>
	<p class="muted">
		What this team offers other teams and how they should phrase a work request. Agents of other
		teams see this (together with the description and tags) when they discover this team; requests
		they file land above as proposals for you to review.
	</p>
	{#if isPo}
		<form method="POST" action="?/saveInterface" class="card" use:enhance>
			<div class="field">
				<label for="interface">Offered interface</label>
				<textarea
					id="interface"
					name="interface"
					placeholder="e.g. We own the billing service. We take requests for new payment providers and invoice formats — include the provider's API docs and the target market in your request."
					>{data.team.interface}</textarea
				>
			</div>
			<button type="submit">Save interface</button>
		</form>
	{:else}
		<p class="card muted" style="margin:0">{data.team.interface || 'No interface stated yet.'}</p>
	{/if}
</section>

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

	{#if isPo}
		<form
			method="POST"
			action="?/startSprint"
			class="card row"
			style="margin-top:1rem"
			use:enhance
		>
			<div style="flex:1;min-width:200px">
				<label for="tokenBudget">Token budget for the sprint (hard limit)</label>
				<input
					id="tokenBudget"
					name="tokenBudget"
					type="number"
					value={data.defaultSprintTokenBudget}
					min="10000"
					max={data.maxSprintTokenBudget > 0 ? data.maxSprintTokenBudget : undefined}
					step="10000"
				/>
			</div>
			<button type="submit" style="align-self:flex-end">Start new sprint</button>
		</form>
	{/if}
	{#if !hasScrumMaster && data.agents.length > 0}
		<p class="muted">
			Tip: add a Scrum Master agent — it facilitates the meetings. Without one, the first agent
			takes over facilitation.
		</p>
	{/if}
</section>

{#if data.proposals.length > 0}
	<section>
		<h2>Proposed by the team</h2>
		<p class="muted">
			Backlog items your agents proposed (during work or in a retrospective) and work requests
			from other teams. They stay out of sprint planning until you approve them.
		</p>
		<table>
			<thead>
				<tr><th>Item</th><th>Proposed by</th><th></th></tr>
			</thead>
			<tbody>
				{#each data.proposals as item (item.id)}
					<tr>
						<td>
							<strong>{item.title}</strong>
							{#if item.collabBranch}
								<span class="badge warn" title="Cross-team feature on shared branch {item.collabBranch}">
									collab
								</span>
							{/if}
							{#if item.description}<div class="muted">{item.description}</div>{/if}
							{#if item.proposalRationale}
								<div class="muted"><em>Why: {item.proposalRationale}</em></div>
							{/if}
						</td>
						<td>
							{#if item.requestedByTeam}
								<span class="badge warn">team {item.requestedByTeam}</span>
							{:else}
								<span class="badge accent">{item.proposedBy}</span>
							{/if}
						</td>
						<td>
							{#if isPo}
								<div class="row">
									<form method="POST" action="?/approveProposal" use:enhance>
										<input type="hidden" name="id" value={item.id} />
										<button class="small" type="submit">Approve</button>
									</form>
									<form method="POST" action="?/rejectProposal" use:enhance>
										<input type="hidden" name="id" value={item.id} />
										<button class="ghost small" type="submit">Reject</button>
									</form>
								</div>
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</section>
{/if}

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
							{#if item.requestedByTeam}
								<span class="badge warn" title="Requested by another team, approved by you">
									team {item.requestedByTeam}
								</span>
							{:else if item.proposedBy}
								<span class="badge accent" title="Proposed by an agent, approved by you">
									{item.proposedBy}
								</span>
							{/if}
							{#if item.collabBranch}
								<span class="badge warn" title="Cross-team feature on shared branch {item.collabBranch}">
									collab
								</span>
							{/if}
							{#if item.description}<div class="muted">{item.description}</div>{/if}
						</td>
						<td class="muted">{item.acceptanceCriteria || '—'}</td>
						<td>
							{#if isPo}
								<form method="POST" action="?/deleteBacklogItem" use:enhance>
									<input type="hidden" name="id" value={item.id} />
									<button class="ghost small" type="submit">Delete</button>
								</form>
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{:else}
		<p class="muted">The backlog is empty.</p>
	{/if}

	{#if isPo}
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
	{/if}
</section>

<section>
	<h2>Team members ({data.agents.length}/{data.maxTeamSize})</h2>
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
					<div class="row spread">
						<span>
							<span class="badge">{agent.memoryCount} memories</span>
							{#if agent.personalityPinned}
								<span class="badge warn" title="The Product Owner pinned this personality — the agent may not revise it.">pinned</span>
							{/if}
						</span>
						{#if isPo}
							<form method="POST" action="?/togglePin" use:enhance>
								<input type="hidden" name="agentId" value={agent.id} />
								<button
									class="ghost small"
									type="submit"
									title={agent.personalityPinned
										? 'Allow this agent to revise its personality again after retrospectives.'
										: 'Freeze this personality — the agent may no longer revise it.'}
								>
									{agent.personalityPinned ? 'Unpin personality' : 'Pin personality'}
								</button>
							</form>
						{/if}
					</div>
					{#if agent.revisions.length > 0}
						<details style="margin-top:0.5rem">
							<summary>
								Personality history ({agent.revisions.length}
								{agent.revisions.length === 1 ? 'revision' : 'revisions'})
							</summary>
							<div class="stack" style="margin-top:0.5rem">
								{#each agent.revisions as revision (revision.id)}
									<div>
										<p class="muted" style="margin:0 0 0.2rem">
											{revision.sprintNumber != null
												? `After sprint ${revision.sprintNumber}`
												: 'Revision'}{revision.rationale ? ` — ${revision.rationale}` : ''}
										</p>
										<p class="personality-diff">
											{#each wordDiff(revision.previous, revision.revised) as op, i (i)}
												{#if op.kind === 'same'}<span>{op.text}</span>
												{:else if op.kind === 'add'}<ins>{op.text}</ins>
												{:else}<del>{op.text}</del>{/if}{' '}
											{/each}
										</p>
									</div>
								{/each}
							</div>
						</details>
					{/if}
				</div>
			{/each}
		</div>
	{:else}
		<p class="muted">No agents yet — build your team below.</p>
	{/if}

	{#if isPo}
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
	{/if}
</section>

<section>
	<h2>People</h2>
	<p class="muted">
		The humans with access to this team. The Product Owner runs the team; viewers can follow
		everything — sprints, meetings, work runs — but change nothing.
	</p>
	<table>
		<thead>
			<tr><th>User</th><th>Role</th><th></th></tr>
		</thead>
		<tbody>
			{#each data.members as member (member.userId)}
				<tr>
					<td>
						<strong>{member.name || member.email}</strong>
						{#if member.name}<span class="muted"> · {member.email}</span>{/if}
					</td>
					<td>
						<span class="badge {member.role === 'product_owner' ? 'accent' : ''}">
							{member.role === 'product_owner' ? 'Product Owner' : 'Viewer'}
						</span>
					</td>
					<td>
						{#if isPo && member.role === 'viewer'}
							<form method="POST" action="?/removeMember" use:enhance>
								<input type="hidden" name="userId" value={member.userId} />
								<button class="ghost small" type="submit">Remove</button>
							</form>
						{/if}
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
	{#if isPo}
		<form method="POST" action="?/addMember" class="card row" style="margin-top:1rem" use:enhance>
			<div style="flex:1;min-width:200px">
				<label for="member-email">Invite a viewer (existing account's email)</label>
				<input id="member-email" name="email" type="email" required placeholder="teammate@example.com" />
			</div>
			<button type="submit" style="align-self:flex-end">Add viewer</button>
		</form>
	{/if}
</section>
