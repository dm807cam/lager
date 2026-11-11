# Lager Stage 3 (Expansion) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the remaining artifact runtime capabilities that can be self-hosted (`assets`, `room`, `artifact`, `downloads`), custom domains per instance, data and code export/import, and tooling for moving existing artifacts onto Lager.

**Architecture:** Each capability is a small server module under `src/data` or `src/platform` plus routes on the instance router (`src/http/instance-*.ts`) and a namespace in the browser runtime (`src/runtime/runtime.js`). Custom domains extend host dispatch and the sign-in handshake. Export, import and artifact checking reuse the existing REST and MCP layers.

**Tech Stack:** unchanged (Node ≥ 22.13, TypeScript strict ESM, Express 5, `node:sqlite`, MCP SDK, zod, Vitest, Supertest, jsdom, nodemailer). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-11-lager-stage3-design.md` (German; binding). Stage 1 and 2 specs and code remain in force where Stage 3 does not change them.

## Global Constraints

- All Stage 1 and Stage 2 constraints still apply: strict TypeScript ESM with `.js` import suffixes; `npm test` and `npm run typecheck` pass before every commit; tests use fresh temp dirs and ephemeral ports; domain errors are `LagerError`; JSON error bodies are `{"error":{"code","message"}}`; user-facing text German, code/comments/commits English; secrets only as hashes; never commit `node_modules`, `dist`, `data`, `.env`, `.superpowers`, `.claude`.
- No new runtime or dev dependencies.
- All existing tests keep passing. Where Stage 3 deliberately changes behaviour, update the affected test and name it in the report; do not delete coverage.
- Authorization is decided only through `core.access` or a platform-role check; no route compares `ownerId`.
- Every state-changing instance route (`/__lager/*`) requires the header `X-Lager-Request: 1`; every state-changing HTML form checks `csrf`; REST keeps the bearer-or-cookie-plus-header rule.
- The browser contract is the Claude artifact runtime. Its type definitions are the authority for shapes, member names and error codes of each capability; read the relevant file before coding and do not copy the files or their comment text into the repository: `/private/tmp/claude-501/bundled-skills/2.1.321/b67091c188ad831055cdc8d5cb834423/artifact-capabilities/0.2.96/{assets,room,artifact,self,downloads,claude}.d.ts`. Members of a capability that Lager cannot support (multi-file publishing, messages to Claude, consent flows) must reject or no-op with the contract's own error code for "not available" rather than be missing.
- `src/runtime/runtime.js` stays one plain ES2020 IIFE without imports; `claude.use()` never throws and resolves `null` for capabilities the instance cannot serve.
- Capability availability follows the app's declaration: a namespace resolves only when the active version's `capabilities` declares it (`assets`, `room`, `artifact` or `self`, `downloads`), mirroring how `db` and `user` behave today.
- Uploaded or user-supplied bytes are never served as `text/html`; every response carrying user content sets `X-Content-Type-Options: nosniff`.
- German level names as in Stage 2. Commit messages: conventional-commit subject, ending with the Co-Authored-By attribution line your own harness instructions specify.

## Review Focus

1. Stored content as an attack: an uploaded SVG, HTML disguised by extension or content type, or an oversized or path-traversing id must not run script on the instance origin when opened directly, escape the instance directory, or bypass the quota (Task 1).
2. Realtime as an attack: a viewer without rights must not emit on a restricted topic, read a room of an instance they cannot open, impersonate another sender, or exhaust memory with rooms, presence blobs or stalled streams (Task 2).
3. Self-published versions leaking state: a version published by instance A must never be served on instance B, become the app's "latest", or be overwritten by a later deploy without the owner's action (Task 3).
4. Custom domains as takeover: a user must not attach a host that is the platform host, under the apps domain, already attached elsewhere, or attach one without the setting allowing it; the handshake must not redirect a sign-in code to a host that is not attached to that instance (Task 4).
5. Export and import crossing privacy lines: exports must omit other users' private areas; imports must not write them; both must respect instance manage rights and the quota (Task 5).

---

### Task 1: Assets — uploads per instance

**Files:**
- Create: `src/data/assets.ts`, `src/http/instance-assets.ts`
- Modify: `src/core.ts`, `src/http/instance.ts` (mount only), `src/data/store.ts` (quota accounting hook only), `src/runtime/runtime.js`, `src/platform/apps.ts` (Capabilities type)
- Test: `tests/assets.test.ts`, `tests/http-assets.test.ts`, extend `tests/runtime.test.ts`

**Interfaces:**
- Consumes: Stage 2 `Core`, `core.access.levelFor`, `InstanceData.usage/trash`, instance request context helpers in `src/http/instance.ts`, `LagerError('quota_exceeded')`.
- Produces:

```ts
// src/data/assets.ts
export interface AssetInfo { id: string; contentType: string; sizeBytes: number; createdAt: string; uploadedBy: string | null }
export const ASSET_LIMITS: { maxBytes: number /* 20 MiB */; maxScriptBytes: number /* 16 MiB, css/js */; maxSvgBytes: number /* 2 MiB */; maxFiles: number /* 2000 */ };
export function normalizeAssetType(declared: string | undefined, bytes: Buffer): string;   // returns an allowed content type or throws invalid_argument (unsupported_type)
export class InstanceAssets {
  constructor(dataDir: string, quotaBytes: number, dbUsage: (instanceId: string) => number);
  put(instanceId: string, bytes: Buffer, declaredType: string | undefined, by: string | null): AssetInfo;
  get(instanceId: string, id: string): { info: AssetInfo; path: string } | null;
  list(instanceId: string, onlyBy?: string): AssetInfo[];          // newest first
  delete(instanceId: string, id: string): boolean;
  usage(instanceId: string): { files: number; bytes: number };
  close(): void;
}
// Core gains `assets: InstanceAssets`. Capabilities gains `assets?: { upload?: 'interact' }`.
```

Storage: files at `<dataDir>/instances/<instanceId>/assets/<id>` (id = 32 hex chars from `crypto.randomBytes(16)`), metadata in `<dataDir>/instances/<instanceId>/assets.sqlite` (`assets(id PRIMARY KEY, content_type, size_bytes, uploaded_by, created_at)`). Ids are validated against `^[0-9a-f]{32}$` before any path is built. Quota: `put` throws `quota_exceeded` when document usage + asset bytes + the new file would exceed `quotaBytes` (0 = unlimited), and `conflict` when `maxFiles` is reached. The document store's own quota check also counts asset bytes (wire through `createCore`).

Allowed content types: `image/png|jpeg|gif|webp|avif|svg+xml`, `video/mp4|webm`, `audio/mpeg|ogg|wav|mp4`, `application/pdf`, `font/woff|woff2|ttf|otf`, `text/css`, `text/javascript`, `text/csv`, `text/markdown`, `application/json`, `text/plain`. `normalizeAssetType` takes the declared type's essence (lower-cased, parameters stripped, `application/javascript` → `text/javascript`), rejects anything not on the list (including `text/html` and `application/xhtml+xml`), and rejects a declared binary image/video/audio/pdf/font type whose leading bytes do not match that format's signature. Size caps per type as in `ASSET_LIMITS`.

Routes (instance host):
- `POST /__lager/assets` — raw body (`express.raw`, limit 20 MiB + 1), `Content-Type` = declared type, header `X-Lager-Request: 1`. Requires the capability to be declared and the viewer's level to be `admin|owner`, or `interact` when `capabilities.assets.upload === 'interact'`. → `201 {id, url:"/_blob/<id>", sizeBytes, contentType}`. Errors map to the contract's upload codes in the runtime: 413 → `too_large`, unsupported type → `unsupported_type`, quota/count → `quota_or_state`, no right → `not_uploader`.
- `GET /__lager/assets` → `{assets:[{id,url,contentType,sizeBytes,createdAt}], usage:{files,bytes,maxFiles,maxBytes}}`; viewers below `admin` see only their own uploads. `maxBytes` is the remaining-inclusive instance quota (0 → a large constant, 2^40).
- `DELETE /__lager/assets/:id` → `{deleted:boolean}`; `admin|owner` any asset, an `interact` uploader only their own (otherwise 403).
- `GET /_blob/:id` — readable by every viewer with level ≥ `view` (same access as the page; anonymous only on public instances). Headers: stored `Content-Type` (with `; charset=utf-8` for text types), `X-Content-Type-Options: nosniff`, `Cache-Control: private, max-age=31536000, immutable`, `Content-Disposition: inline` for image/video/audio/font/css/js/pdf and `attachment` for csv/markdown/json/plain; for `image/svg+xml` and all text types additionally `Content-Security-Policy: sandbox; default-src 'none'; style-src 'unsafe-inline'`. Supports `Range` for video/audio via `res.sendFile`.

Runtime: `use('assets')` resolves a frozen namespace per `assets.d.ts` when the capability is declared and the viewer may at least list; `upload(blob, opts?)`, `list()`, `delete(id)`; `url` values are returned exactly as the server gives them.

- [ ] **Step 1: Write failing tests.**

```ts
// tests/assets.test.ts
it('put/get/list/delete roundtrip', …)                 // file on disk under the instance's assets dir; list newest first; delete removes file and row
it('type allowlist and normalisation', …)              // text/html, application/xhtml+xml, application/octet-stream → invalid_argument; 'IMAGE/PNG; charset=x' → image/png; application/javascript → text/javascript
it('binary signature must match the declared type', …) // PNG bytes declared image/jpeg → invalid_argument; '<html>' declared image/png → invalid_argument
it('size caps per type', …)                            // svg > 2 MiB, css > 16 MiB, png > 20 MiB → invalid_argument (too large)
it('quota counts documents plus assets', …)            // quota 1 MiB: 700 KiB asset ok, second 700 KiB → quota_exceeded; document writes then also fail; after delete both work
it('ids are validated', …)                             // get/delete with '../x', 'abc', 33 chars → null/false, no fs access outside the instance dir
it('instances are isolated and survive reopen', …)

// tests/http-assets.test.ts  (app declares {assets:{}}; second app declares {assets:{upload:'interact'}}; third declares nothing)
it('owner uploads and the blob is served with safe headers', …)   // 201; GET /_blob/id → bytes equal, nosniff, immutable cache
it('svg is served sandboxed', …)                       // CSP header contains 'sandbox'; content-type image/svg+xml
it('html is refused even when declared as text/plain is accepted as plain', …)  // text/html → 400; a body '<script>' as text/plain → served as text/plain with sandbox CSP and attachment disposition
it('undeclared capability → 403/404 and runtime null', …)
it('interact uploader with upload:"interact" sees and deletes only own files', …)  // other's file: not in list, DELETE → 403
it('interact cannot upload without the declaration', …) // 403
it('view-level viewer can read a blob but not list or upload', …)
it('private instance: anonymous blob request is redirected or refused like the page', …)
it('requires X-Lager-Request', …)
it('413 for oversized bodies', …)

// tests/runtime.test.ts (added)
it('assets namespace uploads a Blob and maps error codes', …)     // posts raw body with the blob's type; 413 → too_large; 403 → not_uploader
it('assets is null when not declared', …)
```

- [ ] **Step 2: Run `npm test`; expect failures.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test` and `npm run typecheck`; both pass.**
- [ ] **Step 5: Commit** `feat: assets capability with per-instance uploads`.

---

### Task 2: Room — realtime events and presence

**Files:**
- Create: `src/data/rooms.ts`, `src/http/instance-room.ts`
- Modify: `src/core.ts`, `src/http/instance.ts` (mount only), `src/runtime/runtime.js`, `src/platform/apps.ts` (Capabilities type)
- Test: `tests/rooms.test.ts`, `tests/http-room.test.ts`, extend `tests/runtime.test.ts`

**Interfaces:**
- Consumes: Stage 2 instance context and viewer resolution (including the epoch/disabled re-check used by the db event stream), `core.access.levelFor`.
- Produces:

```ts
// src/data/rooms.ts — in-memory only
export interface PeerInfo { peer: string; by: string | null; guest: boolean; kind: 'viewer'; presence: Record<string, unknown>; updatedAt: number }
export type RoomEvent =
  | { type: 'message'; topic: string; data: unknown; from: PeerInfo }
  | { type: 'peers'; peers: PeerInfo[]; joined: PeerInfo[]; left: PeerInfo[]; updated: PeerInfo[] };
export const ROOM_LIMITS: { maxRoomsPerInstance: 50; maxPeersPerRoom: 200; maxPresenceBytes: 8192; maxMessageBytes: 65536; maxRoomNameLength: 64 };
export class Rooms {
  connect(instanceId: string, room: string, peer: { by: string | null; guest: boolean }, send: (e: RoomEvent) => void): { peerId: string; leave(): void };
  emit(instanceId: string, room: string, peerId: string, topic: string, data: unknown): void;       // not_found for an unknown peer
  setPresence(instanceId: string, room: string, peerId: string, patch: Record<string, unknown | null>): void;  // null deletes a key
  peers(instanceId: string, room: string): PeerInfo[];
}
// Core gains `rooms: Rooms`. Capabilities gains `room?: { topics?: Record<string, 'interact'> }`.
```

The lobby room is named `""`; `join(name)` rooms use `name` (1..64 chars, `[A-Za-z0-9._-]`). A room exists while it has peers. Limits throw `LagerError('conflict')` (rooms, peers) or `invalid_argument` (sizes, names). A peer's identity fields (`by`, `guest`) come only from the server-side viewer, never from the client.

Routes (instance host; capability must be declared; viewer level ≥ `view`, anonymous viewers on public instances are guests):
- `GET /__lager/room/events?room=<name>` — SSE. First event `hello` `{peer, peers}`; then `message` and `peers` events; `: ping` every 25 s, during which the viewer's access is re-checked (epoch, disabled, level) and the stream ended when it is gone. Closing the stream removes the peer and notifies the others.
- `POST /__lager/room` (JSON, 128 kB limit, `X-Lager-Request: 1`) `{room, peer, op, topic?, data?, patch?}` with `op: 'emit' | 'presence'`. The `peer` id must belong to a live stream of the same viewer (same user id, or for guests the same peer secret returned in `hello`), else 403. `emit` requires level `admin|owner`, or `interact` when `capabilities.room.topics[topic] === 'interact'`; `presence` is allowed for every connected peer. → `{ok:true}`.
- Rate limit: 30 POSTs per second per peer (burst), over the limit → 429.

Runtime: `use('room')` per `room.d.ts`: `emit`, `on`, `presence`, `peers`, `onPeers`, `join(name)` returning an object with the same verbs plus `leave()`. One EventSource per joined room, opened lazily and re-opened with backoff after an error (re-sending the last full presence state after reconnect). `Sender.isMe`/`sameTab` are derived from the peer id; `kind` is always `"viewer"`. Members that send to Claude resolve/reject per the contract's "not available" behaviour.

- [ ] **Step 1: Write failing tests.**

```ts
// tests/rooms.test.ts
it('peers see each other and messages', …)             // connect a, b → both get peers events; a emits → b and a receive a message with from.peer === a
it('presence patch merges and null deletes', …)        // updated list contains the peer; state cleared on leave (left list)
it('rooms are separate and vanish when empty', …)      // a message in room 'x' is not delivered to the lobby
it('limits', …)                                        // 51st room → conflict; 201st peer → conflict; presence > 8 KiB → invalid_argument; message > 64 KiB → invalid_argument; bad room name → invalid_argument
it('emit from an unknown peer is refused', …)

// tests/http-room.test.ts  (real server on port 0; app declares {room:{topics:{move:'interact'}}})
it('hello, then a message emitted by the owner reaches a second viewer', …)
it('interact viewer may emit an opened topic but not another one', …)   // 'move' ok, 'reset' → 403
it('view-level viewer cannot emit but can set presence', …)
it('a peer id of another viewer cannot be used', …)    // 403
it('sender identity comes from the session', …)        // body fields by/guest are ignored
it('undeclared capability → 404/403', …)
it('private instance refuses anonymous streams', …)
it('stream ends when the session is revoked', …)       // logout → stream closes within one ping (short interval override)
it('rate limit', …)                                    // 31st post within a second → 429

// tests/runtime.test.ts (added)
it('room emit/on roundtrip through stubbed transport', …)
it('onPeers reports joined, left and updated', …)
it('join(name) opens its own stream and leave() closes it', …)
it('room is null when not declared', …)
```

- [ ] **Step 2: Run `npm test`; expect failures.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test` and `npm run typecheck`; both pass.**
- [ ] **Step 5: Commit** `feat: room capability with events and presence`.

---

### Task 3: Self-publishing pages and downloads

**Files:**
- Create: `src/http/instance-artifact.ts`
- Modify: `src/platform/db.ts` (migration 5), `src/platform/apps.ts`, `src/http/instance.ts` (mount; `reload` event on the existing event stream), `src/http/manage.ts` (auto-update toggle, version labels), `src/mcp/tools.ts` and `src/http/api.ts` (deploy result field), `src/runtime/runtime.js`
- Test: `tests/self-publish.test.ts`, `tests/http-artifact.test.ts`, extend `tests/runtime.test.ts`, `tests/http-manage.test.ts`

**Interfaces:**
- Consumes: Stage 2 `Apps` (deploy, activate, versions), `core.access`, instance event stream (`Hub`).
- Produces:

```ts
// src/platform/apps.ts
export interface Version { /* existing */ instanceId: string | null }   // null = deployed version; otherwise self-published by that instance
// Apps gains:
selfPublish(input: { instanceId: string; html: string; baseVersion: number; userId: string }): { version: Version; instance: Instance };
  // requires checks.canManage; conflict when instance.activeVersion !== baseVersion; creates the next version number with instanceId set,
  // capabilities copied from the base version, note 'selbst gespeichert'; activates it on this instance only; sets autoUpdate = false.
setAutoUpdate(instanceId: string, on: boolean, userId: string): Instance;   // canManage
latestDeployedVersion(appId: string): Version | null;                        // highest number with instanceId === null
// Changed rules: "latest" for createInstance, deploy's unchanged-content check and deploy's auto-update uses deployed versions only;
// activate() refuses (forbidden) a version whose instanceId is another instance; listVersions(appId) still returns all, readVersionHtml unchanged.
// DeployResult gains `pinned: Instance[]` — instances of the app that were not updated because autoUpdate is off.
// Hub: new event { type: 'reload'; version: number } published after a successful selfPublish and after any activation.
```

Migration 5: `ALTER TABLE versions ADD COLUMN instance_id TEXT` (null for all existing rows).

Routes (instance host):
- `POST /__lager/artifact` (JSON, limit 16 MiB + margin, `X-Lager-Request: 1`) `{html, baseVersion}` → `{version:"<n>"}`. Requires the active version to declare `artifact` or `self`, and level `admin|owner`. Errors: not declared → 403 code `not_declared`; level too low → 403 `forbidden` (runtime maps to `not_writer`); `conflict` → 409; html empty or over 16 MiB → 400/413 (`invalid_content` / `too_large`); more than 60 publishes per hour for the instance → 429 (`rate_limited`).
- The existing event stream (`/__lager/db/events`) additionally delivers `event: reload` with `{version}`.
- `GET /__lager/session` already reports `instance.version`; the runtime uses it as `baseVersion`.

Runtime:
- `use('artifact')` and `use('self')` (same object) when declared: `publish(html)` per `artifact.d.ts` for the single-document form — resolves `{version}`; on success every open view, this one included, reloads (`location.reload()`) when it receives `reload` with a version different from the one it loaded (the runtime opens the event stream when this namespace is used, even without db listeners). Other publish forms and members of the contract reject with the contract's code for an unsupported operation. Read-only viewers reject `not_writer`.
- `use('downloads')` when declared: `save({filename, data})` per `downloads.d.ts` — asks `window.confirm('Datei „<filename>" speichern?')`; declined → reject `{code:'declined'}`; otherwise builds a Blob (string/Blob/ArrayBuffer/typed array), triggers a download through a temporary `<a download>`, revokes the object URL, resolves `{status:'saved'}`. The filename is reduced to its base name with control characters removed; extensions `.exe .bat .cmd .scr .js .msi .dmg .app .sh` reject `rejected_extension`; data over 50 MiB rejects `too_large`.

Management page (`/instances/:slug`): in „Version", a checkbox form „Automatisch auf neue Versionen aktualisieren" (`POST /ui/instances/:slug/auto-update`, `on=1|0`, csrf, canManage); self-published versions are labelled „selbst gespeichert"; the app page (`/apps/:slug`) lists only deployed versions plus a count of self-published ones per instance. MCP/REST deploy results include `pinned: [slug…]` and a German warning when non-empty („Diese Instanzen wurden nicht aktualisiert, weil sie selbst gespeicherte Inhalte haben: …").

- [ ] **Step 1: Write failing tests.**

```ts
// tests/self-publish.test.ts
it('selfPublish creates an instance-bound version and pins the instance', …)   // version.instanceId === instance.id; activeVersion = new number; autoUpdate false
it('conflict on a stale baseVersion', …)
it('a later deploy skips the pinned instance and reports it', …)   // result.pinned contains it; its activeVersion unchanged; other instances updated
it('self-published versions are not "latest"', …)      // createInstance for the same app starts at latestDeployedVersion; identical redeploy check ignores them
it('another instance cannot activate it', …)           // forbidden; the publishing instance can re-activate it and deployed ones
it('setAutoUpdate(true) lets the next deploy update again', …)
it('snapshot hook still runs on selfPublish', …)       // data snapshot labelled v<a>-to-v<b> exists when the instance has data
it('migration 5 keeps existing versions deployed', …)

// tests/http-artifact.test.ts  (app declares {artifact:{}}; second instance of the same app; app without the declaration)
it('owner publishes; the page then serves the new html', …)
it('reload event reaches a second open stream', …)
it('interact viewer → 403 not writer; undeclared app → 403 not_declared', …)
it('stale baseVersion → 409', …)
it('the other instance of the app keeps serving its own version', …)
it('61st publish within an hour → 429', …)
it('oversized and empty html are refused', …)
it('requires X-Lager-Request', …)

// tests/runtime.test.ts (added)
it('artifact.publish posts html with the loaded version and maps errors', …)
it('self is the same namespace as artifact', …)
it('a reload event with a newer version reloads the page once', …)
it('downloads.save confirms, sanitises the filename and refuses blocked extensions', …)
it('artifact and downloads are null when not declared', …)

// tests/http-manage.test.ts (added)
it('auto-update toggle', …)
it('self-published versions are labelled and hidden from the app page list', …)
```

- [ ] **Step 2: Run `npm test`; expect failures.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test` and `npm run typecheck`; both pass.**
- [ ] **Step 5: Commit** `feat: self-publishing pages and downloads capability`.

---

### Task 4: Custom domains per instance

**Files:**
- Create: `src/platform/domains.ts`
- Modify: `src/platform/db.ts` (migration 6), `src/platform/settings.ts`, `src/platform/apps.ts` (cleanup on instance deletion), `src/core.ts`, `src/config.ts` (`hostUrl` helper), `src/http/app.ts` (host dispatch), `src/http/platform.ts` (`/auth/instance`), `src/http/instance.ts` (redirect to sign-in), `src/http/manage.ts`, `src/http/admin.ts` (setting), `src/http/api.ts`, `src/mcp/tools.ts`, `src/guide.md`, `skill/lager/SKILL.md`
- Test: `tests/domains.test.ts`, `tests/http-domains.test.ts`, extend `tests/mcp.test.ts`, `tests/api.test.ts`

**Interfaces:**
- Consumes: Stage 2 `Settings`, `Access.canManageInstance`, `Apps.onInstanceDeleted`, handshake code issuing in `src/http/platform.ts`.
- Produces:

```ts
// src/platform/settings.ts
export type CustomDomainsMode = 'admins' | 'publishers';
// Settings gains: get customDomains(): CustomDomainsMode (default 'admins'); setCustomDomains(mode): void

// src/platform/domains.ts
export function normalizeHost(input: string): string;   // lower-case, trims a trailing dot; throws invalid_argument unless it is a DNS hostname with ≥ 2 labels, ≤ 253 chars, labels [a-z0-9-] not starting/ending with '-', no port, no IP literal
export class Domains {
  constructor(db: DatabaseSync, config: Config, settings: Settings);
  canManage(user: User, canManageInstance: boolean): boolean;   // admin always; publisher when settings.customDomains === 'publishers' and canManageInstance
  add(instance: Instance, host: string, by: User, canManageInstance: boolean): string;   // returns the normalised host; forbidden without canManage; invalid_argument for the platform host or a host equal to or under config.appsDomain; conflict when attached anywhere
  remove(instance: Instance, host: string, by: User, canManageInstance: boolean): boolean;
  list(instanceId: string): string[];
  instanceIdFor(host: string): string | null;                   // in-memory cache, invalidated on add/remove/removeAll
  removeAll(instanceId: string): void;
}
// src/config.ts
export function hostUrl(cfg: Config, host: string): string;     // same protocol and port as publicUrl
// Core gains `domains: Domains`; createCore registers apps.onInstanceDeleted(i => domains.removeAll(i.id)).
```

Migration 6: `instance_domains(host TEXT PRIMARY KEY, instance_id TEXT NOT NULL, created_by TEXT, created_at TEXT NOT NULL)` with an index on `instance_id`.

Behaviour:
- Host dispatch (`src/http/app.ts`): platform host → platform router; `<slug>.<appsDomain>` → instance by slug; otherwise `core.domains.instanceIdFor(hostname)` → that instance; else 404.
- Sign-in from a custom host: the instance redirects to `<publicUrl>/auth/instance?slug=<slug>&host=<hostname>&return=<path>`. `/auth/instance` accepts `host` only when it is attached to that instance (else 400), and then redirects the code to `hostUrl(config, host) + '/__lager/callback?…'`; without `host` the behaviour is unchanged. The code stays bound to the instance id; the callback and cookie logic are unchanged (host-only cookie on the custom host).
- `instanceJson` (REST/MCP) and the management page list `domains` and their URLs; deploy results keep the primary URL first.
- Management page: section „Eigene Domains", shown only when `domains.canManage(user, …)`: list with „Entfernen", add form (hostname), and the note „DNS, Proxy-Eintrag und Zertifikat für die Domain richtest du selbst ein. Lager prüft nicht, wem die Domain gehört." Routes `POST /ui/instances/:slug/domains` (`host`), `POST /ui/instances/:slug/domains/remove` (`host`), csrf. Notices: invalid host → „Das ist kein gültiger Hostname."; conflict → „Diese Domain ist bereits vergeben."; platform/apps domain → „Diese Domain kann nicht verwendet werden."
- Admin settings page: select „Eigene Domains" with options „Nur Administratoren" / „Auch Publisher".
- REST: `GET /api/instances/:slug/domains`, `PUT` `{host}`, `DELETE` `{host}` → `{domains:[…]}`. MCP tools (total becomes 16): `add_domain {instance, host}`, `remove_domain {instance, host}`. Guide and skill (identical bodies): a short paragraph in „Teilen und Instanzen" on custom domains and who may set them.

- [ ] **Step 1: Write failing tests.**

```ts
// tests/domains.test.ts
it('normalizeHost', …)          // 'Notes.Example.COM.' → 'notes.example.com'; rejects 'localhost', 'a', 'ex ample.com', '1.2.3.4', '[::1]', 'a.com:8080', '-a.com', 'a..com', 254-char host
it('add/list/remove and lookup cache', …)
it('refuses the platform host and anything under the apps domain', …)   // 'lager.localhost' (publicUrl host), 'apps.localhost', 'x.apps.localhost' → invalid_argument
it('a host can be attached only once platform-wide', …)                 // conflict on a second instance
it('who may manage', …)         // admin yes; publisher with manage right only when the setting is 'publishers'; plain user never; publisher without manage right never
it('deleting the instance frees its domains', …)

// tests/http-domains.test.ts
it('custom host serves the instance', …)                                 // Host: notes.example.test → 200 page after handshake
it('sign-in from a custom host returns to that host', …)                 // 302 to platform with host param; platform 302 to http://notes.example.test:<port>/__lager/callback?code=…; cookie set for that host; page 200
it('host param not attached to the instance → 400', …)                   // also a host attached to another instance
it('a cookie from the custom host is not valid on the default host and vice versa is separate', …)   // each host needs its own handshake; both then work
it('unknown host → 404', …)
it('management page shows the section only to those who may manage', …)
it('add and remove through the page with notices', …)
it('admin setting switches publisher access', …)

// tests/api.test.ts, tests/mcp.test.ts (added)
it('domains over REST', …); it('lists the sixteen tools', …); it('add_domain and remove_domain', …); it('a publisher is refused while the setting is admins', …)
```

- [ ] **Step 2: Run `npm test`; expect failures.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test` and `npm run typecheck`; both pass.**
- [ ] **Step 5: Commit** `feat: custom domains per instance`.

---

### Task 5: Export, import, artifact check, migration guide

**Files:**
- Create: `src/platform/check.ts`
- Modify: `src/platform/lint.ts` (delegate), `src/platform/apps.ts` (deploy warnings), `src/data/store.ts`, `src/http/api.ts`, `src/http/manage.ts`, `src/mcp/tools.ts`, `src/guide.md`, `skill/lager/SKILL.md`
- Test: `tests/check.test.ts`, extend `tests/data-store.test.ts`, `tests/api.test.ts`, `tests/mcp.test.ts`, `tests/http-manage.test.ts`

**Interfaces:**
- Consumes: Stage 2 `InstanceData`, `Access`, REST/MCP helpers; Task 3 `Version.instanceId`.
- Produces:

```ts
// src/platform/check.ts
export const SUPPORTED_CAPABILITIES: readonly string[];   // db, user, permissions, assets, room, artifact, self, downloads
export interface ArtifactCheck { used: string[]; unsupported: string[]; undeclared: string[]; warnings: string[] }
export function checkArtifact(html: string, capabilities?: Capabilities): ArtifactCheck;
// used: capability names found as string literals in claude.use("…") / claude.use('…') calls (sorted, unique);
// unsupported: used names not in SUPPORTED_CAPABILITIES; undeclared: used, supported names (except permissions) missing from `capabilities`;
// warnings (German): the existing browser-storage warnings; one per unsupported capability („… wird von Lager nicht nachgebildet; claude.use("…") liefert null."); one per undeclared capability („… wird benutzt, ist aber nicht in capabilities deklariert."); one when `window.claude.complete` or `claude.complete(` is used.
// lintArtifact(html) keeps its signature and returns checkArtifact(html).warnings for the storage rules only; Apps.deploy now returns checkArtifact(html, capabilities).warnings.

// src/data/store.ts
exportDocs(instanceId: string, opts?: { includePrivateOf?: string }): Generator<{ path: string; data: Record<string, unknown> }>;
  // all documents ordered by path, omitting everything under data/users/ except the area of `includePrivateOf`
importDocs(instanceId: string, docs: Iterable<{ path: string; data: Record<string, unknown> }>, by: string | null, opts?: { allowPrivateOf?: string }): { imported: number };
  // validates every doc first (paths, data limits; a path under data/users/<id>/ is refused unless id === allowPrivateOf), then writes all in one transaction (set semantics); quota applies; publishes one `reset` event
```

REST (auth as today; instance routes need `canManageInstance`):
- `GET /api/instances/:slug/export` → `200 application/x-ndjson`, `Content-Disposition: attachment; filename="<slug>-<yyyymmdd>.ndjson"`, one JSON object `{path,data}` per line, streamed; includes the caller's own private area, omits everyone else's.
- `POST /api/instances/:slug/import` — body `application/x-ndjson` or `application/json` (array), limit 50 MiB, at most 100000 documents → `{imported}`; the caller's own private area may be written.
- `GET /api/apps/:slug/versions/:number` → the version's HTML as `text/plain; charset=utf-8` with `Content-Disposition: attachment; filename="<slug>-v<n>.html"` and `nosniff`. Deployed versions: app owner and collaborators; self-published versions: managers of the publishing instance.
- `POST /api/check` `{html, capabilities?}` → `ArtifactCheck` (any signed-in publisher or admin).

MCP tools (total becomes 19): `import_data {instance, docs:[{path,data}]}` (max 1000 docs) → `{imported}`; `export_data {instance, prefix?, limit?}` (default limit 200, max 1000; `truncated` flag) → `{docs, truncated}`; `check_artifact {html, capabilities?}` → `ArtifactCheck`.

Management pages: instance page section „Daten" with a link „Daten exportieren (NDJSON)" (GET to a session-authenticated page route `/instances/:slug/export` producing the same stream); versions tables on the instance and app pages get a link „HTML" per row (`/apps/:slug/versions/:number/html`, same authorization as REST).

Guide and skill (identical bodies): new section „Bestehende Artefakte übernehmen" — the steps for Claude: read the existing artifact's source; run `check_artifact`; replace capabilities Lager does not provide (name them) and browser storage; declare `capabilities`; deploy; move data (read it from the old environment with the tools available there and write it with `import_data`, or for data that only lives in a browser add a one-time export button to the old artifact and import the file through REST); verify the instance; and the limits (private areas of other users cannot be imported, uploads are re-uploaded through the app). Update the capability list in the guide (now including `assets`, `room`, `artifact`, `downloads` and what stays `null`) and keep the first section within 15 lines.

- [ ] **Step 1: Write failing tests.**

```ts
// tests/check.test.ts
it('finds used capabilities in both quote styles', …)          // claude.use("db"), claude.use('room'), await window.claude.use( "assets" ) → used ['assets','db','room']
it('reports unsupported and undeclared ones', …)               // sample, tts → unsupported with one German warning each; db used but capabilities {} → undeclared; permissions never undeclared
it('warns about claude.complete and browser storage', …)
it('clean artifact has no warnings', …)
it('deploy returns the combined warnings', …)                  // via core.apps.deploy

// tests/data-store.test.ts (added)
it('exportDocs omits other users private areas', …)            // includes own with includePrivateOf
it('importDocs is all-or-nothing', …)                          // one invalid path → nothing written; valid set → imported count, reset event
it('importDocs refuses foreign private paths and respects the quota', …)

// tests/api.test.ts (added)
it('export streams NDJSON with attachment headers', …)
it('import accepts NDJSON and a JSON array', …)
it('export → import into a second instance reproduces the documents', …)
it('non-manager is refused for export and import', …)
it('version html download: owner and collaborator yes, stranger no; self-published only for the instance manager', …)
it('POST /api/check', …)

// tests/mcp.test.ts (changed/added)
it('lists the nineteen tools', …); it('import_data then export_data with prefix and truncation', …); it('check_artifact', …)

// tests/http-manage.test.ts (added)
it('export link and html links are present and authorised', …)
```

- [ ] **Step 2: Run `npm test`; expect failures.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test` and `npm run typecheck`; both pass.**
- [ ] **Step 5: Commit** `feat: export, import, artifact check and migration guide`.

---

### Task 6: Documentation, examples and end-to-end test

**Files:**
- Create: `examples/board.html`, `tests/e2e-stage3.test.ts`
- Modify: `README.md`, `.env.example` (only if a variable was added)

**Interfaces:**
- Consumes: everything from Tasks 1–5 through HTTP only.

`examples/board.html`: a small shared pin-board written like a Claude artifact that uses `db` (cards), `assets` (attach an image to a card), `room` (who is here, live cursor-free presence list) and `downloads` (export the cards as JSON), degrading gracefully when a namespace is `null`; no browser storage; all `user` and other namespace members awaited correctly.

README additions (German, concrete): section „Bausteine" (table: capability, what it does on Lager, how to declare it, limits; and which ones stay unavailable); „Eigene Domains" (who may set them, the proxy/DNS/certificate steps for Nginx Proxy Manager, that Lager does not verify ownership, sign-in behaviour); „Export, Import und Umzug" (data export/import, HTML download, moving an existing artifact with Claude, what cannot be moved automatically); update „Grenzen" (uploads count toward the quota; snapshots cover documents only) and „Was Lager nicht kann".

- [ ] **Step 1: Write the failing test.**

```ts
// tests/e2e-stage3.test.ts  (real server on port 0)
it('assets, room, self-publish, custom domain, export/import', async () => {
  // 1. publisher deploys examples/board.html as 'board' with capabilities {db:{},user:{},assets:{},room:{},downloads:{}} → no warnings
  // 2. owner uploads a PNG → GET /_blob/<id> returns the bytes with nosniff; uploading text/html → refused
  // 3. two streams on /__lager/room/events (owner and a granted 'interact' user): presence of each is seen by the other; owner emits → the other receives
  // 4. a second app with {artifact:{}}: owner publishes a changed page → served; redeploy reports the instance as pinned
  // 5. admin attaches 'board.example.test' → the instance answers on that host after its own handshake
  // 6. export NDJSON from 'board', import into a new instance 'board-2' → same documents; the HTML of version 1 downloads as an attachment
});
```

- [ ] **Step 2: Run it; if it passes at once, say so in the report.**
- [ ] **Step 3: Write the example and documentation; fix nothing under `src/` — report gaps instead.**
- [ ] **Step 4: Run `npm test`, `npm run typecheck`, `npm run build`; all pass.**
- [ ] **Step 5: Commit** `docs: capabilities, custom domains, export and migration; stage 3 end-to-end test`.

---

## Addendum (owner decision during execution): English by default, internationalisation

The owner decided that the whole product is English by default and must be translatable, starting with English, French, Spanish and German. This replaces the earlier rule "user-facing text German". Tasks 7 and 8 implement it; the Global Constraints rule on language now reads:

- Human-facing text (HTML pages, notices, e-mails, runtime dialogs) comes only from the message catalogs under `src/i18n/` through `t()`; no literal human-facing sentence in any other source file. English is the source catalog and the fallback.
- Machine-facing text is English only and is not translated: `LagerError` messages, JSON error bodies, REST/MCP results and tool descriptions, artifact-check warnings, log lines, the guide (`src/guide.md`), the skill, the README, code comments and commit messages.
- Brand copy (owner's wording, English source): tagline "The only two apps you'll ever need: Claude + Lager." and the pitch "We used to buy apps. Now Claude builds any app you can imagine, on the spot. Lager is where they run — on your server, with your data staying yours."

### Task 7: i18n foundation, public and account pages, e-mails, machine-facing English

**Files:**
- Create: `src/i18n/index.ts`, `src/i18n/en.ts`, `src/i18n/de.ts`, `src/i18n/fr.ts`, `src/i18n/es.ts`, `src/http/locale.ts`
- Modify: `src/platform/db.ts` (migration 7: `users.locale TEXT`), `src/platform/users.ts`, `src/platform/accounts.ts`, `src/config.ts` (`LAGER_DEFAULT_LOCALE`), `src/http/pages.ts`, `src/http/platform.ts`, `src/http/auth.ts`, `src/http/instance.ts` and the `instance-*.ts` files (their HTML pages and error messages), `src/mcp/oauth.ts` (consent page), `src/runtime/runtime.js` (dialog text), `src/platform/check.ts`, `src/platform/lint.ts`, `src/platform/apps.ts`, `src/platform/domains.ts`, `src/data/*.ts`, `src/core.ts`, `src/mcp/tools.ts` (messages and descriptions), `src/guide.md`, `skill/lager/SKILL.md`, `.env.example`
- Test: `tests/i18n.test.ts`, `tests/http-locale.test.ts`; update every test that asserts a German string in the files above

**Interfaces:**
- Produces:

```ts
// src/i18n/index.ts
export const LOCALES = ['en', 'de', 'fr', 'es'] as const;
export type Locale = (typeof LOCALES)[number];
export const LOCALE_NAMES: Record<Locale, string>;            // 'English', 'Deutsch', 'Français', 'Español'
export type MessageKey = keyof typeof import('./en.js').en;    // en.ts exports `en` as a const object of key → template
export function isLocale(value: unknown): value is Locale;
export function t(locale: Locale, key: MessageKey, params?: Record<string, string | number>): string;
  // templates use {name} placeholders; a missing key in a non-English catalog falls back to English; a missing param leaves the placeholder text out (empty string)
export function negotiateLocale(acceptLanguage: string | undefined, fallback: Locale): Locale;   // RFC 9110 q-values, matches primary subtags ('fr-CA' → 'fr')
export function formatDate(locale: Locale, iso: string): string;   // Intl.DateTimeFormat, UTC, date and time to the minute
// Each of de.ts, fr.ts, es.ts exports a catalog typed `Record<MessageKey, string>` so a missing or extra key is a compile error.

// src/http/locale.ts
export function requestLocale(core: Core, req: Request, user?: User | null): Locale;
  // order: signed-in user's stored locale → cookie `lager_lang` → Accept-Language → config.defaultLocale
export const LANG_COOKIE = 'lager_lang';

// src/platform/users.ts: User gains `locale: Locale | null`; Users.setLocale(id, locale | null): User
// src/config.ts: Config gains `defaultLocale: Locale` (LAGER_DEFAULT_LOCALE, default 'en'; invalid value → startup error naming the variable)
```

Behaviour:
- `page()` takes the locale: `<html lang="…">`, translated chrome (navigation, sign-out, footer). Every platform page gets a footer language switcher: links `GET /lang/<locale>?return=<path>` that set `lager_lang` (1 year, `SameSite=Lax`, host-only, not HttpOnly-sensitive but set `HttpOnly`) and redirect to `safeReturnPath(return)`; unknown locale → 404. For a signed-in user the switcher also stores the choice with `Users.setLocale`.
- Account page: a language select (the four locale names plus "Browser default" = null), `POST /account/locale` (csrf).
- All pages and notices in `pages.ts`, `platform.ts` (login, errors, 404, forbidden), `auth.ts` (register, verify, forgot, reset, account) and the instance-host pages (not found, disabled, forbidden, bad code) use `t()`. Instance-host pages use `requestLocale` with the instance viewer where known, else cookie is not available on that host → Accept-Language → default.
- OAuth consent page uses `t()`.
- E-mails are sent in the recipient's locale: the stored locale of the user if any, else the locale of the request that triggered the mail (registration, resend, forgot, invite created by an administrator → the administrator's request locale). `Accounts` methods that send mail take an optional `locale` argument; subjects and bodies come from the catalogs.
- Registration stores the request locale as the new user's locale.
- `/__lager/session` reports `viewer.locale` (stored locale or negotiated); the runtime uses it for the one human-facing string it shows (the download confirmation) from a small embedded table for the four locales, falling back to English.
- Machine-facing strings that are German today are rewritten in English in place (no catalog): artifact-check and lint warnings, `LagerError` messages in `apps.ts`, `domains.ts`, `data/*`, `core.ts` (startup refusal), MCP tool messages and descriptions, JSON error messages in the instance routes. Where a web page shows a notice derived from a `LagerError`, the page maps the error to a catalog key by a stable identifier (extend `LagerError` with an optional `reason` string code, e.g. `slug_retired`, `instance_limit`, `creation_rate`, `host_invalid`, `host_taken`, `host_forbidden`) instead of matching message text.
- `src/guide.md` and `skill/lager/SKILL.md` are rewritten in English (same content, bodies identical, first section ≤ 15 lines). The MCP server instructions therefore become English.
- Brand copy: the login page shows the tagline as a heading above the form and the pitch below it (catalog keys `brand.tagline`, `brand.pitch`; translated in all four catalogs, with "Claude" and "Lager" left untranslated).
- Translation quality: French, Spanish and German texts are natural, consistent in formality (German "du", French "vous", Spanish "tú"), and keep placeholders intact.

- [ ] **Step 1: Write failing tests.**

```ts
// tests/i18n.test.ts
it('all catalogs have exactly the English keys', …)            // key sets equal for de, fr, es
it('placeholders match the English template in every catalog', …)   // same {name} set per key
it('no catalog value is empty or equal to its key', …)
it('t interpolates and falls back', …)                         // t('de', key, {name:'X'}) contains X; unknown param → empty
it('negotiateLocale', …)                                       // 'fr-CA,fr;q=0.9,en;q=0.8' → fr; 'es;q=0.1,de;q=0.9' → de; 'ja' → fallback; undefined → fallback; '*' → fallback
it('formatDate differs by locale and is stable', …)
it('brand copy keeps the names Claude and Lager in every locale', …)

// tests/http-locale.test.ts
it('login page is English by default with lang="en" and the tagline', …)
it('Accept-Language selects French, Spanish, German', …)       // lang attribute and one known string per locale
it('language switcher sets the cookie and wins over Accept-Language', …)
it('a signed-in user\'s stored locale wins over the cookie', …) // set via POST /account/locale
it('unknown locale in /lang → 404; return is sanitised', …)
it('registration mail is sent in the request locale; later mails in the stored locale', …)
it('instance-host error pages follow Accept-Language', …)
it('LAGER_DEFAULT_LOCALE changes the fallback; invalid value is refused', …)
it('session reports viewer.locale and the runtime dialog uses it', …)
it('notices map by reason code, not by message text', …)       // a retired slug shows the localized notice in fr
```

- [ ] **Step 2: Run `npm test`; expect failures.**
- [ ] **Step 3: Implement.** Update existing tests that assert German strings from the converted files to assert the English text (default locale) — prefer importing `t('en', key)` over hard-coding where the exact wording is not the point of the test.
- [ ] **Step 4: Run `npm test` and `npm run typecheck`; both pass.**
- [ ] **Step 5: Commit** `feat: i18n foundation with English default; public pages, mails and machine text in English`.

### Task 8: Translate the signed-in area and enforce catalog-only text

**Files:**
- Modify: `src/http/dashboard.ts`, `src/http/manage.ts`, `src/http/admin.ts`, `src/i18n/en.ts`, `src/i18n/de.ts`, `src/i18n/fr.ts`, `src/i18n/es.ts`, `README.md` (section on languages), any remaining file with human-facing literals
- Test: `tests/i18n-coverage.test.ts`; update `tests/dashboard.test.ts`, `tests/http-manage.test.ts`, `tests/http-admin.test.ts` and any other test asserting German text

**Interfaces:**
- Consumes: Task 7 `t`, `requestLocale`, `page(locale, …)`, `formatDate`, reason codes on `LagerError`.

Behaviour:
- Every heading, label, button, table header, option, empty state, confirmation hint and notice on the home page, instance page, app page and the whole administration area comes from the catalogs. Role and level names are catalog entries (`role.admin`, `level.view`, …). Dates use `formatDate`. Sizes use a locale-aware number format.
- Notices in `manage.ts` are selected by `LagerError.reason` codes (add codes where a message is still matched by text) and shown in the viewer's locale; the signed flash carries only the notice key.
- README gains a section "Languages": how the locale is chosen (account setting, switcher cookie, browser, `LAGER_DEFAULT_LOCALE`), which languages ship, and how to add one (copy `src/i18n/en.ts` to a new file, translate the values, register it in `LOCALES` and `LOCALE_NAMES`; the type checker reports missing keys).

- [ ] **Step 1: Write failing tests.**

```ts
// tests/i18n-coverage.test.ts
it('no human-facing German remains outside the catalogs', …)
  // scan every file under src/ except src/i18n/*: no characters äöüÄÖÜß„“ and none of a list of German UI words
  // (e.g. 'Speichern', 'Löschen', 'Freigabe', 'Instanz', 'Einladung', 'Passwort', 'Anmelden', 'Abmelden', 'Übersicht', 'Verwaltung') as whole words
it('every catalog key is used somewhere in src', …)            // grep each key; unused keys fail (allow a short explicit allowlist for keys built dynamically, e.g. role.* and level.*)
it('every t() call uses an existing key', …)                    // static scan of t(…, '<key>') literals against en
it('the home, instance, app and admin pages render in all four locales without missing-key output', …)
  // render each page per locale for a seeded core and assert the body contains no '{', no 'undefined' and none of the English sentinel strings when locale ≠ en (pick five distinctive English labels)
```

- [ ] **Step 2: Run `npm test`; expect failures.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test`, `npm run typecheck`, `npm run build`; all pass.**
- [ ] **Step 5: Commit** `feat: translate dashboard, management and administration; enforce catalog-only text`.
