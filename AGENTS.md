# Repository Guidelines

## Project Structure & Module Organization

`backend/src/mastra/` contains the application runtime. Keep agents in `agents/`, callable capabilities in `tools/`, retrieval code in `rag/`, and shared vector configuration in `vector.ts`. Scripts used for one-off ingestion and manual checks live in `backend/src/scripts/`. PostgreSQL schema lives in `backend/database/init.sql`; seed material belongs in `backend/data/seed/`. `frontend/` contains the React knowledge-workbench UI and must not import Mastra runtime code directly. Do not treat vector metadata as the source of truth: canonical work and chapter records belong in the `works` and `chapters` tables.

## Build, Test, and Development Commands

- In `backend/`, `npm install` installs the locked dependencies and `npm run typecheck` runs the required static check.
- In `backend/`, `npm run dev` starts Mastra Studio, `npm run ingest:daodejing` imports the bundled test excerpts, and `npm run ask -- "《道德经》中的无为是什么意思？"` performs the manual RAG smoke check.
- In `frontend/`, `npm run build` performs the production build and type check.

Run `backend/database/init.sql` against the configured PostgreSQL database before ingestion. Do not start services or run ingestion against a shared database without explicit approval.

## Coding Style & Naming Conventions

Use TypeScript with strict mode and two-space indentation. Use `camelCase` for values and functions, `PascalCase` for types/classes, and kebab-case filenames such as `search-scripture.ts`. Keep imports explicit with `.js` extensions in source files. Preserve citation metadata (`title`, `chapter`, `version`, `type`, `source`) through every retrieval path; distinguish original scriptures from commentary and model synthesis.

## Testing Guidelines

No automated test runner is configured yet. Every code change must pass `npm run typecheck`. For RAG changes, also run the manual question above and verify that the answer returns a separate citation with a book title and chapter. Add future tests beside the relevant module as `*.test.ts` and avoid real API keys or production databases in tests.

## Commit & Pull Request Guidelines

The repository history currently contains only the initial commit, so no established commit convention exists. Use concise imperative messages, for example `feat: add chapter retrieval tool`. Keep each commit scoped. PRs should describe the user-facing behavior, list schema/configuration changes, include validation commands and results, and call out any unverified provider or database behavior.

## Security & Configuration

Keep credentials only in `.env`; never commit `DATABASE_URL` passwords, `DEEPSEEK_API_KEY`, or embedding-provider keys. Update `.env.example` only with placeholders. Do not introduce novel source text without its version and verifiable source metadata.
