# Lager Stage 2 (Accounts and Access) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the single-admin Lager server into a multi-user platform: self-registration, roles managed by an administrator, per-instance sharing with users and groups, and separate instances of one app for different users.

**Architecture:** New framework-free modules in `src/platform` (settings, accounts, mail, groups, access) extend the existing core; the existing owner-only checks are replaced by one access module; new Express extensions (`auth`, `admin`) and a restructured dashboard expose it; REST, MCP and the browser runtime gain sharing features.

**Tech Stack:** unchanged from Stage 1 (Node ≥ 22.13, TypeScript strict ESM, Express 5, `node:sqlite`, MCP SDK, zod, Vitest, Supertest) plus `nodemailer`.

**Spec:** `docs/superpowers/specs/2026-11-11-lager-stage2-design.md` (German; binding). Stage 1 spec and code remain in force where Stage 2 does not change them.

## Global Constraints

- Everything in Stage 1's constraints still applies: strict TypeScript ESM with `.js` import suffixes; `npm test` and `npm run typecheck` pass before every commit; tests use fresh temp dirs and ephemeral ports; domain errors are `LagerError`; JSON error bodies are `{"error":{"code","message"}}`; user-facing text German, code/comments/commits English; secrets stored only as hashes, compared with `crypto.timingSafeEqual`; never commit `node_modules`, `dist`, `data`, `.env`, `.superpowers`, `.claude`.
- The only new runtime dependency is `nodemailer` (plus `@types/nodemailer` as dev dependency).
- All existing Stage 1 tests keep passing. Where Stage 2 deliberately changes behaviour, update the affected test and name it in the report; do not delete coverage.
- `LagerError` gains the code `quota_exceeded` (HTTP 507). No other new codes.
- Every state-changing HTML form posts a `csrf` field checked with the existing `csrfValid`; every state-changing JSON route keeps the existing bearer-or-cookie-plus-`X-Lager-Request` rule.
- Every interpolated value in server-rendered HTML goes through `esc`.
- Authorization is decided only through `core.access` (Task 2) or a platform-role check; no route compares `ownerId` directly.
- One-time links (verify, reset, invite) use 32 random bytes base64url, stored as SHA-256; lifetimes: verify 24 h, reset 1 h, invite 7 d.
- Minimum password length for registration, reset and change: 10 characters.
- German level names in the UI: `view` „Betrachter", `interact` „Mitwirkender", `admin` „Verwalter", `owner` „Besitzer". Role names: `admin` „Administrator", `publisher` „Publisher", `user` „Nutzer".
- Commit messages: conventional-commit subject, ending with the Co-Authored-By attribution line your own harness instructions specify.

## Review Focus

1. Privilege escalation through forged requests: a non-admin posting to `/admin/*`; an instance „Verwalter" deleting the instance or granting `owner`; a user creating an instance of an app without self-service; a collaborator deleting the app (Tasks 2, 4, 5).
2. Locking out the last active administrator by demoting or disabling them (Task 1).
3. Stale credentials: after disable, password change or logout, the old platform cookie, the old instance cookie, API tokens and OAuth tokens of a disabled user must all be rejected (Tasks 1, 3).
4. One-time link misuse: a verify token used as reset token, a used or expired token, an invite bound to another e-mail, and identical responses of „Passwort vergessen" for known and unknown addresses (Tasks 1, 3).
5. Limits under hostile use: writes past the instance quota fail with `quota_exceeded` and leave existing data readable; the per-user instance limit holds for self-service creation (Task 2, 5).

---

### Task 1: Account lifecycle, settings and mail

**Files:**
- Create: `src/platform/settings.ts`, `src/platform/mail.ts`, `src/platform/accounts.ts`
- Modify: `src/platform/db.ts` (migration 3), `src/platform/users.ts`, `src/platform/tokens.ts`, `src/mcp/oauth.ts` (bearer lookup only), `src/config.ts`, `src/core.ts`, `src/errors.ts`, `src/http/errors.ts`, `package.json`
- Test: `tests/settings.test.ts`, `tests/accounts.test.ts`, extend `tests/users.test.ts`, `tests/tokens.test.ts`, `tests/config.test.ts`

**Interfaces:**
- Consumes: Stage 1 `Users`, `ApiTokens`, `OAuthStore`, `Config`, `createCore`, `openPlatformDb`.
- Produces:

```ts
// src/errors.ts: ErrorCode gains 'quota_exceeded' (src/http/errors.ts maps it to 507)

// src/config.ts — Config gains:
smtpUrl?: string;            // LAGER_SMTP_URL, e.g. smtp://user:pass@host:587
mailFrom?: string;           // LAGER_MAIL_FROM, default 'Lager <no-reply@' + publicUrl.hostname + '>'
instanceQuotaBytes: number;  // LAGER_INSTANCE_QUOTA_MB (default 50) * 1024 * 1024

// src/platform/users.ts
export const MIN_PASSWORD_LENGTH = 10;
export interface User { /* existing fields */ verified: boolean; disabled: boolean; sessionEpoch: number }
export type LoginResult = { ok: true; user: User } | { ok: false; reason: 'invalid' | 'unverified' | 'disabled' };
// Users gains:
create(input: { email; name; password; role; verified?: boolean }): User;   // verified defaults to true; validates role → invalid_argument
checkLogin(email: string, password: string): LoginResult;                   // verifyPassword(email, pw) = checkLogin ok ? user : null
setRole(id: string, role: Role): User;            // conflict when it would leave no active (not disabled) admin
setDisabled(id: string, disabled: boolean): User; // same guard; disabling bumps the epoch
setName(id: string, name: string): User;          // 1..80 chars after trim
setPassword(id: string, password: string): void;  // < MIN_PASSWORD_LENGTH → invalid_argument; bumps the epoch
markVerified(id: string): void;
bumpEpoch(id: string): void;

// src/platform/settings.ts
export type RegistrationMode = 'open' | 'invite' | 'closed';
export class Settings {
  constructor(db: DatabaseSync, defaults: { registration: RegistrationMode });
  get registration(): RegistrationMode; setRegistration(mode: RegistrationMode): void;
  get maxInstancesPerUser(): number;    setMaxInstancesPerUser(n: number): void;   // default 20, allowed 1..1000
}

// src/platform/mail.ts
export interface Mail { to: string; subject: string; text: string }
export interface Mailer { readonly enabled: boolean; send(mail: Mail): Promise<void> }
export function createMailer(config: Config): Mailer;   // nodemailer SMTP when smtpUrl is set; otherwise enabled=false and send() resolves without sending
export class MemoryMailer implements Mailer { enabled = true; sent: Mail[] = []; send(mail: Mail): Promise<void> }

// src/platform/accounts.ts
export interface InviteInfo { id: string; email: string | null; role: Role; createdAt: string; expiresAt: string; used: boolean }
export class Accounts {
  constructor(db: DatabaseSync, users: Users, settings: Settings, mailer: Mailer, config: Config);
  register(input: { name: string; email: string; password: string; inviteToken?: string }): Promise<{ user: User; needsVerification: boolean }>;
  verifyEmail(token: string): User;
  resendVerification(email: string): Promise<void>;        // never reveals whether the address exists
  requestPasswordReset(email: string): Promise<void>;      // never reveals whether the address exists
  createResetLink(userId: string): string;                 // for administrators; returns the URL
  resetPassword(token: string, password: string): User;    // also marks the account verified
  createInvite(input: { email?: string; role: Role; createdBy: string }): Promise<{ id: string; url: string }>;
  getInvite(token: string): InviteInfo | null;             // null when unknown, used or expired
  listInvites(): InviteInfo[];                             // newest first
  revokeInvite(id: string): boolean;
}

// src/core.ts
export interface Core { /* existing */ settings: Settings; mailer: Mailer; accounts: Accounts }
export function createCore(config: Config, opts?: { mailer?: Mailer }): Core;
```

Migration 3 (one transaction, `user_version = 3`), covering the whole of Stage 2:
- `users`: add `verified_at TEXT`, `disabled_at TEXT`, `session_epoch INTEGER NOT NULL DEFAULT 0`; set `verified_at = created_at` for existing rows.
- `settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)`.
- `account_tokens(hash TEXT PRIMARY KEY, id TEXT UNIQUE NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('verify','reset','invite')), user_id TEXT, email TEXT, role TEXT, created_by TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT)`.
- `groups(id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, created_at TEXT NOT NULL)`, `group_members(group_id TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY(group_id, user_id))`.
- `grants(instance_id TEXT NOT NULL, principal_type TEXT NOT NULL CHECK(principal_type IN ('user','group')), principal_id TEXT NOT NULL, level TEXT NOT NULL CHECK(level IN ('view','interact','admin')), created_by TEXT, created_at TEXT NOT NULL, PRIMARY KEY(instance_id, principal_type, principal_id))`.
- `app_collaborators(app_id TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY(app_id, user_id))`.
- `apps`: add `self_instances TEXT NOT NULL DEFAULT 'off'`. `instances`: add `users_level TEXT NOT NULL DEFAULT 'interact'`, `disabled_at TEXT`.

Behaviour:
- `register`: mode `closed` → `forbidden`; mode `invite` → a valid invite token is required (`forbidden` otherwise); mode `open` → an invite token is optional. An invite bound to an e-mail only works for that address (case-insensitive). Role comes from the invite, else `user`. Password shorter than 10 → `invalid_argument`; duplicate e-mail → `conflict`. The account is verified immediately when an invite was used or `mailer.enabled` is false; otherwise it is unverified and a verification mail is sent. The invite is consumed in the same transaction as the insert.
- Links: `<publicUrl>/verify?token=…`, `<publicUrl>/reset?token=…`, `<publicUrl>/register?invite=…`.
- Mail subjects: „Lager: E-Mail-Adresse bestätigen", „Lager: Passwort zurücksetzen", „Lager: Einladung". Body: two or three German sentences, the link on its own line, and the validity period.
- A token works only for its own kind, once, before expiry; otherwise `invalid_argument`.
- `checkLogin` checks the password first; a correct password on a disabled account → `disabled`, on an unverified one → `unverified`; anything else → `invalid` (same timing as today).
- `ApiTokens.verify` and the OAuth access-token lookup return no user when the user is disabled.
- Default registration mode when nothing is stored: `open` if `mailer.enabled`, else `invite`.

- [ ] **Step 1: Write failing tests.**

```ts
// tests/users.test.ts (added)
it('new fields default', …)                         // verified true, disabled false, sessionEpoch 0; create({verified:false}) → verified false
it('checkLogin reasons', …)                         // wrong pw → invalid; disabled + right pw → disabled; unverified + right pw → unverified; disabled + wrong pw → invalid
it('cannot demote or disable the last active admin', …)   // conflict; works once a second active admin exists; a disabled admin does not count
it('setPassword enforces length and bumps the epoch', …)  // 9 chars → invalid_argument; epoch +1; old password no longer verifies
it('disabling bumps the epoch, enabling does not', …)
it('create rejects an unknown role', …)             // invalid_argument

// tests/settings.test.ts
it('defaults and persistence', …)                   // registration from defaults; set → survives reopening the db; maxInstancesPerUser 20; 0 and 1001 → invalid_argument

// tests/accounts.test.ts  (MemoryMailer unless stated)
it('open registration sends a verification mail', …)        // needsVerification true; mail to address; link token verifies; user.verified true afterwards
it('verification link is single use and kind-bound', …)     // second verifyEmail → invalid_argument; using it in resetPassword → invalid_argument
it('expired tokens fail', …)                                // fake timers: verify after 24 h + 1 s, reset after 1 h + 1 s, invite after 7 d + 1 s
it('without mailer accounts are verified at once', …)       // createMailer(config without smtpUrl).enabled false; needsVerification false
it('invite mode requires a valid invite', …)                // no token → forbidden; bad token → forbidden; good token → user with invite role, verified, invite used
it('invite bound to an e-mail rejects other addresses', …)  // forbidden; matching address in other letter case works
it('invite is consumed atomically', …)                      // duplicate e-mail with a valid invite → conflict and the invite stays usable
it('closed mode refuses', …)                                // forbidden
it('short password and duplicate e-mail', …)                // invalid_argument, conflict
it('password reset flow', …)                                // mail sent; resetPassword sets pw, bumps epoch, marks verified; token single use
it('reset and resend do not reveal unknown addresses', …)   // resolve without throwing and send no mail
it('admin reset link works', …)
it('invites list and revoke', …)                            // revoked invite → getInvite null

// tests/tokens.test.ts (added)
it('tokens of a disabled user stop working', …)             // ApiTokens.verify → null; OAuth access token lookup → no user

// tests/config.test.ts (added)
it('mail and quota settings', …)                            // instanceQuotaBytes default 50 MiB; LAGER_INSTANCE_QUOTA_MB=1 → 1048576; mailFrom default contains the public hostname
```

- [ ] **Step 2: Run `npm test`; expect failures.**
- [ ] **Step 3: Implement.** `npm install nodemailer` and `@types/nodemailer` (dev). Keep every existing public signature working.
- [ ] **Step 4: Run `npm test` and `npm run typecheck`; both pass.**
- [ ] **Step 5: Commit** `feat: account lifecycle, settings and mail`.

---

### Task 2: Access model — groups, grants, collaborators, instance lifecycle, quota

**Files:**
- Create: `src/platform/groups.ts`, `src/platform/access.ts`
- Modify: `src/platform/apps.ts`, `src/data/store.ts`, `src/core.ts`, `src/http/instance.ts`, `src/http/platform.ts`, `src/http/dashboard.ts`, `src/http/api.ts`, `src/mcp/tools.ts`, `src/http/pages.ts`, `src/runtime/runtime.js` (error mapping only)
- Test: `tests/groups.test.ts`, `tests/access.test.ts`, extend `tests/apps.test.ts`, `tests/data-store.test.ts`, `tests/http-instance.test.ts`, `tests/runtime.test.ts`

**Interfaces:**
- Consumes: Task 1 `User` (with `disabled`), `Settings`, migration 3 tables; Stage 1 `Apps`, `InstanceData`, `Level`.
- Produces:

```ts
// src/platform/groups.ts
export interface Group { id: string; name: string; createdAt: string; memberCount: number }
export class Groups {
  constructor(db: DatabaseSync, users: Users);
  create(name: string): Group;                 // 1..60 chars; duplicate name → conflict
  rename(id: string, name: string): Group; delete(id: string): void;   // delete removes memberships and the group's grants
  list(): Group[]; get(id: string): Group | null; getByName(name: string): Group | null;
  members(id: string): User[]; addMember(id: string, userId: string): void; removeMember(id: string, userId: string): void;
  groupsOf(userId: string): string[];          // group ids
}

// src/platform/apps.ts — changed/added
export type SelfInstances = 'off' | 'users';
export interface App { /* existing */ selfInstances: SelfInstances }
export interface Instance { /* existing */ usersLevel: 'view' | 'interact'; disabled: boolean }
// Apps gains:
setChecks(checks: { canDeploy(app: App, userId: string): boolean; canManage(instance: Instance, userId: string): boolean }): void;
  // deploy() uses canDeploy for existing apps (first deploy still needs role admin|publisher); activate(), setVisibility(), setUsersLevel() use canManage.
  // Without setChecks the Stage 1 owner-only behaviour applies.
setUsersLevel(instanceId: string, level: 'view' | 'interact', userId: string): Instance;
setSelfInstances(appId: string, mode: SelfInstances, userId: string): App;          // owner only
addCollaborator(appId: string, userId: string, byUserId: string): void;             // owner only; target must be an active admin|publisher, else invalid_argument
removeCollaborator(appId: string, userId: string, byUserId: string): void;
listCollaborators(appId: string): User[]; isCollaborator(appId: string, userId: string): boolean;
setInstanceDisabled(instanceId: string, disabled: boolean): Instance;               // caller enforces the platform admin role
deleteInstance(instanceId: string, userId: string): void;                           // owner only; removes the row and its grants; fires onInstanceDeleted
deleteApp(appId: string, userId: string): void;   // owner only; conflict when an instance of the app is owned by someone else; deletes own instances, collaborators, versions; moves <dataDir>/apps/<appId> to <dataDir>/trash/app-<appId>-<stamp>
onInstanceDeleted(hook: (instance: Instance) => void): void;
listInstancesOwnedBy(userId: string): Instance[]; listAllApps(): App[]; listAllInstances(): Instance[];
// createInstance(): rejects with conflict („Instanz-Limit erreicht") when the owner already owns settings.maxInstancesPerUser instances and is not a platform admin; Apps receives Settings through its constructor (new last parameter).

// src/platform/access.ts
export type GrantLevel = 'view' | 'interact' | 'admin';
export interface Grant { instanceId: string; principalType: 'user' | 'group'; principalId: string; principalLabel: string; level: GrantLevel }
export class Access {
  constructor(db: DatabaseSync, users: Users, groups: Groups, apps: Apps);
  levelFor(instance: Instance, user: User | null): Level;
  listGrants(instanceId: string): Grant[];                 // principalLabel: user e-mail or group name
  setGrant(instance: Instance, principalType: 'user' | 'group', principalId: string, level: GrantLevel, by: User): void;   // by needs canManageInstance; owner as principal → invalid_argument; unknown principal → not_found
  removeGrant(instance: Instance, principalType: 'user' | 'group', principalId: string, by: User): void;
  canManageInstance(instance: Instance, user: User): boolean;   // level admin or owner
  canDeploy(app: App, user: User): boolean;                     // active, role admin|publisher, and owner or collaborator
  canCreateInstance(app: App, user: User): boolean;             // canDeploy, or app.selfInstances === 'users' for any active user
  sharedWith(user: User): Instance[];                           // via direct or group grant, not owned by the user, not disabled
  catalog(user: User): { instances: Instance[]; apps: App[] };  // instances with visibility users|public not owned by the user and not disabled; apps with selfInstances 'users'
  usersWithAccess(instance: Instance, query?: string, limit?: number): User[];   // owner, direct grantees, members of granted groups; active users only; name or e-mail contains query; default limit 20
}

// src/data/store.ts
// InstanceData constructor gains a 4th parameter quotaBytes (0 = unlimited). set/update/acquire-with-data throw LagerError('quota_exceeded') when the instance's data.sqlite is already ≥ quotaBytes. Reads and deletes always work.
usage(instanceId: string): number;      // bytes of data.sqlite, 0 without data
trash(instanceId: string): void;        // closes the handle and moves <dataDir>/instances/<id> to <dataDir>/trash/<id>-<stamp>; no-op without data

// src/core.ts
export interface Core { /* existing */ groups: Groups; access: Access }
```

`levelFor` rules: instance disabled → `none`; user disabled → treated as anonymous; owner → `owner`; otherwise the maximum of: direct grant, grants of the user's groups, `usersLevel` when visibility is `users` and a user is signed in, `view` when visibility is `public`. Anonymous viewers get `view` only on `public` instances.

Rewiring in this task (behaviour for a single owner stays as in Stage 1):
- `createCore` builds `Groups` and `Access`, calls `apps.setChecks(...)` with `access.canDeploy` / `access.canManageInstance` (looking users up by id), registers `apps.onInstanceDeleted(i => data.trash(i.id))`, and passes `config.instanceQuotaBytes` to `InstanceData`.
- `src/http/instance.ts`: remove the exported `levelFor`; use `core.access.levelFor(instance, user)` everywhere (session resolution, handshake). A disabled instance serves a German page „Diese Instanz wurde deaktiviert." with status 403 on `/`, and 403 JSON on `/__lager/*`.
- `src/http/platform.ts` (`/auth/instance`), `src/http/dashboard.ts`, `src/http/api.ts`, `src/mcp/tools.ts`: replace owner comparisons with `core.access.canManageInstance` (instance operations and `db_read`/`db_write`) and `core.access.canDeploy` (deploy); app-level reads (`get_app`, `GET /api/apps/:slug`) are allowed for owner and collaborators; lists show apps the user owns or collaborates on. `db_read`/`db_write` keep refusing `data/users/<other>/…`.
- `src/runtime/runtime.js`: map server code `quota_exceeded` to the contract's `quota_exceeded`.

- [ ] **Step 1: Write failing tests.**

```ts
// tests/groups.test.ts
it('create, rename, delete, duplicate name', …)     // conflict on duplicate (case-insensitive); delete removes memberships
it('members and groupsOf', …)                       // adding twice is idempotent; unknown user → not_found

// tests/access.test.ts  (users: owner o (publisher), e, v, x (role user), admin a; instance i of o's app)
it('owner and visibility defaults', …)              // o → owner; private: e → none, anon → none; users: e → interact (usersLevel view → view), anon → none; public: anon → view, e → view
it('direct grants raise the level', …)              // grant e interact on private → interact; grant admin → admin; public + grant interact → interact
it('group grants apply to members', …)              // v in group g, grant g view → v view; remove member → none; delete group → grant gone
it('highest level wins', …)                         // direct view + group admin → admin
it('disabled instance and disabled user', …)        // disabled instance → none for everyone incl. owner; disabled user e with grant → as anonymous
it('platform admin gets no implicit access', …)     // a → none on o's private instance
it('setGrant authorization', …)                     // x (no access) → forbidden; e with admin grant can grant v; granting the owner → invalid_argument; unknown user → not_found
it('canDeploy', …)                                  // o true; collaborator p2 (publisher) true; collaborator demoted to user → false; e false
it('canCreateInstance', …)                          // e false with selfInstances off, true with 'users'
it('sharedWith and catalog', …)                     // sharedWith(e) lists granted instance once (direct+group); catalog(e) lists users/public instances of others and self-service apps; own and disabled excluded
it('usersWithAccess', …)                            // owner + grantee + group member; query filters by name/e-mail; disabled users excluded; limit respected

// tests/apps.test.ts (added)
it('collaborator can deploy, cannot delete or change self-service', …)
it('addCollaborator needs a publisher or admin target', …)       // invalid_argument for role user; only the owner may add
it('instance admin grantee can activate and change visibility', …)   // via core (createCore wiring)
it('deleteInstance moves data to trash and removes grants', …)   // only owner; data dir gone from instances/, present under trash/; slug reusable afterwards
it('deleteApp refuses while others own instances', …)            // conflict; succeeds after those are deleted; app files moved to trash
it('instance limit per user', …)                                 // settings.maxInstancesPerUser = 2 → third createInstance conflict; platform admin exempt
it('setInstanceDisabled', …)

// tests/data-store.test.ts (added)
it('quota blocks writes but not reads or deletes', …)   // quota 64 KiB: fill until quota_exceeded; get/query still work; delete works; quota 0 = unlimited
it('usage and trash', …)

// tests/http-instance.test.ts (added)
it('grantee gets the granted level in the session', …)  // e with view grant on a private instance: handshake works, level 'view', write → 403
it('disabled instance serves the notice', …)            // 403 containing 'deaktiviert'; /__lager/session → 403
it('quota_exceeded maps to 507', …)

// tests/runtime.test.ts (added)
it('quota_exceeded is passed through', …)
```

- [ ] **Step 2: Run `npm test`; expect failures.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test` and `npm run typecheck`; both pass.**
- [ ] **Step 5: Commit** `feat: access model with groups, grants, collaborators and quota`.

---

### Task 3: Registration, verification, password reset, account page, session epochs

**Files:**
- Create: `src/http/auth.ts`, `src/http/ratelimit.ts`
- Modify: `src/http/session.ts`, `src/http/platform.ts`, `src/http/instance.ts`, `src/http/pages.ts`, `src/http/dashboard.ts` (header links only), `src/server.ts`
- Test: `tests/http-auth.test.ts`, extend `tests/http-platform.test.ts`, `tests/http-instance.test.ts`

**Interfaces:**
- Consumes: Task 1 `Accounts`, `Users.checkLogin/setName/setPassword/bumpEpoch`, `MemoryMailer`, `createCore(config, {mailer})`; Stage 1 `signToken`, `csrfToken`, `csrfValid`, `page`, `PlatformExtension`.
- Produces:

```ts
// src/http/ratelimit.ts
export class RateLimiter { constructor(max: number, windowMs: number, maxKeys?: number); hit(key: string): boolean /* false when over the limit */; reset(key: string): void }

// src/http/auth.ts
export const authExtension: PlatformExtension;   // /register, /verify, /verify/resend, /forgot, /reset, /account

// src/http/session.ts
// every signed session artefact carries the user's sessionEpoch as `ep`:
//   platform session {uid, ep}; instance cookie {uid, iid, k:'inst', ep}; handshake code {uid, iid, k:'code', jti, ep}
// sessionUser() and the instance-side checks reject a token whose ep differs from the user's current sessionEpoch, and any disabled user.
export function issueSession(core: Core, res: Response, user: User): void;   // sets the platform cookie
```

Routes (platform host, German pages using `page()`):
- `GET /register[?invite=…]` — mode `closed`: page „Die Registrierung ist geschlossen."; mode `invite` without a valid invite: page „Registrierung nur mit Einladung."; otherwise a form (Name, E-Mail, Passwort, hidden invite). An invite bound to an e-mail pre-fills that field read-only.
- `POST /register` — calls `accounts.register`. `needsVerification` → page „Wir haben dir eine E-Mail geschickt. Bestätige deine Adresse über den Link darin." Otherwise sign in (`issueSession`) and redirect to `/`. Errors re-render the form with the German message (`conflict` → „Diese E-Mail-Adresse ist bereits registriert.", short password → „Das Passwort braucht mindestens 10 Zeichen."). Rate limit: 5 registrations per IP per hour → 429.
- `GET /verify?token=…` — success: sign in and redirect to `/`; failure: page „Der Link ist ungültig oder abgelaufen." with a form posting to `/verify/resend` (e-mail). `POST /verify/resend` always answers „Falls die Adresse bei uns registriert und noch nicht bestätigt ist, haben wir eine neue E-Mail geschickt."
- `GET /forgot`, `POST /forgot` — always answers „Falls die Adresse bei uns registriert ist, haben wir eine E-Mail zum Zurücksetzen geschickt." Rate limits: 5 per IP per hour (429) and 3 per e-mail per hour (silently skipped, same page).
- `GET /reset?token=…` — form (new password); `POST /reset` — `accounts.resetPassword`, then page „Passwort geändert." with a link to `/login`; invalid token → „Der Link ist ungültig oder abgelaufen." (400).
- `GET /account` (session) — forms: name; password change (current password, new password); `POST /account/name`, `POST /account/password` (csrf). Wrong current password → „Das aktuelle Passwort ist falsch." A successful password change bumps the epoch and issues a fresh session for this browser.
- Login (`src/http/platform.ts`): use `checkLogin`; `unverified` → „Bitte bestätige zuerst deine E-Mail-Adresse." with the resend form; `disabled` → „Dieses Konto ist deaktiviert."; the login page links „Passwort vergessen?" and, unless mode is `closed`, „Konto erstellen". `POST /logout` bumps the epoch (ends every session of the account).
- Header (`page()`): signed-in pages show links „Übersicht" (`/`) and „Konto" (`/account`).
- Public auth forms (`/register`, `/forgot`, `/reset`, `/verify/resend`) have no session, so instead of `csrf` they require the request's `Origin` header (when present) to equal the platform origin; a mismatching Origin → 403.

- [ ] **Step 1: Write failing tests** (core built with `MemoryMailer` unless stated).

```ts
// tests/http-auth.test.ts
it('register → mail → verify → signed in', …)                 // POST /register 200 with the notice; link from the mail; GET /verify → 302 '/' with session cookie; dashboard 200
it('login before verification is refused with a hint', …)     // 401 containing 'bestätige'
it('registration modes', …)                                    // closed → notice, POST → 403; invite without token → notice; with valid invite → account with invite role, signed in at once
it('invite bound to an e-mail pre-fills and enforces it', …)
it('duplicate e-mail and short password re-render the form', …)   // German messages; values other than the password are kept
it('registration rate limit', …)                               // 6th POST from one IP → 429
it('forgot answers identically for known and unknown addresses', …)   // same status and body; mail only for the known one
it('forgot per-address limit is silent', …)                    // 4th request: same page, still 3 mails
it('reset flow', …)                                            // link from mail; POST new password; old password fails, new works; link reuse → 400
it('reset with a verify token fails', …)                       // 400
it('account: change name and password', …)                     // wrong current password → message; success keeps this browser signed in
it('password change ends other sessions', …)                   // second cookie jar gets redirected to /login afterwards
it('logout ends every session', …)                             // both cookie jars signed out
it('cross-origin post to a public auth form is refused', …)    // Origin: https://evil.example → 403
it('login page links', …)                                      // contains 'Passwort vergessen?' and 'Konto erstellen'; closed mode hides the latter

// tests/http-platform.test.ts (added)
it('disabled account cannot sign in and loses its session', …) // login → 401 'deaktiviert'; existing cookie → redirect to /login

// tests/http-instance.test.ts (added)
it('instance cookie dies with the epoch', …)                   // after logout/password change/disable the instance cookie yields the anonymous flow
it('handshake code from before an epoch bump is rejected', …)  // 400
```

- [ ] **Step 2: Run `npm test`; expect failures.**
- [ ] **Step 3: Implement.** Register `authExtension` in `src/server.ts` and in the shared test helper that builds the app.
- [ ] **Step 4: Run `npm test` and `npm run typecheck`; both pass.**
- [ ] **Step 5: Commit** `feat: registration, verification, password reset and account page`.

---

### Task 4: Administration area

**Files:**
- Create: `src/http/admin.ts`
- Modify: `src/http/pages.ts` (header link „Verwaltung" for administrators), `src/server.ts`
- Test: `tests/http-admin.test.ts`

**Interfaces:**
- Consumes: Task 1 `Users.setRole/setDisabled/list`, `Accounts.createInvite/listInvites/revokeInvite/createResetLink`, `Settings`; Task 2 `Groups`, `Apps.listAllApps/listAllInstances/setInstanceDisabled`, `InstanceData.usage`; Stage 1 `requireUser`, `csrfToken`, `csrfValid`, `page`, `esc`.
- Produces: `export const adminExtension: PlatformExtension;` and `export function requireAdmin(core: Core): RequestHandler` (non-admin → 403 German page; no session → redirect to `/login`).

Pages (platform host, role `admin` only, every POST with `csrf`, each POST redirects back to the page it came from unless stated):
- `GET /admin` — tabs/links to the sections below; shows the first one.
- `GET /admin/users` — table: name, e-mail, role (`<select>` + „Speichern"), status (aktiv / unbestätigt / deaktiviert), created; buttons „Deaktivieren"/„Aktivieren", „Rücksetz-Link". `POST /admin/users/:id/role`, `POST /admin/users/:id/disabled` (`disabled=1|0`), `POST /admin/users/:id/reset-link` (renders the users page with the link shown once, status 200). A `conflict` from the last-admin guard is shown as „Der letzte aktive Administrator kann nicht herabgestuft oder deaktiviert werden."
- `GET /admin/invites` — form (optional e-mail, role) and table of open invites with „Widerrufen". `POST /admin/invites` renders the page with the new link shown once (status 200) and a note whether a mail was sent; `POST /admin/invites/:id/revoke`.
- `GET /admin/groups` — list with member counts, create form; `GET /admin/groups/:id` — rename form, members table with „Entfernen", add-member form (e-mail), „Gruppe löschen". `POST /admin/groups`, `POST /admin/groups/:id/rename`, `POST /admin/groups/:id/members` (unknown e-mail → message „Kein Konto mit dieser E-Mail-Adresse."), `POST /admin/groups/:id/members/:userId/remove`, `POST /admin/groups/:id/delete`.
- `GET /admin/settings` — registration mode (`<select>`: „Offen", „Nur mit Einladung", „Geschlossen") with a note when mail is not configured („Ohne Mailversand werden E-Mail-Adressen nicht bestätigt."), max instances per user. `POST /admin/settings`.
- `GET /admin/apps` — every app with owner e-mail and its instances: slug (link), owner e-mail, active version, visibility, data size (KiB/MiB from `data.usage`), status; button „Deaktivieren"/„Aktivieren". `POST /admin/instances/:slug/disabled`. No link or control here exposes instance content.

- [ ] **Step 1: Write failing tests.**

```ts
// tests/http-admin.test.ts
it('non-admin gets 403, anonymous is redirected', …)          // for GET /admin/users and for a POST with a valid csrf of a non-admin
it('change role', …)                                          // user becomes publisher; page shows it
it('last admin guard shows a message', …)                     // POST role=user for the only admin → page with the German message, role unchanged
it('disable and enable a user', …)                            // disabled user's session cookie stops working
it('reset link is shown once and works', …)
it('create invite shows the link; revoke removes it', …)      // link registers a user with the chosen role
it('groups: create, add member by e-mail, remove, delete', …) // unknown e-mail → message
it('settings: registration mode and instance limit', …)       // persisted in core.settings
it('apps overview lists foreign apps and disables an instance', …)   // disabled instance → its host serves the notice
it('posts without csrf → 403', …)
it('escapes user-controlled names', …)                        // user name and group name '<script>' appear escaped
```

- [ ] **Step 2: Run `npm test`; expect failures.**
- [ ] **Step 3: Implement.** Register `adminExtension` in `src/server.ts` and the test helper.
- [ ] **Step 4: Run `npm test` and `npm run typecheck`; both pass.**
- [ ] **Step 5: Commit** `feat: administration area for users, invites, groups and settings`.

---

### Task 5: Home, catalog, instance and app pages with sharing

**Files:**
- Modify: `src/http/dashboard.ts` (restructure; split into `src/http/dashboard.ts` for home and `src/http/manage.ts` for the instance and app pages if it exceeds ~250 lines), `src/http/pages.ts`
- Test: rewrite `tests/dashboard.test.ts`, add `tests/http-manage.test.ts`

**Interfaces:**
- Consumes: Task 2 `Access` (all methods), `Groups.list`, `Apps` additions; Stage 1 dashboard helpers, `csrfValid`.
- Produces: `dashboardExtension` (unchanged export) now mounting the routes below; if split, `export const manageExtension: PlatformExtension` registered next to it.

Pages (platform host, session required, every POST with `csrf`, POSTs redirect back to the page they came from):
- `GET /` — „Übersicht" with sections, each omitted when empty except the first:
  - „Meine Instanzen" — instances the user owns: title, link to the instance URL, active version, visibility label, link „Verwalten" (`/instances/:slug`). Empty state: „Du hast noch keine Instanzen."
  - „Für mich freigegeben" — `access.sharedWith(user)`: title, link, the user's level label; link „Verwalten" when `canManageInstance`.
  - „Katalog" — `access.catalog(user)`: shared instances (link, owner name) and self-service apps with a form „Eigene Instanz anlegen" (slug field) posting to `/ui/apps/:slug/instances`.
  - For roles `admin`/`publisher`: „Meine Apps" (owned or collaborating: title, latest version, link `/apps/:slug`), „Claude verbinden" (connector URL) and „API-Tokens" (as in Stage 1). Role `user` sees none of these three.
- `GET /instances/:slug` — requires `canManageInstance` (else 403 page): header with URL; „Version" (versions table with „Aktivieren"); „Sichtbarkeit" (visibility select plus level select „Stufe für Angemeldete" shown for `users`); „Freigaben" (table: principal label, type „Nutzer"/„Gruppe", level select + „Speichern", „Entfernen"; add form: e-mail **or** group select, level select); „Schnappschüsse" (with „Wiederherstellen"); for the owner only „Instanz löschen" (form requiring the slug typed into a field named `confirm`).
- `GET /apps/:slug` — requires owner or collaborator: versions table; instances table (slug, owner e-mail, link); form „Instanz anlegen" (slug, optional „Besitzer (E-Mail)"); for the owner only: „Mitarbeiter" (list, add by e-mail, remove), „Selbstbedienung" (select „Aus"/„Alle Angemeldeten"), „App löschen" (`confirm` = slug).
- POST routes: existing `/ui/instances/:slug/activate|visibility|restore` (visibility also accepts `users_level`); new `/ui/instances/:slug/grants` (`email` or `group`, `level`), `/ui/instances/:slug/grants/remove` (`type`, `id`), `/ui/instances/:slug/delete` (`confirm`), `/ui/apps/:slug/instances` (`slug`, optional `owner_email`), `/ui/apps/:slug/collaborators` (`email`), `/ui/apps/:slug/collaborators/remove` (`id`), `/ui/apps/:slug/self-instances` (`mode`), `/ui/apps/:slug/delete` (`confirm`).
- Authorization per route: instance routes need `canManageInstance`, delete needs ownership; `/ui/apps/:slug/instances` needs `canCreateInstance`, and `owner_email` is honoured only with `canDeploy` (otherwise the creator becomes the owner); collaborator, self-service and delete routes need app ownership.
- Messages: unknown e-mail → „Kein Konto mit dieser E-Mail-Adresse."; wrong `confirm` → „Zur Bestätigung den Namen eingeben."; `conflict` and `invalid_argument` errors are shown as a notice on the page they came from (pass the message through a signed, short-lived `flash` query parameter or re-render; never reflect unsanitised input).
- Layout rules from Stage 1 stay: usable at 375 px without horizontal scrolling, light/dark, palette navy `#1f2a5c` / orange `#f58220`.

- [ ] **Step 1: Write failing tests** (users: publisher `p` owning app `notes` with instance `notes`; user `u`; user `w`; group `team` with `w`).

```ts
// tests/dashboard.test.ts (rewritten; keep the Stage 1 cases that still apply: redirect without session, escaping, token shown once, csrf)
it('plain user sees no publisher sections', …)                 // no 'Meine Apps', 'API-Tokens', 'Claude verbinden'; empty state text present
it('publisher sees apps, connector and tokens', …)
it('shared instance appears under „Für mich freigegeben" with the level', …)   // u with view grant → 'Betrachter'
it('catalog lists users-visible instances and self-service apps', …)
it('self-service creates an own instance', …)                  // u posts slug → instance owned by u, appears under 'Meine Instanzen'; app without self-service → 403

// tests/http-manage.test.ts
it('instance page requires manage rights', …)                  // u without grant → 403; u with admin grant → 200; anonymous → /login
it('grant by e-mail, change level, remove', …)                 // level visible in core.access.levelFor
it('grant to a group', …)                                      // w gets the level
it('unknown e-mail shows the message', …)
it('visibility with users level', …)                           // users + view → another signed-in user gets view
it('admin grantee cannot delete; owner can with confirmation', …)   // grantee → 403; wrong confirm → message and instance still there; right confirm → gone, 302 '/'
it('app page: collaborator sees it, cannot manage collaborators', …)
it('owner adds and removes a collaborator; role user is refused', …)
it('create instance for another user', …)                      // owner_email=u → u owns it; a self-service creator passing owner_email is ignored
it('instance limit message', …)                                // settings max 1 → second self-service creation shows 'Instanz-Limit erreicht'
it('delete app refuses while others own instances', …)
it('posts without csrf → 403', …)
```

- [ ] **Step 2: Run `npm test`; expect failures.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test` and `npm run typecheck`; both pass.**
- [ ] **Step 5: Commit** `feat: home, catalog and management pages with sharing`.

---

### Task 6: Sharing over REST and MCP, user search in the runtime, guide

**Files:**
- Modify: `src/http/api.ts`, `src/mcp/tools.ts`, `src/http/instance.ts`, `src/runtime/runtime.js`, `src/guide.md`, `skill/lager/SKILL.md`
- Test: extend `tests/api.test.ts`, `tests/mcp.test.ts`, `tests/http-instance.test.ts`, `tests/runtime.test.ts`

**Interfaces:**
- Consumes: Task 2 `Access`, `Groups.getByName`, `Apps.createInstance`; Stage 1 REST/MCP helpers.
- Produces:
  - REST: `GET /api/instances/:slug/grants` → `{grants:[{type,label,level}]}`; `PUT /api/instances/:slug/grants` `{email?|group?, level}` → same list; `DELETE /api/instances/:slug/grants` `{email?|group?}` → same list; `POST /api/apps/:slug/instances` `{slug, ownerEmail?, visibility?}` → instance JSON. Exactly one of `email`/`group` (group by name), else `invalid_argument`. Authorization as in Task 5.
  - MCP tools (total becomes 14): `share_instance {instance, email?, group?, level}`, `unshare_instance {instance, email?, group?}`, `list_shares {instance}` (also returns `visibility` and `usersLevel`); `create_instance` gains optional `owner_email`.
  - Instance endpoint `GET /__lager/users?q=<text>` → `{profiles:[{id,name,email,isMe}]}` from `access.usersWithAccess(instance, q, 20)`; returns an empty list unless the active version declares `capabilities.user.scopes` containing `"profile"`; requires level ≥ `view` and a signed-in viewer. The existing `?ids=` form is unchanged. E-mail only with scope `"email"` as before.
  - Runtime: `user.search(q)` calls that endpoint and returns `Profile[]` in the same shape as `profiles()` values (never rejects; `[]` on any error).
  - Guide and skill (bodies stay identical): new section „Teilen und Instanzen" explaining the two kinds of sharing (same instance = shared data via `share_instance`/visibility; own instance = separate data via `create_instance` with `owner_email` or self-service), the level names, that `user.search` needs the `profile` scope, and the quota error `quota_exceeded`.

- [ ] **Step 1: Write failing tests.**

```ts
// tests/api.test.ts (added)
it('grants over REST', …)                 // PUT by e-mail → listed; PUT by group; DELETE; both email and group → 400; non-manager → 403
it('create instance over REST', …)        // with ownerEmail as owner/collaborator; plain user without self-service → 403

// tests/mcp.test.ts (changed/added)
it('lists the fourteen tools', …)
it('share_instance, list_shares, unshare_instance', …)   // grantee's level changes accordingly
it('create_instance with owner_email', …)
it('sharing tools on a foreign instance are forbidden', …)

// tests/http-instance.test.ts (added)
it('user search needs the profile scope', …)   // without scope → []; with scope → owner and grantee matching q; anonymous → 401

// tests/runtime.test.ts (added)
it('user.search calls the endpoint and never rejects', …)
```

- [ ] **Step 2: Run `npm test`; expect failures.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test` and `npm run typecheck`; both pass.**
- [ ] **Step 5: Commit** `feat: sharing over rest and mcp, user search, guide update`.

---

### Task 7: Documentation, configuration and multi-user end-to-end test

**Files:**
- Modify: `README.md`, `.env.example`, `docker-compose.yml` (only if new variables need passing), `tests/e2e.test.ts` (keep the Stage 1 scenario)
- Test: `tests/e2e-multiuser.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–6 through HTTP only (plus `MemoryMailer` injected into the core to read mails).

README additions (German, concrete, no marketing language): section „Konten und Rollen" (registration modes and their defaults, what each role may do, how the first administrator is created, that administrators cannot read instance data); „Mailversand" (the two SMTP variables with an example, what works without mail: invitations and administrator-generated reset links); „Teilen" (same instance vs. own instance, levels, groups, self-service); „Grenzen" (quota and instance limit); „Löschen und Papierkorb" (where trashed data lies and that emptying `<dataDir>/trash` is manual); update the list of what is not included. `.env.example`: `LAGER_SMTP_URL`, `LAGER_MAIL_FROM`, `LAGER_INSTANCE_QUOTA_MB` with German one-line comments.

- [ ] **Step 1: Write the failing test.**

```ts
// tests/e2e-multiuser.test.ts  (real server on port 0, MemoryMailer, registration mode 'open')
it('invite, register, share, separate instances, revoke', async () => {
  // 1. admin signs in, creates an invite with role publisher → publisher P registers through the link (signed in at once)
  // 2. user U registers openly → mail → verify link → signed in
  // 3. P creates an API token and deploys examples/notes.html as 'notes'
  // 4. U opens the private instance → 403 after the handshake attempt
  // 5. P grants U 'view' via PUT /api/instances/notes/grants → U gets the page; U's write to notes/n1 → 403; U reads P's doc
  // 6. P raises U to 'interact' → U's write succeeds; P sees U's doc (shared data)
  // 7. P enables self-service on the app; U creates instance 'notes-u' from the catalog → its notes collection is empty (separate data); U is owner there
  // 8. admin disables U → U's platform cookie and both instance cookies stop working
  // 9. admin, who owns nothing here, cannot open P's private instance
});
```

- [ ] **Step 2: Run it; expect failure only if an earlier task left a gap — if it passes at once, say so in the report.**
- [ ] **Step 3: Write the documentation; fix nothing outside this task's files — report gaps instead.**
- [ ] **Step 4: Run `npm test`, `npm run typecheck`, `npm run build`; all pass.**
- [ ] **Step 5: Commit** `docs: accounts, roles and sharing; multi-user end-to-end test`.
