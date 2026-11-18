# AI providers and AI groups — design

Date: 2026-11-18 · Status: draft for approval

## Intent

Today the administrator connects exactly one language model provider with one model, one API key and one
hourly request limit that applies to every signed-in person (`src/platform/ai.ts`, settings keys `ai_*`).
The administrator wants to decide, per group of people, **which model answers** and **how many requests per
hour** they may send — and to be able to use **several providers at once** (for example Anthropic for one
group, a local Ollama for everyone else).

## Goals

- Several named providers, each with its own type (preset), API key and optional server address.
- **AI groups**: each is a name + provider + model + requests per hour. Every person is in **at most one** AI
  group; people in none use the default AI group "Everyone else".
- One provider key can serve several AI groups with different models (no re-entering keys).
- Existing installations keep working unchanged after the upgrade.

## Non-goals

- Token budgets, daily/monthly quotas or cost accounting. The limit stays *requests per hour*.
- Persisting the request counter. It stays in memory and starts over on restart, as today.
- Changing the existing sharing groups (`groups`, `group_members`, grants). AI groups are separate and do not
  affect app access; sharing groups keep allowing several memberships.
- Choosing an AI group on invitation or registration. New people start in "Everyone else".
- Apps choosing the model. `window.claude.complete` is unchanged; the server picks the model from the caller.
- Per-group answer length. *Longest answer* (`ai_max_tokens`) stays one global setting.

## Anti-goals

- A key must never be sent to a provider other than the one it was entered for, and never shown again
  (only its last four characters), as today.
- App viewers must never learn which provider/AI group they are in beyond the `model` field already returned,
  nor see provider error details (those stay admin-only / server log).
- No AI group may silently point at nothing.

## Approaches considered

- **A. Providers, then AI groups that pick a provider + model + limit (chosen).** Keys entered once; one
  provider serves several models. Slightly more UI than B.
- **B. Self-contained model setups.** Each entry has provider, key, model and limit. Fewer screens but the same
  key is typed and rotated in several places.
- **C. AI settings on each sharing group's page.** No answer for someone in two groups and keys copied
  everywhere. Rejected.

The administrator picked **A**, and then chose that a person belongs to only one group for AI, kept **separate
from the sharing groups** (rather than limiting sharing groups to one per person everywhere). With one group per
person, the ordered rule list of the first draft is unnecessary: an AI group *is* its rule.

## Decided design

### Data

New migration (appended to `MIGRATIONS` in `src/platform/db.ts`):

- `ai_providers(id TEXT PK, name TEXT NOT NULL UNIQUE COLLATE NOCASE, type TEXT NOT NULL, base_url TEXT,
  key_enc TEXT, created_at TEXT NOT NULL)` — `type` is a `ProviderId` from `PRESETS`; `key_enc` uses the
  existing AES-GCM `v1:` format and key derivation.
- `ai_groups(id TEXT PK, name TEXT NOT NULL UNIQUE COLLATE NOCASE, provider_id TEXT, model TEXT NOT NULL
  DEFAULT '', hourly_limit INTEGER NOT NULL, created_at TEXT NOT NULL)` — one row with the fixed id `default`
  is "Everyone else" (name shown translated, cannot be deleted or renamed). `provider_id NULL` means *no model
  for these people* ("Off").
- `ALTER TABLE users ADD COLUMN ai_group_id TEXT` — `NULL` means the default AI group.
- Data migration in the same step: if `ai_provider` is set, create one provider from `ai_provider`,
  `ai_base_url`, `ai_key` (ciphertext copied as is — same derivation) named after the preset label (for
  `custom`, a fixed name such as "Custom server"), and the default AI group from `ai_model` + `ai_hourly_limit`.
  If `ai_provider` is set but `ai_model` is empty (today: "not configured"), the provider is created but the
  default AI group is Off. If nothing is set, the default AI group is Off with the default limit (60). Then delete
  `ai_provider`, `ai_model`, `ai_base_url`, `ai_key`, `ai_hourly_limit`. `ai_max_tokens` stays.

### Resolution

`AiModels.groupFor(userId)` → the user's `ai_group_id` row, or `default` when it is `NULL` or points at a row
that no longer exists. Its provider/model/limit are used for the call. No provider, or a provider that lacks a
required key, means "not available for this person". An AI group with a provider always has a non-empty model:
the form refuses a provider without a model (no silent fallback to `modelHint`).

### Request path (`src/http/instance-complete.ts`)

- Resolve the AI group after the existing access checks.
- No usable model for this person → `503 not_configured` ("No language model is available to you."), so pages
  keep handling a single, already documented code.
- Rate limit: one in-memory counter per person; the check uses the person's current AI group limit at the
  moment of the request. `RateLimiter` gains a per-call max (`hit(key, max)`), so changing a limit or moving a
  person takes effect at once without resetting anyone's window.
- The three-in-flight cap, signed-in + contributor requirement and global max-tokens cap are unchanged.

### Admin: AI model page (`/admin/ai`)

1. **Providers** — table (name, type, address, key hint) with edit/delete; an "Add provider" form (name, type,
   key, address). Editing keeps the key when the field is left empty; changing the type **or the server
   address** drops the key (stricter than today, so a stored key never follows an address change to another
   host; a provider that needs a key then asks for it again). Each provider has a **Test** button that sends
   `TEST_PROMPT` with the model of the first AI group using that provider, else the preset's `modelHint`.
   Deleting a provider that any AI group uses is refused with a message naming those groups.
2. **AI groups** — table (name, provider or Off, model, requests/hour, number of people) with edit/delete; an
   "Add AI group" form. "Everyone else" is always listed last, editable (provider, model, limit) but not
   deletable. Deleting an AI group moves its people to "Everyone else" (`ai_group_id = NULL`).
3. **Longest answer** — the existing global field.

### Admin: Users page (`/admin/users`)

New column **AI group**: a select per person (Everyone else + every AI group) with a save button, built like
the existing role select (`POST /admin/users/:id/ai-group`).

All new strings in `en`, `de`, `es`, `fr` (the i18n coverage test enforces this). Forms are plain POST + CSRF +
redirect like the rest of `admin.ts`.

### Other touch points

- `core.ai.configured` → true when at least one AI group points at a usable provider (admin status line).
- `src/guide.md`, `skill/lager/SKILL.md`, README: "the administrator decides per person which model answers".
- Tests: migration from old settings (with key, without key, provider without model, nothing set); resolution
  (assigned, default, deleted group, Off, provider missing key); per-person limit changes take effect at once;
  provider delete refusal; AI group delete moves people to default; key dropped on type/address change and
  never sent to a different provider; admin forms incl. users AI-group select.

## Calls made while writing (not discussed with the administrator)

- Any AI group, "Everyone else" included, can be Off (no model).
- Counter is per person; the current AI group's limit applies at each request.
- "No model for you" reuses the `not_configured` error code.
- An AI group with a provider must name a model; migration of a provider-without-model becomes Off.
- Changing a provider's address drops its stored key.
- Provider Test uses the first AI group's model for that provider, else the preset example.
- AI groups are assigned only on the Users page (not on invite).

## Left to the builder

- Exact route names, HTML layout within existing UI helpers (`settingRow`, `dataTable`, `form`).
- Whether edit forms are inline in table rows or on sub-pages (`/admin/ai/providers/:id`,
  `/admin/ai/groups/:id`), following what the sharing-groups page does.
- Name limits (reuse `MAX_NAME` = 60 from `groups.ts`).
- Whether the migration is a SQL step or a JS step run after the SQL migrations.
