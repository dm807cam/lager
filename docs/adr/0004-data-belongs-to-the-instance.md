# 0004. Data belongs to the instance, not to the version

- Status: Accepted
- Date: 2026-11-11

## Context

Assistants rewrite apps often. Users must never lose their data because a new version was deployed, and must be able to go back to an older version when a new one is broken.

## Decision

- An **app** has numbered **versions**: one HTML file plus a declaration of capabilities. Deploying the same content and capabilities again creates no new version.
- An **instance** is a running copy of an app with its own host name, its own data and a pointer to its active version. The first deploy creates a default instance with the app's slug.
- Changing the active version only moves the pointer. A deploy moves every instance that follows deploys (`autoUpdate`, on by default). Any existing version can be activated, backwards or forwards.
- Before every change of the active version, Lager takes a snapshot of the instance's documents (`LAGER_SNAPSHOT_KEEP`, 20 by default). Restoring a snapshot first saves the current state as another one.

## Consequences

- New code must cope with existing data. The guide tells assistants to change data formats in a backward-compatible way.
- Snapshots cover documents only, not uploaded files or pages an instance saved itself. That keeps them small; the limits page says so.
- Several instances of one app have separate data, which is what one of the two ways of sharing relies on (see 0009).
