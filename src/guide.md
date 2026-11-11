Lager is a self-hosted server for Claude artifacts: every app gets its own subdomain, numbered versions with rollback, and durable data storage per instance.
Build the artifact exactly like a Claude artifact: a single HTML file, with scripts and styles inline or from a CDN.
Keep durable data only through `const db = await claude.use("db")` – never `localStorage`, `sessionStorage` or `indexedDB`, which are lost when the device changes.
Information about the user comes from `await claude.use("user")`.
When deploying, pass the `capabilities` the artifact uses, usually `{"db": {}, "user": {}}`.
Deploy with the `deploy_app` tool (slug, html, title, capabilities, note) instead of publishing a claude.ai artifact.
When you deploy a new app, always pass `icon_svg`, `description` and `theme_color` too (rules: section "Icon and home screen" in `get_guide`).
If you have a shell and a `LAGER_TOKEN`, upload the file directly instead of sending its content as an argument:
`curl -X PUT -H "Authorization: Bearer $LAGER_TOKEN" -H "Content-Type: text/html" --data-binary @index.html "<Lager-address>/api/apps/<slug>?title=...&capabilities=..."`
Afterwards tell the user the URL that comes back and every warning in `warnings`.
Sharing: the same instance with `share_instance` (shared data) or a separate instance with `create_instance` (separate data); the section "Sharing and instances" in `get_guide` explains the difference.
To move an existing claude.ai artifact here: first `check_artifact` (best effort: it sees only `claude.use("…")` calls written with a string literal), then follow the section "Moving existing artifacts" in `get_guide`.
Details (rules, limits, versions, instances, pre-filling data): the `get_guide` tool.

---

# Lager – guide for Claude

## Capabilities

`window.claude.use(name)` returns a promise for a namespace or `null` and never throws. A namespace appears only when the active version declares it in `capabilities`; names Lager does not know always return `null`. So declare every namespace you use and check the result for `null`; `check_artifact` shows what is missing before the deploy.

- `db` (`{"db": {}}`, rules in `db.rules`) – document database following the contract of Claude artifacts: `db.collection("tasks")`, `db.doc("tasks/t1")`, `get/set/update/delete/add`, `where/orderBy/limit`, `onSnapshot` (live updates), `acquire` (lock with an expiry). `null` without an access level on the instance.
- `user` (`{"user": {}}`) – `id`, `name`, `email` (only with `user: {scopes: ["email"]}`), `isOwner`, `canEdit`, `can`, `me`, `profiles`, `search`, `avatarUrl`. `search` needs `user: {scopes: ["profile"]}`. Every member of `user` is an asynchronous function, `name` too: `const name = await user.name();`.
- `permissions` (no declaration needed) – `state`, `request`, `manage`; shows the available namespaces as granted and everything else as `unavailable`.
- `assets` (`{"assets": {}}`) – `upload(blob, {type?})`, `list()`, `delete(idOrUrl)`; files live at `/_blob/<id>` and count toward the instance's storage. Managers and owners may upload; with `{"assets": {"upload": "interact"}}` contributors may too. Otherwise `null`. Limits: 20 MiB per file (CSS and JavaScript 16 MiB, SVG 2 MiB), at most 2000 files per instance; allowed are images, video, audio, PDF, fonts, CSS, JavaScript, CSV, Markdown, JSON and text.
- `room` (`{"room": {}}`, optionally `{"topics": {"<topic>": "interact"}}`) – ephemeral rooms with messages and presence, in memory only, without history: `room.join(name)` returns a room object with `emit(topic, data)`, `on(topic, handler)`, `presence(patch)`, `peers()`, `onPeers`, `connected`, `onConnection`, `leave()`. Managers and owners may send on any topic, contributors only on topics declared with `"interact"`; viewers only listen. `null` without an access level. Limits: room name `^[a-z0-9][a-z0-9_.-]{0,47}$`, topic `^[a-z][a-z0-9_.-]{0,47}$`, message at most 4 KiB of JSON and 8 levels deep, presence at most 2 KiB, at most 16 named rooms per page.
- `artifact` or `self` (equivalent; `{"artifact": {}}`, disabled with `{"publish": false}`) – the page saves itself: `artifact.publish(html)` (a complete document that starts with `<!doctype html`) creates a new version that belongs to this instance only and is active there at once. Only managers and owners may save; at most 16 MiB, 60 saves per hour and instance, the last 20 saved versions are kept (older ones are deleted). The instance then stops following deploys until `set_auto_update` turns that back on. `publish` with several files, as well as `edit`, `sync` and `metadata`, reject with an error code. `null` means the declaration is missing.
- `downloads` (`{"downloads": {}}`) – `downloads.save({filename, data})` offers the viewer a file to save after they confirm. Allowed extensions: gif, png, jpg, jpeg, webp, mp4, webm, mov, txt, json, md, docx, pptx, epub, csv, ttf, html, svg, pdf, xlsx, zip, fig; at most 50 MiB.
- Everything else (for example `sample`, `tts`) returns `null`. Build the artifact so that it works without these namespaces: check for `null` and hide the feature.

`window.claude.complete` does not exist; the call rejects with an error.

## Database access rules

Levels: `view < interact < admin < owner`, plus `self` (nobody holds it by themselves). Who reaches what: the instance owner → `owner`; whoever holds a level through a share (`share_instance`, individually or via a group) → that level, the highest one if there are several ways; with visibility `users` every signed-in user → the level for signed-in users (default `interact`, see `list_shares`); with `public` anonymous visitors too → `view`.

Without rules: read from `view`, write from `interact`. Anonymous visitors never write.

Rules live in `capabilities.db.rules` as `{path, read?, write?}` and set minimum levels per path prefix. The most specific matching rule wins. The segment `{self}` matches only the viewer's own ID.

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

`data/users/<id>/…` always belongs to user `<id>` alone – reading and writing, not even for the owner, and rules cannot loosen that. Private settings and drafts live there.

## Limits

- Path: at most 16 segments and 1000 bytes in total, each segment at most 200 bytes, no empty segments.
- Document paths have an even number of segments (`tasks/t1`), collection paths an odd number (`tasks`).
- Document: at most 256 KiB as JSON and 32 levels deep; numbers must be finite.
- Queries: at most 1000 results.
- HTML: at most 16 MiB.
- Import: REST at most 20 MiB (a JSON array 5 MiB) and 100000 documents per call, one import per instance at a time; `import_data` at most 1000 documents. Export: `export_data` returns 200 documents by default, at most 1000, and may stop earlier (it also stops at about 8 MiB): when `truncated` is true there is more, so narrow `prefix` and ask again. Both follow the app's rules at your level; the owner is unrestricted.

## Versions and rollback

Every deploy with changed content or changed capabilities creates the next version and activates it on all instances with automatic updates. Identical content creates no new version (`createdVersion: false`).

- `get_app {slug}` shows all versions and instances.
- `activate_version {instance, version}` activates any existing version – backwards and forwards.
- `set_auto_update {instance, on}` switches whether the instance follows new deploys; switching it on moves the instance to the latest deployed version at once.
- Before every version change Lager automatically takes a snapshot of the instance's data. `list_snapshots {instance}` shows them, `restore_snapshot {instance, snapshot}` restores one (the current state is saved first).

Data belongs to the instance, never to the version: new code must cope with the existing data. Change data formats in a backward-compatible way (read missing fields with default values).

## Icon and home screen

Every app has an icon, and every app can be added to a phone's home screen. Pass these three arguments of `deploy_app` when you deploy a new app (`set_app_icon` changes them later; on REST: `icon_svg` in the JSON body of `PUT /api/apps/<slug>`, `description` and `theme_color` in the query or the JSON body, `PUT /api/apps/<slug>/icon` with `Content-Type: image/svg+xml`, `PATCH /api/apps/<slug>` with `{description, theme_color}`):

- `icon_svg`: the icon as SVG. The root must be `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">` (the `xmlns` attribute is required; the viewBox must be square; `width` and `height`, if you give them, must be equal plain numbers). A filled background that covers the whole square (phones crop the icon to their own shape, so keep the motif away from the edges). One bold, simple motif that stays legible at 48 px. Two or three colours. Only these elements are allowed: `svg` (root only), `g`, `defs`, `path`, `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon`, `linearGradient`, `radialGradient`, `stop`, `clipPath`, `mask`, `use`, `symbol`, `title`, `desc`. Filters, patterns, markers, `<style>`, text, images, links, animation and a nested `<svg>` are not allowed (the renderer has no fonts: draw letters as paths), and neither are scripts, `on…` attributes, `filter`, `stroke-dasharray`, a `stroke-width` below 0.01, DOCTYPE or entities. `href` and `url()` may only point to `#id` inside the icon. At most 64 KiB, 2000 elements and 32 levels of nesting. In short: filters, patterns, text and nested svg are not allowed. Example:

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
- Levels: `view` (viewer: look), `interact` (contributor: also write data, as far as the app's rules allow), `admin` (manager: additionally manage shares, versions, visibility and data). `owner` cannot be granted; the owner also creates and deletes the instance.
- `set_visibility {instance, visibility}`: `private` (only the owner and people it is shared with), `users` (all signed-in users) or `public` (no sign-in).
- The account must exist. Whoever has none must be invited by the administrator; tell the user that instead of inventing a share.

**A separate instance – separate data** (everyone should have their own copy, such as a training diary per person):
- `create_instance {app, slug, visibility?, owner_email?}` creates another instance with its own subdomain and its own data. With `owner_email` it belongs to the account with that address (only for those who may deploy the app); without, it belongs to the caller. For users without deploy rights it works only if the app's owner has allowed self-service; otherwise Lager answers `forbidden`.
- From a shell: `GET|PUT|DELETE /api/instances/<slug>/grants` (body `{email|group, level}`) and `POST /api/apps/<slug>/instances` (body `{slug, ownerEmail?, visibility?}`) with the same bearer token.

**Custom domain:** `add_domain {instance, host}` and `remove_domain {instance, host}` let an instance also answer on a hostname of its own (from a shell `GET|PUT|DELETE /api/instances/<slug>/domains`, body `{host}`). Administrators may do this for any instance, and publishers who manage the instance only if the administrator has allowed it; otherwise Lager answers `forbidden`. At most 10 domains per instance. The user sets up DNS, proxy entry and certificate themselves; Lager does not check who owns the domain. The first URL stays the address under the apps domain.

An instance's storage is limited (default 50 MB). When it is full, writes are rejected with the error code `quota_exceeded`; then delete data or tell the user. `db_write` runs the operations one after another; if one fails midway, the error message says how many were applied before.

`user.search(q)` in the artifact (person picker, `@` mention) finds the owner and the people the instance is shared with, and needs `user: {scopes: ["profile"]}`; at most 8 results, `[]` without the scope or without a sign-in. Store only the `id`, never the name; email addresses come only with the additional scope `"email"`.

## Pre-filling data

Do not hard-code starter and sample data into the HTML; create it after the deploy with `db_write`:

```json
{"instance": "todo", "ops": [
  {"op": "set", "path": "tasks/t1", "data": {"title": "First task", "done": false}},
  {"op": "update", "path": "settings/main", "data": {"theme": "light"}}
]}
```

`import_data` writes more documents at once (migration, backup), see below. At most 100 operations per call (`set` replaces, `update` merges, `delete` deletes). `db_read {instance, path, where?, orderBy?, limit?}` reads a document (`{doc}`) or a collection (`{docs}`). Both act with your own level on the instance: the owner without the app's rules, a manager according to the app's rules (rules that require `owner` stay closed to them). Other users' private areas always stay locked.

## Compatibility with `window.storage`

Artifacts from the claude.ai chat that use `window.storage.get/set/delete/list(key | prefix, shared)` keep working: with `shared = true` the values land in the collection `kv` (for all viewers of the instance), otherwise under `data/users/<id>/storage/kv/<key>` (for the viewer only); shared values live under `kv/<key>`. Values are strings. Deleting a document does not take its sub-collections with it: `delete` removes only the document itself. For new artifacts `claude.use("db")` is the better choice.

## Moving existing artifacts

An existing artifact (from the claude.ai chat or from elsewhere) moves like this:

1. **Read the source.** Get the complete HTML of the existing artifact. For an earlier Lager version the user downloads it under "HTML" in the version list (`GET /api/apps/<slug>/versions/<n>`).
2. **Check.** `check_artifact {html, capabilities?}` (or `POST /api/check`) is best effort: it finds only `claude.use("…")` calls with a string literal as the name (not `claude.use(name)`), so read the code yourself as well. It names `used` (namespaces used), `unsupported` (namespaces Lager does not offer, which return `null`), `undeclared` (used but not declared) and `warnings` (browser storage, `claude.complete`).
3. **Replace.** Rework everything `unsupported` names: check for `null` and hide the feature or replace it. `localStorage`, `sessionStorage` and `indexedDB` switch to `claude.use("db")`; `window.storage` keeps working unchanged (see above), `claude.complete` does not exist. Tell the user which features are lost as a result.
4. **Declare.** Enter every namespace used in `capabilities` (`db`, `user`, `assets`, `room`, `artifact`, `downloads`; `permissions` needs nothing), with rules and scopes. Check again with `check_artifact` until `undeclared` and `unsupported` are empty.
5. **Deploy.** `deploy_app`; tell the user the URL and all warnings.
6. **Transfer the data.** Read the data with the means of the old environment and write it with `import_data {instance, docs: [{path, data}]}` (at most 1000 documents per call, repeatable in parts; existing documents are replaced). From a shell, `POST /api/instances/<slug>/import` works with a body of `application/x-ndjson` (one line `{"path":…,"data":…}` per document) or a JSON array. If the data lives only in the user's browser, build a one-off "Export data" button into the old artifact that saves the data as a file, and import that file through the REST interface. An export from Lager: `export_data {instance, prefix?, limit?}` (check `truncated`: it may stop early) or `GET /api/instances/<slug>/export` (NDJSON, complete, also as the link "Export data (NDJSON)" on the instance page).
7. **Verify.** Open the instance, spot-check with `db_read` or `export_data`, and ask the user to try the most important workflows.

Limits: other users' private areas (`data/users/<id>/…`) can be neither imported nor exported; only your own can be written. Uploaded files do not move with it: upload them again through the app (`assets.upload`) and replace the references. An import replaces documents with the same path but deletes no others. Lager takes no snapshot before an import; back up existing data first with `export_data` if needed.
