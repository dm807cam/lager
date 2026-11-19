# 0002. One process, SQLite and one data directory

- Status: Accepted
- Date: 2026-11-11

## Context

Lager is meant for people with a home server and a weekend, as well as for small organisations. Every extra service (a database server, a queue, a container per app) makes installing, backing up and upgrading harder.

## Decision

Lager runs as one Node.js process. It stores everything in one data directory: the platform database (`platform.sqlite`), one SQLite database per instance, uploaded files, deployed versions, snapshots, the trash and the server secret. It uses the `node:sqlite` module built into Node.js, has no native dependencies, and does not run apps in containers of their own. Configuration comes only from environment variables.

Rejected: an external database server (operational cost), a container per app (resource cost and complexity, and apps are static pages anyway), a reverse proxy of our own (every user already has one).

## Consequences

- Backing up means copying one directory. An online backup command (`npm run backup`) takes consistent SQLite snapshots while the server runs.
- Lager scales vertically. Several processes cannot share one data directory, and realtime rooms live in memory only.
- New features must fit into this model. A feature that needs another service needs a strong case and a new record.
