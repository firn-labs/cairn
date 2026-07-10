# Cairn

**AI agent teams, run with SCRUM.**

Cairn orchestrates teams of AI agents the way real software teams work: a human Product Owner
fills a backlog, the agent team plans a sprint, works, presents its results in a sprint review,
and reflects in a retrospective. Like the stone cairns that mark mountain routes, every sprint
each agent adds a stone: retrospectives are distilled into a small set of memories that shape
how the agent works in future sprints — the rest is deliberately forgotten.

## Core ideas

- **SCRUM as the coordination protocol.** Multi-agent systems usually fail at coordination.
  SCRUM gives agents bounded work (the sprint backlog), fixed synchronization points (the
  ceremonies) and a human control point (the PO). All ceremonies run as real multi-turn
  discussions between the agents and are fully visible in the UI — transcript and summary.
- **Agents are individuals.** Each agent has a name, a role, a personality and its own memory,
  and each can run on a different model/provider (Anthropic, OpenAI, Mistral, OpenRouter,
  Ollama). Agents give each other direct feedback in retrospectives.
- **Memory by distillation.** After every retrospective each agent compresses the sprint into
  1–3 first-person insights. Only those insights persist. This prevents memory overload and
  makes learning deliberate.
- **Cost control is a core feature.** Every sprint has a hard token budget. Every LLM call is
  metered; meetings stop when the budget is exhausted.

## Quickstart (development)

```sh
npm install
cp .env.example .env       # add at least one provider API key
npm run dev
```

Open http://localhost:5173, create a team, add 2–10 agents (one Scrum Master recommended),
fill the backlog, start a sprint and run the planning.

## Quickstart (Docker)

```sh
cp .env.example .env       # add your API keys
docker compose up --build
```

Open http://localhost:3000. The SQLite database lives in the `cairn-data` volume.

## The sprint lifecycle

| Phase | What happens | Who acts |
|---|---|---|
| `planning` | Sprint Planning meeting: the team discusses the product backlog in two rounds, commits to items and a sprint goal | Agents |
| `active` | Work phase. (M1: item status is tracked manually; M2 gives agents real git workspaces) | Agents + PO |
| `review` (after Sprint Review meeting) | The team presents results; the PO accepts or rejects each item. Rejected items return to the product backlog | PO |
| `completed` (after Retrospective) | The team reflects, exchanges feedback, and each agent distills its memories for future sprints | Agents |

## Architecture

```
src/lib/server/
  db/            SQLite (better-sqlite3) + Drizzle ORM. Schema: teams, agents,
                 agent_memories, backlog_items, sprints, meetings, messages.
  llm/           Provider registry on top of the Vercel AI SDK. One function —
                 getModel(provider, model) — hides all provider differences.
  engine/
    prompts.ts     Builds each agent's system prompt from personality + memories.
                   Agents are stateless between calls; identity lives in the DB.
    meeting.ts     Generic round-robin discussion runner with budget enforcement.
    ceremonies.ts  Planning, Review, Retrospective — each a discussion plus a
                   structured decision by the Scrum Master (generateObject).
```

Ceremonies run in the background (fire-and-forget from the form action) and write their
outcome to the `meetings` row; the sprint page polls while a meeting is `running`.

## Roadmap

- **M1 — this milestone.** One team end-to-end: backlog → planning → review → retro →
  memory distillation. Multi-provider agents, token budgets, full meeting transcripts.
- **M2 — real work.** Docker workspace per team; agents implement backlog items on real git
  branches (team branch → task branch per item), run builds/tests, and open PRs the PO
  reviews in the sprint review. GitHub/GitLab/Codeberg integration.
- **M3 — living teammates.** Personality evolution over time, agent-created backlog items,
  ad-hoc meetings the agents call themselves, memory consolidation when the window fills.
- **M4 — teams of teams.** Tag-based team discovery, dynamic inter-team interfaces, collab
  branches for cross-team features.

## License

Cairn is free software, licensed under the [GNU AGPL-3.0](LICENSE) — the same license as
other Firn Labs projects. If you run a modified version as a network service, you must make
your modified source available to its users.

## Commands

```sh
npm run dev          # dev server
npm run check        # typecheck (svelte-check)
npm run build        # production build (adapter-node)
npm run db:generate  # regenerate migrations after schema changes
npm run db:studio    # browse the database
```
