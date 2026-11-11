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
const MAX_ELEMENTS = 500;
const MAX_DEPTH = 16;
const MAX_GRADIENTS = 64;
const MAX_STOPS = 32;
const MAX_NUMBER = 100000;
const MAX_NUMBER_CHARS = 20;
const MAX_PATH_CHARS = 20000;
/** Wall-clock limit for all sizes of one `set`, enforced by terminating the worker. */
const RENDER_TIMEOUT_MS = 3000;
const MAX_QUEUED = 20;
/** Waiting jobs one user may have, so a single publisher cannot hold the whole queue. */
const MAX_QUEUED_PER_OWNER = 2;
const RECYCLE_AFTER_JOBS = 50;
const RECYCLE_RSS_GROWTH = 256 * 1024 * 1024;
const WORKER_HEAP_MB = 128;
const MAX_VIEWBOX = 100000;
const SVG_NS = 'http://www.w3.org/2000/svg';
/** The maskable variant shows the icon at this share of the canvas, inside the platform-safe zone. */
const MASKABLE_SCALE = 0.8;
const MAX_ID_LENGTH = 64;

/**
 * The icon subset: flat shapes, groups, gradients. No masks, clip paths, `use`, filters, patterns, markers, CSS, links, animation,
 * text, images or scripts. Every cost a renderer can be driven into (nested masks, `use` fan-out, filter radii, dash arrays, huge
 * coordinates) comes from something outside this set, so the cost of an accepted icon is bounded by construction.
 */
const ALLOWED_ELEMENTS = new Set([
  'svg', 'g', 'defs', 'linearGradient', 'radialGradient', 'stop', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'title', 'desc',
]);
const GRADIENTS = new Set(['linearGradient', 'radialGradient']);

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

const PLAIN_NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const NUMBER_TOKEN = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const COLOR = /^(?:#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|(?:rgb|rgba)\(\s*[0-9.,%\s+-]{1,60}\)|[A-Za-z]{1,30})$/;
const FILL_URL = /^url\(\s*#([A-Za-z_][A-Za-z0-9_.-]{0,63})\s*\)$/;
const ENUMS: Record<string, string[]> = {
  'fill-rule': ['nonzero', 'evenodd'], 'stroke-linecap': ['butt', 'round', 'square'], 'stroke-linejoin': ['miter', 'round', 'bevel'],
  gradientUnits: ['userSpaceOnUse', 'objectBoundingBox'], spreadMethod: ['pad', 'reflect', 'repeat'],
};
const LENGTHS = new Set(['x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'fx', 'fy', 'width', 'height']);
const OPACITIES = new Set(['fill-opacity', 'stroke-opacity', 'opacity', 'stop-opacity']);
const ALLOWED_ATTRIBUTES = new Set([
  'xmlns', 'viewBox', 'id', 'd', 'points', 'fill', 'stroke', 'stroke-width', 'stroke-miterlimit', 'transform', 'gradientTransform', 'offset',
  'stop-color', ...LENGTHS, ...OPACITIES, ...Object.keys(ENUMS),
]);

/** A finite plain number of at most 20 characters with an absolute value of at most 100000. */
function boundedNumber(text: string, what: string): number {
  if (text.length > MAX_NUMBER_CHARS || !PLAIN_NUMBER.test(text)) iconInvalid(`${what} must be a plain number of at most ${MAX_NUMBER_CHARS} characters.`);
  const n = Number(text);
  if (!Number.isFinite(n) || Math.abs(n) > MAX_NUMBER) iconInvalid(`${what} must be between -${MAX_NUMBER} and ${MAX_NUMBER}.`);
  return n;
}

/** A length: a bounded number, optionally followed by `px` or `%`. */
function checkLength(name: string, value: string): void {
  boundedNumber(value.trim().replace(/(?:px|%)$/, ''), name);
}

/** Numbers separated by whitespace and commas (`points`). */
function checkNumberList(name: string, value: string): void {
  if (value.length > MAX_PATH_CHARS) iconInvalid(`${name} is longer than ${MAX_PATH_CHARS} characters.`);
  for (const part of value.trim().split(/[\s,]+/)) if (part !== '') boundedNumber(part, name);
}

/** Path data: the standard command letters and bounded numbers only. */
function checkPathData(value: string): void {
  if (value.length > MAX_PATH_CHARS) iconInvalid(`path data is longer than ${MAX_PATH_CHARS} characters.`);
  let i = 0;
  while (i < value.length) {
    const c = value[i];
    if (c === ' ' || c === ',' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }
    if ('MmLlHhVvCcSsQqTtAaZz'.includes(c)) { i++; continue; }
    NUMBER_TOKEN.lastIndex = i;
    const m = NUMBER_TOKEN.exec(value);
    if (!m) iconInvalid('path data contains something other than commands and numbers.');
    boundedNumber(m![0], 'a number in path data');
    i += m![0].length;
  }
}

const TRANSFORM_ARGS: Record<string, number[]> = { translate: [1, 2], scale: [1, 2], rotate: [1, 3], skewX: [1], skewY: [1], matrix: [6] };

/** `translate`, `scale`, `rotate`, `skewX`, `skewY` and `matrix` with bounded numeric arguments. */
function checkTransform(value: string): void {
  if (value.length > 1000) iconInvalid('a transform is too long.');
  let rest = value.trim();
  const re = /^(translate|scale|rotate|skewX|skewY|matrix)\s*\(([^()]*)\)[\s,]*/;
  while (rest !== '') {
    const m = re.exec(rest);
    if (!m) { iconInvalid('transform may only use translate, scale, rotate, skewX, skewY and matrix.'); return; }
    const args = m[2].trim().split(/[\s,]+/).filter((a) => a !== '');
    if (!TRANSFORM_ARGS[m[1]].includes(args.length)) iconInvalid(`${m[1]}() has the wrong number of arguments.`);
    for (const a of args) boundedNumber(a, `an argument of ${m[1]}()`);
    rest = rest.slice(m[0].length);
  }
}

function checkOpacity(name: string, value: string): void {
  const n = boundedNumber(value.trim(), name);
  if (n < 0 || n > 1) iconInvalid(`${name} must be between 0 and 1.`);
}

interface Refs { ids: Set<string>; gradients: Set<string>; uses: string[] }

/** One attribute of the fixed list: its value is checked for its own type. Everything else is refused. */
function checkAttribute(name: string, raw: string, refs: Refs, element: string): void {
  if (!ALLOWED_ATTRIBUTES.has(name)) {
    iconInvalid(`the attribute "${name}" is not allowed (only plain geometry, fill/stroke colours, gradients and transforms; no style, class, href, mask, clip-path or filter).`);
  }
  const value = decode(raw);
  if (name === 'xmlns') {
    if (value !== SVG_NS) iconInvalid(`xmlns must be "${SVG_NS}".`);
  } else if (name === 'viewBox') {
    // Checked as part of the root.
  } else if (name === 'id') {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(value)) iconInvalid('an id must be letters, digits, "_", "-" or "." (at most 64).');
    if (refs.ids.has(value)) iconInvalid(`the id "${value}" is used twice.`);
    refs.ids.add(value);
    if (GRADIENTS.has(element)) refs.gradients.add(value);
  } else if (name === 'd') {
    checkPathData(value);
  } else if (name === 'points') {
    checkNumberList(name, value);
  } else if (name === 'transform' || name === 'gradientTransform') {
    checkTransform(value);
  } else if (name === 'fill' || name === 'stroke') {
    const ref = FILL_URL.exec(value.trim());
    if (ref) refs.uses.push(ref[1]);
    else if (!COLOR.test(value.trim())) iconInvalid(`${name} must be a colour or url(#gradient-id).`);
  } else if (name === 'stop-color') {
    if (!COLOR.test(value.trim())) iconInvalid('stop-color must be a colour.');
  } else if (name === 'stroke-width') {
    const n = boundedNumber(value.trim().replace(/px$/, ''), name);
    if (n < 0 || n > 1000) iconInvalid('stroke-width must be between 0 and 1000.');
  } else if (name === 'stroke-miterlimit') {
    const n = boundedNumber(value.trim(), name);
    if (n < 0 || n > 100) iconInvalid('stroke-miterlimit must be between 0 and 100.');
  } else if (name === 'offset') {
    const pct = value.trim().endsWith('%');
    const n = boundedNumber(value.trim().replace(/%$/, ''), name);
    if (n < 0 || n > (pct ? 100 : 1)) iconInvalid('offset must be between 0 and 1 (or 0% and 100%).');
  } else if (OPACITIES.has(name)) {
    checkOpacity(name, value);
  } else if (name in ENUMS) {
    if (!ENUMS[name].includes(value.trim())) iconInvalid(`${name} must be one of ${ENUMS[name].join(', ')}.`);
  } else if (LENGTHS.has(name)) {
    checkLength(name, value);
  }
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
  const stack: Array<{ name: string; local: string; stops: number }> = [];
  const refs: Refs = { ids: new Set(), gradients: new Set(), uses: [] };
  let gradients = 0;
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
    const local = name;
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
      iconInvalid(`<${local}> is not allowed. Allowed elements: svg, g, defs, linearGradient, radialGradient, stop, path, rect, circle, ellipse, line, polyline, polygon, title, desc (no masks, clip paths, use, filters, patterns, styles, text, images or scripts).`);
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
    if (GRADIENTS.has(local) && ++gradients > MAX_GRADIENTS) iconInvalid(`it has more than ${MAX_GRADIENTS} gradients.`);
    if (local === 'stop') {
      const parent = stack[stack.length - 1];
      if (!parent || !GRADIENTS.has(parent.local)) iconInvalid('<stop> must be inside a gradient.');
      if (++parent.stops > MAX_STOPS) iconInvalid(`a gradient has more than ${MAX_STOPS} stops.`);
    }
    for (const [k, v] of attributes) {
      if (k === 'viewBox' && stack.length > 0) iconInvalid('viewBox belongs on the root <svg> only.');
      // The root's size attributes were checked together with its viewBox.
      if (stack.length === 0 && (k === 'width' || k === 'height' || k === 'viewBox' || k === 'xmlns')) { if (k === 'xmlns') checkAttribute(k, v, refs, local); continue; }
      checkAttribute(k, v, refs, local);
    }
    if (!selfClosing) stack.push({ name, local, stops: 0 });
    i = j;
  }
  if (stack.length > 0) iconInvalid('an element is not closed.');
  for (const id of refs.uses) if (!refs.gradients.has(id)) iconInvalid(`url(#${id}) must refer to a linearGradient or radialGradient of the icon.`);
  if (!rootSeen) iconInvalid('the root element must be <svg>.');
}

const validId = (id: string): boolean => /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id) && id.length <= MAX_ID_LENGTH;

export interface AppIconsOptions {
  /** Wall-clock limit of one `set` (default 3000 ms). */
  timeoutMs?: number;
  /** Jobs that may wait behind the running one (default 20). */
  queueLimit?: number;
  /** Replaces the worker program (a source text, or a function of the number of workers started so far); for tests only. */
  workerSource?: string | ((started: number) => string);
  /** Successful jobs after which the worker is replaced (default 50). */
  recycleAfter?: number;
  /** Waiting jobs per owner (default 2). */
  perOwnerLimit?: number;
}

interface Job { svg: string; color: string; owner?: string; resolve(files: Record<string, Uint8Array>): void; reject(e: unknown): void }
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
  private readonly workerSource: string | ((started: number) => string);
  private readonly recycleAfter: number;
  private readonly perOwnerLimit: number;
  /** Workers started so far (tests watch recycling). */
  workersStarted = 0;
  private jobsOnWorker = 0;
  private inflight = new Map<string, Promise<void>>();

  constructor(private dataDir: string, opts: AppIconsOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? RENDER_TIMEOUT_MS;
    this.queueLimit = opts.queueLimit ?? MAX_QUEUED;
    this.workerSource = opts.workerSource ?? ICON_WORKER_SOURCE;
    this.recycleAfter = opts.recycleAfter ?? RECYCLE_AFTER_JOBS;
    this.perOwnerLimit = opts.perOwnerLimit ?? MAX_QUEUED_PER_OWNER;
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
    const source = typeof this.workerSource === 'function' ? this.workerSource(this.workersStarted) : this.workerSource;
    this.workersStarted++;
    this.jobsOnWorker = 0;
    const worker = new Worker(source, {
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
  private draw(svg: string, color: string, owner?: string): Promise<Record<string, Uint8Array>> {
    if (this.closed) return Promise.reject(new LagerError('conflict', 'The icon renderer is shutting down.'));
    if (this.queue.length >= this.queueLimit) {
      return Promise.reject(new LagerError('conflict', 'Too many icons are waiting to be drawn. Try again in a moment.'));
    }
    if (owner !== undefined && this.queue.filter((j) => j.owner === owner).length >= this.perOwnerLimit) {
      return Promise.reject(new LagerError('conflict', 'You already have icons waiting to be drawn. Try again in a moment.'));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ svg, color, owner, resolve, reject });
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
    const rssBefore = process.memoryUsage.rss();
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
        if (m.type === 'done' && m.id === id) {
          // A worker is replaced after a number of jobs, or when the process grew by a lot while it drew: wasm memory is never given back.
          if (++this.jobsOnWorker >= this.recycleAfter || process.memoryUsage.rss() - rssBefore > RECYCLE_RSS_GROWTH) this.discardWorker();
          done(() => resolve(m.files));
        } else if (m.type === 'failed' && m.id === id) {
          // A failed drawing may have left the renderer in a broken state (a wasm trap poisons it): never reuse the worker.
          this.discardWorker();
          done(() => reject(failed(`it could not be drawn (${m.message}).`)));
        }
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
  set(appId: string, svg: string, themeColor: string, owner?: string): Promise<void> {
    if (!validId(appId)) return Promise.reject(new LagerError('invalid_argument', 'Invalid app id.'));
    try { this.validate(svg); } catch (e) { return Promise.reject(e); }
    const color = /^#[0-9a-f]{6}$/i.test(themeColor) ? themeColor : DEFAULT_THEME_COLOR;
    // Identical requests for one app that are in flight at the same time share one job.
    const key = `${appId}\0${color}\0${svg}`;
    const running = this.inflight.get(key);
    if (running) return running;
    const job = this.store(appId, svg, color, owner).finally(() => { this.inflight.delete(key); });
    this.inflight.set(key, job);
    return job;
  }

  private async store(appId: string, svg: string, color: string, owner?: string): Promise<void> {
    const drawn = await this.draw(svg, color, owner);
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
  async setDefault(appId: string, slug: string, themeColor: string, owner?: string): Promise<void> {
    if (this.has(appId)) return;
    await this.set(appId, defaultIconSvg(slug), themeColor, owner);
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
