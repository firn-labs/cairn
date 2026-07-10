# Cairn — development notes

Cairn orchestrates teams of AI agents that work in SCRUM sprints. Human = Product Owner;
agents plan, work, review and retrospect. See README.md for the vision and roadmap.

## Stack

- SvelteKit 2 + Svelte 5 (runes mode is forced in vite.config.ts), TypeScript, adapter-node.
- SQLite via better-sqlite3 + Drizzle ORM. Migrations live in `drizzle/` and run automatically
  at startup (`migrate()` in `src/lib/server/db/index.ts`). After changing
  `src/lib/server/db/schema.ts`, run `npm run db:generate` and commit the new migration.
- LLM calls go through the Vercel AI SDK (v7). Never call a provider SDK directly — always use
  `getModel(provider, model)` from `src/lib/server/llm/providers.ts`.

## Architecture rules

- Agent identity is stateless-per-call: everything an agent "is" (personality, memories) lives
  in the DB and is rebuilt into the system prompt by `engine/prompts.ts` on every call.
- Every LLM call MUST be billed to the sprint (`tokensUsed`) and respect the sprint's
  `tokenBudget`. Use the helpers in `engine/meeting.ts`; don't add unmetered calls.
- Ceremonies are fire-and-forget background jobs; all outcomes (including errors) are written
  to the `meetings` row. The UI polls — never block a form action on LLM calls.
- Memory is distilled, not accumulated: only retrospective insights (1–3 per agent per sprint)
  become memories, and prompts include at most the newest 25.

## Commands

- `npm run dev` — dev server (port 5173)
- `npm run check` — typecheck; run before pushing
- `npm run build` — production build
- Docker: `docker compose up --build` (port 3000)

## Conventions

- Svelte 5 runes (`$props`, `$state`, `$derived`, `$effect`) — no legacy `export let`.
- Tabs for indentation (scaffold default).
- Feature-branch-per-issue workflow; PRs merge via "Rebase and merge".
