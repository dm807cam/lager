---
name: lager
description: Use this skill when the user wants an artifact, a small app or a tool built and a Lager connector is available. The result is published on their own Lager server with durable data storage instead of as a chat artifact.
---

Lager is a self-hosted server for small web apps that you build for the user: every app gets its own subdomain, numbered versions with rollback, and durable data storage per instance.
Build each app as one self-contained HTML file, with scripts and styles inline or from a CDN. It reaches Lager only through the `window.lager` runtime, which Lager injects into every page.
Keep durable data only through `const db = await lager.use("db")` – never `localStorage`, `sessionStorage` or `indexedDB`, which are lost when the device changes.
Information about the user comes from `await lager.use("user")`.
When deploying, pass the `capabilities` the app uses, usually `{"db": {}, "user": {}}`.
Deploy with the `deploy_app` tool (slug, html, title, capabilities, note); do not hand the user a file or a chat preview instead.
When you deploy a new app, always pass `icon_svg`, `description` and `theme_color` too (rules: section "Icon and home screen" in `get_guide`).
If you have a shell and a `LAGER_TOKEN`, upload the file directly instead of sending its content as an argument:
`curl -X PUT -H "Authorization: Bearer $LAGER_TOKEN" -H "Content-Type: text/html" --data-binary @index.html "<Lager-address>/api/apps/<slug>?title=...&capabilities=..."`
Afterwards tell the user the URL that comes back and every warning in `warnings`.
Sharing: the same instance with `share_instance` (shared data) or a separate instance with `create_instance` (separate data); the section "Sharing and instances" in `get_guide` explains the difference.
To move an app from elsewhere (for example a claude.ai artifact): first `check_app`, which also flags APIs of other hosts that need converting, then follow the section "Moving existing apps" in `get_guide`.
To change an app that already exists (also one from an earlier conversation), first fetch its code with `get_version` and edit that; redeploy with the capabilities it returns, or send only the changed pieces with `edit_version`.
Before your first app, read the `get_guide` tool: the runtime API with a complete example, rules, limits, versions, instances, pre-filling data.

---

# Lager – guide for building apps

## Capabilities

`window.lager.use(name)` returns a promise for a namespace or `null` and never throws. `db` is there for every viewer with an access level and `user` for every viewer; declaring them adds rules and scopes. Every other namespace appears only when the active version declares it in `capabilities`, and names Lager does not know always return `null`. Declare every namespace you use, check the result for `null`, and run `check_app` before the deploy: it shows what is missing.

- `db` (`{"db": {}}`, rules in `db.rules`) – document database with live updates (signatures under "Runtime API" below): `db.collection("tasks")`, `db.doc("tasks/t1")`, `get/set/update/delete/add`, `where/orderBy/limit`, `onSnapshot` (live updates), `acquire` (lock with an expiry). `null` without an access level on the instance. `{"db": {"offline": false}}` stops the app from opening without a connection (see "Without a connection" below).
- `user` (`{"user": {}}`) – `id`, `name`, `email` (only with `user: {scopes: ["email"]}`), `isOwner`, `canEdit`, `can`, `me`, `profiles`, `search`, `avatarUrl`. `search` needs `user: {scopes: ["profile"]}`. Every member of `user` is an asynchronous function, `name` too: `const name = await user.name();`.
- `permissions` (no declaration needed) – `state`, `request`, `manage`; shows the available namespaces as granted and everything else as `unavailable`.
- `assets` (`{"assets": {}}`) – `upload(blob, {type?})`, `list()`, `delete(idOrUrl)`; files live at `/_blob/<id>` and count toward the instance's storage. Managers and owners may upload; with `{"assets": {"upload": "interact"}}` contributors may too. Otherwise `null`. Limits: 20 MiB per file (CSS and JavaScript 16 MiB, SVG 2 MiB), at most 2000 files per instance; allowed are images, video, audio, PDF, fonts, CSS, JavaScript, CSV, Markdown, JSON and text.
- `room` (`{"room": {}}`, optionally `{"topics": {"<topic>": "interact"}}`) – ephemeral rooms with messages and presence, in memory only, without history: `room.join(name)` returns a room object with `emit(topic, data)`, `on(topic, handler)`, `presence(patch)`, `peers()`, `onPeers`, `connected`, `onConnection`, `leave()`. Managers and owners may send on any topic, contributors only on topics declared with `"interact"`; viewers only listen. `null` without an access level. Limits: room name `^[a-z0-9][a-z0-9_.-]{0,47}$`, topic `^[a-z][a-z0-9_.-]{0,47}$`, message at most 4 KiB of JSON and 8 levels deep, presence at most 2 KiB, at most 7 named rooms per page (each room is a connection, and a viewer may hold 8 per instance, the lobby included, across all open tabs).
- `page` (`{"page": {}}`, disabled with `{"publish": false}`) – the page saves itself: `page.publish(html)` (a complete document that starts with `<!doctype html`) creates a new version that belongs to this instance only and is active there at once. Only managers and owners may save; at most 16 MiB, 60 saves per hour and instance, the last 20 saved versions are kept (older ones are deleted). The instance then stops following deploys until `set_auto_update` turns that back on. `publish` resolves `{version}` or rejects with `{code, message}` (`not_writer`, `not_granted`, `not_declared` when the active version no longer declares `page`, `conflict` when another view saved first, `too_large`, `rate_limited`, `invalid_content`, `upstream_error` for network or server failures). `null` means the declaration is missing.
- `downloads` (`{"downloads": {}}`) – `downloads.save({filename, data})` offers the viewer a file to save after they confirm. Allowed extensions: gif, png, jpg, jpeg, webp, mp4, webm, mov, txt, json, md, docx, pptx, epub, csv, ttf, html, svg, pdf, xlsx, zip, fig; at most 50 MiB.
- `ingest` (`{"ingest": {"endpoints": [...]}}`) – the instance takes data from outside: another website, a webhook, a script, a phone shortcut, a sensor. Each endpoint only adds JSON documents to one collection (section "Receiving data from outside"). `ingest.endpoints()` resolves `[{name, url, auth, collection, origins, managedOrigins, instanceOrigins, maxBytes, enabled, token, canManage}]`, so the page can show its owner what to paste where; `canManage` is `true` for managers and owners, and only for them is `token` a string (it is `null` for everyone else). `ingest.setOrigins(name, origins)` lets managers and owners name their own websites for an endpoint that declares `managedOrigins: true`. `null` without the declaration.
- `embed` (`{"embed": {}}`) – other websites may show the instance in a frame, for example a comment box or a poll on the owner's blog (section "Showing the app on other websites"). The declaration names no websites: the people who manage each instance add them on the instance page. `embed.get()` resolves `{origins, active, limit, canManage, manageUrl}`; `embed.setOrigins(origins)` takes a list that only removes websites. Only managers and owners see the list, everyone else gets empty lists. `null` without the declaration.
- Every other name returns `null`. Build the app so that it works without a namespace it cannot get: check for `null` and hide the feature.

`window.lager.complete(prompt, options?)` asks a language model the server's administrator set up (Claude, OpenAI, OpenRouter, DeepSeek, Gemini, Mistral, Groq, Ollama or another OpenAI-compatible server; the administrator decides per person which model answers and how many requests per hour they get) and resolves the answer as a string. Declare it with `{"complete": {}}`. Pick the model by the task: `list_models` shows the models you may choose (their names, what each is good for, and `isDefault` for the one every viewer gets otherwise). Declare one with `{"complete": {"model": "<name>"}}`: a fast, cheap one for short replies, sorting or extraction, a stronger one for long texts, reasoning or code. Leave `model` out when the default model is good enough. People whose AI group does not allow the chosen model get the default model of their group, and the app's owner can change the choice later (`set_app_model`). `prompt` is a string or a list of `{role: "user" | "assistant" | "system", content: string}` for a conversation; `options` may carry `system` (a system prompt), `maxTokens` (the administrator's limit always applies) and `full: true`, which makes it resolve `{text, model, stopReason, truncated}` instead of the bare string; `truncated` is `true` when the answer hit the length limit, so check it before parsing. A `<think>…</think>` block at the start of the answer (what reasoning models on OpenAI-compatible servers send) is removed from the text, and an unclosed one leaves it empty with `truncated: true`; other tags such as `<thinking>` are left alone. Only signed-in viewers with at least contributor access may call it; for guests and viewers the call rejects. It also rejects (an `Error` with `code`) when no model is set up or none is available to this person (`not_configured`), the app does not declare it (`not_declared`), the person sent too many requests this hour (`rate_limited`), the model declined (`refused`) or the provider failed (`provider_error`, `timeout`). So catch the error and show a short message instead of breaking the page. Which model answers can differ from viewer to viewer, so don't rely on the abilities of one particular model; ask for structured output in plain words and parse it defensively.

## Runtime API

Lager injects `window.lager` into every page before the page's own scripts run, so no import or script tag is needed. Never declare a variable, function or class named `lager` yourself: it hides the runtime (`check_app` warns about it). Everything below is asynchronous unless it says otherwise.

**`db`** (`const db = await lager.use("db")`):

- `db.collection(path)` returns a collection reference (odd number of segments, `tasks` or `lists/l1/items`); `db.doc(path)` a document reference (even number, `tasks/t1`). Both are synchronous and throw a `TypeError` for an invalid path.
- Collection reference: `.doc(id?)` (synchronous; without `id` a new random id), `.add(data)` resolves the new document reference, and the query methods below.
- Query (chainable, synchronous): `.where(field, op, value)` with `op` one of `==`, `!=`, `<`, `<=`, `>`, `>=`, `in`, `not-in`, `array-contains`, `array-contains-any` (`field` may be a dotted path such as `"author.id"`), `.orderBy(field, "asc" | "desc")`, `.limit(n)`. Then `.get()` resolves a query snapshot, or `.onSnapshot(next, error?)` listens.
- Document reference: `.id`, `.path`, `.get()` resolves a document snapshot, `.set(data)` replaces the document, `.update(data)` merges deeply into it (creating it if needed; it needs read access to the path too), `.delete()` removes it (not its sub-collections), `.collection(name)`, `.onSnapshot(next, error?)`, `.acquire({holder, ttlMs?, data?})` takes a lease (default 30 s, at most 300 s) and resolves `{acquired, version, expiresAt}`.
- Document snapshot: `.id`, `.exists`, `.data()` (the stored object, frozen; `undefined` when the document does not exist).
- Query snapshot: `.docs` (document snapshots), `.size`, `.empty`, `.docChanges()` (`[{type: "added" | "modified" | "removed", doc, oldIndex, newIndex}]`).
- `onSnapshot` calls `next` once right away with the current state and again after every change, including changes by other viewers, and returns a function that stops listening. It retries network and server failures by itself; any other error goes to `error` once and ends the listener. `get`, `set`, `update`, `delete`, `add` and `acquire` reject with an object `{code, message}`, where `code` is `not_granted` (the viewer's level does not allow it), `quota_exceeded`, `invalid_argument` or `unavailable` (network, server or too many requests; retry later). A query takes at most 10 `where` clauses, 5 `orderBy` fields and 30 values in an `in`, `not-in` or `array-contains-any` list; a signed-in viewer may make 600 reads and 300 writes per minute on an instance (guests share 600 reads per client address), so never poll in a tight loop: use `onSnapshot`, which reloads at most every 250 ms however fast changes arrive.
- Store plain JSON: strings, finite numbers, booleans, `null`, arrays and objects. Store times as `Date.now()` numbers or ISO strings, never `Date` objects.
- Without a connection: Lager keeps the page, the viewer's session and the scripts and stylesheets it loads (also from CDNs) on the device, so an app opened once opens again offline, and `lager.use("db")` and `lager.use("user")` still resolve with the last known viewer (offline, `user.email()` resolves `null`). Reads and writes need the server: `onSnapshot` waits and delivers the current state as soon as the connection is back, while `get`, `set`, `update`, `delete`, `add` and `acquire` reject with `unavailable`, so show that and let the viewer try again. Do not build a queue of your own in `localStorage` or `indexedDB`. Lager deletes what it kept as soon as the viewer has lost access. An app whose data would mislead when it is not current (a live quiz, bookings) declares `{"db": {"offline": false}}`.

**`user`** (`const user = await lager.use("user")`): every member is an async function. `await user.name()`, `await user.id()`, `await user.isOwner()`, `await user.canEdit()`; the rest is listed under "Capabilities" above.

**`lager.complete(prompt, options?)`**: see "Capabilities" above; always wrap it in `try`/`catch`.

A complete app with shared, live data, a guard for the missing capability, and error handling (deploy with `{"db": {}, "user": {}}`):

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Shared list</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem}li{display:flex;justify-content:space-between;padding:.4rem 0}</style>
</head>
<body>
<h1>Shared list</h1>
<p id="status"></p>
<form id="add"><input id="text" required placeholder="New item"> <button>Add</button></form>
<ul id="items"></ul>
<script>
(async () => {
  const status = document.getElementById("status");
  const db = await lager.use("db");
  const user = await lager.use("user");
  if (!db) { status.textContent = "Storage is not available."; document.getElementById("add").hidden = true; return; }
  const me = user ? await user.name() : "";
  const items = db.collection("items");
  items.orderBy("createdAt").onSnapshot((snap) => {
    document.getElementById("items").replaceChildren(...snap.docs.map((d) => {
      const li = document.createElement("li");
      li.textContent = d.data().text + (d.data().by ? " (" + d.data().by + ")" : "");
      const del = document.createElement("button");
      del.textContent = "Delete";
      del.onclick = () => items.doc(d.id).delete().catch((e) => { status.textContent = e.message; });
      li.append(del);
      return li;
    }));
  }, (e) => { status.textContent = e.message; });
  document.getElementById("add").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = document.getElementById("text");
    try {
      await items.add({ text: input.value, by: me, createdAt: Date.now() });
      input.value = "";
    } catch (err) { status.textContent = err.code === "not_granted" ? "You can only read this list." : err.message; }
  });
})();
</script>
</body>
</html>
```

## Database access rules

Levels: `view < interact < admin < owner`, plus `self` (nobody holds it by themselves). Who reaches what: the instance owner → `owner`; whoever holds a level through a share (`share_instance`, individually or via a group) → that level, the highest one if there are several ways; with visibility `users` every signed-in user → the level for signed-in users (default `interact`, see `list_shares`); with `public` anonymous visitors too → `view`.

Without rules: read from `view`, write from `interact`. Anonymous visitors never write, with one exception: under a rule with `"write": "anyone"` they add documents and do nothing else (section "Receiving data from outside").

Rules live in `capabilities.db.rules` as `{path, read?, write?}` and set minimum levels per path prefix. The most specific matching rule wins, separately for reading and for writing: a rule that sets only `write` leaves `read` to the next broader rule that sets it (and the other way round). The segment `{self}` matches only the viewer's own ID.

Example poll – everyone may write only their own vote, the owner may write all:

```json
{"db": {"rules": [
  {"path": "votes", "read": "view", "write": "owner"},
  {"path": "votes/{self}", "write": "interact"}
]}}
```

Example sign-off – everyone signs off only for themselves, and even the owner cannot sign for others:

```json
{"db": {"rules": [
  {"path": "signoffs", "read": "view", "write": "self"},
  {"path": "signoffs/{self}", "read": "view", "write": "interact"}
]}}
```

`data/users/<id>/…` always belongs to user `<id>` alone – reading and writing, not even for the owner, and rules cannot loosen that. Private settings and drafts live there. The user reads it from `view`; writing it always takes `interact`, also when a rule opens other paths to viewers, so a viewer cannot store anything there. Deleting one's own private documents works from `view`.

A path the viewer may write but not read (a drop box, for example `{"path": "inbox", "read": "admin", "write": "interact"}`) takes `set`, `add` and `delete` only. `update` and `acquire` reject with `not_granted` there, because they work on the stored document; write whole documents with `set` instead.

## Receiving data from outside

Two things let data in from people and machines without an account. Both only add documents: the server makes up the id, so nothing that exists can be read, overwritten or deleted that way. What arrives is kept apart from the instance's own data and has a quota of its own, the ingest quota (default 10 MB), so it never uses up the instance's storage. Everything that arrives is untrusted input: show it with `textContent`, never as HTML, check types and lengths before you use it, and never put a secret into a page that guests can open.

**Endpoints, for everything that is not the instance's own page:** a counting snippet on the user's blog, a form on their website, a webhook, a script, a phone shortcut, a sensor. Declare them, and ask the user for the address of their website instead of guessing it, or let them name it in the app (`managedOrigins`, below):

```json
{"db": {}, "user": {}, "ingest": {"endpoints": [
  {"name": "hits", "auth": "none", "origins": ["https://blog.example.com"], "visitor": "daily", "onFull": "rotate"},
  {"name": "weight", "auth": "token", "maxBytes": 2048}
]}}
```

- The sender posts one JSON object to `<address of the instance>/_ingest/<name>`. An accepted request answers `202` without a body. Refusals: `400` not one JSON object, `401` token missing or wrong, `403` origin not listed, `404` no such endpoint or switched off, `413` too large, `429` too many requests (wait as long as `Retry-After` says), `507` the ingest quota is full.
- `auth: "none"` is for web pages: only pages on the listed `origins` (scheme and host, no path, never `"*"`) may send. Browsers enforce that; a script can claim any origin, so such an endpoint keeps other websites out, not people. Send with `navigator.sendBeacon(url, JSON.stringify(data))` or `fetch(url, {method: "POST", body: JSON.stringify(data), keepalive: true})` and set no headers: a plain string body needs no preflight.
- `managedOrigins: true` is for apps whose users bring their own websites, such as an analytics dashboard that every owner points at their blog: `origins` may then stay empty, and the people who manage each instance add their websites, in the app with `ingest.setOrigins("hits", ["https://blog.example.com", "https://www.example.com"])` or on the instance page under "Data from outside". `setOrigins` replaces the instance's list and resolves the endpoint as `endpoints()` shows it; it rejects with `not_granted` for everyone but managers and owners and with `invalid_argument` for an address that is not scheme and host, or for a list that grows past 20 websites with the declared ones (a list that only removes websites is always taken). `"*"` cannot be added, and until a website is added an `auth: "none"` endpoint takes nothing. The added websites are the owner's own configuration: `endpoints()` shows them (in `origins` and `instanceOrigins`) only where `canManage` is `true`, and everyone else sees the declared websites alone, so show the settings form only where `canManage` is `true`. Prefer this to `auth: "token"` with `["*"]` for snippets on public pages: the token would be in every visitor's page source.
- `auth: "token"` is for everything else. The sender sets the header `Authorization: Bearer <token>`. Only where it cannot set a header, it adds `?key=<token>` to the address instead; proxies write addresses into their logs, so use the header wherever possible. Every instance has its own token per endpoint. Managers see and replace it on the instance page under "Data from outside", and the page gets it from `ingest.endpoints()` to show it to them (it is `null` for everyone else). `origins` is optional here; `["*"]` lets pages of any website send with the token.
- Fields: `name` (required; lowercase letters, digits, `-` and `_`), `auth` (required), `origins`, `managedOrigins` (`true` or `false`, the default), `collection` (default: the name), `maxBytes` (default 4096, at most 65536), `maxPerDay` (documents per UTC day, default 10000, at most 100000), `onFull` (`"refuse"`, the default, or `"rotate"`: when the ingest quota is full, the oldest received documents of this collection make room; right for streams such as page views, wrong for messages), `visitor: "daily"`, `country: true`. At most 8 endpoints; a field Lager does not know is refused.
- The server adds `_receivedAt` (ISO time) to every document. With `visitor: "daily"` it adds `_visitor`: the same for one visitor during one day, different the next day, and not traceable to a person, so unique visitors can be counted without cookies. With `country: true` it adds `_country` (two letters) if the server's operator set that up; otherwise the field is missing. A sender cannot set these three fields, and the client address is never stored.
- The collection of an endpoint is readable from `admin` (managers and the owner) unless a rule in `db.rules` sets `read` for that path or for a path above it; then that rule decides. Read it like any collection, for example `db.collection("hits").orderBy("_receivedAt", "desc").limit(1000).onSnapshot(...)`; live queries hear of new documents at most every 2 seconds.
- A received document stays a received document: whoever may write the path can `update`, `set` and `delete` it, but it keeps counting against the ingest quota until it is deleted, `rotate` may drop it, and it is not part of snapshots. An app that keeps data for long therefore copies what came in into documents of its own (daily totals, an approved list, each under a new path) and deletes the received ones.
- Per minute an instance takes 150 requests from one client address without a token, 600 per endpoint and 1200 in all.
- Endpoints work on private instances: the page stays private while the website sends. After the deploy tell the user the address of each endpoint and where the token is.
- On an instance whose owner neither owns nor maintains the app (one you created for someone else, or one a user created themselves), every endpoint starts switched off: its owner or a manager turns it on on the instance page under "Data from outside". Tell them so. `ingest.endpoints()` shows `enabled: false` until then, and the endpoint answers `404`.
- All endpoints and `anyone` rules of an instance share its ingest quota. One that strangers can fill (an endpoint without a token, an `anyone` rule) can leave the others without room until a manager deletes: do not put data you must not miss behind the same instance as an open guestbook.

**`"write": "anyone"`, for guests on the instance's own page:** an RSVP, a guestbook, a poll or a feedback button on a `public` instance. Such a rule lets every visitor who can open the instance add documents with `collection.add(data)`, signed in or not:

```json
{"db": {"rules": [{"path": "rsvps", "read": "admin", "write": "anyone"}]}}
```

- Only `add` works for them. Who may `set`, `update`, `delete` and `acquire` there is who may without this rule: the next broader rule that sets `write` decides, else contributors (`interact`) and above. So `[{"path": "forms", "write": "admin"}, {"path": "forms/inbox", "write": "anyone"}]` lets everyone add and only managers change. `anyone` is a level for `write` only.
- A visitor's document has at most 4096 bytes. All visitors together add at most 600 documents per minute and 10000 per day under one rule; beyond that `add` rejects with `unavailable`, and with `quota_exceeded` when the ingest quota is full.
- Choose `read` on purpose: `"admin"` keeps the answers to the managers (an RSVP list), `"view"` shows them to every visitor (a guestbook). Before you show visitors what other visitors wrote, consider letting a manager approve it.
- `user.can("data.write")` is `false` for these visitors. Call `add` and handle `not_granted`.

## Showing the app on other websites

Without `embed`, a browser shows an instance only on its own address: no other page can put it in a frame. An app that is meant to sit on somebody's website (comments under a blog post, a poll, a booking form) declares `{"embed": {}}`. The declaration carries no websites, and the app cannot add any: the people who manage each instance add them on the instance page under "Shown on other websites", and until they do nothing changes. `embed.get()` gives the app the list and `manageUrl`, the address of that page, so the app's settings can show which websites are open and send the owner there with a link. Ask the user for the address of their website instead of guessing it, and give them a snippet like this one to paste:

```html
<div id="comments"></div>
<script>
  var f = document.createElement("iframe");
  f.src = "https://comments.apps.example.com/?page=" + encodeURIComponent(location.pathname);
  f.title = "Comments";
  f.style.cssText = "width:100%;border:0;height:400px";
  document.getElementById("comments").appendChild(f);
</script>
```

- Inside a frame on another website the browser passes nobody's sign-in: every visitor is a guest there, the owner too. So the instance must be `public`, and guests write only where a `"write": "anyone"` rule lets them add. Keep moderation and settings on the app's own address (for example behind `?admin`), where the owner is signed in.
- A website is scheme and host, such as `https://myblog.example.org`; `https://www.myblog.example.org` is another one. At most 20 per instance. Refused are `*`, other instances, the apps domain, custom domains, the platform, and every website on the same domain as the server (there the browser would pass the visitor's sign-in into the frame).
- The frame is a page of its own. It can tell the embedding page its height with `window.parent.postMessage({height: …}, "*")`; the embedding page checks `event.source` before it uses the message. Take the page a frame belongs to from its URL, as above, not from `document.referrer`.
- `setOrigins` rejects with `{code, message}`: `not_granted` (also for a list that adds a website), `invalid_argument` or `unavailable`.

## Limits

- Path: at most 16 segments and 1000 bytes in total, each segment at most 200 bytes, no empty segments. A segment uses only letters, digits and `_ - . ~ : @ +`, and is not `.` or `..`. Turn other text (a name, a title, an email address) into such an id, for example by replacing everything else with `-`, and keep the original text as a field of the document.
- Document paths have an even number of segments (`tasks/t1`), collection paths an odd number (`tasks`).
- Document: at most 256 KiB as JSON and 32 levels deep; numbers must be finite.
- Queries: at most 1000 results.
- HTML: at most 16 MiB.
- `title`: at most 100 characters; `note`: at most 500; `description`: at most 200. Each is one line of plain text (line breaks become spaces); a longer one is refused.
- Slugs: lowercase letters, digits and hyphens, at most 63 characters. New apps and instances cannot take names such as `www`, `api`, `admin`, `login`, `auth`, `account`, `mail`, `static`, `assets`, `cdn`, `status`, `support` or `security` (`Slug "…" is reserved`): pick a more specific name.
- Deploys: at most 60 new versions per app and hour, and at most 60 new apps per person and hour, counted for `deploy_app` and the REST API together (a deploy with unchanged content creates no version and does not count). When a deploy is refused for that reason, tell the user and wait instead of retrying in a loop; test changes with `check_app` rather than with extra deploys.
- Data from outside: at most 8 endpoints per app, a request at most 65536 bytes, and the ingest quota of the instance (default 10 MB, apart from the storage) for everything that came in and was not deleted since; see "Receiving data from outside".
- Embedding: at most 20 websites per instance (`embed`).
- Import: REST at most 20 MiB (a JSON array 5 MiB) and 100000 documents per call, one import per instance at a time; `import_data` at most 1000 documents. Export: `export_data` returns 200 documents by default, at most 1000, and may stop earlier (it also stops at about 8 MiB): when `truncated` is true there is more, so narrow `prefix` and ask again. Both follow the app's rules at your level; the owner is unrestricted.

## Versions and rollback

Every deploy with changed content or changed capabilities creates the next version and activates it on all instances with automatic updates. Identical content creates no new version (`createdVersion: false`). An app keeps its newest 100 deployed versions; an older one is deleted for good, unless an instance still runs it.

- `get_app {slug}` shows all versions and instances.
- `get_version {app, version?}` returns the complete HTML of a version (default: the latest deployed one) together with its capabilities and the app's title; `get_version {instance}` returns the version active on that instance, which may be one the page saved itself (`savedByInstance`). Use it whenever you continue work on an existing app: never rebuild an app from memory or from its description. If `get_app` shows an instance whose `activeVersion` is not `latestVersion` (pinned, rolled back or saved by the page itself), ask the user which code to build on before you deploy: a deploy moves every instance that follows deploys to the new version. Redeploy the edited HTML with the same `capabilities` (or deliberately changed ones), because a deploy without `capabilities` declares none. A large app can be read in parts: pass `limit` (bytes, for example 40000; at least 1024) and call again with `offset` set to the `nextOffset` of the answer until `nextOffset` is `null`, then join the parts in order; pass `limit` whenever you do not know the size (`get_app` lists `sizeBytes` per version), since an app that fits comes back whole. After the first part, always continue with `{app, version}` from its answer – not `instance`, and never without `version` – so that every part comes from the same version even if someone deploys or the page saves itself meanwhile; if you can compute a SHA-256 (for example in a shell), the joined parts must match `sha256`, otherwise start over. Never deploy a part as the whole app. From a shell, `GET /api/apps/<slug>/versions/<n>` with the bearer token saves the HTML to a file instead.
- `edit_version {slug, base_version, edits: [{old_text, new_text}], note?, capabilities?}` changes an app without sending all of its HTML again: it replaces each `old_text` in the latest deployed version and deploys the result as a new version, keeping the capabilities of `base_version` unless you pass new ones. Prefer it to `deploy_app` for changes to a large app: retyping a long file lets small mistakes slip in. Copy every `old_text` exactly from `get_version`, with enough surrounding text that it occurs exactly once; the edits apply in order, and if one of them does not match exactly once nothing is deployed. `base_version` must be the latest deployed version, otherwise the answer is `conflict`: someone deployed since you read the code, so read it again.
- `activate_version {instance, version}` activates any existing version – backwards and forwards.
- `set_auto_update {instance, on}` switches whether the instance follows new deploys; switching it on moves the instance to the latest deployed version at once.
- Before every version change Lager automatically takes a snapshot of the instance's data. Version changes by `activate_version` or `set_auto_update` and restores together are limited to 10 per instance and hour (deploys are not counted); beyond that Lager answers `rate_limited`. `list_snapshots {instance}` shows them, `restore_snapshot {instance, snapshot}` restores one (the current state is saved first); only the owner of the instance may restore, because it rolls back all data, also what the rules keep from managers.

Data belongs to the instance, never to the version: new code must cope with the existing data. Change data formats in a backward-compatible way (read missing fields with default values).

## Icon and home screen

Every app has an icon, and every app can be added to a phone's home screen. Pass these three arguments of `deploy_app` when you deploy a new app (`set_app_icon` changes them later; on REST: `icon_svg` in the JSON body of `PUT /api/apps/<slug>`, `description` and `theme_color` in the query or the JSON body, `PUT /api/apps/<slug>/icon` with `Content-Type: image/svg+xml`, `PATCH /api/apps/<slug>` with `{description, theme_color}`):

- `icon_svg`: the icon as SVG, drawn from a small subset of SVG. The root must be `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">` (the `xmlns` attribute is required; the viewBox must be square; `width` and `height`, if you give them, must be equal plain numbers). Use a filled background that covers the whole square (phones crop the icon to their own shape, so keep the motif away from the edges), one bold simple motif that stays legible at 48 px, and two or three colours.
  - Allowed elements: `svg` (root only), `g`, `defs`, `linearGradient`, `radialGradient`, `stop`, `path`, `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon`, `title`, `desc`. No masks, clip paths, `use`, `symbol`, filters, patterns, markers, `<style>`, text, images, links, animation or a nested `<svg>` (the renderer has no fonts: draw letters as paths).
  - Allowed attributes: `xmlns`, `viewBox`, `width`, `height`, `id`, `d`, `x`, `y`, `x1`, `y1`, `x2`, `y2`, `cx`, `cy`, `r`, `rx`, `ry`, `fx`, `fy`, `points`, `fill`, `fill-opacity`, `fill-rule`, `stroke`, `stroke-width`, `stroke-linecap`, `stroke-linejoin`, `stroke-miterlimit`, `stroke-opacity`, `opacity`, `transform`, `gradientUnits`, `gradientTransform`, `spreadMethod`, `offset`, `stop-color`, `stop-opacity`. Nothing else: no `style`, `class`, `href`, `mask`, `clip-path`, `filter` or `on…` attributes, so write colours as attributes (`fill="#336699"`), not as CSS.
  - `fill` and `stroke` take a colour (`#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb(…)`, `rgba(…)`, a colour name, `none`, `currentColor`) or `url(#id)` where `id` is a `linearGradient` or `radialGradient` of the icon. Gradients are the only references that exist.
  - Plain numbers only: every number (attributes, `points`, `transform` arguments, path data) is finite, at most 100000 in absolute value and at most 20 characters; `stroke-width` 0 to 1000, `stroke-miterlimit` at most 100, opacities 0 to 1; `d` at most 20000 characters; `transform` only `translate`, `scale`, `rotate`, `skewX`, `skewY`, `matrix`.
  - Limits: 64 KiB, 500 elements, 16 levels of nesting, 64 gradients with at most 32 stops each.
  In short: filters, patterns, text and nested svg are not allowed, and neither are masks, clip paths, `use` and styles. Example:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2b3a8c"/><stop offset="1" stop-color="#1f2a5c"/></linearGradient></defs>
  <rect width="512" height="512" fill="url(#bg)"/>
  <circle cx="256" cy="256" r="120" fill="#f58220"/>
  <path d="M206 256l36 36 70-80" fill="none" stroke="#ffffff" stroke-width="28" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
```
- `theme_color`: a hex colour such as `#1f2a5c` that matches the icon's background. It colours the status bar and the start screen of the installed app.
- `description`: one plain sentence (at most 200 characters) saying what the app does.

Without `icon_svg` a new app gets a generated icon and the result carries a warning; a redeploy without it leaves the icon as it is. An icon that is refused never fails a deploy: the previous (or generated) icon stays and the reason is in `warnings`; `set_app_icon` returns an error instead. Tell the user about such a warning.

To install: the user opens the app on the phone and chooses "Add to Home Screen" (in the browser menu or the share sheet). The first time, signing in happens in the browser; the installed app then opens like any other app.

## Sharing and instances

The first deploy creates the default instance with the slug of the app (visibility `private`). Instance slugs are globally unique. There are two ways to share; choose by asking whether the people involved should see the same data.

**The same instance – shared data** (poll, family list, team board):
- `share_instance {instance, email? | group?, level}` gives an account (email) or a group (name) access or changes the level; exactly one of `email` and `group`. `unshare_instance {instance, email? | group?}` takes the access back, `list_shares {instance}` shows shares, `visibility` and `usersLevel`.
- Levels: `view` (viewer: look), `interact` (contributor: also write data, as far as the app's rules allow), `admin` (manager: additionally manage shares, versions, visibility and data). `owner` cannot be granted; the owner also creates and deletes the instance and restores snapshots.
- `set_visibility {instance, visibility}`: `private` (only the owner and people it is shared with), `users` (all signed-in users) or `public` (no sign-in).
- The account must exist. Whoever has none must be invited by the administrator; tell the user that instead of inventing a share.

**A separate instance – separate data** (everyone should have their own copy, such as a training diary per person):
- `create_instance {app, slug, visibility?, owner_email?}` creates another instance with its own subdomain and its own data. With `owner_email` it belongs to the account with that address (only for those who may deploy the app); without, it belongs to the caller. Unless you are an administrator, you can create at most 5 instances a day for other accounts, and none for an account that already owns half of the instances it may have: Lager answers `conflict`, and that person creates the instance themselves or an administrator does. For users without deploy rights it works only if the app's owner has allowed self-service; otherwise Lager answers `forbidden`.
- From a shell: `GET|PUT|DELETE /api/instances/<slug>/grants` (body `{email|group, level}`) and `POST /api/apps/<slug>/instances` (body `{slug, ownerEmail?, visibility?}`) with the same bearer token.

**Custom domain:** `add_domain {instance, host}` and `remove_domain {instance, host}` let an instance also answer on a hostname of its own (from a shell `GET|PUT|DELETE /api/instances/<slug>/domains`, body `{host}`). Administrators may do this for any instance, and publishers who manage the instance only if the administrator has allowed it; otherwise Lager answers `forbidden`. At most 10 domains per instance. The user sets up DNS, proxy entry and certificate themselves; Lager does not check who owns the domain. The first URL stays the address under the apps domain.

An instance's storage is limited (default 50 MB). When it is full, writes are rejected with the error code `quota_exceeded`; then delete data or tell the user. `db_write` runs the operations one after another; if one fails midway, the error message says how many were applied before.

`user.search(q)` in the app (person picker, `@` mention) finds the owner and the people the instance is shared with, and needs `user: {scopes: ["profile"]}`; at most 8 results, `[]` without the scope or without a sign-in. Store only the `id`, never the name; email addresses come only with the additional scope `"email"`. `user.profiles(ids)` resolves an id only for people this instance knows: the viewer, the owner, the people it is shared with, everyone who ever wrote one of its documents (outside the private areas) and whoever is in one of its rooms right now. Every other id stays unknown, like one that does not exist.

## Pre-filling data

Do not hard-code starter and sample data into the HTML; create it after the deploy with `db_write`:

```json
{"instance": "todo", "ops": [
  {"op": "set", "path": "tasks/t1", "data": {"title": "First task", "done": false}},
  {"op": "update", "path": "settings/main", "data": {"theme": "light"}}
]}
```

`import_data` writes more documents at once (migration, backup), see below. At most 100 operations per call (`set` replaces, `update` merges, `delete` deletes). `db_read {instance, path, where?, orderBy?, limit?}` reads a document (`{doc}`) or a collection (`{docs}`). Both act with your own level on the instance: the owner without the app's rules, a manager according to the app's rules (rules that require `owner` stay closed to them). Other users' private areas always stay locked.

## Moving existing apps

An app from elsewhere (a claude.ai artifact, an HTML file the user has, an app on another Lager server) moves like this:

1. **Read the source.** Get the complete HTML. For a version already on Lager use `get_version {app, version?}` (or, from a shell, `GET /api/apps/<slug>/versions/<n>`; the user finds it under "HTML" in the version list).
2. **Check.** `check_app {html, capabilities?}` (or `POST /api/check`) names `used` (namespaces reached through `lager.use("…")`), `unsupported` (namespaces Lager does not offer, which return `null`), `undeclared` (used but not declared) and `warnings` (browser storage, APIs of other hosts, `lager.complete`). It is best effort: it finds only calls with a string literal as the name, so read the code yourself as well.
3. **Convert.** Apps written for claude.ai call `window.claude` and `window.storage`, which do not exist on Lager:
   - `window.claude.use(…)` and `window.claude.complete(…)` (also written `claude.use(…)` and `claude.complete(…)`) become `lager.use(…)` and `lager.complete(…)`; the arguments stay the same. The one exception: `claude.use("artifact")` and `claude.use("self")`, the namespace that lets a page save itself, become `lager.use("page")`, declared as `{"page": {}}`.
   - `window.storage.get/set/delete/list(key, shared)` becomes documents in `lager.use("db")`: shared values in a collection everyone reads (for example `kv`), personal values under `data/users/<user id>/…`, which only that user can read and write (writing takes the level `interact`). Storage keys are free text, so do not use them as document ids directly (see the path rules under "Limits"): derive an id from them and store the key itself as a field, for example `{key, value}`. `list(prefix)` becomes a query over that collection.
   - `localStorage`, `sessionStorage` and `indexedDB` become `lager.use("db")` as well.
   - For everything `unsupported` names: check for `null` and hide the feature or replace it. Tell the user which features are lost.
4. **Declare.** Enter every namespace used in `capabilities` (`db`, `user`, `assets`, `room`, `page`, `downloads`, `ingest`, and `complete` for `lager.complete`; `permissions` needs nothing), with rules and scopes. Check again with `check_app` until `undeclared`, `unsupported` and the conversion warnings are gone.
5. **Deploy.** `deploy_app`; tell the user the URL and all warnings.
6. **Transfer the data.** Read the data with the means of the old environment and write it with `import_data {instance, docs: [{path, data}]}` (at most 1000 documents per call, repeatable in parts; existing documents are replaced). From a shell, `POST /api/instances/<slug>/import` works with a body of `application/x-ndjson` (one line `{"path":…,"data":…}` per document) or a JSON array. If the data lives only in the user's browser, build a one-off "Export data" button into the old app that saves the data as a file, and import that file through the REST interface. An export from Lager: `export_data {instance, prefix?, limit?}` (check `truncated`: it may stop early) or `GET /api/instances/<slug>/export` (NDJSON, complete, also as the link "Export data (NDJSON)" on the instance page).
7. **Verify.** Open the instance, spot-check with `db_read` or `export_data`, and ask the user to try the most important workflows.

Limits: other users' private areas (`data/users/<id>/…`) can be neither imported nor exported; only your own can be written. Uploaded files do not move with it: upload them again through the app (`assets.upload`) and replace the references. An import replaces documents with the same path but deletes no others. Lager takes no snapshot before an import; back up existing data first with `export_data` if needed.
