# 0017. Data from outside comes in through append-only endpoints with a quota of their own

- Status: Proposed
- Date: 2026-11-20

## Context

0007 says that anonymous visitors never write, and instance endpoints answer only the instance's own page with the visitor's session. That keeps instances safe, but it rules out two kinds of app. A public page cannot take one small input from a guest (an RSVP, a guestbook entry, a vote) without making the guest create an account. And nothing outside the instance can feed it: not a counting snippet on the owner's blog, not a form on their website, a webhook, a script, a phone shortcut or a sensor. Such apps needed a second server next to Lager that collected the data, with its own hosting, secret and backup. The workarounds people reach for instead are worse than a narrow door: an API token with full deploy rights in a script, or accounts handed out so that strangers reach contributor level.

Whatever opens here is reachable by anyone on the internet, on a server that is often a Raspberry Pi. It must not become a way to read data, to act as a signed-in visitor, to fill the instance's storage or to keep the server busy.

## Decision

An app can let data in from outside in two ways. Both only **append**: the server makes up the id of every document, so nothing that exists can be read, overwritten or deleted through them.

- **Ingest endpoints.** The `ingest` capability declares up to 8 named endpoints. `POST /_ingest/<name>` on the instance's host stores one JSON object in the endpoint's collection and answers `202` without a body. Who may send is part of the declaration: with `auth: "none"`, browsers on the listed origins (checked against the `Origin` header, with CORS answered for those origins only, and `*` refused); with `auth: "token"`, whoever presents the endpoint's token. A field Lager does not know fails the deploy, and a stored declaration that does not parse opens nothing.
- **`write: "anyone"` in the data rules.** Every visitor who can open the instance, signed in or not, may `add` documents below such a path. Nothing else changes there: `set`, `update`, `delete` and `acquire` stay with the default write level, and the private areas never take such documents. This amends the sentence in 0007: anonymous visitors never write, except that they append where a rule says so.

What keeps this contained:

- **No session.** The endpoint route is mounted before the instance's session is read and never looks at a cookie. A request is anonymous there, whoever's browser sent it, so a page on another site cannot borrow a signed-in visitor's rights (no request forgery), and no document is stored under anybody's name. CORS never allows credentials.
- **Tokens are derived, not stored.** A token is an HMAC of the server secret, the instance, the endpoint and a counter. It can be shown again on the instance page at any time, the platform database alone does not reveal it, and replacing it is incrementing the counter. It opens one endpoint of one instance and nothing else.
- **A quota of its own.** Documents from outside live in the instance's database like all others, so the app reads them with `db`, and exports, snapshots and backups cover them without new code. Each one has a row in a bookkeeping table that says what it counts against the ingest quota (`LAGER_INGEST_QUOTA_MB`, default 10 MiB per instance, `0` = off for the whole server). That sum is taken off what the instance's own storage is measured by, so a flood from outside cannot fill the instance, and a full instance does not close the endpoint. A document counts with the database pages it can take at worst, not with its JSON length, because counting too little would let data from outside eat into the instance's space; a test holds that bound for every document size while a collection rotates. Triggers keep the bookkeeping, so no present or future write path can forget it.
- **Becoming the instance's own.** When someone with write access changes a received document, its row goes: it counts against the instance's storage from then on. When the ingest quota is full, an endpoint refuses (`507`), or, with `onFull: "rotate"`, drops the oldest received documents of its collection, never ones that were changed since.
- **Limits before work.** Per minute an instance takes 150 requests from one client address without a token, 600 per endpoint or rule and 1200 in all, and an endpoint takes a declared number of documents per day (default 10000). They are checked before the body is read; a body is at most `maxBytes` (default 4 KiB, at most 64 KiB) and is not decompressed. Commits of received documents are not forced to disk one by one, so requests from strangers do not turn into one disk sync each; live queries hear of them at most every 2 seconds per collection. Counters of accepted, refused and limited requests are kept in memory, so a refused request never costs a write.
- **Private by default.** The collection of an endpoint is readable from `admin` unless the app's rules set `read` for it: what strangers send is not shown to other strangers because a rule was forgotten.
- **Nothing about the sender is stored.** No address, user agent or origin. `visitor: "daily"` adds a hash keyed with a random value that exists only in memory and is replaced every day, so unique visitors can be counted without cookies and the value cannot be linked across days or traced back, even with the server's secret and database. `country: true` adds the two letters of a header the operator names (`LAGER_COUNTRY_HEADER`), and nothing without that setting.
- **Switches.** The people who manage an instance see every endpoint on its page, with its address, token and counters, and can close each one at once. An administrator can disable the instance; the operator can turn the whole feature off.

Alternatives that lost:

- *A separate database file per instance for received data.* Exact accounting and a hard wall, but received documents would fall out of snapshots and restores unless those learned about two files, and every read would have to look in both. The same-file design keeps one database per instance (0002, 0004) at the price of an estimated size.
- *Always answering `202`,* as first proposed, so that a prober learns nothing. Senders need the difference: a webhook retries on `429` and `5xx`, and a person with a mistyped token in a phone shortcut needs `401`, not silence. The statuses reveal only what the sender already knows or the instance page of a public address would show; a switched-off endpoint answers like a missing one.
- *Endpoints that start switched off until the instance's owner turns them on.* A deploy can already change what an instance does for its visitors, including its data rules; an endpoint is in the same class, and the owner's switch is one click away.
- *A generic tracker script served by Lager, a retention time per endpoint, origins set per instance.* Left out: the first is app code, the second is what `rotate` and the quota already bound, and the third waits for a need.
- *Stored tokens (hashed, as API tokens are).* A hash cannot be shown again, and the instance page is where people look for the value they pasted into a device a year ago.

## Consequences

- Apps for page views, forms, webhooks, sensors, RSVPs and polls need no second server. `examples/pageviews.html` shows the first.
- An endpoint without a token is open to anyone who can run a script; the origin list keeps other websites out, not people. The guide, `check_app` and the deploy warning say so, and tell assistants to treat what arrives as untrusted input.
- "Anonymous visitors never write" is no longer an invariant of the server but the default. Code that reasons about who can create documents must consider `appendRule` and the ingest route; code that needs the rules of a version must take them from `effectiveRules`, which adds the default for endpoint collections.
- An instance can take up to `LAGER_INGEST_QUOTA_MB` on disk beyond its quota, and a snapshot can be as large as both together. `usage` of an instance leaves received documents out; `ingestUsage` reports them.
- Changing `LAGER_SECRET` replaces every ingest token, as it ends every session.
- The request limits, the daily counts and the visitor key live in memory: they start again with the server, and several Lager processes would not share them (0002).
- When trust levels for publishing arrive (#7), `auth: "none"` endpoints and `anyone` rules are the natural things to hold to them on servers with open registration. Today only administrators and publishers can deploy, so only they can declare either.
