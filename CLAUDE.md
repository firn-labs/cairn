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
  become memories, and prompts include at most the newest 25 active ones. When an agent's
  active set outgrows that window, consolidation (engine/consolidation.ts) merges it into a
  smaller first-person set after the retrospective; originals get `archivedAt` set — memory
  rows are never deleted, and archived rows must stay out of prompts and counts.
- Personality evolution (engine/personality.ts) is edit-not-rewrite: proposals failing the
  drift guard (word-level retention, length caps in that file) are rejected, pinned agents
  are skipped, and every applied change gets a `personality_revisions` row — never update
  `agents.personality` from anywhere else without recording a revision.
- All Docker access goes through `src/lib/server/workspace/docker.ts` — never talk to the
  daemon (dockerode, CLI, socket) from anywhere else. Containers/volumes carry `cairn.*`
  labels; the labels, not the DB, are the source of truth for what exists.
- Workspace containers get an EMPTY environment: provider API keys and app config must
  never be passed into the container config. The ONE sanctioned exception (issue #12):
  CLI executors inject their credential per exec call (`execInWorkspace`'s `env` option)
  or as a container-local home-dir file — never via the container's `Env`, never onto the
  `/workspace` volume. Those credentials come from `server/executorCredentials.ts`
  (encrypted at rest, resolved via the team's PO) — the only read/write path for them.
  Anything a CLI executor runs can read its own credential; that trust model is
  documented in the Settings UI and must stay stated wherever credentials are entered.
- Work runs follow the same fire-and-forget pattern as ceremonies: outcome/error goes to
  the `work_runs` row, the UI polls. Startup reconciliation lives in `src/hooks.server.ts`
  (marks interrupted runs failed, removes orphaned containers).
- Multi-step tool loops bill the sprint per chunk from `result.totalUsage` and call
  `assertBudget` between chunks (see `engine/executors/toolLoop.ts`); new executors
  implement the `Executor` interface in `engine/executor.ts`. Executor selection is
  per team (`teams.executor` + JSON `teams.executorConfig`, edited on the team page),
  falling back to CAIRN_EXECUTOR. CLI executors (`engine/executors/cli.ts`) run the
  tool inside the workspace container, bill the sprint once after the run
  (`usage.billed=false`) and mark estimates with `usage.approximate` — a single item
  can overshoot the budget by at most its own run.
- Agent-created backlog items go through `proposeBacklogItem` in `engine/backlog.ts` — the
  only write path. They enter as status `proposed` (never `backlog`, never with a sprint)
  and become plannable only via the PO's approve action on the team page.
- Ad-hoc meetings go through `runAdhocMeeting` in `engine/adhoc.ts` — the only write path
  for `adhoc` meeting rows. Both cost guards live there (per-sprint rate limit, per-meeting
  token cap); don't add other ways for agents to talk outside ceremonies.
- Cross-team requests go through `requestTeamWork` in `engine/crossTeam.ts` — the only
  write path. They land in the TARGET team as `proposed`, behind that team's PO gate, like
  any agent proposal. Collab branches require a shared project; the branch name is generated
  once and STORED on every participating item (`backlogItems.collabBranch`), never
  re-derived. A collab branch is the one branch with a writer per team: sync MERGES the
  remote in (`syncCollabBranch` in `workspace/git.ts`) — never rebase, never force-push.
- Git hosting (projects): all hosting API access and git auth material lives in
  `src/lib/server/hosting.ts`; tokens are stored encrypted via `src/lib/server/secrets.ts`
  and decrypted only server-side. Auth reaches git solely as a per-invocation
  `-c http.extraHeader` flag in `workspace/git.ts` — never in the container env, the repo
  config, or an executor prompt. Cairn never force-pushes and never pushes the default
  branch; sprint results reach it only via the PR opened at sprint review
  (`engine/sprintPr.ts`).

- Auth (issue #9): sessions are server-side rows keyed by the SHA-256 of the cookie token
  (`server/auth/session.ts`); passwords are scrypt-hashed (`server/auth/password.ts`) — no
  auth library, no native deps. `hooks.server.ts` resolves the session into `locals.user`
  and redirects everything except `/login`/`/signup`. Authorization is per team via
  `team_members`: EXACTLY ONE `product_owner` plus any number of read-only `viewer`s —
  loads call `requireTeamMember`, every mutating action calls `requireTeamPo`
  (`server/auth/access.ts`); non-members get 404, not 403. Never rely on hidden UI as the
  gate. Projects are per-user (`ownerUserId`) because they hold repo tokens; cross-team
  discovery (`engine/crossTeam.ts`) only ever sees teams of the same PO user. Signup is
  open only while `users` is empty (first user adopts pre-auth teams/projects) or with
  `CAIRN_ALLOW_SIGNUP=true`.
- OIDC (`server/auth/oidc.ts` = protocol, `server/auth/oidcFlow.ts` = the shared
  start/callback flow, `server/auth/ssoProviders.ts` = config source): hand-rolled
  code+PKCE flow, no dependency; ID-token signature check intentionally skipped per OIDC
  Core 3.1.3.7 (direct TLS to the token endpoint) — iss/aud/exp/nonce ARE validated;
  don't "fix" that with a JWT lib. The IdP's groups claim maps to the INSTANCE role
  `users.role` (`member` may create teams/projects, `viewer` is a read-only guest;
  in neither configured group = login rejected), re-mapped on every login — instance
  role gates creation only, per-team rights stay in `team_members`. Accounts link via
  the `oidc_accounts` table (providerId+subject, then by email); OIDC-created users get
  the unverifiable password sentinel 'oidc'. CAIRN_ALLOW_SIGNUP does not gate SSO logins.
- SSO providers (issue #25) live in `oidc_providers`, managed under /admin/sso; the
  CAIRN_OIDC_* env vars are a bootstrap fallback (sentinel provider id 'env') that
  applies ONLY while the table is empty — precedence lives in `ssoProviders.ts`, don't
  re-derive it elsewhere. Routes: `/login/oidc[/callback]` for 'env',
  `/login/oidc/<id>[/callback]` for DB providers — the env callback URL must never
  change (existing IdP registrations). Client secrets are encrypted via
  `server/secrets.ts` and are write-only toward the UI: no load may put a secret (or
  its ciphertext) into page data. The OIDC flow doubles as account linking: ?link=1 on
  the start route stores the session user in the flow cookie and the callback attaches
  the subject to THAT user (after re-checking the live session) instead of logging in.
- Instance admin (issue #25): `users.isAdmin`, first user of an instance becomes admin
  (signup, OIDC first login, migration backfill). Everything under /admin calls
  `requireAdmin` (`server/auth/access.ts`) in the load AND in every action — actions
  run before loads, the layout guard alone is not the gate; non-admins get 404. Admins
  never change their own flag, so an instance cannot lose its last admin.
- Instance settings (issues #19/#23/#25) live in `app_settings`, read/written ONLY via
  `server/settings.ts` (typed registries: LIMITS, FLAGS, STRING_SETTINGS,
  PROVIDER_SETTINGS). Consumers read at call time (`getLimit(...)` etc., no module-level
  constants) so admin changes apply without restart. When adding a tunable limit, add it
  to the LIMITS registry with the old hardcoded value as default — never a new table or
  env var. Provider API keys resolve DB-over-env via `providerSetting(...)` in
  `llm/providers.ts`; admin-stored keys are encrypted and write-only toward the UI.
- The cross-team collaboration toggle (issue #23, `collaborationEnabled()`) gates BOTH
  read and write paths: `discoverTeams` returns [], `requestTeamWork` throws, and the
  tool loop neither registers the two cross-team tools nor mentions them in the prompt.
  Keep all four gates when touching collaboration code.

## Commands

- `npm run dev` — dev server (port 5173)
- `npm run check` — typecheck; run before pushing
- `npm run build` — production build
- Docker: `docker compose up --build` (port 3000)

## Conventions

- Svelte 5 runes (`$props`, `$state`, `$derived`, `$effect`) — no legacy `export let`.
- Tabs for indentation (scaffold default).
- Feature-branch-per-issue workflow; PRs merge via "Rebase and merge".
