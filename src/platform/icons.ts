import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { LagerError } from '../errors.js';
import { defaultIconSvg } from './default-icon.js';
import { ICON_WORKER_SOURCE } from './icon-worker-code.js';

export const ICON_SIZES = [512, 192, 180, 64] as const;
export const MAX_ICON_SVG_BYTES = 65536;
export const DEFAULT_THEME_COLOR = '#1f2a5c';
const MAX_ELEMENTS = 2000;
const MAX_DEPTH = 32;
/** Wall-clock limit for all sizes of one `set`, enforced by terminating the worker. */
const RENDER_TIMEOUT_MS = 3000;
const MAX_QUEUED = 20;
const WORKER_HEAP_MB = 128;
const MAX_VIEWBOX = 100000;
const SVG_NS = 'http://www.w3.org/2000/svg';
/** The maskable variant shows the icon at this share of the canvas, inside the platform-safe zone. */
const MASKABLE_SCALE = 0.8;
const MAX_ID_LENGTH = 64;

/**
 * The only elements an icon may use: shapes, groups, gradients, clipping and masking. Everything else is refused, which removes
 * filters (a single `feMorphology` can keep a renderer busy for minutes), patterns, markers, CSS, links, animation, text, images,
 * scripts and foreign content. Compared by lower-cased name.
 */
const ALLOWED_ELEMENTS = new Set([
  'svg', 'g', 'defs', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'lineargradient', 'radialgradient', 'stop',
  'clippath', 'mask', 'use', 'symbol', 'title', 'desc',
]);

const iconInvalid = (message: string): never => {
  throw new LagerError('invalid_argument', `The icon cannot be used: ${message}`, 'icon_invalid');
};

const NAME = /[A-Za-z_][A-Za-z0-9_.:-]*/y;
const WS = /[ \t\r\n]/;
const BAD_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/;
const ENTITY = /^&(?:#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos);/;
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

const localName = (name: string): string => name.slice(name.lastIndexOf(':') + 1).toLowerCase();

/** Decodes the five predefined entities and numeric references once; any other `&` makes the document unparseable. */
function decode(text: string): string {
  if (!text.includes('&')) return text;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '&') { out += text[i]; continue; }
    const m = ENTITY.exec(text.slice(i, i + 12));
    if (!m) return iconInvalid('it uses an entity reference that is not defined (only &amp; &lt; &gt; &quot; &apos; and numeric references are allowed).');
    const body = m[0].slice(1, -1);
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) || (code < 0x20 && code !== 9 && code !== 10 && code !== 13)) {
        return iconInvalid('it contains an invalid character reference.');
      }
      out += String.fromCodePoint(code);
    } else {
      out += NAMED[body];
    }
    i += m[0].length - 1;
  }
  return out;
}

/** CSS (a style attribute or any attribute value): references may only point to a fragment of the same document. */
function scanCss(text: string, strict: boolean): void {
  if (strict && text.includes('\\')) iconInvalid('CSS escapes are not allowed.');
  const lower = text.toLowerCase();
  if (strict) for (const word of ['@import', 'image-set(', 'expression(', 'src(', 'filter', 'stroke-dasharray']) {
    if (lower.includes(word)) iconInvalid(`"${word}" is not allowed in CSS.`);
  }
  for (const m of lower.matchAll(/url\s*\(/g)) {
    const rest = lower.slice(m.index + m[0].length).replace(/^\s+/, '').replace(/^["']\s*/, '');
    if (!rest.startsWith('#')) iconInvalid('url() may only point to an element of the icon itself (#id).');
  }
}

const PLAIN_NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** A stroke-width must be a finite plain number of at least 0.01: hairline strokes make a renderer slow. */
function checkStrokeWidth(value: string): void {
  const m = /^\s*(.*?)\s*(?:px)?\s*$/.exec(value);
  const text = m ? m[1] : value;
  const n = PLAIN_NUMBER.test(text) ? Number(text) : Number.NaN;
  if (!Number.isFinite(n) || n < 0.01) iconInvalid('stroke-width must be a number of at least 0.01.');
}

function checkAttribute(name: string, raw: string): void {
  const value = decode(raw);
  const local = localName(name);
  if (local.startsWith('on')) iconInvalid(`the event handler attribute "${name}" is not allowed.`);
  if (name.toLowerCase() === 'xml:base') iconInvalid('xml:base is not allowed.');
  if (local === 'href' && !value.replace(/^[\u0000- ]+/, '').startsWith('#')) {
    iconInvalid('href may only point to an element of the icon itself (#id).');
  }
  if (local === 'filter') iconInvalid('filters are not allowed.');
  if (local === 'stroke-dasharray') iconInvalid('stroke-dasharray is not allowed.');
  if (local === 'stroke-width') checkStrokeWidth(value);
  if (local === 'style') for (const m of value.matchAll(/stroke-width\s*:\s*([^;]*)/gi)) checkStrokeWidth(m[1]);
  scanCss(value, local === 'style');
}

/** A positive finite number within the size limit, or null. Units other than a trailing `px` are not accepted. */
function dimension(value: string, allowPx: boolean): number | null {
  const m = /^\s*(.*?)\s*$/.exec(value);
  let text = m ? m[1] : value;
  if (allowPx && text.endsWith('px')) text = text.slice(0, -2);
  if (!PLAIN_NUMBER.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) && n > 0 && n <= MAX_VIEWBOX ? n : null;
}

/** The root must say it is SVG, be square and have a sane size before anything is drawn (the renderer allocates the whole pixmap). */
function checkRoot(attributes: Array<[string, string]>): void {
  const get = (name: string): string | undefined => { const f = attributes.find(([k]) => k === name); return f ? decode(f[1]) : undefined; };
  if (get('xmlns') !== SVG_NS) iconInvalid(`the <svg> element must declare xmlns="${SVG_NS}".`);
  const viewBox = get('viewBox');
  if (viewBox === undefined) iconInvalid('the <svg> element needs a square viewBox such as viewBox="0 0 512 512".');
  const parts = viewBox!.trim().split(/[\s,]+/);
  const nums = parts.map((p) => (PLAIN_NUMBER.test(p) ? Number(p) : Number.NaN));
  if (parts.length !== 4 || !nums.every(Number.isFinite)) iconInvalid('the viewBox must be four finite numbers.');
  const [, , w, h] = nums;
  if (!(w > 0 && h > 0) || w > MAX_VIEWBOX || h > MAX_VIEWBOX) iconInvalid(`the viewBox width and height must be positive and at most ${MAX_VIEWBOX}.`);
  if (Math.abs(w - h) > 0.005 * Math.max(w, h)) iconInvalid('the icon must be square (use viewBox="0 0 512 512").');
  const width = get('width');
  const height = get('height');
  const sizes: number[] = [];
  for (const [label, v] of [['width', width], ['height', height]] as const) {
    if (v === undefined) continue;
    const d = dimension(v, true);
    if (d === null) iconInvalid(`${label} must be a plain number (optionally with px), at most ${MAX_VIEWBOX}.`);
    sizes.push(d!);
  }
  if (sizes.length === 2 && sizes[0] !== sizes[1]) iconInvalid('width and height must be equal.');
  if (sizes.length === 1) iconInvalid('give both width and height, or neither.');
}

/**
 * Walks the SVG text tag by tag. It accepts only what a strict XML parser would and refuses everything it cannot parse cleanly,
 * so no spelling (case, whitespace, quoting, entities, CDATA, comments, processing instructions) can hide a forbidden construct.
 */
function tokenize(svg: string): void {
  const n = svg.length;
  const start = svg.charCodeAt(0) === 0xfeff ? 1 : 0;
  const stack: Array<{ name: string; local: string }> = [];
  let elements = 0;
  let rootSeen = false;
  let i = start;

  const text = (chunk: string, raw: boolean): void => {
    if (stack.length === 0) {
      if (chunk.trim() !== '') iconInvalid('there is content outside the <svg> element.');
      return;
    }
    if (!raw) decode(chunk);
  };

  while (i < n) {
    const lt = svg.indexOf('<', i);
    text(svg.slice(i, lt < 0 ? n : lt), false);
    if (lt < 0) { i = n; break; }
    i = lt;
    if (svg.startsWith('<!--', i)) {
      const end = svg.indexOf('-->', i + 4);
      if (end < 0) iconInvalid('a comment is not closed.');
      if (svg.slice(i + 4, end).includes('--')) iconInvalid('a comment contains "--".');
      i = end + 3;
      continue;
    }
    if (svg.startsWith('<![CDATA[', i)) {
      const end = svg.indexOf(']]>', i + 9);
      if (end < 0) iconInvalid('a CDATA section is not closed.');
      if (stack.length === 0) iconInvalid('there is content outside the <svg> element.');
      text(svg.slice(i + 9, end), true);
      i = end + 3;
      continue;
    }
    if (svg.startsWith('<?', i)) {
      // Only the XML declaration at the very start; anything else (xml-stylesheet, …) can pull in external resources.
      if (i !== start || !/^<\?xml[ \t\r\n]/.test(svg.slice(i, i + 7))) iconInvalid('processing instructions are not allowed.');
      const end = svg.indexOf('?>', i + 2);
      if (end < 0) iconInvalid('the XML declaration is not closed.');
      i = end + 2;
      continue;
    }
    if (svg.startsWith('<!', i)) iconInvalid('DOCTYPE and ENTITY declarations are not allowed.');

    if (svg[i + 1] === '/') {
      NAME.lastIndex = i + 2;
      const m = NAME.exec(svg);
      if (!m) { iconInvalid('a closing tag is malformed.'); return; }
      let j = i + 2 + m[0].length;
      while (j < n && WS.test(svg[j])) j++;
      if (svg[j] !== '>') iconInvalid('a closing tag is malformed.');
      const open = stack.pop();
      if (!open || open.name !== m[0]) iconInvalid('the tags are not properly nested.');
      i = j + 1;
      continue;
    }

    NAME.lastIndex = i + 1;
    const m = NAME.exec(svg);
    if (!m) { iconInvalid('a tag is malformed.'); return; }
    const name = m[0];
    const local = localName(name);
    let j = i + 1 + name.length;
    const seen = new Set<string>();
    const attributes: Array<[string, string]> = [];
    let selfClosing = false;
    for (;;) {
      const before = j;
      while (j < n && WS.test(svg[j])) j++;
      if (j >= n) iconInvalid('a tag is not closed.');
      if (svg[j] === '>') { j++; break; }
      if (svg.startsWith('/>', j)) { selfClosing = true; j += 2; break; }
      if (j === before) iconInvalid('attributes must be separated by whitespace.');
      NAME.lastIndex = j;
      const a = NAME.exec(svg);
      if (!a) { iconInvalid('an attribute is malformed.'); return; }
      j += a[0].length;
      while (j < n && WS.test(svg[j])) j++;
      if (svg[j] !== '=') iconInvalid(`the attribute "${a[0]}" has no value.`);
      j++;
      while (j < n && WS.test(svg[j])) j++;
      const quote = svg[j];
      if (quote !== '"' && quote !== "'") iconInvalid(`the value of "${a[0]}" is not quoted.`);
      const close = svg.indexOf(quote, j + 1);
      if (close < 0) iconInvalid(`the value of "${a[0]}" is not closed.`);
      const value = svg.slice(j + 1, close);
      if (value.includes('<')) iconInvalid(`the value of "${a[0]}" contains "<".`);
      if (seen.has(a[0])) iconInvalid(`the attribute "${a[0]}" appears twice.`);
      seen.add(a[0]);
      attributes.push([a[0], value]);
      j = close + 1;
    }

    if (name.includes(':')) iconInvalid(`<${name}> uses a namespace prefix; write plain SVG elements.`);
    if (!ALLOWED_ELEMENTS.has(local)) {
      iconInvalid(`<${local}> is not allowed. Allowed elements: svg, g, defs, path, rect, circle, ellipse, line, polyline, polygon, linearGradient, radialGradient, stop, clipPath, mask, use, symbol, title, desc (no filters, patterns, text, images, styles or scripts).`);
    }
    if (stack.length === 0) {
      if (rootSeen) iconInvalid('there is more than one root element.');
      if (local !== 'svg') iconInvalid('the root element must be <svg>.');
      rootSeen = true;
      checkRoot(attributes);
    } else if (local === 'svg') {
      iconInvalid('a nested <svg> is not allowed.');
    }
    if (++elements > MAX_ELEMENTS) iconInvalid(`it has more than ${MAX_ELEMENTS} elements.`);
    if (stack.length + 1 > MAX_DEPTH) iconInvalid(`it is nested deeper than ${MAX_DEPTH} levels.`);
    for (const [k, v] of attributes) checkAttribute(k, v);
    if (!selfClosing) stack.push({ name, local });
    i = j;
  }
  if (stack.length > 0) iconInvalid('an element is not closed.');
  if (!rootSeen) iconInvalid('the root element must be <svg>.');
}

const validId = (id: string): boolean => /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id) && id.length <= MAX_ID_LENGTH;

export interface AppIconsOptions {
  /** Wall-clock limit of one `set` (default 3000 ms). */
  timeoutMs?: number;
  /** Jobs that may wait behind the running one (default 20). */
  queueLimit?: number;
  /** Replaces the worker program; for tests of the timeout and crash paths only. */
  workerSource?: string;
}

interface Job { svg: string; color: string; resolve(files: Record<string, Uint8Array>): void; reject(e: unknown): void }
type WorkerMessage = { type: 'ready' } | { type: 'done'; id: number; files: Record<string, Uint8Array> } | { type: 'failed'; id: number; message: string };

export class AppIcons {
  /** Render jobs handed to the worker so far (tests assert that refused icons never reach it). */
  jobsStarted = 0;
  private worker: Worker | null = null;
  private workerReady: Promise<Worker> | null = null;
  private queue: Job[] = [];
  private running = false;
  private closed = false;
  private jobId = 0;
  private readonly timeoutMs: number;
  private readonly queueLimit: number;
  private readonly workerSource: string;

  constructor(private dataDir: string, opts: AppIconsOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? RENDER_TIMEOUT_MS;
    this.queueLimit = opts.queueLimit ?? MAX_QUEUED;
    this.workerSource = opts.workerSource ?? ICON_WORKER_SOURCE;
  }

  /** Starts the render worker (which loads the wasm) and waits until it is ready. Safe to call repeatedly. */
  async ready(): Promise<void> {
    await this.spawn();
  }

  /** Ends the worker; waiting jobs are rejected. The next `set` starts a new one unless the instance is closed for good. */
  close(): void {
    this.closed = true;
    this.discardWorker();
    for (const job of this.queue.splice(0)) job.reject(new LagerError('conflict', 'The icon renderer is shutting down.'));
  }

  private discardWorker(): void {
    const worker = this.worker;
    this.worker = null;
    this.workerReady = null;
    if (worker) void worker.terminate();
  }

  private spawn(): Promise<Worker> {
    if (this.closed) return Promise.reject(new LagerError('conflict', 'The icon renderer is shutting down.'));
    if (this.workerReady) return this.workerReady;
    const require = createRequire(import.meta.url);
    const worker = new Worker(this.workerSource, {
      eval: true,
      workerData: { module: require.resolve('@resvg/resvg-wasm'), wasm: require.resolve('@resvg/resvg-wasm/index_bg.wasm') },
      resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
    });
    // A worker must never keep the process alive.
    worker.unref();
    this.worker = worker;
    this.workerReady = new Promise<Worker>((resolve, reject) => {
      const fail = (e: unknown): void => {
        if (this.worker === worker) { this.worker = null; this.workerReady = null; }
        reject(e instanceof Error ? e : new Error(String(e)));
      };
      worker.once('error', fail);
      worker.once('exit', () => fail(new Error('the renderer stopped')));
      const onReady = (m: WorkerMessage): void => {
        if (m.type === 'ready') { worker.off('message', onReady); resolve(worker); }
        else if (m.type === 'failed') { worker.off('message', onReady); fail(new Error(m.message)); }
      };
      worker.on('message', onReady);
    });
    this.workerReady.catch(() => undefined);
    return this.workerReady;
  }

  /** Draws all sizes and the maskable variant in the worker, within the wall-clock limit. */
  private draw(svg: string, color: string): Promise<Record<string, Uint8Array>> {
    if (this.closed) return Promise.reject(new LagerError('conflict', 'The icon renderer is shutting down.'));
    if (this.queue.length >= this.queueLimit) {
      return Promise.reject(new LagerError('conflict', 'Too many icons are waiting to be drawn. Try again in a moment.'));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ svg, color, resolve, reject });
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    const job = this.queue.shift();
    if (!job) return;
    this.running = true;
    try {
      job.resolve(await this.runJob(job));
    } catch (e) {
      job.reject(e);
    } finally {
      this.running = false;
      void this.pump();
    }
  }

  private async runJob(job: Job): Promise<Record<string, Uint8Array>> {
    const failed = (why: string): LagerError => new LagerError('invalid_argument', `The icon cannot be used: ${why}`, 'icon_invalid');
    const deadline = Date.now() + this.timeoutMs;
    let worker: Worker;
    try {
      worker = await Promise.race([
        this.spawn(),
        new Promise<never>((_, reject) => { setTimeout(() => reject(new Error('timeout')), this.timeoutMs).unref(); }),
      ]);
    } catch (e) {
      this.discardWorker();
      if (e instanceof LagerError) throw e;
      throw failed('the renderer did not start in time.');
    }
    const id = ++this.jobId;
    this.jobsStarted++;
    return new Promise((resolve, reject) => {
      const done = (fn: () => void): void => {
        clearTimeout(timer);
        worker.off('message', onMessage);
        worker.off('error', onError);
        worker.off('exit', onExit);
        fn();
      };
      // The hard limit: a drawing that is still running is ended with the whole worker, never waited for.
      const timer = setTimeout(() => {
        this.discardWorker();
        done(() => reject(failed('it takes too long to draw.')));
      }, Math.max(1, deadline - Date.now()));
      const onMessage = (m: WorkerMessage): void => {
        if (m.type === 'done' && m.id === id) done(() => resolve(m.files));
        else if (m.type === 'failed' && m.id === id) done(() => reject(failed(`it could not be drawn (${m.message}).`)));
      };
      const onError = (e: Error): void => { this.discardWorker(); done(() => reject(failed(`the renderer failed (${e.message}).`))); };
      const onExit = (): void => { this.discardWorker(); done(() => reject(failed('the renderer stopped.'))); };
      worker.on('message', onMessage);
      worker.on('error', onError);
      worker.on('exit', onExit);
      worker.postMessage({ id, svg: job.svg, color: job.color, sizes: [...ICON_SIZES], maskableInner: Math.round(512 * MASKABLE_SCALE) });
    });
  }

  validate(svg: string): void {
    if (typeof svg !== 'string') iconInvalid('icon_svg must be a string.');
    if (Buffer.byteLength(svg) > MAX_ICON_SVG_BYTES) iconInvalid('it is larger than 64 KiB.');
    if (BAD_CONTROL.test(svg)) iconInvalid('it contains control characters.');
    if (/<!(?:doctype|entity)/i.test(svg)) iconInvalid('DOCTYPE and ENTITY declarations are not allowed.');
    tokenize(svg);
  }

  private folder(appId: string): string {
    return path.join(this.dataDir, 'apps', appId, 'icon');
  }

  /** Validates, renders every size plus the maskable 512 in the worker, and swaps the files in; on any failure the previous icon stays. */
  async set(appId: string, svg: string, themeColor: string): Promise<void> {
    if (!validId(appId)) throw new LagerError('invalid_argument', 'Invalid app id.');
    this.validate(svg);
    const color = /^#[0-9a-f]{6}$/i.test(themeColor) ? themeColor : DEFAULT_THEME_COLOR;
    const drawn = await this.draw(svg, color);
    const files = new Map<string, Uint8Array | string>(Object.entries(drawn));
    files.set('icon.svg', svg);

    const dir = this.folder(appId);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = crypto.randomUUID();
    const temps: Array<[string, string]> = [];
    try {
      // icon-512.png goes last: `has` looks at it, so a half-written set is never reported as present.
      const order = [...files.keys()].filter((k) => k !== 'icon-512.png').concat('icon-512.png');
      for (const name of order) {
        const tmp = path.join(dir, `${name}.${stamp}.tmp`);
        fs.writeFileSync(tmp, files.get(name)!);
        temps.push([tmp, path.join(dir, name)]);
      }
      for (const [tmp, target] of temps) fs.renameSync(tmp, target);
    } catch (e) {
      for (const [tmp] of temps) fs.rmSync(tmp, { force: true });
      throw e;
    }
  }
  /** Writes the generated icon for `slug`, only when the app has none yet. */
  async setDefault(appId: string, slug: string, themeColor: string): Promise<void> {
    if (this.has(appId)) return;
    await this.set(appId, defaultIconSvg(slug), themeColor);
  }

  has(appId: string): boolean {
    return validId(appId) && fs.existsSync(path.join(this.folder(appId), 'icon-512.png'));
  }

  /** The stored source of the icon (server-side only; an SVG is never sent to a browser), or null. */
  source(appId: string): string | null {
    if (!this.has(appId)) return null;
    try { return fs.readFileSync(path.join(this.folder(appId), 'icon.svg'), 'utf8'); } catch { return null; }
  }

  png(appId: string, size: (typeof ICON_SIZES)[number], maskable = false): string | null {
    if (!validId(appId) || !(ICON_SIZES as readonly number[]).includes(size)) return null;
    if (maskable && size !== 512) return null;
    const file = path.join(this.folder(appId), maskable ? 'icon-512-maskable.png' : `icon-${size}.png`);
    return fs.existsSync(file) ? file : null;
  }

  remove(appId: string): void {
    if (!validId(appId)) return;
    fs.rmSync(this.folder(appId), { recursive: true, force: true });
  }
}
