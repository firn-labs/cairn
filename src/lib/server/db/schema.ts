import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core';

const createdAt = () =>
	integer('created_at', { mode: 'timestamp_ms' })
		.notNull()
		.$defaultFn(() => new Date());

/**
 * A human user. Signup is open only while the table is empty (the first user
 * becomes the instance owner and adopts all pre-auth teams and projects);
 * afterwards it requires CAIRN_ALLOW_SIGNUP=true. Passwords are scrypt-hashed
 * (see `server/auth/password.ts`) — never store or log the plaintext.
 */
export const users = sqliteTable('users', {
	id: text('id').primaryKey(),
	/** Stored lowercased; the login identifier. */
	email: text('email').notNull().unique(),
	name: text('name').notNull().default(''),
	/** For OIDC-created accounts this is the sentinel 'oidc' — it can never
	 *  verify, so such accounts cannot log in with a password. */
	passwordHash: text('password_hash').notNull(),
	/**
	 * Instance-level role. `member` = full account: may create teams (becoming
	 * their Product Owner) and projects. `viewer` = read-only guest: sees only
	 * teams shared with them, creates nothing. Team-level rights stay in
	 * `team_members`. For OIDC logins this is re-mapped from the IdP's groups
	 * on every login (see `server/auth/oidc.ts`); password signups are members.
	 */
	role: text('role', { enum: ['member', 'viewer'] }).notNull().default('member'),
	/**
	 * Instance administrator (issue #25): may manage SSO providers, instance
	 * settings and other users' admin flag under /admin. The first user of an
	 * instance becomes admin automatically (signup, first OIDC login, and the
	 * migration backfill for existing instances). Orthogonal to `role` — an
	 * admin is usually also a member, but the flags are independent.
	 */
	isAdmin: integer('is_admin', { mode: 'boolean' }).notNull().default(false),
	createdAt: createdAt()
});

/**
 * A DB-managed OIDC provider (issue #25), editable by instance admins under
 * /admin/sso. When this table has rows they are the ONLY providers offered;
 * the CAIRN_OIDC_* env vars act as a bootstrap fallback used solely while the
 * table is empty (id sentinel 'env', see `server/auth/ssoProviders.ts`).
 * The client secret is AES-256-GCM encrypted via `server/secrets.ts` and is
 * never sent to the client.
 */
export const oidcProviders = sqliteTable('oidc_providers', {
	id: text('id').primaryKey(),
	/** Login-button label, e.g. the company IdP's name. */
	label: text('label').notNull(),
	issuer: text('issuer').notNull(),
	clientId: text('client_id').notNull(),
	/** Empty string = public client (PKCE only, no secret). */
	clientSecretCiphertext: text('client_secret_ciphertext').notNull().default(''),
	scopes: text('scopes').notNull().default('openid profile email'),
	groupsClaim: text('groups_claim').notNull().default('groups'),
	memberGroup: text('member_group').notNull().default(''),
	viewerGroup: text('viewer_group').notNull().default(''),
	/** Disabled providers keep their linked accounts but offer no login. */
	enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
	createdAt: createdAt()
});

/**
 * SSO identities linked to a user account — replaces the former
 * `users.oidcSubject` column so one account can be reachable through several
 * providers (issue #25). `providerId` references `oidc_providers.id` or is the
 * sentinel 'env' for the env-var fallback provider (no FK because of that
 * sentinel; provider deletion cleans up its rows explicitly).
 */
export const oidcAccounts = sqliteTable(
	'oidc_accounts',
	{
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		providerId: text('provider_id').notNull(),
		/** The IdP's stable `sub` claim for this user. */
		subject: text('subject').notNull(),
		createdAt: createdAt()
	},
	(table) => [primaryKey({ columns: [table.providerId, table.subject] })]
);

/**
 * Instance-wide settings, one row per key (issue #19/#23/#25): configurable
 * limits and budgets, feature flags, provider API credentials and similar.
 * Read/write ONLY through `server/settings.ts`, which knows each key's type,
 * default and whether the value is stored encrypted — never query this table
 * directly.
 */
export const appSettings = sqliteTable('app_settings', {
	key: text('key').primaryKey(),
	value: text('value').notNull(),
	updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
});

/**
 * Server-side session. `id` is the SHA-256 hex of the random token that lives
 * in the cookie, so a database leak does not leak usable session tokens.
 */
export const sessions = sqliteTable('sessions', {
	id: text('id').primaryKey(),
	userId: text('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
	createdAt: createdAt()
});

/**
 * Team membership. Every team has EXACTLY ONE `product_owner` row (the write
 * paths in routes enforce this) and any number of `viewer` rows. The PO is the
 * only member who may mutate the team; viewers get read-only access.
 */
export const teamMembers = sqliteTable(
	'team_members',
	{
		teamId: text('team_id')
			.notNull()
			.references(() => teams.id, { onDelete: 'cascade' }),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		role: text('role', { enum: ['product_owner', 'viewer'] })
			.notNull()
			.default('viewer'),
		createdAt: createdAt()
	},
	(table) => [primaryKey({ columns: [table.teamId, table.userId] })]
);

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
	/** Projects hold repo tokens, so they are strictly per-user. Null only on
	 *  rows from before auth existed; the first signup adopts those. */
	ownerUserId: text('owner_user_id').references(() => users.id, { onDelete: 'cascade' }),
	createdAt: createdAt()
});

/**
 * A team of AI agents. `tags` is a JSON string array describing what the team
 * is for — together with `description` and `interface` it is what other teams'
 * agents see when they discover this team (engine/crossTeam.ts).
 */
export const teams = sqliteTable('teams', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	description: text('description').notNull().default(''),
	tags: text('tags').notNull().default('[]'),
	/** The team's interface toward other teams: what it offers and how to phrase
	 *  a work request to it. Written by the Product Owner; empty = not stated. */
	interface: text('interface').notNull().default(''),
	/** null = no git hosting connected; the team works in a local-only repo. */
	projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
	/** Work-phase executor for this team; '' = instance default (CAIRN_EXECUTOR
	 *  or the built-in tool loop). See `engine/executor.ts` for the known ids. */
	executor: text('executor').notNull().default(''),
	/** JSON object with executor settings the Product Owner edits in the UI:
	 *  { model?, baseUrl?, timeoutMinutes?, extraEnv? } — see `TeamExecutorConfig`
	 *  in `engine/executor.ts`. Parsed leniently; unknown keys are ignored. */
	executorConfig: text('executor_config').notNull().default('{}'),
	createdAt: createdAt()
});

/**
 * Per-user credentials for CLI executors (issue #12): OAuth tokens / auth files
 * from the user's own subscription plans (Claude Max, ChatGPT), or plain API
 * keys. Stored AES-256-GCM encrypted like hosting tokens. One row per
 * (user, kind). At work time a team resolves credentials via its Product
 * Owner's user — a viewer's credentials are never used.
 *
 * Trust model: unlike the built-in tool loop (keys stay server-side), a CLI
 * executor necessarily carries its credential INTO the workspace container,
 * where agent-written code could read it — same exposure as running the CLI
 * on your own machine. The UI says so where credentials are entered.
 */
export const executorCredentials = sqliteTable(
	'executor_credentials',
	{
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		/**
		 * claude_code_oauth  — long-lived token from `claude setup-token` (Max plan)
		 * anthropic_api_key  — Anthropic API key for Claude Code
		 * codex_auth_json    — full contents of ~/.codex/auth.json (ChatGPT plan)
		 * openai_api_key     — OpenAI API key for Codex
		 */
		kind: text('kind', {
			enum: ['claude_code_oauth', 'anthropic_api_key', 'codex_auth_json', 'openai_api_key']
		}).notNull(),
		secretCiphertext: text('secret_ciphertext').notNull(),
		createdAt: createdAt(),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
	},
	(table) => [primaryKey({ columns: [table.userId, table.kind] })]
);

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
 * few insights, and only those persist. When the active set outgrows the
 * prompt window the agent consolidates it (see `engine/consolidation.ts`):
 * originals are archived (`archivedAt`), never deleted, and replaced by a
 * smaller set of `consolidated` memories.
 */
export const agentMemories = sqliteTable('agent_memories', {
	id: text('id').primaryKey(),
	agentId: text('agent_id')
		.notNull()
		.references(() => agents.id, { onDelete: 'cascade' }),
	sprintId: text('sprint_id'),
	kind: text('kind', { enum: ['seed', 'retro_insight', 'feedback', 'consolidated'] })
		.notNull()
		.default('retro_insight'),
	content: text('content').notNull(),
	/** Set when a consolidation replaced this memory; null = active (in the prompt window). */
	archivedAt: integer('archived_at', { mode: 'timestamp_ms' }),
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
	/**
	 * `proposed` = created by an agent and awaiting Product Owner review; sprint
	 * planning only sees `backlog` items, so proposals can never bypass the PO.
	 */
	status: text('status', {
		enum: ['proposed', 'backlog', 'selected', 'in_progress', 'done', 'accepted', 'rejected']
	})
		.notNull()
		.default('backlog'),
	/** null = created by the Product Owner (human). */
	createdByAgentId: text('created_by_agent_id'),
	/** For agent proposals: why the agent thinks this belongs on the backlog. */
	proposalRationale: text('proposal_rationale').notNull().default(''),
	/** Set when another team requested this item (engine/crossTeam.ts): the
	 *  requesting team. The item still enters as `proposed` — the receiving
	 *  team's Product Owner gates it like any other proposal. */
	requestedByTeamId: text('requested_by_team_id').references(() => teams.id, {
		onDelete: 'set null'
	}),
	/** Shared cross-team branch (`collab/...`) this item is worked on instead of
	 *  the team branch. Identical on the items of every participating team; only
	 *  possible when the teams share a project. */
	collabBranch: text('collab_branch'),
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

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type TeamMember = typeof teamMembers.$inferSelect;
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
export type ExecutorCredential = typeof executorCredentials.$inferSelect;
export type OidcProvider = typeof oidcProviders.$inferSelect;
export type OidcAccount = typeof oidcAccounts.$inferSelect;
export type AppSetting = typeof appSettings.$inferSelect;
