# Lager Stage 4 (App icons, home-screen install, visual redesign) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every app gets an icon that Claude supplies at deploy time (or a generated one), every instance can be added to a phone's home screen with that icon, and the whole web interface is redesigned from a plain admin look into a modern app-launcher.

**Architecture:** A new `AppIcons` module stores one SVG per app and rasterises it to PNGs with `@resvg/resvg-wasm`; instances expose a web app manifest and icon routes and get the matching `<head>` tags injected. The redesign replaces the inline CSS in `src/http/pages.ts` with a static stylesheet and a new page shell and reworks the markup of every page; handlers, authorization and catalogs stay as they are.

**Tech Stack:** unchanged, plus `@resvg/resvg-wasm` (pure WebAssembly, no native code).

**Spec:** this plan is the spec for Stage 4 (owner's request: "overhaul the design — it looks bleak and boring, not like a modern next-gen web app"; "add the hook for Claude to generate an icon when it uploads a new app through the MCP, so that apps have an icon when stored on a phone as a PWA"; an app-store-style card grid was given as loose inspiration only). Earlier specs remain in force.

## Global Constraints

- All earlier constraints apply: strict TypeScript ESM with `.js` import suffixes; `npm test` and `npm run typecheck` pass before every commit; tests use temp dirs and ephemeral ports; `LagerError` for domain errors; human-facing text only through the catalogs in `src/i18n/` (all four languages, German "du", French "vous" with ’, Spanish "tú"; "Lager", "Claude", "Publisher" untranslated); machine-facing text English; secrets only as hashes; never commit `node_modules`, `dist`, `data`, `.env`, `.superpowers`, `.claude`.
- The only new dependency is `@resvg/resvg-wasm`.
- Authorization, csrf, Origin guards, escaping, redirects and status codes of existing handlers do not change. Task 2 changes markup, styles and catalog text only.
- An SVG supplied by a client is never served to a browser in any form; only PNGs rendered from it are.
- No external resources in any page: no web fonts, CDNs, analytics or remote images. One stylesheet and at most one small script, both served from the platform host with long-lived caching and a content hash in the URL.
- Accessibility: WCAG AA contrast in both themes, visible focus on every interactive element, 44 px minimum touch targets on touch layouts, correct landmarks and heading order, `prefers-reduced-motion` respected, everything usable without JavaScript (the script only enhances).
- Layout works from 320 px to 1440 px wide without horizontal page scrolling.
- Commit messages: conventional-commit subject, ending with the Co-Authored-By attribution line your own harness instructions specify.

## Review Focus

1. A hostile SVG (scripts, external references, `<foreignObject>`, entity expansion, huge dimensions, deep nesting, embedded 50-megapixel bitmaps) must not execute anywhere, reach the network or the file system, exhaust memory or CPU, or be served back (Task 1).
2. Manifest and icon routes are public: they must reveal nothing beyond an app's name, colours and icon, and must not be usable to enumerate private data or bypass the instance access check (Task 1).
3. Injected `<head>` tags must not break or duplicate what an artifact already declares, and must not be injectable through an app's title, description or colour (Task 1).
4. The redesign must not change behaviour: every form still posts the same fields to the same route with csrf; no handler logic moves into client script (Task 2).
5. Keyboard and screen-reader use of the new navigation, menus, cards and tables; both themes; narrow screens (Task 2).

---

### Task 1: App icons, descriptions and home-screen install

**Files:**
- Create: `src/platform/icons.ts`, `src/platform/default-icon.ts`, `src/http/instance-pwa.ts`, `assets/icon-180.png`, `assets/icon-192.png`, `assets/icon-512.png` (rendered once from `assets/icon.webp` with `sips`)
- Modify: `package.json`, `src/platform/db.ts` (migration 9), `src/platform/apps.ts`, `src/core.ts`, `src/http/inject.ts`, `src/http/instance.ts` (mount, head injection), `src/http/platform.ts` (public icon and platform manifest routes), `src/http/api.ts`, `src/mcp/tools.ts`, `src/platform/check.ts`, `src/guide.md`, `skill/lager/SKILL.md`, `README.md`
- Test: `tests/icons.test.ts`, `tests/http-pwa.test.ts`, extend `tests/http-inject.test.ts`, `tests/mcp.test.ts`, `tests/api.test.ts`, `tests/check.test.ts`

**Interfaces:**
- Produces:

```ts
// src/platform/apps.ts
export interface App { /* existing */ description: string; themeColor: string; iconVersion: number }   // iconVersion bumps on every icon change (cache busting)
// Apps.deploy input gains optional `description?: string` (≤ 200 chars after trim, plain text) and `themeColor?: string` (#rgb or #rrggbb; stored as #rrggbb lower-case). Omitted on redeploy = unchanged. Defaults: '' and '#1f2a5c'.
// Apps.setAppMeta(appId, { description?, themeColor? }, userId): App   // owner or collaborator (canDeploy)

// src/platform/default-icon.ts
export function defaultIconSvg(seed: string): string;   // deterministic 512×512 SVG from the slug: two-colour gradient background and one of ≥ 8 simple geometric glyphs in white; no <text>

// src/platform/icons.ts
export const ICON_SIZES = [512, 192, 180, 64] as const;
export const MAX_ICON_SVG_BYTES = 65536;
export class AppIcons {
  constructor(dataDir: string);
  ready(): Promise<void>;                                   // loads the wasm once; idempotent
  validate(svg: string): void;                              // throws LagerError('invalid_argument', …, reason 'icon_invalid') — see rules
  set(appId: string, svg: string, themeColor: string): Promise<void>;   // validates, renders all sizes plus the maskable 512, writes atomically
  setDefault(appId: string, slug: string, themeColor: string): Promise<void>;   // only when the app has no icon yet
  has(appId: string): boolean;
  png(appId: string, size: (typeof ICON_SIZES)[number], maskable?: boolean): string | null;   // absolute file path
  remove(appId: string): void;
}
// Core gains `icons: AppIcons`. createCore stays synchronous; `core.icons.ready()` is awaited in server start-up and by tests that need it.
```

Migration 9: `apps` gains `description TEXT NOT NULL DEFAULT ''`, `theme_color TEXT NOT NULL DEFAULT '#1f2a5c'`, `icon_version INTEGER NOT NULL DEFAULT 0`.

Icon rules (`validate`): UTF-8 text ≤ 64 KiB; root element `<svg>`; refused when it contains (case-insensitively, anywhere) a `<!DOCTYPE` or `<!ENTITY`, a `<script`, `<foreignObject`, `<iframe`, `<image`, `<use` with an `href` that does not start with `#`, `<text`/`<tspan` (no fonts are available to the renderer — the guide tells Claude to draw shapes), an `on…=` attribute, or any `href`/`xlink:href`/`url(` that does not start with `#` or `data:image/` — and `data:` at all is refused for simplicity (so: only `#fragment` references). More than 2000 elements or nesting deeper than 32 → refused. Rendering uses `fitTo` width so the output size is fixed regardless of the SVG's own dimensions, with a 2-second budget per icon (render in the calling tick is acceptable; refuse inputs over the element cap before rendering). Storage: `<dataDir>/apps/<appId>/icon/icon.svg` and `icon-<size>.png`, `icon-512-maskable.png` (the icon scaled to 80 % centred on the theme colour). Files are written to a temp name and renamed.

Entry points:
- MCP `deploy_app` gains optional `icon_svg`, `description`, `theme_color`. A deploy that creates an app without `icon_svg` gets the default icon and a warning in the result: "No icon supplied; a generated one is used. Pass icon_svg to set your own." A redeploy without `icon_svg` leaves the icon untouched. An invalid icon does not fail the deploy: the deploy succeeds, the previous or default icon stays, and the result carries a warning naming the reason. New tool `set_app_icon {app, icon_svg?, description?, theme_color?}` (owner or collaborator; at least one field; an invalid icon here is an error). Tool total becomes 21. Results of `deploy_app`, `get_app`, `list_apps` include `description`, `themeColor` and `iconUrl` (the public 192 px PNG URL on the platform host).
- REST: `PUT /api/apps/:slug` accepts `description`, `theme_color` (query or JSON) and `icon_svg` (JSON only); `PUT /api/apps/:slug/icon` with body `image/svg+xml` (limit 64 KiB + margin); `PATCH /api/apps/:slug` `{description?, theme_color?}`.
- Platform host, public, cacheable for a year with the version in the URL: `GET /app-icons/<appId>/<iconVersion>/<size>.png` (size ∈ 64, 192, 512; unknown app or size → 404; a wrong version redirects to the current one). `<appId>` is the app's UUID. Also `GET /manifest.webmanifest` for the platform itself (name "Lager", the `assets/icon-*.png` files served at `/icon-192.png`, `/icon-512.png`, `/icon-180.png`), linked from the platform page shell together with `apple-touch-icon` and `theme-color`.
- Instance host, public (no session needed, served even for private instances, but not for disabled ones → 404): `GET /__lager/manifest.webmanifest` → `{name: app.title, short_name: ≤ 12 chars of the title, description, start_url: "/", scope: "/", display: "standalone", background_color: themeColor, theme_color: themeColor, icons: [192 any, 512 any, 512 maskable]}` with `Content-Type: application/manifest+json`; `GET /__lager/icon-<size>.png` (180, 192, 512) and `/__lager/icon-512-maskable.png`; `GET /apple-touch-icon.png` and `/favicon.ico` → the 180/64 PNG. All with `nosniff`, `Cross-Origin-Resource-Policy: same-origin` except the manifest and icons, which must be fetchable by the browser's install machinery: use `Cross-Origin-Resource-Policy: cross-origin` for them and nothing else.
- Head injection (`src/http/inject.ts`): next to the runtime script, inject — only when the artifact's own HTML does not already contain a `rel="manifest"` link — `<link rel="manifest" href="/__lager/manifest.webmanifest">`, `<link rel="apple-touch-icon" href="/__lager/icon-180.png?v=<iconVersion>">`, `<link rel="icon" type="image/png" href="/__lager/icon-192.png?v=<iconVersion>">`, `<meta name="theme-color" content="<themeColor>">`, `<meta name="apple-mobile-web-app-capable" content="yes">`, `<meta name="mobile-web-app-capable" content="yes">`, `<meta name="apple-mobile-web-app-title" content="<escaped title>">`; and a `<meta name="viewport" content="width=device-width, initial-scale=1">` only when the artifact has none. Every interpolated value is attribute-escaped; the colour is re-validated against the hex pattern at injection time.
- Deleting an app removes its icon files (with the app's other files).
- `check_artifact` / deploy warnings: unchanged apart from the icon warning above.
- Guide and skill (identical bodies, first section ≤ 15 lines; add one line to the first section: always pass `icon_svg`, `description` and `theme_color` when deploying a new app): new section "Icon and home screen" — what to pass and the rules: square `viewBox="0 0 512 512"`, a filled background covering the whole square (phones crop to their own shape), one bold simple motif that stays legible at 48 px, two or three colours, shapes and paths only (no `<text>`, no images, no external references, no scripts), under 64 KiB; `theme_color` matching the background; `description` one plain sentence; how users install (open the app on the phone, "Add to Home Screen"), and that signing in happens in the browser the first time.
- README: section "App icons and home-screen install".

- [ ] **Step 1: Write failing tests.**

```ts
// tests/icons.test.ts
it('default icon is deterministic, valid and differs between slugs', …)
it('set renders every size and the maskable variant as real PNGs', …)      // PNG signature; IHDR width/height equal the requested size
it('validate refuses hostile or unsupported SVG', …)
  // each → invalid_argument with reason icon_invalid: <script>, onload=, <foreignObject>, <image href="http://…">, <use href="http://…">, href="javascript:…",
  // url(http://…) in a style, <!DOCTYPE with an entity (billion-laughs sample), <text>, not SVG at all, 70 KiB, 2001 elements, 33 levels deep
it('a huge declared size renders at the requested size', …)                // width="100000" height="100000" → 512×512 PNG, fast
it('remove deletes the files; has() reflects state', …)
it('output is written atomically and survives reopen', …)

// tests/http-pwa.test.ts
it('manifest of an instance carries name, colours and three icons', …)     // content type application/manifest+json; private instance still serves it; disabled instance → 404
it('icon routes serve PNGs with the right sizes; unknown size → 404', …)
it('apple-touch-icon and favicon resolve', …)
it('the page gets manifest, icon and theme tags injected exactly once', …)
it('an artifact with its own manifest link is left alone', …)
it('title and colour cannot inject markup', …)                             // title `"><script>` appears attribute-escaped; a stored bad colour falls back to the default
it('platform host serves app icons by app id and version and its own manifest', …)   // wrong version → redirect; unknown → 404; cache headers
it('manifest and icons expose nothing but name, description, colours and icons', …)  // exact key set

// tests/http-inject.test.ts (added)
it('viewport is added only when missing', …)

// tests/mcp.test.ts (changed/added)
it('lists the twenty-one tools', …)
it('deploy_app with icon_svg, description and theme_color', …)             // get_app returns them and an iconUrl that serves a PNG
it('first deploy without an icon gets the default and a warning', …)
it('redeploy without icon_svg keeps the icon', …)
it('an invalid icon does not fail the deploy but is reported', …)
it('set_app_icon: owner yes, stranger no, invalid icon is an error', …)

// tests/api.test.ts (added)
it('PUT /api/apps/:slug/icon and PATCH /api/apps/:slug', …)

// tests/check.test.ts (added)
it('deploy result carries the icon warning text in English', …)
```

- [ ] **Step 2: Run `npm test`; expect failures.**
- [ ] **Step 3: Implement.** Check the installed `@resvg/resvg-wasm` package's README and types for the exact API (`initWasm`, `Resvg`, `fitTo`, `background`) before coding; load the `.wasm` file from `node_modules` by resolving the package path, and make the build copy nothing extra (it is read from `node_modules` at run time, which the Docker image keeps).
- [ ] **Step 4: Run `npm test`, `npm run typecheck`, `npm run build`; all pass.**
- [ ] **Step 5: Commit** `feat: app icons from Claude, descriptions, and home-screen install`.

---

### Task 2: Visual redesign

**Files:**
- Create: `src/static/app.css`, `src/static/app.js`, `src/http/static.ts`, `src/http/ui.ts` (shared view helpers: icon sprite, app card, badge, empty state, section, data table, menu)
- Modify: `src/http/pages.ts` (new shell; remove the inline CSS), `src/http/dashboard.ts`, `src/http/manage.ts`, `src/http/admin.ts`, `src/http/auth.ts`, `src/http/platform.ts` (login markup, static routes), `src/mcp/oauth.ts` (consent markup only), the four catalogs, `package.json` (build copies `src/static`), `README.md` (one screenshot-free paragraph on themes)
- Test: `tests/ui.test.ts`; update existing page tests only where they assert markup that changes

**Interfaces:**
- Consumes: Task 1 `App.description`, `App.themeColor`, `App.iconVersion`, the public app-icon URL; all existing handlers and catalogs.
- Produces: `page(locale, title, body, opts)` keeps its signature (new optional fields allowed); `src/http/static.ts` exports a `PlatformExtension` serving `/static/app.<hash>.css` and `/static/app.<hash>.js` (hash of the file content, `Cache-Control: public, max-age=31536000, immutable`) and a helper returning the current URLs.

#### Design brief (binding)

**Character.** Lager is the shelf where a person keeps the apps Claude built for them. The interface should feel like a personal app launcher — calm, confident, a little warm — not like a server admin panel. The app icons are the colour in the room; the chrome stays quiet so they stand out. Avoid: gradients on everything, glassmorphism piled on glassmorphism, decorative illustrations without purpose, dense tables as the first thing a user sees.

**Tokens** (CSS custom properties on `:root`; dark values under `@media (prefers-color-scheme: dark)` guarded by `:root:not([data-theme="light"])`, and again under `:root[data-theme="dark"]`; a theme toggle in the account menu cycles system/light/dark, stored in `localStorage` by the script, with a tiny inline pre-paint snippet in `<head>` to avoid a flash):
- Light: canvas `#f4f5f8`, surface `#ffffff`, surface-2 `#f0f1f5`, ink `#0e1020`, ink-2 `#4a4f66`, ink-3 `#7b8098`, line `#e3e5ee`, brand navy `#1f2a5c`, accent `#f58220`, accent-ink (text on accent) `#1c1200`, success `#0f7a45`, danger `#c0263a`, warning `#9a5b00`.
- Dark: canvas `#0b0d18`, surface `#141729`, surface-2 `#1b1f36`, ink `#eef0fa`, ink-2 `#b3b8d0`, ink-3 `#868cab`, line `#272c47`, accent `#ff9a3d`, accent-ink `#1c1200`, success `#5fd49a`, danger `#ff8296`, warning `#f2b866`.
- Radius: 10 px controls, 16 px cards, 22 % for app-icon tiles (squircle look via `border-radius`), 999 px pills. Shadow: one soft elevation for cards on hover and for menus (`0 8px 30px rgb(15 18 40 / .10)`; in dark a 1 px lighter line instead of shadow).
- Type: `font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif`; display heading `clamp(1.9rem, 1.2rem + 2.6vw, 3rem)` weight 750 letter-spacing −0.03em; section heading 1.15rem weight 650; body 0.975rem/1.55; small 0.82rem; monospace for slugs, URLs and tokens. Numbers in tables `font-variant-numeric: tabular-nums`.
- Spacing scale 4/8/12/16/24/32/48/72. Page max width 1200 px with 20 px gutters (16 px under 480 px).
- Motion: 140 ms ease-out for hover/focus/menus; cards lift 2 px on hover; all motion removed under `prefers-reduced-motion`.

**Shell.** A sticky top bar (surface at 85 % opacity with backdrop blur, bottom hairline): left the Lager icon (32 px) and wordmark; centre the primary navigation as a pill-style segmented control — "Apps" (home), "Catalog" (anchor to the catalog section or its own route if you split it), "Administration" (admins only) — with the current item filled; right a language menu (globe icon, current language code) and an account menu (circle with the user's initials on a colour derived from their id; opens a menu with name and e-mail, Account, theme choice, Sign out). Menus are `<details>` elements enhanced by the script (close on outside click and Escape) so they work without JavaScript. Under 720 px the navigation moves to a bottom tab bar with icons and labels (fixed, safe-area padding) and the top bar keeps logo and account only. A "skip to content" link is the first focusable element. The footer is minimal: the language switcher remains reachable there for no-JS and for signed-out pages.

**Home ("Apps").** A display heading "Your apps" with a one-line summary beneath it (e.g. "3 apps · 1 shared with you"). Then sections as card grids (`grid-template-columns: repeat(auto-fill, minmax(260px, 1fr))`, gap 16 px):
- App card: the app icon as a 56 px tile, title (weight 650) with the instance slug beneath in small monospace ink-3; the description clamped to two lines (when empty, a quiet placeholder line is omitted rather than shown); a row of badges (visibility with lock/users/globe icon; version; "shared · <level>" on shared cards; "paused" when disabled); footer with a primary "Open" button (opens the instance) and, when the viewer may manage it, a quiet "Manage" button. The whole card is not a link — two explicit actions.
- "My apps" for publishers shows the same card shape per app (icon, title, description, latest version, instance count) with "Manage".
- "Catalog": same cards; self-service apps show "Get your own" which reveals an inline form (slug field + create) inside the card via `<details>`.
- "Connect Claude" (publishers): a highlighted panel on brand navy with the connector URL in a copyable field (copy button enhanced by script; selectable text without it) and a three-step hint; API tokens below in a compact table card, the one-time token shown in a callout with a copy button.
- Empty home state: centred, the Lager icon large, the tagline as heading, the pitch as text, and three numbered steps (Connect Claude → Ask it to build something → It appears here), with the connector URL for publishers.

**Instance and app pages.** Header band with the app icon (72 px), title, URL as a link with an "Open" button, and badges. Content in a two-column layout above 960 px: main column with sections as cards ("Version" as a vertical timeline with the active one marked, "Sharing" with the grants table and an add form in a single row, "Data" with export and snapshots, "Custom domains"); side column with a summary card (owner, visibility control, auto-update toggle as a switch-styled checkbox, storage used as a thin meter against the quota). Destructive actions live in a "Danger zone" card with a danger-coloured outline at the bottom of the main column. Tables collapse to stacked rows under 640 px (each cell labelled via `data-label`).

**Administration.** Section navigation as pills under the page heading. Each section is a card: users as a table with avatar initials, role and status as badges and a compact action group per row; invitations and reset links show the one-time link in the same callout component as tokens; settings as labelled rows with help text; the apps overview groups instances under their app with its icon.

**Signed-out pages** (login, register, forgot, reset, verify, messages, consent): a centred card (max 420 px) on a full-height canvas with a soft navy-to-canvas radial wash at the top; the Lager icon (64 px) and the tagline above the card on login; the pitch beneath the form in ink-2. The consent page shows the requesting client's name and redirect host prominently (keep the `<strong>` emphasis) with clear Allow/Deny buttons of equal size, Deny first in DOM order.

**Components** (reused everywhere, defined once in `ui.ts`/`app.css`): buttons (primary = accent background with accent-ink text; secondary = surface-2; quiet = transparent with ink-2; danger = danger outline; sizes md/sm; all ≥ 40 px tall, 44 px on touch), inputs and selects with visible labels and focus rings (2 px accent outline, 2 px offset), badges, notices (success/danger/warning banners with an icon, `role="status"`/`role="alert"` as today), callout for one-time secrets, card, section header with optional action, data table, meter, avatar, app-icon tile (falls back to a neutral tile if the image fails), icon sprite (inline SVG symbols: open-external, settings, share, copy, trash, plus, globe, lock, users, check, alert, chevron, menu, sun, moon, logout).

**Script (`app.js`, optional enhancement only, no framework, < 6 KB):** close menus on outside click/Escape; copy-to-clipboard buttons with a transient "Copied" state (text from a `data-` attribute rendered server-side from the catalog); theme toggle; confirm-by-typing hint that enables the danger button when the typed text matches (the server check stays authoritative); nothing else.

**Catalog text.** New strings (navigation labels, summaries, empty states, button labels, badge labels, theme names, "Copied") go into all four catalogs. Reuse existing keys wherever the meaning is the same.

- [ ] **Step 1: Write failing tests.**

```ts
// tests/ui.test.ts
it('static assets are served with a content hash and immutable caching; a wrong hash is 404', …)
it('every page links the stylesheet and has no inline <style> block beyond the pre-paint theme snippet', …)
it('shell has a skip link, one <main>, one <h1>, and landmarks for banner and navigation', …)   // home, instance, app, admin, login
it('home shows cards with the app icon, title, description and badges', …)                      // icon URL points at the public app-icon route with the current version
it('cards offer Open for everyone with access and Manage only to managers', …)
it('empty home shows the tagline and the three steps', …)
it('account menu and language menu are <details> and work as plain links/forms without script', …)
it('theme snippet sets data-theme before paint and the stylesheet defines both themes', …)
it('tables carry data-label attributes for the stacked layout', …)
it('consent page: client name and redirect host emphasised, Deny precedes Allow in the DOM', …)
it('forms post the same fields to the same routes as before', …)
  // snapshot of {action, method, sorted field names} for every form on home, instance, app, admin sections, account and auth pages,
  // compared against a fixture generated from the pre-redesign pages (generate the fixture first, from the current code, and commit it)
it('no external URLs in any page or static asset', …)                                           // no http(s):// other than the platform's and instances' own
it('all four locales render every page without missing keys', …)                                // extend the existing coverage render test
```

- [ ] **Step 2: Generate the form fixture from the current code, commit it, then run `npm test`; expect the new tests to fail.**
- [ ] **Step 3: Implement** the stylesheet, the helpers and the page markup per the design brief.
- [ ] **Step 4: Run `npm test`, `npm run typecheck`, `npm run build`; all pass.** Start the server locally and look at every page yourself in both themes and at 375 px and 1280 px if you have a browser tool; otherwise say in the report that you could not look at it.
- [ ] **Step 5: Commit** `feat: redesign the interface as an app launcher`.
