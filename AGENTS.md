# Repository Guidelines

## Upstream Sync Policy

`mastra-agent-starter` is this repository's long-term upstream template. Keep
the current business repository as `origin`; configure the template as the
`upstream` remote (`https://github.com/kechen123/mastra-agent-starter.git`).

Never push this repository's business work to `upstream`.

Before beginning a substantial task, before pushing `origin`, and once again
after a push, run `git fetch upstream` and inspect whether `upstream/main`
contains commits not yet present locally.

If upstream changes exist, review the concrete diff and classify the relevant
changes (Runtime, Agent, Skill, Tool, Conversation, SSE, database, UI,
Provider, or infrastructure) before deciding whether to merge them.

Do not use an upstream update to overwrite current business behavior. Resolve
conflicts only after understanding both the template change and the business
change, then rerun checks appropriate to the merge.

Daymind-specific business features should normally remain only in this
repository. This includes features related to personal/work knowledge,
projects, inbox ingestion, memory, wiki organization, retrieval behavior, and
assistant-specific workflows.

If a business change produces a genuinely reusable Runtime, Skill, Provider,
retrieval, document-processing, memory, wiki, or Job capability that is not
specific to Daymind, document it as a possible upstream contribution.

Do not modify or push changes to the upstream repository automatically.

The practical procedure and conflict-handling checklist live in
[`docs/UPSTREAM_SYNC.md`](docs/UPSTREAM_SYNC.md).


## Project Structure & Module Organization

`backend/src/mastra/` contains the application runtime. Keep agents in `agents/`, callable capabilities in `tools/`, and retrieval code in `rag/`. Scripts used for one-off checks live in `backend/src/scripts/`. PostgreSQL schema lives in `backend/database/init.sql`. `frontend/` contains the React knowledge-workbench UI and must not import Mastra runtime code directly.

During development, schema changes target a freshly initialized database: when `backend/database/init.sql` changes, the database is deleted and initialized again. Do not add compatibility DDL, data backfills, or migration paths for an old database unless the user explicitly requests backward compatibility.

## Build, Test, and Development Commands

- In `backend/`, `npm install` installs the locked dependencies and `npm run typecheck` runs the required static check.
- In `backend/`, `npm run dev` starts Mastra Studio.
- In `frontend/`, `npm run build` performs the production build and type check.

Run `backend/database/init.sql` against the configured PostgreSQL database before starting services. Do not start services or run ingestion against a shared database without explicit approval.

## Coding Style & Naming Conventions

Use TypeScript with strict mode and two-space indentation. Use `camelCase` for values and functions, `PascalCase` for types/classes, and kebab-case filenames. Keep imports explicit with `.js` extensions in source files. Preserve citation metadata (`title`, `chapter`, `documentName`, `chunkIndex`, `source`) through every retrieval path.

## Framework-native Capability Priority

When `assistant-ui`, Base UI, React, Tailwind, Mastra, or PostgreSQL already provides a capability whose semantics meet the requirement, prefer that framework-native capability over a parallel hand-written implementation. Keep or introduce custom behavior only when there is a confirmed product or reliability difference. Record the difference, risk, and validation evidence; do not treat a superficially similar framework feature as grounds to remove durable Run persistence, SSE replay, approvals, workspace isolation, or citation provenance.

## Testing Guidelines

No automated test runner is configured yet. Every code change must pass `npm run typecheck`. Add future tests beside the relevant module as `*.test.ts` and avoid real API keys or production databases in tests.

## Commit & Pull Request Guidelines

The repository history currently contains only the initial commit, so no established commit convention exists. Use concise imperative messages, for example `feat: add knowledge base retrieval tool`. Keep each commit scoped. PRs should describe the user-facing behavior, list schema/configuration changes, include validation commands and results, and call out any unverified provider or database behavior.

Before every commit or push, update the documentation progress in the same change set. Keep `README.md`, `docs/architecture.md`, and `docs/implementation-plan.md` aligned with the verified implementation state; work in progress must be marked as unverified and must not be presented as completed.

## Security & Configuration

Keep credentials only in `.env`; never commit `DATABASE_URL` passwords, `DEEPSEEK_API_KEY`, or embedding-provider keys. Update `.env.example` only with placeholders. Do not introduce novel source text without verifiable source metadata.
