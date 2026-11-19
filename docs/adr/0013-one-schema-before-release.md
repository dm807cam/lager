# 0013. One database schema until the first release

- Status: Accepted
- Date: 2026-11-19

## Context

During development the platform database collected ten migrations, including data migrations for settings that no released version ever had. No installation needs them, and they make the schema hard to read.

## Decision

Until the first release, the platform schema is a single migration that creates the complete current schema. From the first release on, schema changes are appended as new migrations and released migrations are never edited. The instance databases create their tables with `CREATE TABLE IF NOT EXISTS`.

## Consequences

- The schema can be read in one place (`src/platform/db.ts`).
- Development databases created before this change must be recreated.
- After the first release, every schema change needs a migration that works on existing data, and a test for it.
