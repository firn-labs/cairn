<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';

	let { data, form } = $props();

	const meetingRunning = $derived(data.meetings.some((m) => m.status === 'running'));
	const workRunning = $derived(data.workRuns.some((r) => r.status === 'running'));
	const latestWorkRun = $derived(data.workRuns.at(-1));
	const budgetPct = $derived(
		Math.min(100, Math.round((data.sprint.tokensUsed / data.sprint.tokenBudget) * 100))
	);

	// The newest work-item run per backlog item — the review artifacts to show.
	const latestItemRun = $derived(
		new Map(data.workRuns.flatMap((run) => run.itemRuns.map((ir) => [ir.backlogItemId, ir])))
	);

	// Poll while a ceremony or the work phase runs in the background.
	$effect(() => {
		if (!meetingRunning && !workRunning) return;
		const timer = setInterval(() => invalidateAll(), 3000);
		return () => clearInterval(timer);
	});

	const itemBadge: Record<string, string> = {
		selected: '',
		in_progress: 'warn',
		done: 'accent',
		accepted: 'good',
		rejected: 'bad'
	};

	const itemRunBadge: Record<string, string> = {
		pending: '',
		running: 'warn',
		done: 'good',
		failed: 'bad',
		skipped: ''
	};

	function logLine(log: { kind: string; toolName: string | null; content: string }): string {
		if (log.kind === 'tool_call') return `→ ${log.toolName ?? 'tool'}: ${log.content}`;
		if (log.kind === 'tool_result') return `← ${log.content}`;
		return log.content;
	}

	const meetingTitle: Record<string, string> = {
		planning: 'Sprint Planning',
		review: 'Sprint Review',
		retrospective: 'Retrospective',
		adhoc: 'Ad-hoc meeting'
	};

	const nextCeremony = $derived(
		data.sprint.status === 'planning'
			? { type: 'planning', label: 'Run Sprint Planning' }
			: data.sprint.status === 'active'
				? { type: 'review', label: 'Run Sprint Review' }
				: data.sprint.status === 'review'
					? { type: 'retrospective', label: 'Run Retrospective' }
					: null
	);
</script>

<svelte:head>
	<title>Sprint {data.sprint.number} · {data.team.name} · Cairn</title>
</svelte:head>

<p class="crumbs">
	<a href="/">Teams</a> / <a href="/teams/{data.team.id}">{data.team.name}</a> / Sprint {data.sprint
		.number}
</p>

<div class="row spread">
	<h1 style="margin:0">Sprint {data.sprint.number}</h1>
	<span class="badge {data.sprint.status === 'completed' ? 'good' : 'accent'}"
		>{data.sprint.status}</span
	>
</div>
{#if data.sprint.goal}
	<p style="font-size:1.05rem;margin-top:0.5rem"><strong>Goal:</strong> {data.sprint.goal}</p>
{/if}

<div class="card" style="margin-top:1rem">
	<div class="row spread">
		<strong>Token budget</strong>
		<span class="muted"
			>{data.sprint.tokensUsed.toLocaleString()} / {data.sprint.tokenBudget.toLocaleString()} tokens
			({budgetPct}%)</span
		>
	</div>
	<div class="meter" style="margin-top:0.5rem">
		<div class={budgetPct > 85 ? 'hot' : ''} style="width:{budgetPct}%"></div>
	</div>
	<p class="muted" style="margin:0.5rem 0 0">
		Hard limit: meetings stop when the budget is exhausted.
	</p>
</div>

{#if form?.error}
	<div class="banner error" style="margin-top:1rem">{form.error}</div>
{/if}

{#if data.sprint.prUrl}
	<div class="banner info" style="margin-top:1rem">
		The sprint review is the PR review:
		<a href={data.sprint.prUrl} target="_blank" rel="noreferrer">open the pull request</a>
		to inspect and merge the team's work.
	</div>
{:else if data.team.projectId && (data.sprint.status === 'review' || data.sprint.status === 'completed')}
	<form method="POST" action="?/openPr" style="margin-top:1rem" use:enhance>
		<button type="submit">Open pull request</button>
		<span class="muted"> Team branch → default branch, for your review on the hosting site.</span>
	</form>
{/if}

{#if meetingRunning}
	<div class="banner info" style="margin-top:1rem">
		<span class="spin"></span>&nbsp; The team is in a meeting — this page refreshes automatically.
	</div>
{:else if nextCeremony && !workRunning}
	<form method="POST" action="?/runCeremony" style="margin-top:1rem" use:enhance>
		<input type="hidden" name="type" value={nextCeremony.type} />
		<button type="submit">{nextCeremony.label}</button>
		{#if nextCeremony.type === 'retrospective'}
			<span class="muted"> Requires an accept/reject decision on every item first.</span>
		{/if}
	</form>
{/if}

{#if data.sprint.status === 'active'}
	<div class="card" style="margin-top:1rem">
		<div class="row spread">
			<strong>Work phase</strong>
			{#if latestWorkRun}
				<span
					class="badge {latestWorkRun.status === 'completed'
						? 'good'
						: latestWorkRun.status === 'failed'
							? 'bad'
							: 'warn'}"
				>
					{latestWorkRun.status === 'running' ? 'in progress' : latestWorkRun.status}
				</span>
			{/if}
		</div>

		{#if workRunning}
			<div class="banner info" style="margin-top:0.75rem">
				<span class="spin"></span>&nbsp; The team is working in its workspace — item statuses
				update automatically.
			</div>
		{:else}
			{#if latestWorkRun?.status === 'failed' && latestWorkRun.error}
				<div class="banner error" style="margin-top:0.75rem">{latestWorkRun.error}</div>
			{/if}
			<form method="POST" action="?/startWork" style="margin-top:0.75rem" use:enhance>
				<button type="submit" disabled={!data.dockerAvailable || !data.hasDevelopers}>
					{latestWorkRun ? 'Run work phase again' : 'Start work phase'}
				</button>
				{#if !data.dockerAvailable}
					<span class="muted"> Docker is not reachable — flip item statuses manually below.</span>
				{:else if !data.hasDevelopers}
					<span class="muted"> The team needs at least one developer agent.</span>
				{:else}
					<span class="muted">
						The agents implement the sprint backlog in the team's Docker workspace.</span>
				{/if}
			</form>
		{/if}

		{#if latestWorkRun && latestWorkRun.logs.length > 0}
			{#if workRunning}
				<div class="transcript" style="margin-top:0.75rem">
					{#each latestWorkRun.logs as log (log.id)}
						<div class="msg"><div class="content">{logLine(log)}</div></div>
					{/each}
				</div>
			{:else}
				<details style="margin-top:0.75rem">
					<summary>Work log ({latestWorkRun.logs.length} entries)</summary>
					<div class="transcript">
						{#each latestWorkRun.logs as log (log.id)}
							<div class="msg"><div class="content">{logLine(log)}</div></div>
						{/each}
					</div>
				</details>
			{/if}
		{/if}
	</div>
{/if}

<section>
	<h2>Sprint backlog</h2>
	{#if data.items.length > 0}
		<table>
			<thead>
				<tr><th>Item</th><th>Status</th><th>Actions</th></tr>
			</thead>
			<tbody>
				{#each data.items as item (item.id)}
					{@const itemRun = latestItemRun.get(item.id)}
					<tr>
						<td>
							<strong>{item.title}</strong>
							{#if item.collabBranch}
								<span class="badge warn" title="Cross-team feature — worked on shared branch {item.collabBranch} instead of the team branch">
									collab
								</span>
							{/if}
							{#if item.description}<div class="muted">{item.description}</div>{/if}
							{#if item.acceptanceCriteria}
								<div class="muted">AC: {item.acceptanceCriteria}</div>
							{/if}
							{#if itemRun && (itemRun.diff || itemRun.resultNote || itemRun.error)}
								<details style="margin-top:0.5rem">
									<summary>
										Changes{itemRun.diffStat
											? ` (${itemRun.diffStat.split('\n').at(-1)?.trim()})`
											: ''}
									</summary>
									{#if itemRun.error}
										<div class="banner error" style="margin-top:0.5rem">{itemRun.error}</div>
									{/if}
									{#if itemRun.resultNote}
										<div class="summary-box">{itemRun.resultNote}</div>
									{/if}
									{#if itemRun.commitLog}
										<pre class="diff">{itemRun.commitLog}</pre>
									{/if}
									{#if itemRun.diff}
										<pre class="diff">{itemRun.diff}</pre>
									{:else}
										<p class="muted">No changes were committed.</p>
									{/if}
								</details>
							{/if}
						</td>
						<td>
							<span class="badge {itemBadge[item.status] ?? ''}">{item.status}</span>
							{#if itemRun && (workRunning || itemRun.status === 'failed' || itemRun.status === 'skipped')}
								<div style="margin-top:0.35rem">
									<span class="badge {itemRunBadge[itemRun.status] ?? ''}">work: {itemRun.status}</span>
								</div>
							{/if}
						</td>
						<td>
							{#if data.sprint.status === 'active' && !workRunning}
								<form method="POST" action="?/setItemStatus" class="row" use:enhance>
									<input type="hidden" name="id" value={item.id} />
									{#if item.status === 'selected'}
										<button class="ghost small" name="status" value="in_progress">Start</button>
									{:else if item.status === 'in_progress'}
										<button class="ghost small" name="status" value="done">Mark done</button>
									{:else if item.status === 'done'}
										<button class="ghost small" name="status" value="in_progress">Reopen</button>
									{/if}
								</form>
							{:else if data.sprint.status === 'review' && item.status !== 'accepted' && item.status !== 'rejected'}
								<form method="POST" action="?/decideItem" class="row" use:enhance>
									<input type="hidden" name="id" value={item.id} />
									<button class="good small" name="decision" value="accept">Accept</button>
									<button class="bad small" name="decision" value="reject">Reject</button>
								</form>
							{:else}
								<span class="muted">—</span>
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{:else}
		<p class="muted">
			Empty — the team selects items from the product backlog during sprint planning.
		</p>
	{/if}
</section>

<section>
	<h2>Meetings</h2>
	{#if data.meetings.length > 0}
		<div class="stack">
			{#each data.meetings as meeting (meeting.id)}
				<div class="card">
					<div class="row spread">
						<strong>{meetingTitle[meeting.type]}</strong>
						<span
							class="badge {meeting.status === 'completed'
								? 'good'
								: meeting.status === 'failed'
									? 'bad'
									: 'warn'}"
						>
							{meeting.status === 'running' ? 'in progress' : meeting.status}
						</span>
					</div>

					{#if meeting.status === 'failed' && meeting.error}
						<div class="banner error" style="margin-top:0.75rem">{meeting.error}</div>
					{/if}

					{#if meeting.summary}
						<div class="summary-box">{meeting.summary}</div>
					{/if}

					{#if meeting.messages.length > 0}
						<details style="margin-top:0.75rem">
							<summary>Transcript ({meeting.messages.length} contributions)</summary>
							<div class="transcript">
								{#each meeting.messages as msg (msg.id)}
									<div class="msg">
										<div class="author">{msg.authorName}</div>
										<div class="content">{msg.content}</div>
									</div>
								{/each}
							</div>
						</details>
					{/if}
				</div>
			{/each}
		</div>
	{:else}
		<p class="muted">No meetings yet. Start with the sprint planning.</p>
	{/if}
</section>
