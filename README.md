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
  makes learning deliberate. When an agent's memory outgrows its prompt window, it
  consolidates: it merges its memories into a smaller, denser set (still first person) and
  the originals are archived — long-lived agents stay sharp instead of forgetful.
- **Personalities evolve, but don't drift.** After each retrospective an agent may propose a
  small edit to its own personality text based on the feedback it received. Rewrites are
  rejected automatically (most of the old text must survive), every applied change is shown
  to the PO as a diff on the team page, and the PO can pin a personality to freeze it.
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
| `active` | Work phase: the team's developer agents implement the sprint backlog in the team's Docker workspace — real files, real git branches, real test runs. Without Docker, item status can still be tracked manually | Agents + PO |
| `review` (after Sprint Review meeting) | The team presents results; the PO accepts or rejects each item. Rejected items return to the product backlog | PO |
| `completed` (after Retrospective) | The team reflects, exchanges feedback, each agent distills its memories for future sprints and may propose a small revision to its own personality | Agents |

## Architecture

```
src/lib/server/
  db/            SQLite (better-sqlite3) + Drizzle ORM. Schema: projects, teams, agents,
                 agent_memories, personality_revisions, backlog_items, sprints, meetings,
                 messages, work_runs, work_item_runs, work_logs.
  llm/           Provider registry on top of the Vercel AI SDK. One function —
                 getModel(provider, model) — hides all provider differences.
  engine/
    prompts.ts     Builds each agent's system prompt from personality + memories.
                   Agents are stateless between calls; identity lives in the DB.
    meeting.ts     Generic round-robin discussion runner with budget enforcement.
    ceremonies.ts  Planning, Review, Retrospective — each a discussion plus a
                   structured decision by the Scrum Master (generateObject).
    work.ts        The work phase: assigns sprint items to developer agents and
                   runs them sequentially in the team workspace.
    executor.ts    The "thing that implements one item" interface. Built-in:
                   a metered AI SDK tool loop (executors/toolLoop.ts). CLI-based
                   executors (Claude Code, …) plug in here later (issue #12).
  workspace/
    docker.ts      All Docker access (dockerode): per-team volume, disposable
                   workspace container per sprint, exec with timeouts + output
                   caps, startup reconciliation of orphans.
    git.ts         Branch flow: long-lived team branch, task branch per item,
                   --no-ff merge back when an item completes; with a project
                   connected, clone/fetch/push against the hosting remote.
  hosting.ts       Git hosting (GitHub/GitLab/Codeberg): repo validation, git
                   auth material, pull requests via the hosting APIs.
  secrets.ts       AES-256-GCM encryption for hosting tokens at rest.
```

Ceremonies and work runs execute in the background (fire-and-forget from the form action)
and write their outcome to the `meetings` / `work_runs` row; the sprint page polls while
anything is `running`.

### The team workspace

Each team owns a named Docker volume; a disposable workspace container mounts it during
the work phase and is destroyed when the sprint review starts. Inside, the repo follows a
local branching model: `main` → `team/<name>` (long-lived) → `task/<item>` (one per backlog
item, merged back `--no-ff` when the item completes). Items are worked sequentially, so
merges never conflict. Diffs, commit logs and the agent's self-report are captured into the
database before the container dies and become the evidence in the sprint review — both in
the review meeting prompt and as expandable per-item diffs in the UI.

Note on rejects: rejecting an item in the review does **not** revert its merge. The team
branch is the team's working history; PO acceptance is a product decision, not a git gate.
A rejected item returns to the product backlog and is re-attempted on top of the current
code in a later sprint.

### Projects: real repositories, real pull requests

A **project** connects a repository on GitHub, GitLab or Codeberg (self-hosted instances
work too — the host is taken from the repo URL). Assign a project to a team on the team
page; from then on the workspace repo is a clone of the real repository:

- The team branch is created from the default branch, pushed after every completed item.
- The sprint review opens a **pull request** (team branch → default branch) — the sprint
  review IS the PR review: the PO inspects, comments and merges on the hosting site.
- Cairn never force-pushes and never touches the default branch. The access token is
  stored encrypted and injected per git invocation by the orchestrator only — it never
  enters the workspace container, so the agents themselves cannot push at all.

Workspace containers get an empty environment — provider API keys never enter them — plus
resource limits (2 GiB RAM, 2 CPUs, 256 pids). Set `WORKSPACE_NETWORK=none` to also cut
them off from the network. On Windows, run Docker Desktop (WSL2 backend); the daemon is
auto-detected via the named pipe.

## Roadmap

- **M1 — shipped.** One team end-to-end: backlog → planning → review → retro →
  memory distillation. Multi-provider agents, token budgets, full meeting transcripts.
- **M2 — real work (current).** Docker workspace per team; agents implement backlog items
  on real git branches (team branch → task branch per item) and run builds/tests — shipped
  with issue #2. GitHub/GitLab/Codeberg projects with real PRs the PO reviews in the sprint
  review — shipped with issue #3. Still open in M2: pluggable CLI executors (issue #12).
- **M3 — living teammates.** Personality evolution over time — shipped with issue #4.
  Agent-created backlog items (proposed during work or retrospectives, gated behind PO
  approval) — shipped with issue #5. Ad-hoc meetings the agents call themselves mid-work,
  double-capped against the sprint budget (per-sprint rate limit + per-meeting token cap) —
  shipped with issue #6. Memory consolidation when the window fills — shipped with issue #7.
- **M4 — teams of teams.** Tag-based team discovery, per-team interfaces ("what we offer,
  how to ask us"), work requests that land in the target team's backlog behind THAT team's
  PO gate, and shared collab branches (+ their own PRs) when both teams work on the same
  project — shipped with issue #8.
- **Platform.** Users and authentication (email + password sessions; teams owned by their
  Product Owner and shareable read-only with viewers; per-user projects) — shipped with
  issue #9. Still open: per-user provider API keys.

## Users and access

Cairn is multi-user: everything requires a login. The **first account** created on an
instance becomes its owner — it is made Product Owner of all teams and owner of all
projects that existed before auth. After that, signup is closed unless you set
`CAIRN_ALLOW_SIGNUP=true` (careful on shared deployments: provider API keys are currently
server-global, so anyone who can sign up can spend them).

Each team has exactly one **Product Owner** — the user who created it, with full control —
and any number of **viewers**, added by email on the team page, who can follow everything
(sprints, meetings, work runs, diffs) but change nothing. Projects (and their repo tokens)
are visible only to the user who created them, and agents only ever discover teams that
belong to their own Product Owner.

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
