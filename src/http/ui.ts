import type { Core } from '../core.js';
import { t, type Locale } from '../i18n/index.js';
import type { App } from '../platform/apps.js';
import type { User } from '../platform/users.js';
import { esc, type PageOpts } from './pages.js';
import { csrfToken } from './session.js';

// --- icons ---

const ICONS: Record<string, string> = {
  open: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
  settings: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  sparkle: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6.5 6.5 0 0 1 3.5 6"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5h.01"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H4"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="2"/><rect x="13" y="4" width="7" height="7" rx="2"/><rect x="4" y="13" width="7" height="7" rx="2"/><rect x="13" y="13" width="7" height="7" rx="2"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/>',
  shield: '<path d="M12 3L5 6v5c0 4.5 3 8.3 7 10 4-1.7 7-5.5 7-10V6z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6C3.9 8.4 2 12 2 12s3.6 7 10 7a10 10 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
};
export type IconName = keyof typeof ICONS;

/** The inline symbol sheet every page carries once, right after `<body>`. */
export const SPRITE = `<svg class="sprite" aria-hidden="true" focusable="false">${Object.entries(ICONS)
  .map(([name, paths]) => `<symbol id="i-${name}" viewBox="0 0 24 24">${paths}</symbol>`).join('')}</svg>`;

/** A decorative icon from the sheet; the text next to it carries the meaning. */
export const icon = (name: IconName, cls = ''): string =>
  `<svg class="i${cls ? ` ${cls}` : ''}" aria-hidden="true" focusable="false"><use href="#i-${name}"></use></svg>`;

// --- buttons, badges, notices ---

export type ButtonStyle = 'primary' | 'secondary' | 'quiet' | 'danger';
export const btn = (style: ButtonStyle = 'primary', small = false): string => `btn btn-${style}${small ? ' btn-sm' : ''}`;

/** A link styled as a button; `label` is trusted markup. */
/** ` aria-label="…"` for an action whose visible text needs the thing it acts on, e.g. "Open Notes". */
export const named = (name: string): string => ` aria-label="${esc(name)}"`;

/**
 * The name of a button that repeats on a page, "Save: Role", "Remove: jonas@example.com": its visible word first (WCAG 2.5.3, the
 * label is in the name and starts it, in every language), then what it acts on, so a list of buttons or a voice command can tell
 * them apart (WCAG 2.4.6). `action` and `what` are plain text.
 */
export const namedAction = (locale: Locale, action: string, what: string): string => named(t(locale, 'common.actionOn', { action, what }));

export const linkButton = (href: string, label: string, style: ButtonStyle = 'primary', small = false, extra = ''): string =>
  `<a class="${btn(style, small)}" href="${esc(href)}"${extra}>${label}</a>`;

export type Tone = 'neutral' | 'accent' | 'success' | 'danger' | 'warning';
/** A small label; `text` is plain text. */
export const badge = (text: string, opts: { icon?: IconName; tone?: Tone; dot?: boolean } = {}): string =>
  `<span class="badge${opts.tone && opts.tone !== 'neutral' ? ` badge-${opts.tone}` : ''}${opts.dot ? ' badge-dot' : ''}">${opts.icon ? icon(opts.icon) : ''}<span class="badge-text">${esc(text)}</span></span>`;

const VISIBILITY_ICONS: Record<string, IconName> = { private: 'lock', users: 'users', public: 'globe' };
export const visibilityIcon = (visibility: string): IconName => VISIBILITY_ICONS[visibility] ?? 'lock';

/** Success, error or warning line; the roles are what assistive technology announces. `extra` is trusted markup after the text (an Undo form). */
export function notice(kind: 'success' | 'danger' | 'warning', text: string, extra = ''): string {
  const role = kind === 'success' ? 'status' : 'alert';
  return `<div class="notice notice-${kind}" role="${role}">${icon(kind === 'success' ? 'check' : 'alert')}<span>${esc(text)}</span>${extra}</div>`;
}

/** A copy button, hidden until the script can use the clipboard; without it the text next to it stays selectable. */
/**
 * `what` names what is copied, for a button that repeats on its page: out of sight after the label, so the name reads "Copy: Token
 * feedback", and "Copied: Token feedback" once the script swaps the label (an aria-label would hide that swap from screen readers).
 */
export const copyButton = (locale: Locale, value: string, style: ButtonStyle = 'secondary', label = t(locale, 'common.copy'), small = true, what = ''): string =>
  `<button type="button" class="${btn(style, small)}" data-copy="${esc(value)}" data-copied="${esc(t(locale, 'common.copied'))}" data-copy-failed="${esc(t(locale, 'common.copyFailed'))}" hidden>${icon('copy')}<span data-label>${esc(label)}</span>${
    what ? `<span class="sr-only">${esc(t(locale, 'common.actionOn', { action: '', what }))}</span>` : ''}</button>`;

/** A value to copy: selectable text with a copy button. */
export const copyField = (locale: Locale, value: string, style: ButtonStyle = 'secondary', what = ''): string =>
  `<div class="copyfield"><code>${esc(value)}</code>${copyButton(locale, value, style, undefined, true, what)}</div>`;

/** A one-time secret (token, invitation or reset link): shown once, with what to do about it. */
export const callout = (locale: Locale, title: string, secret: string, warning: string): string =>
  `<div class="callout" role="status"><strong>${icon('check')}${esc(title)}</strong>${copyField(locale, secret, 'primary')}<p class="warn">${icon('alert', 'i-sm')}${esc(warning)}</p></div>`;

/** From this many entries on, a list gets a filter field: below it the whole list fits on a screen or two. */
export const FILTER_FROM = 8;

/**
 * A field that narrows a list while typing: the script hides the entries (`targets`, a selector) whose text does not contain what
 * was typed, and the sections left without one. Hidden until the script shows it: without script there is nothing to filter with.
 * The status line is in the page from the start, empty, so screen readers announce the text the script puts in when nothing is left.
 */
export const filterField = (locale: Locale, id: string, targets: string, label: string): string =>
  `<div class="filter" hidden>${icon('search', 'i-sm')}<label class="sr-only" for="${esc(id)}">${esc(label)}</label><input type="search" id="${esc(id)}" data-filter="${esc(targets)}" placeholder="${esc(label)}" autocomplete="off" spellcheck="false" enterkeyhint="search">`
  + `<p class="filter-none hint" role="status" data-none="${esc(t(locale, 'filter.none'))}"></p></div>`;

/**
 * An empty list: what is missing, and optionally one more sentence (`detail`, plain text) on what the list is for or when it
 * fills up, and the next step (`action`, trusted markup: links styled as buttons).
 */
export const emptyState = (text: string, name: IconName = 'grid', opts: { detail?: string; action?: string } = {}): string =>
  `<div class="empty">${icon(name)}<p>${esc(text)}</p>${opts.detail ? `<p class="empty-detail">${esc(opts.detail)}</p>` : ''}${opts.action ? `<div class="empty-actions">${opts.action}</div>` : ''}</div>`;

/** A titled section of a page with an optional count next to the heading; `body` is trusted markup. */
export function section(id: string, title: string, body: string, opts: { count?: number } = {}): string {
  const count = opts.count !== undefined ? ` <span class="count">${opts.count}</span>` : '';
  return `<section class="section" id="${esc(id)}" aria-labelledby="${esc(id)}-title"><div class="section-head"><h2 id="${esc(id)}-title">${esc(title)}${count}</h2></div>${body}</section>`;
}

/** A card with a heading; `body` is trusted markup. `id` names it, for links and for notices placed above it. */
export const card = (title: string, body: string, cls = '', id = ''): string =>
  `<section class="card${cls ? ` ${cls}` : ''}"${id ? ` id="${esc(id)}"` : ''}><h2>${esc(title)}</h2>${body}</section>`;

/**
 * A table that scrolls on wide screens and stacks its rows under 640 px. `heads` are plain-text column labels; an empty
 * label marks an action column, whose header is read out as "Actions". Each cell repeats its column label in `data-label`
 * for the stacked layout, and explicit roles keep the table semantics when CSS turns the rows into blocks. Cells are trusted markup.
 */
export function dataTable(locale: Locale, heads: string[], rows: string[][], cls = ''): string {
  const th = heads.map((h) => `<th scope="col" role="columnheader">${h ? esc(h) : `<span class="sr-only">${esc(t(locale, 'common.actions'))}</span>`}</th>`).join('');
  const body = rows.map((cells) => `<tr role="row">${cells.map((c, i) => {
    const label = heads[i] ?? '';
    return `<td role="cell" data-label="${esc(label)}"${label ? '' : ' class="actions"'}>${c}</td>`;
  }).join('')}</tr>`).join('');
  return `<div class="table-wrap"><table role="table" class="table-stack${cls ? ` ${cls}` : ''}"><thead role="rowgroup"><tr role="row">${th}</tr></thead><tbody role="rowgroup">${body}</tbody></table></div>`;
}

/** Used against available as a thin bar with the numbers as text. */
export function meter(used: number, quota: number, text: string): string {
  const share = quota > 0 ? Math.min(1, used / quota) : 0;
  const level = share >= 0.95 ? ' full' : share >= 0.8 ? ' high' : '';
  return `<p class="num">${esc(text)}</p><div class="meter${level}" aria-hidden="true"><span style="width:${(share * 100).toFixed(1)}%"></span></div>`;
}

// --- people and apps ---

/** Initials of a name (or of the address when there is no name), at most two letters. */
export function initials(name: string, email: string): string {
  const words = (name.trim() || email.split('@')[0]).split(/[\s._-]+/).filter(Boolean);
  const letters = words.length > 1 ? [words[0], words[words.length - 1]] : [words[0] ?? '?'];
  return letters.map((w) => Array.from(w)[0] ?? '').join('').toUpperCase() || '?';
}

/** One of eight avatar colours, always the same for the same id. */
const hue = (id: string): number => {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return h % 8;
};

export const avatar = (user: { id: string; name: string; email: string }, size: '' | 'sm' | 'lg' = ''): string =>
  `<span class="avatar av${hue(user.id)}${size ? ` avatar-${size}` : ''}" aria-hidden="true">${esc(initials(user.name, user.email))}</span>`;

/**
 * A person in a table cell: avatar, name and address. Text that does not fit its column is cut off with an ellipsis instead of
 * being broken inside a word, and the tooltip shows it whole.
 */
export const personCell = (user: { id: string; name: string; email: string }, name = user.name): string =>
  `<div class="cell-user">${avatar(user, 'sm')}<div><strong title="${esc(name)}">${esc(name)}</strong><span title="${esc(user.email)}">${esc(user.email)}</span></div></div>`;

/** Path of an app's icon on the platform host (public, cached for good because the version is part of it). */
export const appIconPath = (app: App, px: 64 | 192 | 512 = 192): string => `/app-icons/${encodeURIComponent(app.id)}/${app.iconVersion}/${px}.png`;

/** The app's icon as a tile; the initial behind it shows when the image cannot load. */
export function appTile(app: App | null, title: string, size: '' | 'lg' | 'sm' | 'xs' = ''): string {
  const letter = esc((Array.from(title.trim())[0] ?? '?').toUpperCase());
  const px = size === 'lg' ? 72 : size === 'sm' ? 40 : size === 'xs' ? 32 : 56;
  const img = app ? `<img src="${appIconPath(app, px <= 32 ? 64 : 192)}" alt="" width="${px}" height="${px}" loading="lazy" decoding="async">` : '';
  return `<span class="tile${size ? ` tile-${size}` : ''}" aria-hidden="true"><span>${letter}</span>${img}</span>`;
}

/**
 * The parts of an app card; markup fields are trusted. `corner` sits in the top right corner (the AI badge). With `href` the title
 * is a link that covers the whole card, as on a home screen; the actions stay clickable above it.
 */
export interface AppCardParts { app: App | null; title: string; slug: string; description?: string; badges: string[]; actions: string; label?: string; corner?: string; href?: string; linkLabel?: string }

/**
 * Attributes of a button that only repeats the card's own link: it stays as the visible "Open", but keyboard and screen reader
 * reach the destination once, through the title.
 */
export const repeatsCardLink = ' tabindex="-1" aria-hidden="true"';

/** The small badge in the corner of the card of an app that may ask a language model (it declares `complete`). */
export const aiBadge = (label: string, hint: string): string =>
  `<span class="ai-badge" title="${esc(hint)}">${icon('sparkle')}<span aria-hidden="true">${esc(label)}</span><span class="sr-only">${esc(hint)}</span></span>`;

export function appCard(p: AppCardParts): string {
  const desc = p.description?.trim() ? `<p class="app-desc">${esc(p.description)}</p>` : '';
  const title = p.href ? `<a class="card-link" href="${esc(p.href)}"${p.linkLabel ? ` aria-label="${esc(p.linkLabel)}"` : ''}>${esc(p.title)}</a>` : esc(p.title);
  return `<article class="app-card${p.corner ? ' has-corner' : ''}${p.href ? ' is-linked' : ''}"${p.label ? ` aria-label="${esc(p.label)}"` : ''}><div class="app-card-head">${appTile(p.app, p.title)}<div><h3 class="app-title">${title}</h3><span class="slug">${esc(p.slug)}</span></div>${p.corner ?? ''}</div>
${desc}${p.badges.length ? `<div class="badges">${p.badges.join('')}</div>` : ''}<div class="card-actions">${p.actions}</div></article>`;
}

// --- the signed-in shell ---

export type NavItem = 'apps' | 'catalog' | 'publish' | 'admin';

/** Shell options of a signed-in page: the account menu, the navigation and whether the catalog offers the viewer anything. */
export function signedIn(core: Core, user: User, current: NavItem | null, returnPath: string): PageOpts {
  const { instances, apps } = core.access.catalog(user);
  return {
    returnPath,
    user: { id: user.id, name: user.name, email: user.email, admin: user.role === 'admin', publisher: user.role === 'admin' || user.role === 'publisher' },
    csrf: csrfToken(core, user),
    current,
    catalog: instances.length + apps.length > 0,
  };
}
