# Repository Guidelines

## Project Structure & Module Organization

`backend/src/mastra/` contains the application runtime. Keep agents in `agents/`, callable capabilities in `tools/`, and retrieval code in `rag/`. Scripts used for one-off checks live in `backend/src/scripts/`. PostgreSQL schema lives in `backend/database/init.sql`. `frontend/` contains the React knowledge-workbench UI and must not import Mastra runtime code directly.

## Build, Test, and Development Commands

- In `backend/`, `npm install` installs the locked dependencies and `npm run typecheck` runs the required static check.
- In `backend/`, `npm run dev` starts Mastra Studio.
- In `frontend/`, `npm run build` performs the production build and type check.

Run `backend/database/init.sql` against the configured PostgreSQL database before starting services. Do not start services or run ingestion against a shared database without explicit approval.

## Coding Style & Naming Conventions

Use TypeScript with strict mode and two-space indentation. Use `camelCase` for values and functions, `PascalCase` for types/classes, and kebab-case filenames. Keep imports explicit with `.js` extensions in source files. Preserve citation metadata (`title`, `chapter`, `documentName`, `chunkIndex`, `source`) through every retrieval path.

## Testing Guidelines

No automated test runner is configured yet. Every code change must pass `npm run typecheck`. Add future tests beside the relevant module as `*.test.ts` and avoid real API keys or production databases in tests.

## Commit & Pull Request Guidelines

The repository history currently contains only the initial commit, so no established commit convention exists. Use concise imperative messages, for example `feat: add knowledge base retrieval tool`. Keep each commit scoped. PRs should describe the user-facing behavior, list schema/configuration changes, include validation commands and results, and call out any unverified provider or database behavior.

## Security & Configuration

Keep credentials only in `.env`; never commit `DATABASE_URL` passwords, `DEEPSEEK_API_KEY`, or embedding-provider keys. Update `.env.example` only with placeholders. Do not introduce novel source text without verifiable source metadata.
