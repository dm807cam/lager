# Architecture decision records

This folder records the decisions that shape Lager: what was decided, why, and what follows from it. Each record is short, and together they explain why the code looks the way it does. That saves contributors from rediscovering a reason, or from undoing a decision by accident.

We follow the format [described by Michael Nygard](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions): context, decision, consequences.

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted |
| [0002](0002-single-process-with-sqlite.md) | One process, SQLite and one data directory | Accepted |
| [0003](0003-one-subdomain-per-instance.md) | One subdomain per instance, routed by host name | Accepted |
| [0004](0004-data-belongs-to-the-instance.md) | Data belongs to the instance, not to the version | Accepted |
| [0005](0005-per-host-sessions.md) | A session per host, created by a redirect handshake | Accepted |
| [0006](0006-neutral-browser-runtime.md) | One neutral browser runtime, `window.lager`, for every AI | Accepted |
| [0007](0007-access-levels-and-data-rules.md) | Access levels and data rules | Accepted |
| [0008](0008-mcp-connector-with-oauth.md) | An MCP connector with OAuth for any AI assistant | Accepted |
| [0009](0009-accounts-roles-and-sharing.md) | Accounts, roles and two ways of sharing | Accepted |
| [0010](0010-pages-that-save-themselves.md) | Pages that save themselves get versions of their own instance | Accepted |
| [0011](0011-bring-your-own-model.md) | Bring your own model: providers and AI groups | Accepted |
| [0012](0012-english-source-and-translations.md) | English as the source language, translated interface | Accepted |
| [0013](0013-one-schema-before-release.md) | One database schema until the first release | Accepted |
| [0014](0014-agpl-and-dco.md) | AGPL-3.0-or-later and the DCO instead of a CLA | Accepted |
| [0015](0015-model-catalog-and-model-per-app.md) | A model catalog, allowed models per AI group and a model per app | Accepted |
| [0016](0016-confirm-before-instance-sign-in.md) | A visitor confirms before an instance learns who they are | Proposed |
| [0017](0017-append-only-ingest.md) | Data from outside comes in through append-only endpoints with a quota of their own | Proposed |
| [0018](0018-embedding-on-other-websites.md) | Websites outside Lager may frame an instance its managers name them for | Proposed |
| [0019](0019-offline-first-runtime.md) | The runtime makes every app work offline and syncs when the server is back | Proposed |

## Writing a new record

1. Copy [`template.md`](template.md) to the next free number, for example `0015-short-title.md`.
2. Fill it in and open a pull request. The discussion happens there, and the record starts as **Proposed**.
3. When the pull request is merged, the status becomes **Accepted**.

Write a record when a change is hard to reverse, affects several parts of Lager, or when you rejected an obvious alternative. A record is not changed afterwards except for its status: a new decision gets a new record, and the old one becomes **Superseded by 00NN**.
