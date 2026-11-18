# AI Providers and AI Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the administrator connect several language model providers and put each person in one AI group that decides provider, model and requests per hour.

**Architecture:** Two new platform tables (`ai_providers`, `ai_groups`) plus `users.ai_group_id`, filled from the old `ai_*` settings by a SQL migration. `AiModels` (`src/platform/ai.ts`) becomes the owner of providers, AI groups and assignments and resolves a per-person *route* that `complete()` takes. The complete endpoint resolves the route per request and rate-limits with the route's limit; the admin AI page is rebuilt as provider and AI-group lists with edit sub-pages, and the Users page gets an AI group select.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Node `node:sqlite`, Express, server-rendered HTML helpers in `src/http/ui.ts`, vitest + supertest.

**Spec:** `docs/superpowers/specs/2026-11-18-ai-providers-group-rules-design.md`

## Global Constraints

- Keys: stored with the existing AES-GCM `v1:` format and `lager-ai-key:${secret}` derivation; shown only as `…` + last four characters; never sent to a provider other than the one entered for.
- Changing a provider's **type or server address** drops its stored key unless a new key is entered in the same save.
- Requests per hour: whole number 1…`HOURLY_LIMIT_MAX` (10 000); default 60 (`DEFAULT_HOURLY_LIMIT`).
- Longest answer stays global (`ai_max_tokens`, 1…`MAX_TOKENS_LIMIT`, default `DEFAULT_MAX_TOKENS`).
- Names (provider, AI group): trimmed, 1…60 characters (`MAX_NAME` from `groups.ts`), unique case-insensitively within their table.
- The default AI group has the fixed id `default`, stored name `''`, shown as the translated "Everyone else"; it cannot be renamed or deleted; it is listed last.
- An AI group with a provider must have a non-empty model without whitespace (≤ 200 chars). Provider `null` = Off.
- No usable route for a person → `503` with code `not_configured`, message `No language model is available to you.`
- Viewers never see provider details; `AiError.detail` goes to the server log / admin test only (unchanged).
- Sharing groups (`groups`, `group_members`, grants) are not touched.
- Every new UI string exists in `en`, `de`, `es`, `fr`; keys no longer used are removed (the i18n coverage test fails on unused keys). German uses "du", like the existing strings.

## Review Focus

- Editing a provider and leaving the key field empty without changing type or address keeps the key → test in Task 2.
- The server secret changed, so a stored key no longer decrypts → that person gets `not_configured`, and no request goes out without a key → tests in Tasks 2 and 3.
- Lowering a group's limit below what a person already used this hour → their very next request is `429` → test in Task 3.
- A form posted from a stale page for a deleted provider or AI group → a 404 notice, not a 500 → test in Task 4.
- "Family" vs "family" as names → a conflict notice, nothing stored → tests in Tasks 2 and 4.

---

### Task 1: Migration to providers, AI groups and assignments

**Files:**
- Modify: `src/platform/db.ts` (append one migration; `export` the `MIGRATIONS` array)
- Test: `tests/ai-migration.test.ts` (create)

**Interfaces:**
- Produces: tables `ai_providers(id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, type TEXT NOT NULL, base_url TEXT, key_enc TEXT, created_at TEXT NOT NULL)`, `ai_groups(id TEXT PRIMARY KEY, name TEXT NOT NULL, provider_id TEXT, model TEXT NOT NULL DEFAULT '', hourly_limit INTEGER NOT NULL, created_at TEXT NOT NULL)` with `CREATE UNIQUE INDEX ai_groups_name ON ai_groups(name COLLATE NOCASE) WHERE id != 'default'`, column `users.ai_group_id TEXT`. The migrated provider has id `migrated`.

- [ ] **Step 1: Write the failing tests**

Helper in the test: create a temp dir, open `new DatabaseSync(<dir>/platform.sqlite)`, run `MIGRATIONS.slice(0, -1)` and set `PRAGMA user_version` to `MIGRATIONS.length - 1`, insert settings rows, close, then `openPlatformDb(dir)`.

- `migrates a connected provider with key and limit`: settings `ai_provider=anthropic`, `ai_model=claude-opus-5-5`, `ai_key=v1:a:b:c`, `ai_hourly_limit=25`, `ai_max_tokens=900` → `ai_providers` has one row `{id:'migrated', name:'Anthropic (Claude)', type:'anthropic', base_url:null, key_enc:'v1:a:b:c'}`; `ai_groups` has `{id:'default', name:'', provider_id:'migrated', model:'claude-opus-5-5', hourly_limit:25}`; settings keys `ai_provider, ai_model, ai_base_url, ai_key, ai_hourly_limit` are gone; `ai_max_tokens` is still `900`.
- `migrates a custom server with its address`: `ai_provider=custom`, `ai_model=m`, `ai_base_url=http://10.0.0.2:8000/v1` → provider name `Custom server`, `base_url` kept, `key_enc` null.
- `provider without model becomes Off`: `ai_provider=openai`, no `ai_model` → provider row exists; default group `provider_id` is null.
- `nothing configured`: no settings → no providers; default group with `provider_id` null and `hourly_limit` 60.
- `bad stored limit falls back to 60`: `ai_hourly_limit=abc` → 60.
- `fresh database has the default group`: `openPlatformDb` on an empty dir → exactly one `ai_groups` row, id `default`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/ai-migration.test.ts`
Expected: FAIL (`MIGRATIONS` not exported / tables missing).

- [ ] **Step 3: Implement the migration**

Append one SQL string to `MIGRATIONS`: the two tables, the index, the `ALTER TABLE users`, then `INSERT … SELECT` from `settings` for the provider (name via `CASE value` over the preset labels from `PRESETS`, `custom` → `'Custom server'`, `ollama` → `'Ollama'`; only when `value` is one of the nine `ProviderId`s), the default group (`provider_id` = `'migrated'` only when that row exists **and** `ai_model` is non-empty; `hourly_limit` = the stored value when it casts to an integer 1…10000, else 60), and `DELETE FROM settings WHERE key IN ('ai_provider','ai_model','ai_base_url','ai_key','ai_hourly_limit')`. Use `strftime('%Y-%m-%dT%H:%M:%fZ','now')` for `created_at`.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/ai-migration.test.ts`
Expected: PASS. Other suites may now fail on the old `AiModels`; that is fixed in Task 2.

- [ ] **Step 5: Commit**

```bash
git add src/platform/db.ts tests/ai-migration.test.ts
git commit -m "feat: migrate AI settings to providers and AI groups"
```

---

### Task 2: `AiModels` owns providers, AI groups and routes

**Files:**
- Modify: `src/platform/ai.ts` (replace `view`/`configure`/`provider`/`hourlyLimit`/`AiConfigView`/`AiConfigInput`; keep presets, `AiError`, parsing, `stripReasoning`, `isTruncated`)
- Test: `tests/ai.test.ts` (rewrite the configuration and `complete` sections against the new API; keep the `stripReasoning`/parsing tests)

**Interfaces:**
- Consumes: Task 1 tables.
- Produces (all exported from `src/platform/ai.ts`):

```ts
export const DEFAULT_GROUP = 'default';
export interface AiProvider { id: string; name: string; type: ProviderId; baseUrl: string; keyHint: string | null; createdAt: string }
export interface AiProviderInput { name: string; type: ProviderId; baseUrl?: string; /** undefined keeps the stored key, '' removes it */ apiKey?: string }
export interface AiGroup { id: string; name: string; providerId: string | null; model: string; hourlyLimit: number; memberCount: number; isDefault: boolean }
export interface AiGroupInput { name: string; providerId: string | null; model?: string; hourlyLimit: number }
export interface AiRoute { groupId: string; providerId: string; model: string; hourlyLimit: number }

class AiModels {
  listProviders(): AiProvider[]                     // by name
  getProvider(id: string): AiProvider | null
  createProvider(input: AiProviderInput): AiProvider
  updateProvider(id: string, input: AiProviderInput): AiProvider
  deleteProvider(id: string): void                  // conflict, reason 'ai_provider_in_use', when an AI group uses it
  groupsUsing(providerId: string): AiGroup[]
  listGroups(): AiGroup[]                           // by name, default last
  getGroup(id: string): AiGroup | null
  createGroup(input: AiGroupInput): AiGroup
  updateGroup(id: string, input: AiGroupInput): AiGroup   // default: name ignored
  deleteGroup(id: string): void                     // default → forbidden; members' ai_group_id → NULL
  groupIdOf(userId: string): string                 // DEFAULT_GROUP when NULL or dangling
  assign(userId: string, groupId: string): void     // DEFAULT_GROUP stores NULL; unknown group or user → not_found
  routeFor(userId: string): AiRoute | null          // null: Off, provider gone, or key required but missing/undecryptable
  testRoute(providerId: string): AiRoute            // model: first AI group (by name) using it, else PRESETS[type].modelHint; limit 1
  get configured(): boolean                         // some AI group has a usable route
  get maxTokens(): number
  setMaxTokens(n: number): void
  complete(route: AiRoute, messages: ChatMessage[], opts?: { maxTokens?: number; signal?: AbortSignal }): Promise<Completion>
}
```

Validation failures throw `LagerError('invalid_argument', <message>, 'ai_invalid')`; name clashes throw `LagerError('conflict', …, 'ai_name_taken')`; missing ids throw `LagerError('not_found', …)`.

- [ ] **Step 1: Write the failing tests** (in `tests/ai.test.ts`, reusing its `setup()` and fake fetch)

- `providers store the key encrypted and show only its end`: `createProvider({name:'Work', type:'anthropic', apiKey:'sk-ant-secret-1234'})` → `keyHint === '…1234'`; raw `key_enc` starts with `v1:` and does not contain `secret`.
- `editing without a key keeps it; changing type or address drops it`: create openai with key `sk-abcd`; `updateProvider(id,{name:'Work', type:'openai'})` → hint `…abcd`; `updateProvider(id,{name:'Work', type:'openai', baseUrl:'https://proxy.example/v1'})` → throws `/needs an API key/` and the stored key/address are unchanged; the same with `apiKey:'sk-new1'` → hint `…new1`; `updateProvider(id,{name:'Work', type:'ollama'})` → hint `null`.
- `provider names are unique ignoring case`: `Work` then `work` → `conflict`; table has one row.
- `rejects bad provider input without storing it`: unknown type, `custom` without address, address `ftp://x`, address with `user:pw@`, name `''`, name of 61 chars → all throw; `listProviders()` is empty.
- `cannot delete a provider an AI group uses`: create provider + group using it → `deleteProvider` throws with `reason === 'ai_provider_in_use'`; after `deleteGroup`, `deleteProvider` succeeds.
- `AI group needs a model when it has a provider`: `createGroup({name:'Fam', providerId:p, model:'', hourlyLimit:5})` → throws; `model:'has space'` → throws; `hourlyLimit:0` and `10001` → throw; `providerId:'nope'` → `not_found`; `providerId:null, model:''` → ok.
- `default group is listed last, cannot be deleted or renamed`: `listGroups().at(-1)!.id === 'default'`; `deleteGroup('default')` throws `forbidden`; `updateGroup('default',{name:'X', providerId:null, hourlyLimit:9})` keeps name `''` and sets limit 9.
- `assignment and resolution`: user A assigned to group G (provider p, model `m-small`, limit 7) → `routeFor(A)` equals `{groupId:G, providerId:p, model:'m-small', hourlyLimit:7}`; user B unassigned → route of the default group or `null` when default is Off; `assign(A,'default')` stores NULL; `deleteGroup(G)` → `groupIdOf(A) === 'default'`; `assign(A,'nope')` → `not_found`; `memberCount` of G was 1.
- `a key that no longer decrypts makes the route unavailable`: create provider with key under secret `s1`, then `new AiModels(db, 's2', fake)` → `routeFor(user)` is `null`, `configured` is `false`, `sent` is empty.
- `complete sends to the route's provider with that provider's key only`: two providers (anthropic key `sk-ant-1`, openai key `sk-oa-2`), two groups, two users → each `complete(routeFor(u)!, …)` hits its own base URL with its own header (`x-api-key: sk-ant-1` vs `authorization: Bearer sk-oa-2`) and its own model; neither request carries the other key.
- Keep the existing `complete` tests (max-tokens cap, refusal, 429, timeout, bad response, reasoning stripping), changing only how they configure: `createProvider` + `updateGroup('default', …)` + `complete(ai.routeFor(userId)!, …)` (insert a user row directly or via `Users`).

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/ai.test.ts`
Expected: FAIL (new methods missing).

- [ ] **Step 3: Implement the new `AiModels` API in `src/platform/ai.ts`**

Ids via `crypto.randomUUID()`. `complete` reads provider type, base URL and key from the route's `providerId` at call time; a provider that vanished or whose key fails → `AiError('not_configured', …, 503)`. Reuse the existing `encrypt`/`decrypt`, URL and key validation from `configure`. `maxTokens` keeps the `ai_max_tokens` setting. Delete `view`, `configure`, `provider`, `hourlyLimit` and their types.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/ai.test.ts tests/ai-migration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/platform/ai.ts tests/ai.test.ts
git commit -m "feat: several AI providers and AI groups with per-person routes"
```

---

### Task 3: Complete endpoint uses the person's route and limit

**Files:**
- Modify: `src/http/ratelimit.ts` (add an optional per-call max)
- Modify: `src/http/instance-complete.ts`
- Test: `tests/http-complete.test.ts` (switch setup from `core.ai.configure` to providers/groups; add cases)

**Interfaces:**
- Consumes: `core.ai.routeFor(userId): AiRoute | null`, `core.ai.complete(route, messages, opts)`.
- Produces: `RateLimiter.hit(key: string, max?: number): boolean` — `max` overrides the constructor's budget for this call; existing callers unchanged.

- [ ] **Step 1: Write the failing tests**

- `routes each person to their AI group's model`: two providers, groups G1 (model `a-model`) and G2 (model `b-model`), users u1∈G1, u2∈G2 with `interact` grants → `env.sent` bodies carry `a-model` and `b-model` respectively, and the fake receives each provider's own URL.
- `a person whose group is Off gets not_configured`: default Off, user unassigned → `503`, `error.code === 'not_configured'`, `error.message === 'No language model is available to you.'`, nothing sent.
- `the group's hourly limit applies per person and changes take effect at once`: group limit 2 → two `200`, third `429` with `Retry-After: 60`; set limit 5 → next request `200`; set limit 1 → next request `429`.
- `a key that no longer decrypts gives not_configured`: build the harness, create provider with key, then replace `core.ai` with `new AiModels(db, 'other-secret', fake)` (or the harness's equivalent) → `503 not_configured`, `sent` empty.
- Existing cases (declaration, guests, view-only, in-flight cap, provider errors stay private, abort) keep passing after the setup change.
- In `tests/ratelimit` coverage (add to this file if no ratelimit test exists): `hit('k', 1)` true, then `hit('k', 1)` false, then `hit('k', 3)` true.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/http-complete.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `ratelimit.ts`, `hit(key, max = this.max)`. In `instance-complete.ts`, drop the `limiter`/`limiterFor` rebuild; keep one `RateLimiter(HOURLY_LIMIT_MAX, WINDOW_MS)`; after the access checks call `core.ai.routeFor(userId)`; `null` → the `not_configured` reply above; then `limiter.hit(userId, route.hourlyLimit)` and `core.ai.complete(route, …)`.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/http-complete.test.ts tests/ai.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/http/ratelimit.ts src/http/instance-complete.ts tests/http-complete.test.ts
git commit -m "feat: complete uses the caller's AI group for model and hourly limit"
```

---

### Task 4: Admin pages, translations and docs

**Files:**
- Modify: `src/http/admin.ts` (`aiSection`, new `aiProviderPage`, `aiGroupPage`, `usersSection` column, routes)
- Modify: `src/i18n/en.ts`, `de.ts`, `es.ts`, `fr.ts`
- Modify: `src/guide.md`, `skill/lager/SKILL.md`, `README.md` (section "Bring your own model")
- Test: `tests/http-admin-ai.test.ts` (create), plus `tests/i18n-coverage.test.ts` must stay green

**Interfaces:**
- Consumes: Task 2 `AiModels` API.
- Produces routes (all admin-only, CSRF, plain POST + redirect, errors via `failWith`):
  - `GET /admin/ai` — status line, Providers table (name links to `/admin/ai/providers/:id`; type label via `providerLabel`; address; key hint) + "Add provider" form → `POST /admin/ai/providers`; AI groups table (name links to `/admin/ai/groups/:id`; provider name or "Off"; model; requests/hour; people) + "Add AI group" form → `POST /admin/ai/groups`; Longest answer form → `POST /admin/ai/max-tokens`; the access hint `admin.ai.access`.
  - `GET|POST /admin/ai/providers/:id` (edit), `POST /admin/ai/providers/:id/delete`, `POST /admin/ai/providers/:id/test` (uses `testRoute`, shows `admin.ai.testOk`/`admin.ai.testFailed` on the provider page).
  - `GET|POST /admin/ai/groups/:id` (edit; the default group page has no name field and no delete button), `POST /admin/ai/groups/:id/delete`.
  - `POST /admin/users/:id/ai-group` (field `group`; redirect to `/admin/users`). The Users table gets an "AI group" column with a select (Everyone else + every other AI group) and save button, built like the role select.
  - The old `POST /admin/ai` and `POST /admin/ai/test` are removed.
- Error mapping for notices: `conflict` → `admin.ai.nameTaken`, `invalid_argument` → `admin.ai.invalid`, reason `ai_provider_in_use` → `admin.ai.providerInUse` (with `{groups}`: comma-separated group names), `not_found` → `admin.ai.notFound` (404), `forbidden` on default delete → `admin.ai.defaultFixed`.

- [ ] **Step 1: Write the failing tests** (supertest against `makeHarness({ fetch: fake, extensions: [adminExtension] })`, signed in as admin, CSRF from the page)

- `adds a provider and an AI group, then assigns a person`: POST provider form → redirect `/admin/ai`, page lists the provider name and `…1234`; POST group form with that provider → listed with model and limit; POST `/admin/users/<id>/ai-group` → `core.ai.groupIdOf(id)` is the new group; Users page shows it selected.
- `the key field is never echoed`: the provider edit page HTML does not contain the full key.
- `deleting a used provider shows which groups use it`: status 409, page contains the group name, provider still exists.
- `stale ids give a 404 notice`: POST `/admin/ai/groups/<deleted>/delete` and GET `/admin/ai/providers/nope` → 404 and the `admin.ai.notFound` text, no 500.
- `name clash is a conflict notice`: provider `Family` exists, POST `family` → 409, still one provider.
- `test button reports the answer`: provider + group; POST `/admin/ai/providers/:id/test` → 200 and the page contains the fake's answer text; with a failing fake → contains the provider's error detail.
- `default AI group cannot be deleted`: POST `/admin/ai/groups/default/delete` → 403 notice, group still there.
- `non-admins get 403` on `GET /admin/ai` and `POST /admin/users/:id/ai-group`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/http-admin-ai.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement pages, routes and strings**

Follow `groupsSection`/`groupPage` for list + sub-page structure and `settingRow` for the form fields (reuse the current provider/model/key/address/limit field markup and hints). New `en` strings, translated into `de`/`es`/`fr` in the same voice: `admin.ai.providers`, `admin.ai.providers.none`, `admin.ai.providers.add`, `admin.ai.providerName`, `admin.ai.groups`, `admin.ai.groups.add`, `admin.ai.groupName`, `admin.ai.everyoneElse` ("Everyone else"), `admin.ai.people`, `admin.ai.nameTaken`, `admin.ai.providerInUse` ("Used by {groups}. Move those AI groups to another provider first."), `admin.ai.notFound`, `admin.ai.defaultFixed`, `admin.ai.deleteProvider`, `admin.ai.deleteGroup`, `admin.ai.groups.hint` ("Each person is in one AI group; everyone you have not assigned uses Everyone else."), `admin.users.aiGroup`, `admin.users.aiGroupOf` (aria label with `{email}`). Update `admin.ai.intro`, `admin.ai.status.on` (now "{count} AI groups can use a model.") and `admin.ai.key.hint` ("…Changing the type or the address removes the saved key."). Remove keys the new pages no longer use (`admin.ai.provider.hint` if unused, etc.) so the coverage test's unused check passes.

Docs: in `src/guide.md` and `skill/lager/SKILL.md`, change "the language model the server's administrator set up" to say the administrator decides per person which model answers, and that `not_configured` also means "no model for this person". In `README.md` "Bring your own model", describe Providers → AI groups → assigning people on the Users page, and that the hourly limit is per AI group.

- [ ] **Step 4: Run the whole suite and typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all tests PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/http/admin.ts src/i18n src/guide.md skill/lager/SKILL.md README.md tests/http-admin-ai.test.ts
git commit -m "feat: admin pages for AI providers, AI groups and per-person assignment"
```
