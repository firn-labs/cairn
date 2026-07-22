import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

const createdAt = () =>
	integer('created_at', { mode: 'timestamp_ms' })
		.notNull()
		.$defaultFn(() => new Date());

/**
 * A project is a git repository on a hosting service. Teams are assigned to a
 * project; each assigned team works on its own long-lived team branch and
 * sprint results reach the default branch only via a pull request the Product
 * Owner reviews. The access token is stored AES-256-GCM encrypted (see
 * `server/secrets.ts`) and is never sent into workspace containers.
 */
export const projects = sqliteTable('projects', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	provider: text('provider', { enum: ['github', 'gitlab', 'codeberg'] }).notNull(),
	/** HTTPS web URL of the repository, e.g. https://github.com/owner/repo */
	repoUrl: text('repo_url').notNull(),
	/** Detected from the hosting API when the project is created. */
	defaultBranch: text('default_branch').notNull().default('main'),
	tokenCiphertext: text('token_ciphertext').notNull(),
	createdAt: createdAt()
});

/**
 * A team of AI agents. `tags` is a JSON string array describing what the team
 * is for — the basis for cross-team discovery in a later milestone.
 */
export const teams = sqliteTable('teams', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	description: text('description').notNull().default(''),
	tags: text('tags').notNull().default('[]'),
	/** null = no git hosting connected; the team works in a local-only repo. */
	projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
	createdAt: createdAt()
});

export const agents = sqliteTable('agents', {
	id: text('id').primaryKey(),
	teamId: text('team_id')
		.notNull()
		.references(() => teams.id, { onDelete: 'cascade' }),
	name: text('name').notNull(),
	role: text('role', { enum: ['developer', 'scrum_master'] })
		.notNull()
		.default('developer'),
	/** Free-text self-description; evolves over time as the agent develops. */
	personality: text('personality').notNull().default(''),
	/** Pinned by the Product Owner: the agent may no longer revise its personality. */
	personalityPinned: integer('personality_pinned', { mode: 'boolean' }).notNull().default(false),
	provider: text('provider').notNull(),
	model: text('model').notNull(),
	createdAt: createdAt()
});

/**
 * One applied personality revision. After each retrospective an (unpinned)
 * agent may propose a small edit to its own personality text; proposals that
 * pass the drift guard (see `engine/personality.ts`) are applied to the agent
 * and recorded here so the Product Owner can review the change as a diff.
 */
export const personalityRevisions = sqliteTable('personality_revisions', {
	id: text('id').primaryKey(),
	agentId: text('agent_id')
		.notNull()
		.references(() => agents.id, { onDelete: 'cascade' }),
	sprintId: text('sprint_id'),
	previous: text('previous').notNull(),
	revised: text('revised').notNull(),
	/** The agent's own explanation of why it changed, shown to the PO. */
	rationale: text('rationale').notNull().default(''),
	createdAt: createdAt()
});

/**
 * Distilled long-term memory. Full sprint transcripts are intentionally NOT
 * memory — after each retrospective every agent compresses the sprint into a
 * few insights, and only those persist.
 */
export const agentMemories = sqliteTable('agent_memories', {
	id: text('id').primaryKey(),
	agentId: text('agent_id')
		.notNull()
		.references(() => agents.id, { onDelete: 'cascade' }),
	sprintId: text('sprint_id'),
	kind: text('kind', { enum: ['seed', 'retro_insight', 'feedback'] })
		.notNull()
		.default('retro_insight'),
	content: text('content').notNull(),
	createdAt: createdAt()
});

export const backlogItems = sqliteTable('backlog_items', {
	id: text('id').primaryKey(),
	teamId: text('team_id')
		.notNull()
		.references(() => teams.id, { onDelete: 'cascade' }),
	/** Set when the team pulls the item into a sprint during planning. */
	sprintId: text('sprint_id'),
	title: text('title').notNull(),
	description: text('description').notNull().default(''),
	acceptanceCriteria: text('acceptance_criteria').notNull().default(''),
	status: text('status', {
		enum: ['backlog', 'selected', 'in_progress', 'done', 'accepted', 'rejected']
	})
		.notNull()
		.default('backlog'),
	/** null = created by the Product Owner (human). */
	createdByAgentId: text('created_by_agent_id'),
	createdAt: createdAt()
});

export const sprints = sqliteTable('sprints', {
	id: text('id').primaryKey(),
	teamId: text('team_id')
		.notNull()
		.references(() => teams.id, { onDelete: 'cascade' }),
	number: integer('number').notNull(),
	goal: text('goal').notNull().default(''),
	status: text('status', {
		enum: ['planning', 'active', 'review', 'completed']
	})
		.notNull()
		.default('planning'),
	/** Hard ceiling for LLM spend in this sprint, in tokens (input + output). */
	tokenBudget: integer('token_budget').notNull().default(300000),
	tokensUsed: integer('tokens_used').notNull().default(0),
	/** URL of the sprint's pull request (team branch → default branch), if the
	 *  team has a project. The sprint review IS the PR review. */
	prUrl: text('pr_url'),
	createdAt: createdAt(),
	completedAt: integer('completed_at', { mode: 'timestamp_ms' })
});

export const meetings = sqliteTable('meetings', {
	id: text('id').primaryKey(),
	sprintId: text('sprint_id')
		.notNull()
		.references(() => sprints.id, { onDelete: 'cascade' }),
	type: text('type', { enum: ['planning', 'review', 'retrospective', 'adhoc'] }).notNull(),
	status: text('status', { enum: ['running', 'completed', 'failed'] })
		.notNull()
		.default('running'),
	summary: text('summary').notNull().default(''),
	error: text('error'),
	createdAt: createdAt()
});

export const messages = sqliteTable('messages', {
	id: text('id').primaryKey(),
	meetingId: text('meeting_id')
		.notNull()
		.references(() => meetings.id, { onDelete: 'cascade' }),
	/** null = system/Product Owner. */
	agentId: text('agent_id'),
	authorName: text('author_name').notNull(),
	content: text('content').notNull(),
	inputTokens: integer('input_tokens').notNull().default(0),
	outputTokens: integer('output_tokens').notNull().default(0),
	createdAt: createdAt()
});

/**
 * One work-phase job: the sprint's Docker workspace is started (or reused) and
 * the team's developer agents implement the sprint backlog in it. Follows the
 * same fire-and-forget/poll pattern as `meetings`.
 */
export const workRuns = sqliteTable('work_runs', {
	id: text('id').primaryKey(),
	sprintId: text('sprint_id')
		.notNull()
		.references(() => sprints.id, { onDelete: 'cascade' }),
	status: text('status', { enum: ['running', 'completed', 'failed'] })
		.notNull()
		.default('running'),
	/** Docker container id of the workspace; kept for post-mortem. */
	containerId: text('container_id'),
	error: text('error'),
	createdAt: createdAt(),
	finishedAt: integer('finished_at', { mode: 'timestamp_ms' })
});

/**
 * One backlog item being worked in one work run. The diff/commit log captured
 * here (before the task branch is merged back) is the durable artifact the
 * sprint review argues over — the container itself is disposable.
 */
export const workItemRuns = sqliteTable('work_item_runs', {
	id: text('id').primaryKey(),
	workRunId: text('work_run_id')
		.notNull()
		.references(() => workRuns.id, { onDelete: 'cascade' }),
	backlogItemId: text('backlog_item_id')
		.notNull()
		.references(() => backlogItems.id, { onDelete: 'cascade' }),
	/** Assigned developer agent; null for future executors without one. */
	agentId: text('agent_id'),
	executor: text('executor').notNull().default('tool-loop'),
	status: text('status', { enum: ['pending', 'running', 'done', 'failed', 'skipped'] })
		.notNull()
		.default('pending'),
	branch: text('branch').notNull(),
	/** Executor's closing self-report: what was done, test results, open issues. */
	resultNote: text('result_note').notNull().default(''),
	diffStat: text('diff_stat').notNull().default(''),
	/** Unified diff vs. the team-branch tip at item start, truncated at 256 KB. */
	diff: text('diff').notNull().default(''),
	commitLog: text('commit_log').notNull().default(''),
	inputTokens: integer('input_tokens').notNull().default(0),
	outputTokens: integer('output_tokens').notNull().default(0),
	/** True for executors (e.g. future CLI tools) whose usage is estimated. */
	usageApproximate: integer('usage_approximate', { mode: 'boolean' }).notNull().default(false),
	error: text('error'),
	createdAt: createdAt(),
	finishedAt: integer('finished_at', { mode: 'timestamp_ms' })
});

/**
 * Step-by-step trace of a work run: tool calls, tool results, assistant notes
 * and run-level status lines (image pull, repo init, merges, cleanup).
 */
export const workLogs = sqliteTable('work_logs', {
	id: text('id').primaryKey(),
	workRunId: text('work_run_id')
		.notNull()
		.references(() => workRuns.id, { onDelete: 'cascade' }),
	/** null = run-level status entry, not tied to a single item. */
	workItemRunId: text('work_item_run_id').references(() => workItemRuns.id, {
		onDelete: 'cascade'
	}),
	kind: text('kind', { enum: ['status', 'assistant', 'tool_call', 'tool_result'] }).notNull(),
	toolName: text('tool_name'),
	content: text('content').notNull(),
	createdAt: createdAt()
});

export type Project = typeof projects.$inferSelect;
export type Team = typeof teams.$inferSelect;
export type Agent = typeof agents.$inferSelect;
export type PersonalityRevision = typeof personalityRevisions.$inferSelect;
export type AgentMemory = typeof agentMemories.$inferSelect;
export type BacklogItem = typeof backlogItems.$inferSelect;
export type Sprint = typeof sprints.$inferSelect;
export type Meeting = typeof meetings.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type WorkRun = typeof workRuns.$inferSelect;
export type WorkItemRun = typeof workItemRuns.$inferSelect;
export type WorkLog = typeof workLogs.$inferSelect;
