import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

const createdAt = () =>
	integer('created_at', { mode: 'timestamp_ms' })
		.notNull()
		.$defaultFn(() => new Date());

/**
 * A team of AI agents. `tags` is a JSON string array describing what the team
 * is for — the basis for cross-team discovery in a later milestone.
 */
export const teams = sqliteTable('teams', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	description: text('description').notNull().default(''),
	tags: text('tags').notNull().default('[]'),
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
	provider: text('provider').notNull(),
	model: text('model').notNull(),
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

export type Team = typeof teams.$inferSelect;
export type Agent = typeof agents.$inferSelect;
export type AgentMemory = typeof agentMemories.$inferSelect;
export type BacklogItem = typeof backlogItems.$inferSelect;
export type Sprint = typeof sprints.$inferSelect;
export type Meeting = typeof meetings.$inferSelect;
export type Message = typeof messages.$inferSelect;
