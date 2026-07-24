<script lang="ts">
	import { invalidateAll } from '$app/navigation';

	let { data } = $props();

	// Validated against the app surface (#161b22): all 8 slots pass the
	// lightness band, chroma floor, CVD separation and 3:1 contrast checks.
	// Slot order is the safety mechanism — assign in order, never cycle.
	const PALETTE = [
		'#3987e5',
		'#d95926',
		'#199e70',
		'#c98500',
		'#d55181',
		'#008300',
		'#9085e9',
		'#e66767'
	];
	const OTHER_COLOR = '#898781';
	const seriesColor = (i: number) =>
		data.cost.teams[i]?.id === '__other' ? OTHER_COLOR : PALETTE[i % PALETTE.length];

	const MEETING_LABEL: Record<string, string> = {
		planning: 'Planning',
		review: 'Review',
		retrospective: 'Retrospective',
		adhoc: 'Ad-hoc'
	};

	let decisionCount = $derived(data.proposals.length + data.reviewItems.length);

	// Live tiles: re-run the load while any meeting or work phase is running.
	$effect(() => {
		if (!data.anyRunning) return;
		const timer = setInterval(() => invalidateAll(), 3000);
		return () => clearInterval(timer);
	});

	// ---- cost chart geometry ----------------------------------------------
	const W = 720;
	const H = 210;
	const PAD = { left: 48, right: 8, top: 8, bottom: 22 };
	const plotW = W - PAD.left - PAD.right;
	const plotH = H - PAD.top - PAD.bottom;
	let slot = $derived(plotW / Math.max(data.cost.days.length, 1));

	let dayTotals = $derived(data.cost.days.map((d) => d.values.reduce((a, b) => a + b, 0)));
	let maxTotal = $derived.by(() => {
		const raw = Math.max(...dayTotals, 1);
		// round up to 1/2/5 × 10^n so the axis labels read cleanly
		const pow = 10 ** Math.floor(Math.log10(raw));
		for (const m of [1, 2, 5, 10]) if (m * pow >= raw) return m * pow;
		return raw;
	});
	const yScale = (tokens: number) => (tokens / maxTotal) * plotH;

	let windowTotal = $derived(dayTotals.reduce((a, b) => a + b, 0));
	let windowCost = $derived.by(() => {
		let usd = 0;
		let unpriced = false;
		for (const p of data.cost.providers) {
			if (p.costUsd === null) unpriced = true;
			else usd += p.costUsd;
		}
		return { usd, unpriced };
	});

	let hover: number | null = $state(null);

	function fmtTokens(n: number): string {
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
		if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
		return String(n);
	}
	function fmtUsd(n: number): string {
		if (n >= 100) return `$${n.toFixed(0)}`;
		if (n >= 1) return `$${n.toFixed(2)}`;
		return `$${n.toFixed(3)}`;
	}
	function fmtDay(day: string): string {
		return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric',
			timeZone: 'UTC'
		});
	}
	function fmtWhen(date: Date): string {
		return date.toLocaleString('en-US', {
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit'
		});
	}
</script>

{#if !data.hasTeams}
	<div class="welcome">
		<div class="welcome-stones" aria-hidden="true">
			<span></span><span></span><span></span><span></span>
		</div>
		<h1>Welcome to Cairn</h1>
		<p class="welcome-tagline">
			Cairn runs teams of AI agents the way real software teams work: a Product Owner fills the
			backlog, the team plans a sprint in a real meeting, does the work and presents it back for
			review — and learns from every retrospective.
		</p>
		{#if data.canCreate}
			<ol class="welcome-steps">
				<li>
					<h3>Create a team</h3>
					<p class="muted">
						Give it a name and a purpose, then add two to ten agents — each with its own role,
						personality, memory and model.
					</p>
				</li>
				<li>
					<h3>Fill the backlog</h3>
					<p class="muted">
						Write down what you want built and start a sprint — the team commits to a goal in its
						planning meeting and gets to work.
					</p>
				</li>
				<li>
					<h3>Review the results</h3>
					<p class="muted">
						Accept or reject each item at sprint review. Every sprint has a hard token budget, so
						the cost stays in your hands.
					</p>
				</li>
			</ol>
			<a class="btn welcome-cta" href="/teams">Create your first team</a>
		{:else}
			<div class="card welcome-note">
				<p class="muted" style="margin:0">
					You're signed in as a viewer, so there's nothing you need to set up. Once a Product Owner
					adds you to a team, its sprints, meetings and costs show up right here.
				</p>
			</div>
		{/if}
	</div>
{:else}
	<h1>Dashboard</h1>
	<p class="muted">
		Everything that needs you across your teams: pending decisions, running sprints, spend and the
		latest meeting outcomes. <a href="/teams">Manage teams</a>
	</p>

	{#if decisionCount > 0}
		<section>
			<div class="row spread">
				<h2>Needs your decision</h2>
				<span class="badge warn">{decisionCount} waiting</span>
			</div>
			<div class="card">
				{#each data.reviewItems as item (item.id)}
					<a class="list-row" href="/teams/{item.teamId}/sprints/{item.sprintId}">
						<span class="row" style="gap:0.5rem">
							<span class="badge warn">review</span>
							<span>{item.title}</span>
						</span>
						<span class="muted">{item.teamName} · Sprint {item.sprintNumber}</span>
					</a>
				{/each}
				{#each data.proposals as proposal (proposal.id)}
					<a class="list-row" href="/teams/{proposal.teamId}">
						<span class="row" style="gap:0.5rem">
							<span class="badge accent">{proposal.crossTeam ? 'cross-team' : 'proposal'}</span>
							<span>{proposal.title}</span>
						</span>
						<span class="muted">{proposal.teamName}</span>
					</a>
				{/each}
			</div>
		</section>
	{/if}

	<section>
		<h2>Active sprints</h2>
		{#if data.activeSprints.length === 0}
			<div class="card">
				<p class="muted" style="margin:0">No sprint is currently underway on any of your teams.</p>
			</div>
		{:else}
			<div class="grid">
				{#each data.activeSprints as sprint (sprint.id)}
					{@const pct = Math.min(100, Math.round((sprint.tokensUsed / sprint.tokenBudget) * 100))}
					<a class="card link" href="/teams/{sprint.teamId}/sprints/{sprint.id}">
						<div class="row spread">
							<h3>{sprint.teamName} · Sprint {sprint.number}</h3>
							<span
								class="badge {sprint.status === 'active'
									? 'good'
									: sprint.status === 'review'
										? 'warn'
										: ''}">{sprint.status}</span
							>
						</div>
						{#if sprint.goal}
							<p class="muted" style="margin:0.25rem 0 0.6rem">{sprint.goal}</p>
						{/if}
						<div class="meter" style="margin-bottom:0.35rem">
							<div class={pct >= 90 ? 'hot' : ''} style="width:{pct}%"></div>
						</div>
						<p class="muted" style="margin:0">
							{fmtTokens(sprint.tokensUsed)} / {fmtTokens(sprint.tokenBudget)} tokens ({pct}%)
							{#if sprint.cost && (sprint.cost.usd > 0 || !sprint.cost.unpriced)}
								· ≈{fmtUsd(sprint.cost.usd)}{sprint.cost.unpriced ? '+' : ''}
							{/if}
						</p>
						<p style="margin:0.5rem 0 0; font-size:0.9rem">
							{#if sprint.runningMeetingType}
								<span class="spin"></span>
								{MEETING_LABEL[sprint.runningMeetingType]} meeting running
							{:else if sprint.working}
								<span class="spin"></span> Agents working
							{:else}
								<span class="muted">Idle — waiting on the next step</span>
							{/if}
						</p>
					</a>
				{/each}
			</div>
		{/if}
	</section>

	<section>
		<div class="row spread">
			<h2>Cost — last {data.cost.windowDays} days</h2>
			<span class="muted">
				{fmtTokens(windowTotal)} tokens · ≈{fmtUsd(windowCost.usd)}{windowCost.unpriced ? '+' : ''} est.
			</span>
		</div>
		{#if windowTotal === 0}
			<div class="card">
				<p class="muted" style="margin:0">No token usage recorded in this window yet.</p>
			</div>
		{:else}
			<div class="card">
				{#if data.cost.teams.length > 0}
					<div class="row" style="margin-bottom:0.6rem">
						{#each data.cost.teams as team, i (team.id)}
							<span class="row" style="gap:0.35rem; font-size:0.82rem; color:var(--text-dim)">
								<span class="swatch" style="background:{seriesColor(i)}"></span>{team.name}
							</span>
						{/each}
					</div>
				{/if}
				<div
					class="chart-wrap"
					onmouseleave={() => (hover = null)}
					role="img"
					aria-label="Stacked bar chart of daily token usage per team over the last {data.cost
						.windowDays} days; the provider table below carries the same data"
				>
					<svg viewBox="0 0 {W} {H}" style="width:100%; height:auto; display:block">
						{#each [0.25, 0.5, 0.75, 1] as frac (frac)}
							<line
								x1={PAD.left}
								x2={W - PAD.right}
								y1={PAD.top + plotH - frac * plotH}
								y2={PAD.top + plotH - frac * plotH}
								stroke="var(--border)"
								stroke-width="0.5"
							/>
						{/each}
						<line
							x1={PAD.left}
							x2={W - PAD.right}
							y1={PAD.top + plotH}
							y2={PAD.top + plotH}
							stroke="var(--border)"
						/>
						<text x={PAD.left - 6} y={PAD.top + plotH + 4} class="axis" text-anchor="end">0</text>
						<text x={PAD.left - 6} y={PAD.top + plotH / 2 + 4} class="axis" text-anchor="end"
							>{fmtTokens(maxTotal / 2)}</text
						>
						<text x={PAD.left - 6} y={PAD.top + 4} class="axis" text-anchor="end"
							>{fmtTokens(maxTotal)}</text
						>
						{#each data.cost.days as { day, values }, di (day)}
							{@const x = PAD.left + di * slot}
							<!-- stacked segments, bottom-up in fixed series order -->
							{#each values as tokens, si (si)}
								{#if tokens > 0}
									{@const below = values.slice(0, si).reduce((a, b) => a + b, 0)}
									<rect
										x={x + 2}
										y={PAD.top + plotH - yScale(below + tokens)}
										width={Math.max(slot - 4, 1)}
										height={yScale(tokens)}
										fill={seriesColor(si)}
										stroke="var(--bg-raised)"
										stroke-width="1"
									/>
								{/if}
							{/each}
							<rect
								{x}
								y={PAD.top}
								width={slot}
								height={plotH}
								fill="transparent"
								onmouseenter={() => (hover = di)}
								role="presentation"
							/>
							{#if di === 0 || di === data.cost.days.length - 1 || di === Math.floor(data.cost.days.length / 2)}
								<text x={x + slot / 2} y={H - 6} class="axis" text-anchor="middle"
									>{fmtDay(day)}</text
								>
							{/if}
						{/each}
					</svg>
					{#if hover !== null && data.cost.days[hover]}
						{@const hovered = data.cost.days[hover]}
						<div
							class="chart-tooltip"
							style="left:{((PAD.left + hover * slot + slot / 2) / W) * 100}%"
						>
							<strong>{fmtDay(hovered.day)}</strong> · {fmtTokens(dayTotals[hover])} tokens
							{#each hovered.values as tokens, si (si)}
								{#if tokens > 0}
									<div class="row" style="gap:0.35rem">
										<span class="swatch" style="background:{seriesColor(si)}"></span>
										{data.cost.teams[si]?.name}: {fmtTokens(tokens)}
									</div>
								{/if}
							{/each}
						</div>
					{/if}
				</div>
			</div>
			<div class="card">
				<table>
					<thead>
						<tr>
							<th>Provider</th>
							<th>Model</th>
							<th>Input tokens</th>
							<th>Output tokens</th>
							<th>Est. cost</th>
						</tr>
					</thead>
					<tbody>
						{#each data.cost.providers as p (p.provider + p.model)}
							<tr>
								<td>{p.provider}</td>
								<td>{p.model}</td>
								<td>{fmtTokens(p.inputTokens)}</td>
								<td>{fmtTokens(p.outputTokens)}</td>
								<td>{p.costUsd === null ? '—' : `≈${fmtUsd(p.costUsd)}`}</td>
							</tr>
						{/each}
					</tbody>
				</table>
				<p class="muted" style="margin:0.6rem 0 0; font-size:0.8rem">
					Estimates use a coarse public price sheet per provider/model; "—" means no price is known
					(e.g. OpenRouter routes to varying models). Local models cost $0.
				</p>
			</div>
		{/if}
	</section>

	<section>
		<h2>Recent meetings</h2>
		{#if data.recentMeetings.length === 0}
			<div class="card">
				<p class="muted" style="margin:0">No completed meetings yet.</p>
			</div>
		{:else}
			{#each data.recentMeetings as meeting (meeting.id)}
				<div class="card">
					<div class="row spread">
						<span class="row" style="gap:0.5rem">
							<span class="badge accent">{MEETING_LABEL[meeting.type]}</span>
							<a href="/teams/{meeting.teamId}/sprints/{meeting.sprintId}">
								{meeting.teamName} · Sprint {meeting.sprintNumber}
							</a>
						</span>
						<span class="muted">{fmtWhen(meeting.createdAt)}</span>
					</div>
					<div class="summary-box">{meeting.summary}</div>
				</div>
			{/each}
		{/if}
	</section>
{/if}

<style>
	.axis {
		fill: var(--text-dim);
		font-size: 10px;
	}
</style>
