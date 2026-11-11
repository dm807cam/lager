# Lager Stage 1 (Core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A self-hosted, Docker-deployable server that hosts Claude artifacts on subdomains with versioning, per-instance persistent storage, a `claude.use()`-compatible browser runtime, and an MCP endpoint Claude deploys through.

**Architecture:** One Express process. A framework-free core (`src/platform`, `src/data`) owns apps/versions/instances and per-instance SQLite document stores; HTTP (`src/http`) dispatches by hostname to a platform router or an instance router; a plain-JS browser runtime (`src/runtime/runtime.js`) talks to the instance router; MCP (`src/mcp`) and REST call the same core.

**Tech Stack:** Node ≥ 22.13, TypeScript strict ESM, Express 5, `node:sqlite`, `@modelcontextprotocol/sdk`, `zod`, Vitest, Supertest.

**Spec:** `docs/superpowers/specs/2026-11-11-lager-stage1-design.md` (German; binding).

## Global Constraints

- Runtime deps limited to `express@5`, `@modelcontextprotocol/sdk`, `zod`. Dev deps: `typescript`, `tsx`, `vitest`, `supertest`, `@types/node`, `@types/express`, `@types/supertest`, `jsdom`. No native modules; SQLite only via `node:sqlite` (`DatabaseSync`).
- TypeScript `strict`, `"module": "NodeNext"`, ESM (`"type": "module"`), relative imports with `.js` suffix. Build with `tsc` to `dist/`; `src/runtime/runtime.js` and `src/guide.md` are copied to `dist/` by the build script.
- Scripts: `npm test` = `vitest run`, `npm run typecheck` = `tsc --noEmit`, `npm run build`, `npm run dev` = `tsx watch src/server.ts`, `npm start` = `node dist/server.js`. Both `npm test` and `npm run typecheck` must pass before every commit.
- All persistent state lives under `config.dataDir`. Tests use a fresh `fs.mkdtempSync` directory each and never touch `./data`.
- All thrown domain errors are `LagerError` (`src/errors.ts`) with `code` one of `not_found | forbidden | invalid_argument | conflict | unauthenticated`. JSON error bodies are `{"error":{"code","message"}}`; HTTP status: not_found 404, forbidden 403, invalid_argument 400, conflict 409, unauthenticated 401.
- Slugs (apps and instances) match `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$` and are not one of `www, api, lager, admin, mcp, auth, static`. Instance slugs are globally unique.
- IDs are `crypto.randomUUID()`. Timestamps are ISO-8601 UTC strings.
- User-facing HTML text is German; code, identifiers, comments, commit messages, log lines are English.
- Secrets (passwords, tokens, OAuth codes) are stored only as hashes (`scrypt` for passwords, SHA-256 for random tokens); comparisons use `crypto.timingSafeEqual`.
- Commits: conventional-commit subject; message ends with the line `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`. Never commit `node_modules`, `dist`, `data`, `.env`, `.superpowers`.

## Review Focus

1. Rolling back to an older version after a newer version wrote data: data must be intact and a snapshot must exist (Task 2, test `activate snapshots data and keeps it`).
2. Credentials crossing instances: an instance cookie or handshake code for instance A must be rejected on instance B; `data/users/<other>/…` must be unreadable even for the instance owner (Task 2 `private user area`, Task 3 `cookie for A rejected on B`).
3. Open redirects through `return` parameters on `/login`, `/auth/instance`, `/__lager/callback` (Task 3 `return must be a local path`).
4. Hostile or oversized document input (path with empty segment, 17 segments, 300 KiB doc, 33 levels) returns `invalid_argument` instead of throwing a 500 (Task 2 `limits`, Task 3 `db endpoint maps errors`).
5. HTML without `<head>`, with uppercase tags, or with a leading doctype still gets the runtime script injected exactly once (Task 3 `injectRuntime`).

---

### Task 1: Project scaffold and platform core

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- Create: `src/errors.ts`, `src/config.ts`, `src/platform/db.ts`, `src/platform/users.ts`, `src/platform/apps.ts`, `src/platform/lint.ts`
- Test: `tests/config.test.ts`, `tests/users.test.ts`, `tests/apps.test.ts`, `tests/lint.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:

```ts
// src/errors.ts
export type ErrorCode = 'not_found'|'forbidden'|'invalid_argument'|'conflict'|'unauthenticated';
export class LagerError extends Error { constructor(public code: ErrorCode, message: string) }

// src/config.ts
export interface Config {
  dataDir: string; port: number; publicUrl: URL; appsDomain: string;
  adminEmail?: string; adminPassword?: string; secret: string;
  snapshotKeep: number; trustProxy: boolean;
}
export function loadConfig(env: NodeJS.ProcessEnv): Config;
export function instanceUrl(cfg: Config, slug: string): string; // same protocol and port as publicUrl
export const SLUG_RE: RegExp; export function assertSlug(slug: string): void; // throws invalid_argument

// src/platform/db.ts
import { DatabaseSync } from 'node:sqlite';
export function openPlatformDb(dataDir: string): DatabaseSync; // <dataDir>/platform.sqlite, WAL, runs migrations

// src/platform/users.ts
export type Role = 'admin'|'publisher'|'user';
export interface User { id: string; email: string; name: string; role: Role; createdAt: string }
export class Users {
  constructor(db: DatabaseSync);
  create(input: { email: string; name: string; password: string; role: Role }): User; // conflict on duplicate email (case-insensitive)
  verifyPassword(email: string, password: string): User | null;
  get(id: string): User | null; getByEmail(email: string): User | null;
  list(): User[]; count(): number;
  ensureAdmin(email?: string, password?: string): void; // creates admin only when count() === 0 and both given
}

// src/platform/lint.ts
export function lintArtifact(html: string): string[];

// src/platform/apps.ts
export interface DbRule { path: string; read?: RuleLevel; write?: RuleLevel }
export type RuleLevel = 'view'|'interact'|'admin'|'owner'|'self';
export interface Capabilities { db?: { rules?: DbRule[] }; user?: { scopes?: string[] }; [k: string]: unknown }
export type Visibility = 'private'|'users'|'public';
export interface App { id: string; slug: string; title: string; ownerId: string; createdAt: string }
export interface Version { appId: string; number: number; sha256: string; sizeBytes: number;
  capabilities: Capabilities; note: string | null; createdBy: string; createdAt: string }
export interface Instance { id: string; appId: string; slug: string; ownerId: string;
  activeVersion: number; autoUpdate: boolean; visibility: Visibility; createdAt: string }
export interface DeployResult { app: App; version: Version; instances: Instance[]; warnings: string[];
  createdApp: boolean; createdVersion: boolean }
export type ActivateHook = (instance: Instance, from: number, to: number) => void;
export class Apps {
  constructor(db: DatabaseSync, dataDir: string, users: Users);
  deploy(input: { slug: string; html: string; title?: string; capabilities?: Capabilities; note?: string; userId: string }): DeployResult;
  getApp(slugOrId: string): App | null;
  listApps(ownerId?: string): App[];
  listVersions(appId: string): Version[];            // ascending by number
  readVersionHtml(appId: string, number: number): string;
  createInstance(input: { appId: string; slug: string; ownerId: string; visibility?: Visibility }): Instance; // starts at latest version
  getInstance(id: string): Instance | null;
  getInstanceBySlug(slug: string): Instance | null;
  listInstances(appId: string): Instance[];
  activate(instanceId: string, version: number, userId: string): Instance;
  setVisibility(instanceId: string, visibility: Visibility, userId: string): Instance;
  onBeforeActivate(hook: ActivateHook): void;        // called synchronously before activeVersion changes, also during deploy auto-update
}
```

- [ ] **Step 1: Scaffold.** `package.json` (name `lager`, private, `"type":"module"`, `"engines":{"node":">=22.13"}`, scripts and deps per Global Constraints), `tsconfig.json`, `vitest.config.ts` (node environment, `tests/**/*.test.ts`), `.gitignore` (`node_modules`, `dist`, `data`, `.env`, `.superpowers`). Run `npm install`; commit the lockfile.

- [ ] **Step 2: Write failing tests.**

```ts
// tests/config.test.ts
it('parses env', () => {
  const c = loadConfig({ LAGER_PUBLIC_URL: 'http://lager.localhost:8080', LAGER_APPS_DOMAIN: 'apps.localhost', LAGER_DATA_DIR: tmp });
  expect(c.port).toBe(8080); expect(c.snapshotKeep).toBe(20); expect(c.trustProxy).toBe(true);
  expect(instanceUrl(c, 'workout')).toBe('http://workout.apps.localhost:8080');
  expect(c.secret).toHaveLength(64);                                   // generated hex, persisted
  expect(loadConfig({ ...sameEnv }).secret).toBe(c.secret);            // read back from <dataDir>/secret.key
});
it('requires LAGER_PUBLIC_URL and LAGER_APPS_DOMAIN', () => { expect(() => loadConfig({})).toThrow(/LAGER_PUBLIC_URL/); });
it('rejects bad slugs', () => { for (const s of ['', 'A', '-a', 'a-', 'a_b', 'www', 'mcp', 'x'.repeat(64)]) expect(() => assertSlug(s)).toThrow(LagerError); assertSlug('a'); assertSlug('workout-2'); });

// tests/users.test.ts
it('creates and verifies', …)            // verifyPassword ok → user; wrong password → null; unknown email → null; email match is case-insensitive
it('rejects duplicate email', …)         // code 'conflict'
it('ensureAdmin only on empty db', …)    // second call with other email creates nothing; count() === 1; role 'admin'
it('never stores the plain password', …) // SELECT * FROM users row does not contain the password string

// tests/lint.test.ts
it('warns on browser storage', () => {
  expect(lintArtifact('<script>localStorage.setItem("a","b")</script>')).toHaveLength(1);
  expect(lintArtifact('<script>sessionStorage.x; indexedDB.open("d")</script>')).toHaveLength(2);
  expect(lintArtifact('<p>no storage</p>')).toEqual([]);
});

// tests/apps.test.ts  (admin user `u`, publisher `p`, plain user `n`)
it('first deploy creates app, v1 and default instance', …)
  // createdApp true, version.number 1, instances.length 1, instance.slug === app.slug, activeVersion 1,
  // visibility 'private', autoUpdate true, title defaults to slug, readVersionHtml returns the html byte-for-byte
it('redeploy creates v2 and activates it', …)          // createdApp false, number 2, instance.activeVersion 2
it('identical redeploy creates nothing', …)            // createdVersion false, listVersions length unchanged
it('same html with different capabilities is a new version', …)
it('deploy by non-owner is forbidden', …)              // p deploys slug owned by u → forbidden
it('deploy by role user is forbidden', …)              // n → forbidden
it('activate rolls back and fires hook', …)            // hook called with (instance, 2, 1); activeVersion 1; unknown version → not_found
it('activate to the current version does not fire the hook', …)
it('autoUpdate=false instances stay pinned on deploy', …) // set via direct SQL in the test
it('second instance has its own slug and starts at latest', …) // duplicate instance slug → conflict
it('deploy returns lint warnings', …)
it('rejects html over 16 MiB and empty html', …)       // invalid_argument
```

- [ ] **Step 3: Run `npm test`; expect failures for missing modules.**

- [ ] **Step 4: Implement.** Schema (single migration, `PRAGMA user_version`): `users(id, email UNIQUE COLLATE NOCASE, name, role, password_hash, created_at)`, `apps(id, slug UNIQUE, title, owner_id, created_at)`, `versions(app_id, number, sha256, size_bytes, capabilities JSON, note, created_by, created_at, PRIMARY KEY(app_id, number))`, `instances(id, app_id, slug UNIQUE, owner_id, active_version, auto_update, visibility, created_at)`. Version HTML is written to `<dataDir>/apps/<appId>/versions/<number>/index.html` (write to a temp name, then rename). Password hash format `scrypt$<saltHex>$<hashHex>` (N=16384, 64-byte key). `deploy` and `activate` run inside a SQLite transaction; hooks run before the `UPDATE`. `activate` and `setVisibility` require `userId === instance.ownerId`, else `forbidden`. `lintArtifact` returns one German warning per matched API (`localStorage`, `sessionStorage`, `indexedDB`), each naming the API and telling the author to use `claude.use("db")`.

- [ ] **Step 5: Run `npm test` and `npm run typecheck`; both pass.**

- [ ] **Step 6: Commit** `feat: scaffold project and platform core`.

---

### Task 2: Instance data store, rules, snapshots, core wiring

**Files:**
- Create: `src/data/paths.ts`, `src/data/query.ts`, `src/data/rules.ts`, `src/data/hub.ts`, `src/data/store.ts`, `src/core.ts`
- Test: `tests/data-store.test.ts`, `tests/data-rules.test.ts`, `tests/core.test.ts`

**Interfaces:**
- Consumes: Task 1 `Config`, `LagerError`, `Users`, `Apps`, `DbRule`, `RuleLevel`, `Instance`, `openPlatformDb`.
- Produces:

```ts
// src/data/hub.ts
export type HubEvent = { type: 'change'; path: string; parent: string } | { type: 'reset' };
export class Hub { publish(instanceId: string, e: HubEvent): void; subscribe(instanceId: string, fn: (e: HubEvent) => void): () => void }

// src/data/paths.ts
export function parseDocPath(path: string): { parent: string; id: string };   // throws invalid_argument
export function assertCollectionPath(path: string): void;                      // throws invalid_argument
export function assertDocData(data: unknown): asserts data is Record<string, unknown>;

// src/data/query.ts
export type WhereOp = '=='|'!='|'<'|'<='|'>'|'>='|'in'|'not-in'|'array-contains'|'array-contains-any';
export interface QuerySpec { where?: [string, WhereOp, unknown][]; orderBy?: [string, 'asc'|'desc'][]; limit?: number }

// src/data/rules.ts
export type Level = 'none'|'view'|'interact'|'admin'|'owner';
export interface Viewer { userId: string | null; level: Level }
export function canRead(rules: DbRule[] | undefined, viewer: Viewer, path: string): boolean;  // path: doc or collection path
export function canWrite(rules: DbRule[] | undefined, viewer: Viewer, path: string): boolean;

// src/data/store.ts
export interface Doc { path: string; id: string; data: Record<string, unknown>; version: number;
  createdAt: string; updatedAt: string; updatedBy: string | null }
export interface SnapshotInfo { id: string; label: string; createdAt: string; sizeBytes: number }
export interface AcquireResult { acquired: boolean; version?: number; expiresAt?: string; holder?: string }
export class InstanceData {
  constructor(dataDir: string, hub: Hub, snapshotKeep: number);
  get(instanceId: string, path: string): Doc | null;
  set(instanceId: string, path: string, data: Record<string, unknown>, by: string | null): Doc;     // full replace
  update(instanceId: string, path: string, data: Record<string, unknown>, by: string | null): Doc;  // recursive merge, creates if missing
  delete(instanceId: string, path: string): boolean;
  query(instanceId: string, collectionPath: string, spec?: QuerySpec): Doc[];
  acquire(instanceId: string, path: string, opts: { holder: string; ttlMs?: number; data?: Record<string, unknown> }, by: string | null): AcquireResult;
  hasData(instanceId: string): boolean;
  snapshot(instanceId: string, label: string): SnapshotInfo | null;   // null when the instance has no data file
  listSnapshots(instanceId: string): SnapshotInfo[];                  // newest first
  restore(instanceId: string, snapshotId: string): void;              // snapshots current state first with label 'pre-restore'
  close(): void;
}

// src/core.ts
export interface Core { config: Config; users: Users; apps: Apps; data: InstanceData; hub: Hub; close(): void }
export function createCore(config: Config): Core;  // opens db, ensureAdmin, registers the snapshot hook
```

- [ ] **Step 1: Write failing tests.**

```ts
// tests/data-store.test.ts
it('set/get/update/delete roundtrip', …)
  // set → version 1; set again → version 2 and old fields gone; update merges nested: {a:{x:1}} + {a:{y:2}} → {a:{x:1,y:2}};
  // update on missing doc creates it; delete returns true then false; get missing → null
it('query filters, sorts, limits', …)
  // docs t1{n:1,tags:['a']}, t2{n:2,tags:['b']}, t3{n:3,done:true,meta:{k:'z'}}
  // where n>=2 → [t2,t3]; where tags array-contains 'a' → [t1]; where meta.k == 'z' → [t3]; where n in [1,3] → [t1,t3];
  // orderBy n desc limit 2 → [t3,t2]; default order is by id ascending; docs of subcollection tasks/t1/sub are not returned
it('limits', …)
  // each throws LagerError invalid_argument: path 'a//b', 'a' passed as doc path, 'a/b' passed as collection path,
  // 18-segment path, segment of 201 bytes, data = 300 KiB string, data nested 33 levels, data = [] , data = null
it('publishes change events', …)       // hub receives {type:'change', path:'tasks/t1', parent:'tasks'} for set, update and delete
it('instances are isolated', …)        // same path in two instanceIds holds different data; separate files on disk
it('acquire grants, refuses, expires', …)
  // first holder acquired true; second holder acquired false; same holder re-acquire true; after ttl (use vi.useFakeTimers) second holder true;
  // data option is merged into the doc on grant
it('snapshot and restore', …)
  // snapshot returns info with label; listSnapshots newest first; write more; restore brings old data back;
  // after restore listSnapshots has an extra 'pre-restore' entry; hub got {type:'reset'}; snapshot on an instance without data returns null
it('keeps only snapshotKeep snapshots', …)   // keep=2, take 4 → 2 newest remain
it('data survives reopening', …)             // close(), new InstanceData on same dir → doc still there

// tests/data-rules.test.ts
const owner = {userId:'o', level:'owner'}, ed = {userId:'e', level:'interact'}, vw = {userId:'v', level:'view'}, anon = {userId:null, level:'view'}, none = {userId:'x', level:'none'};
it('defaults', …)                 // read: owner/ed/vw/anon true, none false; write: owner/ed true, vw/anon/none false
it('prefix rule raises minimum', …) // rules [{path:'votes', read:'view', write:'owner'}] → ed cannot write votes/a, owner can; ed can still write tasks/t
it('{self} rule', …)              // + {path:'votes/{self}', write:'interact'} → ed writes votes/e, not votes/v; owner writes any (prefix rule)
it('most specific rule wins', …)  // rules on 'a' and 'a/b/c': path a/b/c/d uses the second
it('self level is held by nobody', …) // {path:'signoffs', read:'view', write:'self'},{path:'signoffs/{self}', read:'view', write:'interact'} → owner cannot write signoffs/e; e can
it('private user area', …)        // data/users/e/x: e read+write true; owner false/false; anon false; rules cannot loosen it
it('anonymous never writes', …)   // even with {path:'open', write:'view'}

// tests/core.test.ts
it('bootstraps admin', …)                         // createCore with adminEmail/adminPassword → users.count() === 1
it('activate snapshots data and keeps it', …)
  // deploy v1, write doc, deploy v2 → listSnapshots length 1 with label 'v1-to-v2'; write doc2 under v2;
  // activate v1 → both docs still readable, snapshot 'v2-to-v1' exists
it('deploy without data creates no snapshot', …)
```

- [ ] **Step 2: Run `npm test`; expect failures.**

- [ ] **Step 3: Implement.** One SQLite file per instance at `<dataDir>/instances/<instanceId>/data.sqlite`, opened lazily and cached, WAL mode; table `docs(path TEXT PRIMARY KEY, parent TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, version INTEGER NOT NULL, created_at TEXT, updated_at TEXT, updated_by TEXT, lease_holder TEXT, lease_expires TEXT)` plus an index on `parent`. `query` loads rows by `parent` and filters/sorts in JS; field names are dot paths; comparisons between different JSON types are false; `limit` must be 1..1000 (default 1000). Snapshots are `VACUUM INTO` files in `<dataDir>/instances/<instanceId>/snapshots/<id>.sqlite`, `id = <UTC yyyymmddThhmmssSSSZ>-<label>`, label restricted to `[a-z0-9-]`. `restore` closes the cached handle, replaces `data.sqlite` (and removes `-wal`/`-shm`), reopens, publishes `reset`. `acquire` default `ttlMs` 30000, max 300000. Rules: split paths into segments; a rule matches when its segments are a prefix of the path's segments, `{self}` matching only `viewer.userId`; the matching rule with the most segments supplies `read`/`write` (each falls back to the default when omitted); level order `view < interact < admin < owner`; `self` and `none` never satisfy. `createCore` registers `apps.onBeforeActivate((inst, from, to) => data.snapshot(inst.id, \`v${from}-to-v${to}\`))`.

- [ ] **Step 4: Run `npm test` and `npm run typecheck`; both pass.**

- [ ] **Step 5: Commit** `feat: per-instance document store with rules and snapshots`.

---

### Task 3: HTTP server, sessions, instance serving and data API

**Files:**
- Create: `src/http/tokens.ts`, `src/http/app.ts`, `src/http/platform.ts`, `src/http/instance.ts`, `src/http/inject.ts`, `src/http/errors.ts`, `src/server.ts`, `src/runtime/runtime.js` (placeholder: `/* runtime */`, replaced in Task 4)
- Test: `tests/http-tokens.test.ts`, `tests/http-inject.test.ts`, `tests/http-platform.test.ts`, `tests/http-instance.test.ts`

**Interfaces:**
- Consumes: Task 2 `Core`, `canRead`, `canWrite`, `Viewer`, `Level`, `QuerySpec`; Task 1 `instanceUrl`, `LagerError`.
- Produces:

```ts
// src/http/tokens.ts — HMAC-SHA256 signed, base64url `<payload>.<sig>`
export function signToken(payload: Record<string, unknown>, secret: string, ttlSeconds: number): string;
export function verifyToken<T>(token: string | undefined, secret: string): T | null;   // null on bad sig, expired, malformed

// src/http/inject.ts
export function injectRuntime(html: string): string;

// src/http/errors.ts
export function sendError(res: Response, err: unknown): void;        // LagerError → mapped status; anything else → 500 {error:{code:'internal'}} and console.error
export function safeReturnPath(value: unknown): string;              // returns '/' unless value is a string starting with '/' and not with '//' or '/\\'

// src/http/app.ts
export function sessionUser(core: Core, req: Request): User | null;  // platform cookie `lager_session`
export function requireUser(core: Core): RequestHandler;             // platform routes: 401 JSON for /api, redirect to /login for pages
export interface PlatformExtension { (router: express.Router, core: Core): void }
export function createHttpApp(core: Core, extensions?: PlatformExtension[]): express.Express;  // extensions mount extra platform-host routes (Tasks 5, 6)
```

HTTP surface (hostname compared without port; `req.hostname` with `trust proxy` = `config.trustProxy`):

Platform host (`config.publicUrl.hostname`):
- `GET /healthz` → `200 {"ok":true}`.
- `GET /login?return=` → German login form. `POST /login` (urlencoded `email`, `password`, `return`) → sets `lager_session` (signed `{uid}`, 30 days, `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` when publicUrl is https, no `Domain`) and redirects to `safeReturnPath(return)`; wrong credentials → `401` form with message `E-Mail oder Passwort ist falsch.`; more than 10 failed attempts per IP in 15 minutes → `429`.
- `POST /logout` → clears cookie, redirects to `/login`.
- `GET /auth/instance?slug=&return=` → no session: redirect to `/login?return=<this url path+query>`; unknown slug: 404; viewer level `none`: 403 German page; else redirect to `<instanceUrl>/__lager/callback?code=<signToken({uid, iid, k:'code'}, 60)>&return=<safeReturnPath>`.
- Any other platform path not handled by an extension → 404.

Instance host (`<slug>.<appsDomain>`; unknown slug → 404 German page):
- Viewer resolution: cookie `lager_inst` = `signToken({uid, iid, k:'inst'}, 30 days)`; valid only when `iid === instance.id`. Level: `uid === instance.ownerId` → `owner`; else visibility `users` and signed in → `interact`; visibility `public` → `view` (also anonymous); else `none`.
- `GET /__lager/callback?code=&return=` → verify code (`k==='code'`, `iid` matches) → set `lager_inst` (`HttpOnly`, `SameSite=Lax`, `Path=/`, no `Domain`) → redirect to `safeReturnPath(return)`; invalid → 400.
- `GET /` and `GET /index.html` → level `none` and no user: `302` to `<publicUrl>/auth/instance?slug=<slug>&return=/`; level `none` with user: 403; else `200` `injectRuntime(html of activeVersion)` with headers `Content-Type: text/html; charset=utf-8`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`.
- `GET /__lager/runtime.js` → the file `src/runtime/runtime.js`, `Content-Type: text/javascript; charset=utf-8`, `Cache-Control: no-cache` with ETag.
- `GET /__lager/session` → `{viewer:{id,name,email,level,isOwner,canEdit}, instance:{id,slug,appSlug,version}, capabilities, loginUrl}`; anonymous viewer has `id:null,name:"",email:null`; `canEdit` = level is `admin` or `owner`; `email` is `null` unless `capabilities.user.scopes` includes `"email"`; level `none` → `401` with `loginUrl` in the error body.
- `GET /__lager/users?ids=a,b` → `{profiles:{[id]:{id,name,email,isMe}}}` for existing users, max 100 ids, same email rule; requires level ≥ `view`.
- `POST /__lager/db` (JSON, limit 512 kB; requires header `X-Lager-Request: 1`, else 403) with body `{op, path, data?, query?, options?}`:
  - `get` → `{doc: Doc|null}`; `query` (`path` = collection, `query` = QuerySpec) → `{docs: Doc[]}`; `set`/`update` → `{doc}`; `delete` → `{ok:true}`; `add` (`path` = collection; server generates a 20-char id) → `{doc}`; `acquire` (`options` = `{holder, ttlMs?, data?}`) → AcquireResult.
  - Permission: reads need `canRead`, writes need `canWrite`, with rules from the active version's `capabilities.db.rules`; denied → `403 {error:{code:'forbidden'}}`; unknown op → 400.
- `GET /__lager/db/events` → SSE; requires level ≥ `view`; sends `event: change` with `{path,parent}` only for paths the viewer `canRead`, `event: reset`, and a `: ping` comment every 25 s; unsubscribes on close.
- Any other path → 404.

Any other hostname → 404 plain text.

`src/server.ts`: `loadConfig(process.env)` → `createCore` → `createHttpApp(core, [])` → listen on `config.port`; logs the platform URL; closes core on SIGTERM/SIGINT.

- [ ] **Step 1: Write failing tests** (Supertest with `.set('Host', …)`; config `publicUrl=http://lager.localhost:8080`, `appsDomain=apps.localhost`; helper `login()` returns the platform cookie; helper `enter(slug)` walks `/auth/instance` → callback and returns the instance cookie).

```ts
// tests/http-tokens.test.ts
it('roundtrips', …); it('rejects tampered payload', …); it('rejects expired', …)  // vi.useFakeTimers
it('rejects garbage', () => { for (const t of [undefined, '', 'a', 'a.b', 'a.b.c']) expect(verifyToken(t, s)).toBeNull(); });

// tests/http-inject.test.ts
const TAG = '<script src="/__lager/runtime.js"></script>';
it('after <head>', () => expect(injectRuntime('<!doctype html><html><head><title>x</title></head></html>')).toBe('<!doctype html><html><head>' + TAG + '<title>x</title></head></html>'));
it('uppercase and attributes', () => expect(injectRuntime('<HTML><HEAD lang="de"><BODY>')).toContain('<HEAD lang="de">' + TAG));
it('no head: after <html>', () => expect(injectRuntime('<html><body>x</body></html>')).toBe('<html>' + TAG + '<body>x</body></html>'));
it('fragment: after doctype or at start', () => { expect(injectRuntime('<!DOCTYPE html><p>x</p>')).toBe('<!DOCTYPE html>' + TAG + '<p>x</p>'); expect(injectRuntime('<p>x</p>')).toBe(TAG + '<p>x</p>'); });
it('injects exactly once', () => expect(injectRuntime('<head></head><head></head>').split(TAG).length).toBe(2));
it('ignores <header>', () => expect(injectRuntime('<header>x</header>')).toBe(TAG + '<header>x</header>'));

// tests/http-platform.test.ts
it('healthz', …)
it('login sets an HttpOnly host-only cookie', …)       // Set-Cookie contains HttpOnly, SameSite=Lax, no Domain=
it('wrong password → 401', …); it('11th failed login → 429', …)
it('return must be a local path', …)                   // return=https://evil.example, //evil.example, /\evil → Location '/'
it('unknown host → 404', …)

// tests/http-instance.test.ts  (app 'workout' deployed by admin; second app 'other')
it('private instance redirects anonymous to the platform', …) // 302 Location starts with http://lager.localhost:8080/auth/instance?slug=workout
it('handshake yields a page with the runtime injected', …)    // 200, body contains TAG, Cache-Control no-store
it('cookie for A rejected on B', …)                           // workout cookie sent to other.apps.localhost → 302 to auth
it('handshake code for A rejected on B', …)                   // 400
it('code cannot be used as session cookie', …)                // set lager_inst=<code> → treated as anonymous
it('public instance serves anonymous with level view', …)     // /__lager/session → viewer.id null, level 'view'
it('session reports owner', …)                                // isOwner true, canEdit true, instance.version 1, email null without scope
it('db roundtrip', …)                                         // set → get → query → update → delete via POST /__lager/db
it('db requires X-Lager-Request', …)                          // 403
it('db endpoint maps errors', …)                              // path 'a//b' → 400 invalid_argument; unknown op → 400; anonymous write on public → 403
it('db honours capabilities rules', …)                        // deploy with rules [{path:'locked', write:'self'}] → owner set locked/x → 403
it('serves the newly active version after rollback, data intact', …)
it('events stream delivers a change', …)                      // start real server on port 0, read SSE with fetch + cookie, write a doc, expect event within 2 s
it('unknown instance slug → 404', …)
```

- [ ] **Step 2: Run `npm test`; expect failures.**
- [ ] **Step 3: Implement** per the HTTP surface above. Parse cookies by hand (no cookie-parser dependency). `injectRuntime` uses one case-insensitive regex per case: `<head(\s[^>]*)?>`, then `<html(\s[^>]*)?>`, then `<!doctype[^>]*>`, else prepend.
- [ ] **Step 4: Run `npm test` and `npm run typecheck`; both pass.** Then `LAGER_PUBLIC_URL=http://lager.localhost:8080 LAGER_APPS_DOMAIN=apps.localhost LAGER_DATA_DIR=./data LAGER_ADMIN_EMAIL=a@b.c LAGER_ADMIN_PASSWORD=test npx tsx src/server.ts` starts and `curl -s -H 'Host: lager.localhost' localhost:8080/healthz` prints `{"ok":true}`; stop it.
- [ ] **Step 5: Commit** `feat: http server with host routing, sessions and instance data api`.

---

### Task 4: Browser runtime

**Files:**
- Modify: `src/runtime/runtime.js` (replace placeholder; plain ES2020, one IIFE, no build step, no imports)
- Test: `tests/runtime.test.ts` (Vitest with `// @vitest-environment jsdom`; evaluates the file's source in the jsdom window with stubbed `fetch` and `EventSource`)

**Interfaces:**
- Consumes: Task 3 endpoints `/__lager/session`, `/__lager/users`, `/__lager/db`, `/__lager/db/events` exactly as specified there.
- Produces: `window.claude.use(name)`, `window.claude.complete`, `window.storage` in every served page.

The contract to match is the Claude artifact runtime. Its type definitions are the authority for shapes and semantics; read these before writing code (read-only reference, do not copy them into the repo):
`/private/tmp/claude-501/bundled-skills/2.1.321/b67091c188ad831055cdc8d5cb834423/artifact-capabilities/0.2.96/claude.d.ts`, `db.d.ts`, `user.d.ts`, `permissions.d.ts`.

Required behaviour:
- `window.claude` is a frozen object with `use(name): Promise<namespace|null>` (memoized per name; never throws; unknown name → `null`) and `complete()` which rejects with `Error('claude.complete is not available on this Lager server')`.
- The session is fetched once (`GET /__lager/session`, `credentials: 'same-origin'`), lazily on first `use`. A `401` or network failure makes `db` resolve `null`; `user` still resolves (anonymous values).
- `use('db')` → frozen `{doc(path), collection(path)}`; `null` when `viewer.level` is absent. References implement every member of `DocumentReference`, `CollectionReference` and `Query` from `db.d.ts`: `doc.get/set/update/delete/acquire/onSnapshot/collection`, `collection.doc(id?)` (auto id: 20 chars `[A-Za-z0-9]`), `collection.add`, immutable chaining `where/orderBy/limit`, `get`, `onSnapshot`. Snapshots carry `metadata: {fromCache:false, hasPendingWrites:false}`; `DocumentSnapshot.data()` returns `undefined` when `exists` is false; `QuerySnapshot.docChanges()` reports `added|modified|removed` with `oldIndex/newIndex` relative to the previous snapshot of that listener (first snapshot: all `added`).
- Requests are `POST /__lager/db` with headers `Content-Type: application/json` and `X-Lager-Request: 1`. A response `{error:{code,message}}` rejects with `{code, message}` where server `forbidden` → `not_granted`, `invalid_argument` → `invalid_argument`, anything else → `unavailable`.
- `onSnapshot`: emits the current state once, then re-fetches and emits again when a relevant event arrives (doc listener: `change.path === path`; query listener: `change.parent === collection path`; `reset`: all listeners). One shared `EventSource('/__lager/db/events')` for the page, opened on the first listener and closed when the last unsubscribes. A listener emits only when the result differs from its previous emission (compare doc `version`s and ids). Fetch errors go to the listener's `error` callback when given.
- `use('user')` → frozen object with `isOwner()`, `canEdit()`, `can(capability)` (`'data.write'` → `true` when level is `interact|admin|owner`, `false` when `view`; any other name → `null`), `id()`, `me()` (`{id,name,avatarUrl:'',color,email,isOwner,canEdit}`), `name()`, `email()`, `avatarUrl()` → `null`, `profiles(ids)` (accepts array or string; `GET /__lager/users?ids=`; missing ids are absent; entries `{id,name,avatarUrl:'',color,email,isMe,guest:false}`; results cached per id), `search(q)` → `[]`. `color` is a deterministic `hsl(<hash(id) % 360> 65% 45%)`. These never reject.
- `use('permissions')` → `{state(name?), request(names?), manage()}`: `state('db')` → `'granted'`; `state()` → `{db:'granted', user:'granted'}`; `request` resolves the same map; `manage()` resolves `undefined`.
- `window.storage` (claude.ai chat compatibility, all async): `set(key, value, shared=false)` → `{key, value, shared}`; `get(key, shared=false)` → `{key, value, shared}` and throws `Error('Key not found: <key>')` when missing; `delete(key, shared=false)` → `{key, deleted:true, shared}`; `list(prefix='', shared=false)` → `{keys: string[], prefix, shared}` sorted. Keys must be non-empty strings ≤ 200 chars, values strings. Storage location: shared → doc `kv/<encodeURIComponent(key)>`, personal → `data/users/<viewer.id>/kv/<encodeURIComponent(key)>`, doc data `{key, value}`. Personal calls reject with `Error('Not signed in')` for anonymous viewers.

- [ ] **Step 1: Write failing tests.** One test per bullet above, named: `use is memoized and unknown names resolve null`, `db is null when the session is 401`, `doc set/get/update/delete send the right requests`, `missing doc snapshot`, `collection add and auto ids`, `query chaining is immutable and sends where/orderBy/limit`, `error codes are mapped`, `doc onSnapshot emits initial and on matching change only`, `query onSnapshot reports docChanges`, `EventSource is shared and closed after last unsubscribe`, `reset re-emits`, `user namespace for owner`, `user namespace for anonymous`, `profiles caches and omits unknown ids`, `permissions are granted`, `storage personal and shared map to the right doc paths`, `storage.get throws on a missing key`, `storage.list filters by prefix`, `claude.complete rejects`, `window.claude is frozen`. The stubbed `fetch` records `[url, init]` and answers from an in-memory map; the stubbed `EventSource` exposes `emit(type, data)`.
- [ ] **Step 2: Run `npx vitest run tests/runtime.test.ts`; expect failures.**
- [ ] **Step 3: Implement `src/runtime/runtime.js`.**
- [ ] **Step 4: Run `npm test` and `npm run typecheck`; both pass.**
- [ ] **Step 5: Commit** `feat: browser runtime compatible with claude.use`.

---

### Task 5: API tokens, REST API, MCP endpoint with OAuth

**Files:**
- Create: `src/platform/tokens.ts`, `src/http/api.ts`, `src/mcp/tools.ts`, `src/mcp/oauth.ts`, `src/mcp/http.ts`, `src/guide.md`
- Modify: `src/platform/db.ts` (migration 2: `api_tokens`, `oauth_clients`, `oauth_codes`, `oauth_tokens`), `src/core.ts` (add `tokens: ApiTokens`), `src/server.ts` (pass extensions), `package.json` build script (copy `src/guide.md`)
- Test: `tests/tokens.test.ts`, `tests/api.test.ts`, `tests/mcp.test.ts`, `tests/oauth.test.ts`

**Interfaces:**
- Consumes: Task 3 `createHttpApp(core, extensions)`, `PlatformExtension`, `sessionUser`, `sendError`, `safeReturnPath`; Task 2 `Core`; Task 1 `Apps`, `instanceUrl`.
- Produces:

```ts
// src/platform/tokens.ts
export interface ApiTokenInfo { id: string; name: string; userId: string; createdAt: string; lastUsedAt: string | null }
export class ApiTokens {
  constructor(db: DatabaseSync, users: Users);
  create(userId: string, name: string): { token: string; info: ApiTokenInfo };  // token = 'lgr_' + 32 random bytes base64url; only its SHA-256 is stored
  verify(token: string): User | null;                                           // updates lastUsedAt
  list(userId: string): ApiTokenInfo[]; revoke(userId: string, id: string): boolean;
}
// src/core.ts: Core gains `tokens: ApiTokens`

// src/http/api.ts
export const apiExtension: PlatformExtension;        // mounts /api/*
export function bearerUser(core: Core, req: Request): User | null;  // API token or OAuth access token from Authorization header

// src/mcp/tools.ts
export function buildMcpServer(core: Core, user: User): McpServer;   // registers all tools for this user
export function describeDeploy(core: Core, r: DeployResult): object; // {app, version, createdVersion, urls: string[], warnings}

// src/mcp/http.ts
export const mcpExtension: PlatformExtension;        // mounts /mcp and the OAuth routes
```

REST (platform host; auth = `Authorization: Bearer <lgr_ token | OAuth access token>`, or the session cookie together with header `X-Lager-Request: 1`; otherwise `401`):
- `PUT /api/apps/:slug` — body either `text/html` (raw, limit 16 MiB; query params `title`, `note`, `capabilities` as JSON string) or `application/json` `{html, title?, note?, capabilities?}` → `200 describeDeploy(...)`.
- `GET /api/apps` → `{apps:[{slug,title,latestVersion,instances:[{slug,url,activeVersion,visibility}]}]}` (own apps only).
- `GET /api/apps/:slug` → same shape for one app plus `versions:[{number,createdAt,note,sizeBytes}]`.
- `POST /api/instances/:slug/activate` `{version}` → instance JSON.
- `POST /api/tokens` `{name}` → `{token, info}`; `GET /api/tokens`; `DELETE /api/tokens/:id`. Token management is allowed with the session cookie only (not with a bearer token).

MCP (platform host):
- `POST /mcp` — Streamable HTTP transport from `@modelcontextprotocol/sdk` in stateless mode (a fresh `McpServer` + transport per request, `sessionIdGenerator: undefined`); `GET`/`DELETE /mcp` → 405. No valid bearer → `401` with header `WWW-Authenticate: Bearer resource_metadata="<publicUrl>/.well-known/oauth-protected-resource"`.
- Server info name `lager`; `instructions` = the first section of `src/guide.md` (everything before the first line that is exactly `---`).
- Tools (zod input schemas; every result is one text content block holding JSON; domain errors return `isError: true` with the German message):
  - `deploy_app {slug, html, title?, capabilities?, note?}` → `describeDeploy`
  - `list_apps {}`; `get_app {slug}` (same shapes as REST)
  - `activate_version {instance, version}`; `create_instance {app, slug, visibility?}`; `set_visibility {instance, visibility}`
  - `db_read {instance, path, where?, orderBy?, limit?}` — even segment count → `{doc}`; odd → `{docs}`
  - `db_write {instance, ops: [{op:'set'|'update'|'delete', path, data?}]}` (max 100 ops) → `{applied}`
  - `list_snapshots {instance}`; `restore_snapshot {instance, snapshot}`
  - `get_guide {}` → full `src/guide.md`
  - `instance`/`app` arguments are slugs. Every tool that touches an instance or app requires the caller to own it (`forbidden` otherwise). `db_read`/`db_write` act as the owner but still refuse paths under `data/users/<other id>/`.
- OAuth 2.1 authorization server, implemented with the SDK's server-auth helpers (`mcpAuthRouter` and an `OAuthServerProvider`; check the installed SDK version's README/types for the exact API before coding):
  - Metadata at `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource`; issuer = `publicUrl` origin.
  - Dynamic client registration (`/register`) persisted in `oauth_clients`.
  - `/authorize`: PKCE `S256` required; no platform session → redirect to `/login?return=<original path+query>`; with session → German consent page naming the client and its redirect host, with a POST form (hidden CSRF token = `signToken({uid, k:'consent', q:<sha256 of query>}, 600)`); approve issues a one-time code (10 min, stored hashed) and redirects to the client's registered `redirect_uri` with `code` and `state`; deny redirects with `error=access_denied`.
  - `/token`: `authorization_code` (verifies PKCE, redirect_uri, client) and `refresh_token` (rotating). Access tokens: opaque random, 1 hour; refresh tokens: 30 days; both stored hashed in `oauth_tokens`. `/revoke` supported.
  - `bearerUser` accepts a valid access token as that user.

`src/guide.md` (German, written for Claude as reader): first section (before `---`) ≤ 15 lines: what Lager is; build the artifact exactly like a Claude artifact; durable data only via `await claude.use("db")`, never `localStorage`/`sessionStorage`/`indexedDB`; declare `capabilities` (`{db:{}, user:{}}`) in the deploy call; deploy with `deploy_app` instead of publishing a claude.ai artifact, or with `curl -X PUT --data-binary @file` to `/api/apps/<slug>` when a shell and an `LAGER_TOKEN` are available; report the returned URL and warnings. After `---`: supported capabilities (`db`, `user`, `permissions`; all others resolve `null` — design for absence), the db rule syntax with the two examples from the spec's contract (`votes` and `signoffs`), limits, versions/rollback tools, instances, seeding data with `db_write` after deploy instead of hardcoding it, `window.storage` compatibility.

- [ ] **Step 1: Write failing tests.**

```ts
// tests/tokens.test.ts
it('create/verify/revoke', …)   // token starts with 'lgr_'; verify → user; DB row does not contain the token; revoked → null; garbage → null

// tests/api.test.ts
it('PUT text/html deploys and returns the url', …)     // urls[0] === 'http://workout.apps.localhost:8080', createdVersion true
it('PUT application/json with capabilities', …)
it('no auth → 401; bad token → 401', …)
it('cookie without X-Lager-Request → 401', …)
it('GET /api/apps lists only own apps', …)
it('activate over REST', …)
it('token management needs the session cookie', …)     // bearer → 403
it('body over 16 MiB → 413 or 400', …)

// tests/mcp.test.ts  (use the SDK Client with StreamableHTTPClientTransport against a real server on port 0, bearer = API token)
it('lists the eleven tools and exposes instructions', …)
it('deploy_app then get_app', …)
it('deploy_app surfaces lint warnings', …)
it('activate_version rolls back', …)
it('db_write then db_read', …)                         // set tasks/t1, read doc and collection
it('db_read refuses another user\'s private area', …)  // isError true
it('restore_snapshot restores data', …)
it('tools on a foreign app are forbidden', …)          // second publisher user
it('no bearer → 401 with WWW-Authenticate resource_metadata', …)

// tests/oauth.test.ts
it('metadata documents are served', …)
it('full code flow with PKCE yields a token that works on /mcp', …)  // register → authorize (with session cookie) → consent POST → token → POST /mcp initialize 200
it('authorize without session redirects to /login with return', …)
it('wrong code_verifier is rejected', …)
it('code is single use', …)
it('refresh rotates and the old refresh token stops working', …)
it('consent POST without valid csrf token → 403', …)
it('redirect_uri must match the registered one', …)
```

- [ ] **Step 2: Run `npm test`; expect failures.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test` and `npm run typecheck`; both pass.**
- [ ] **Step 5: Commit** `feat: api tokens, rest api and mcp endpoint with oauth`.

---

### Task 6: Dashboard, Docker packaging, skill, docs, end-to-end test

**Files:**
- Create: `src/http/dashboard.ts`, `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `.env.example`, `README.md`, `skill/lager/SKILL.md`, `examples/notes.html`
- Modify: `src/server.ts` (add `dashboardExtension`)
- Test: `tests/dashboard.test.ts`, `tests/e2e.test.ts`

**Interfaces:**
- Consumes: Task 5 `apiExtension`, `mcpExtension`, `Core.tokens`; Task 3 `PlatformExtension`, `requireUser`, `signToken`/`verifyToken`.
- Produces: `export const dashboardExtension: PlatformExtension` (mounts `GET /` and `POST /ui/*`).

Dashboard (platform host, session required, German, server-rendered, no client framework, one inline `<style>`, light/dark via `prefers-color-scheme`, usable at 375 px width):
- `GET /` — header with the signed-in e-mail and a logout button; section „Claude verbinden" showing the connector URL `<publicUrl>/mcp`; section „Apps" listing own apps, each with its instances (link to the instance URL, active version, visibility `<select>` with options „Privat", „Alle Angemeldeten", „Öffentlich"), its versions (number, date, note, size; button „Aktivieren" per instance for non-active versions) and snapshots per instance (label, date, button „Wiederherstellen"); section „API-Tokens" (list, create form, revoke button; a new token is shown once on the page rendered after creation). Empty state when there are no apps: „Noch keine Apps. Verbinde Claude und lass ein Artefakt deployen."
- `POST /ui/instances/:slug/activate` (`version`), `POST /ui/instances/:slug/visibility` (`visibility`), `POST /ui/instances/:slug/restore` (`snapshot`), `POST /ui/tokens` (`name`), `POST /ui/tokens/:id/revoke` — each requires hidden field `csrf` = `signToken({uid, k:'ui'}, 12 h)` bound to the session user (403 otherwise), then redirects to `/`.
- Every interpolated value is HTML-escaped.

Packaging:
- `Dockerfile`: multi-stage on `node:24-slim`; build stage `npm ci && npm run build`; runtime stage copies `dist`, `package*.json`, runs `npm ci --omit=dev`, `USER node`, `ENV LAGER_DATA_DIR=/data`, `VOLUME /data`, `EXPOSE 8080`, `HEALTHCHECK` hitting `/healthz` with the platform Host header via `node -e`, `CMD ["node","dist/server.js"]`.
- `docker-compose.yml`: one service `lager`, `build: .`, `env_file: .env`, `ports: ["8080:8080"]`, `volumes: ["./data:/data"]`, `restart: unless-stopped`.
- `.env.example`: every variable from the spec with a German one-line comment.
- `README.md` (German): what Lager is; quick start with Docker; local try-out with `*.localhost`; reverse-proxy setup with Nginx Proxy Manager (two proxy hosts → same port: the platform host and `*.<apps domain>` with a wildcard certificate via DNS challenge, WebSocket/SSE note: disable proxy buffering for `/__lager/db/events`); connecting Claude (custom connector URL for claude.ai/Desktop, `claude mcp add --transport http lager <url>/mcp` for Claude Code, API token alternative); installing the skill; backup (copy the data directory); what Stage 1 does not include.
- `skill/lager/SKILL.md`: frontmatter `name: lager`, `description:` (German; triggers when the user wants an artifact, small app or tool built and a Lager connector is available) and a body equal to the content of `src/guide.md` (the test asserts the bodies match so they cannot drift).
- `examples/notes.html`: a small artifact (notes list) written like a Claude artifact: uses `claude.use("db")` with `onSnapshot` on collection `notes`, `claude.use("user")`, degrades when `db` is `null`, no browser storage.

- [ ] **Step 1: Write failing tests.**

```ts
// tests/dashboard.test.ts
it('redirects to /login without session', …)
it('shows empty state', …)                      // contains 'Noch keine Apps'
it('lists apps, versions, snapshots and the connector url', …)
it('activate via form rolls back', …)           // then instance.activeVersion === 1, response 302 to '/'
it('form without csrf → 403', …)
it('escapes titles', …)                         // app title '<script>alert(1)</script>' appears escaped
it('new token is shown once', …)
it('skill body equals guide', …)                // SKILL.md after frontmatter, trimmed === src/guide.md trimmed

// tests/e2e.test.ts  (real server on port 0; undici/fetch with explicit Host header via a tiny http helper)
it('deploy → open → store → redeploy → rollback keeps data', async () => {
  // 1. create API token through core; PUT /api/apps/notes with examples/notes.html → url returned
  // 2. GET instance '/' without cookie → 302 to platform /auth/instance
  // 3. login on platform, follow /auth/instance → /__lager/callback → instance cookie
  // 4. GET '/' → 200 containing the runtime tag and the example's markup; GET /__lager/runtime.js → 200 non-empty JS
  // 5. POST /__lager/db set notes/n1 {text:'hello'}; query notes → 1 doc
  // 6. PUT changed html → version 2; GET '/' serves the changed markup; query notes → still 1 doc
  // 7. POST /api/instances/notes/activate {version:1}; GET '/' serves v1 markup; notes/n1 still 'hello'
  // 8. core.data.listSnapshots(instance.id) has labels 'v1-to-v2' and 'v2-to-v1'
});
```

- [ ] **Step 2: Run `npm test`; expect failures.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test`, `npm run typecheck`, `npm run build`; all pass.** Run `docker build -t lager:dev .`; it succeeds (if the Docker daemon is not running, say so in the report instead of skipping silently).
- [ ] **Step 5: Commit** `feat: dashboard, docker packaging, skill and docs`.
