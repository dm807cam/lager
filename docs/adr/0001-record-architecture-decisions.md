# 0001. Record architecture decisions

- Status: Accepted
- Date: 2026-11-19

## Context

Lager grew from a few design documents and implementation plans written for one developer's tooling. Once the project is open to contributors, decisions need a home that does not depend on any particular editor or assistant, that stays short, and that explains *why* rather than *how*.

## Decision

We keep architecture decision records in `docs/adr/`, one Markdown file per decision, numbered in order, in English. Each has a status, a date, the context, the decision and its consequences. User documentation stays in `docs/`, and step-by-step implementation plans are not kept in the repository.

## Consequences

- A change that is hard to reverse comes with a new record in the same pull request.
- Accepted records are not rewritten. When a decision changes, a new record supersedes the old one.
- The earlier design documents were folded into records 0002 to 0013 and removed. They remain in the Git history.
