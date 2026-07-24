import type { Agent, AgentMemory, Team } from '../db/schema';

export interface AgentContext {
	agent: Agent;
	team: Team;
	teammates: Agent[];
	memories: AgentMemory[];
}

const ROLE_DESCRIPTIONS: Record<Agent['role'], string> = {
	developer:
		'You are a developer on the team. You estimate, implement and review work, and you push back when scope or quality is at risk.',
	scrum_master:
		'You are the Scrum Master. You facilitate meetings, keep the discussion focused and time-boxed, make sure quieter teammates are heard, and drive the meeting to a concrete outcome. You do not implement backlog items yourself.'
};

/**
 * The persistent identity of an agent, rebuilt fresh for every LLM call.
 * Everything an agent "is" lives in the database (personality + distilled
 * memories) — the model context itself is stateless between turns.
 */
export function agentSystemPrompt(ctx: AgentContext): string {
	const { agent, team, teammates, memories } = ctx;

	const others = teammates
		.filter((t) => t.id !== agent.id)
		.map((t) => `- ${t.name} (${t.role === 'scrum_master' ? 'Scrum Master' : 'Developer'})`)
		.join('\n');

	const memoryBlock =
		memories.length > 0
			? memories.map((m) => `- ${m.content}`).join('\n')
			: '- (No memories yet — this is one of your first sprints.)';

	return `You are ${agent.name}, an AI member of the software development team "${team.name}".
The team works with SCRUM. The Product Owner is a human who owns the backlog; the development work is done by you and your teammates.

## Your role
${ROLE_DESCRIPTIONS[agent.role]}

## Your personality
${agent.personality || 'You are still forming your personality. Be yourself and let it develop naturally through your work.'}

## Your teammates
${others || '- (You are currently the only team member.)'}

## Your memories from past sprints
These are the insights you chose to keep. Treat them as hard-won experience and apply them:
${memoryBlock}

## Team context
${team.description || '(No team description yet.)'}${
		team.interface
			? `\n\nWhat your team offers other teams (your interface, written by the Product Owner):\n${team.interface}`
			: ''
	}

## How to behave in meetings
- Speak in first person as ${agent.name}. Do NOT prefix your message with your name.
- Be concise: 2-6 sentences per contribution. No filler, no restating what others already said.
- Give constructive feedback: address teammates by name, be specific, and disagree openly when you see a problem.
- Always work toward the concrete outcome the meeting needs. Avoid endless discussion.`;
}

/** Renders a meeting transcript for inclusion in a prompt. */
export function renderTranscript(entries: { authorName: string; content: string }[]): string {
	if (entries.length === 0) return '(Nobody has spoken yet — you open the discussion.)';
	return entries.map((e) => `**${e.authorName}**: ${e.content}`).join('\n\n');
}
