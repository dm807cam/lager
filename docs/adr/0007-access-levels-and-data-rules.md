# 0007. Access levels and data rules

- Status: Accepted
- Date: 2026-11-11

## Context

Apps decide what they show, but they run in the visitor's browser and cannot be trusted to enforce who may read or write which data. The server must enforce it, in a way an assistant can declare without writing server code.

## Decision

- Every viewer has one level on an instance: `view < interact < admin < owner`. It is the highest level reached through ownership, a direct grant, a group grant or the visibility (`private`, `users` with a chosen level, `public` with `view`). Anonymous visitors never write.
- Without rules, reading needs `view` and writing `interact`.
- An app can declare rules in `capabilities.db.rules`: `{path, read?, write?}` with minimum levels per path prefix. The most specific matching rule wins, separately for reading and writing. The segment `{self}` matches only the viewer's own id, and the level `self` is held by nobody, so a path can be closed to everyone except the person it names.
- `data/users/<id>/…` belongs to that user alone, for reading and writing, even against the owner. Rules cannot loosen this.

## Consequences

- Polls, sign-off lists and private drafts work without server code, and the guide gives examples.
- The server checks every read, write, query and live update against the rules, so the runtime can stay simple.
- Administrators get no special data access through the interface (see 0009).
