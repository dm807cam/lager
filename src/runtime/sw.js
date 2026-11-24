/* Lager service worker: keeps the page of this instance, its session and the scripts it loads, so the app opens without a
   connection (see docs/adr/0019-offline-first-runtime.md). The runtime registers it with scope "/" on every instance whose
   active version does not turn offline off. Plain ES2020, no dependencies.

   What it answers:
   - the page ("/", "/index.html") and "/__lager/session" for the top-level page: from the network, falling back to the copy
     kept here when the network fails, the server is down (502, 503, 504) or takes longer than NETWORK_TIMEOUT_MS. Frames are
     always left to the network;
   - the runtime's own scripts, the manifest and the icons: the same, once a page is kept;
   - scripts, stylesheets and fonts from other hosts (CDNs): the same, at most MAX_FOREIGN of them, of which at most MAX_OPAQUE
     opaque copies (requests without CORS), because browsers charge every opaque copy several megabytes of the storage quota.
     Such requests go out exactly as the page made them: a request the worker built itself would follow the worker's referrer
     policy instead of the page's and, with CORS, carry an Origin, telling the CDN which instance loaded it.
   Everything else (the database, its event stream, uploads, rooms, sign-in, any request that is not a GET) never touches it.

   What it keeps is decided by the server, never by the page: only a response marked `X-Lager-Offline: 1` is kept. An answer
   for the page or the session that says the viewer has no access (a redirect to the sign-in, 401, 403) or that the instance is
   gone (404, 410), or a page or session without the mark (the app turned offline off), deletes everything kept here.
   The kept session never holds the viewer's email address or the sign-in link: opening the app offline needs neither. */
'use strict';

var CACHE = 'lager-offline-1';
var CACHE_PREFIX = 'lager-offline-';
var PAGE_KEY = '/';
var SESSION_KEY = '/__lager/session';
var OFFLINE_HEADER = 'X-Lager-Offline';
var FROM_CACHE_HEADER = 'X-Lager-From-Cache';
var NETWORK_TIMEOUT_MS = 4000;
var MAX_FOREIGN = 40;
var MAX_OPAQUE = 10;
/** For the requests this worker makes itself (precache), as the page has it: other hosts learn nothing about the instance. */
var REFERRER_POLICY = 'same-origin';
var SHELL_RE = /^\/(__lager\/(runtime\.js|badge\.js|manifest\.webmanifest|icon-(180|192|512|512-maskable)\.png)|apple-touch-icon\.png|favicon\.ico)$/;
var FOREIGN_DESTINATIONS = ['script', 'style', 'font'];
var GONE = [401, 403, 404, 410];
var DOWN = [502, 503, 504];

function clearAll() {
  return caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf(CACHE_PREFIX) === 0; }).map(function (k) { return caches.delete(k); }));
  });
}

function pageKept() {
  return caches.open(CACHE).then(function (c) { return c.match(PAGE_KEY); }).then(function (r) { return !!r; });
}

/** A copy of a kept response that says where it came from. An opaque response (another host, no CORS) cannot be copied and goes out as it is. */
function marked(res) {
  if (res.type === 'opaque') return res;
  var headers = new Headers(res.headers);
  headers.set(FROM_CACHE_HEADER, '1');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: headers });
}

/**
 * The page or the session came back from the network: keep it, delete everything, or leave things as they are.
 * Resolves once the decision is stored, so a script the page asks for next already sees whether the page is kept.
 */
function judgeEntry(key, res) {
  if (res.type === 'opaqueredirect' || (res.redirected && key === PAGE_KEY) || GONE.indexOf(res.status) !== -1) return clearAll();
  if (!res.ok) return Promise.resolve();
  if (res.headers.get(OFFLINE_HEADER) !== '1') return clearAll();
  var copy = key === SESSION_KEY ? reducedSession(res) : Promise.resolve(res.clone());
  return copy.then(function (r) {
    if (!r) return;
    return caches.open(CACHE).then(function (c) { return c.put(key, r); });
  });
}

/**
 * What is kept of a session: everything but the viewer's email address (null, as for an app without the `email` scope) and
 * the sign-in link, which only works online and whose nonce goes stale. Resolves null for an answer that is not a session.
 */
function reducedSession(res) {
  return res.clone().json().then(function (body) {
    if (!body || typeof body !== 'object' || !body.viewer || typeof body.viewer !== 'object') return null;
    var copy = {};
    Object.keys(body).forEach(function (k) { if (k !== 'loginUrl') copy[k] = body[k]; });
    copy.viewer = {};
    Object.keys(body.viewer).forEach(function (k) { copy.viewer[k] = body.viewer[k]; });
    copy.viewer.email = null;
    var headers = new Headers(res.headers);
    headers.delete('Content-Length');
    return new Response(JSON.stringify(copy), { status: res.status, statusText: res.statusText, headers: headers });
  }, function () { return null; });
}

/** Whether a request comes from the top-level page; one whose client cannot be told is treated as a frame. */
function fromTopLevel(event) {
  if (!event.clientId || !self.clients || typeof self.clients.get !== 'function') return Promise.resolve(false);
  return Promise.resolve(self.clients.get(event.clientId)).then(function (c) { return !!c && c.frameType === 'top-level'; }, function () { return false; });
}


/** A script, the manifest, an icon or a file from another host: kept only while the page is, so nothing piles up for an app that turned offline off. */
function judgeShell(key, res, foreign) {
  if (!(res.ok || (foreign && res.type === 'opaque'))) return Promise.resolve();
  var copy = res.clone();
  return pageKept().then(function (kept) {
    if (!kept) return;
    return caches.open(CACHE).then(function (c) {
      return c.put(key, copy).then(function () { return foreign ? trimForeign(c) : undefined; });
    });
  });
}

/**
 * Keeps the newest MAX_FOREIGN files from other hosts, and of them the newest MAX_OPAQUE opaque ones; the cache lists keys in
 * the order they were stored.
 */
function trimForeign(c) {
  return c.keys().then(function (keys) {
    var foreign = keys.filter(function (k) { return new URL(k.url).origin !== self.location.origin; });
    return Promise.all(foreign.map(function (k) { return c.match(k).then(function (r) { return { key: k, opaque: !!r && r.type === 'opaque' }; }); }));
  }).then(function (entries) {
    var drop = [];
    var opaque = entries.filter(function (e) { return e.opaque; });
    opaque.slice(0, Math.max(0, opaque.length - MAX_OPAQUE)).forEach(function (e) { drop.push(e); });
    var rest = entries.filter(function (e) { return drop.indexOf(e) === -1; });
    rest.slice(0, Math.max(0, rest.length - MAX_FOREIGN)).forEach(function (e) { drop.push(e); });
    return Promise.all(drop.map(function (e) { return c.delete(e.key); }));
  });
}

/**
 * Network first: the network's answer when it comes in time, else the kept copy. `judge` decides what to keep and runs
 * whether the answer comes in time or not (the event waits for it). `usable` tells whether a kept copy may answer this request.
 */
function networkFirst(event, load, key, judge, usable) {
  var network = load();
  var judged = network.then(function (res) { return judge(key, res); }, function () { /* offline: nothing to decide */ });
  event.waitUntil(judged.catch(function () { /* a full disk must not break the page */ }));
  var kept = caches.open(CACHE).then(function (c) { return c.match(key); }).then(function (r) { return r && usable(r) ? r : null; }, function () { return null; });

  return new Promise(function (resolve, reject) {
    var done = false;
    var timer = null;
    function answer(res) { if (!done) { done = true; if (timer !== null) clearTimeout(timer); resolve(res); } }
    function fallBack(otherwise) {
      kept.then(function (r) {
        if (r) answer(marked(r));
        else if (otherwise) otherwise();
      });
    }
    // Only a kept copy cuts a slow answer short; without one the page waits for the network as it would without this worker.
    kept.then(function (r) { if (r && !done) timer = setTimeout(function () { fallBack(null); }, NETWORK_TIMEOUT_MS); });
    network.then(function (res) {
      if (DOWN.indexOf(res.status) !== -1) { fallBack(function () { answer(res); }); return; }
      // The decision about the page is stored before the page goes out, so the scripts it loads next see it.
      judged.then(function () { answer(res); }, function () { answer(res); });
    }, function (e) {
      fallBack(function () { if (!done) { done = true; reject(e); } });
    });
  });
}

var always = function () { return true; };

self.addEventListener('install', function (event) {
  self.skipWaiting();
  event.waitUntil(precache().catch(function () { /* installing never fails on a missing connection */ }));
});

self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf(CACHE_PREFIX) === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;
  var url = new URL(request.url);
  if (url.origin === self.location.origin) {
    var load = function () { return fetch(request); };
    // Only the top-level page: a frame (the instance inside itself, an embedding website) neither gets nor replaces a kept copy.
    if (request.mode === 'navigate' && request.destination === 'document' && (url.pathname === '/' || url.pathname === '/index.html')) {
      event.respondWith(networkFirst(event, load, PAGE_KEY, judgeEntry, always));
    } else if (url.pathname === SESSION_KEY) {
      event.respondWith(fromTopLevel(event).then(function (top) {
        return top ? networkFirst(event, load, SESSION_KEY, judgeEntry, always) : fetch(request);
      }));
    } else if (SHELL_RE.test(url.pathname)) {
      event.respondWith(networkFirst(event, load, url.pathname + url.search, function (k, r) { return judgeShell(k, r, false); }, always));
    }
    return;
  }
  if ((url.protocol === 'https:' || url.protocol === 'http:') && FOREIGN_DESTINATIONS.indexOf(request.destination) !== -1) {
    // A request in CORS mode (a module, `crossorigin`) cannot be answered with an opaque copy.
    var usable = function (r) { return request.mode !== 'cors' || r.type !== 'opaque'; };
    // Passed on as the page made it, with the page's referrer policy and mode (see the top of this file).
    event.respondWith(networkFirst(event, function () { return fetch(request); }, request.url, function (k, r) { return judgeShell(k, r, true); }, usable));
  }
});

// ------------------------------------------------------------------ precache

var TAG_RE = /<(script|link)\b([^>]*)>/gi;
var ATTR_RE = /([a-zA-Z-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

function attributes(text) {
  var out = {};
  var m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(text)) !== null) out[m[1].toLowerCase()] = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5];
  // `crossorigin` without a value means "anonymous".
  if (!('crossorigin' in out) && /(^|\s)crossorigin(\s|\/|$)/i.test(text)) out.crossorigin = '';
  return out;
}

/** Scripts and stylesheets from other hosts that the page names in its markup, with the request mode the browser will use for them. */
function foreignFiles(html) {
  var out = [];
  var m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(html)) !== null) {
    var a = attributes(m[2]);
    var href = m[1].toLowerCase() === 'script' ? a.src : (/\bstylesheet\b/i.test(a.rel || '') ? a.href : undefined);
    if (!href) continue;
    var url;
    try { url = new URL(href, self.location.origin); } catch (_) { continue; }
    if (url.origin === self.location.origin || (url.protocol !== 'https:' && url.protocol !== 'http:')) continue;
    var cors = 'crossorigin' in a || (m[1].toLowerCase() === 'script' && (a.type || '').toLowerCase() === 'module');
    out.push({ url: url.href, cors: cors, credentials: a.crossorigin === 'use-credentials' ? 'include' : 'omit' });
  }
  return out.slice(0, MAX_FOREIGN);
}

/**
 * On the first visit the page loaded before this worker existed: fetch the page and the session once, and when the server
 * marks them for keeping, the runtime and the files from other hosts the page names, so the app opens offline the next time.
 */
function precache() {
  return fetch(PAGE_KEY, { credentials: 'same-origin', redirect: 'manual' }).then(function (page) {
    return judgeEntry(PAGE_KEY, page).then(function () { return pageKept(); }).then(function (kept) {
      if (!kept) return;
      return page.clone().text().then(function (html) {
        var jobs = [
          fetch(SESSION_KEY, { credentials: 'same-origin' }).then(function (r) { return judgeEntry(SESSION_KEY, r); }),
          fetch('/__lager/runtime.js', { credentials: 'same-origin' }).then(function (r) { return judgeShell('/__lager/runtime.js', r, false); }),
        ];
        foreignFiles(html).forEach(function (f) {
          // The mode the page's own tag asks for, and the page's referrer policy: no more than the page itself tells the CDN.
          var init = f.cors ? { mode: 'cors', credentials: f.credentials, referrerPolicy: REFERRER_POLICY }
            : { mode: 'no-cors', credentials: 'omit', referrerPolicy: REFERRER_POLICY };
          jobs.push(fetch(f.url, init).then(function (r) { return judgeShell(f.url, r, true); }));
        });
        return Promise.all(jobs.map(function (j) { return j.catch(function () { /* one missing file does not stop the rest */ }); }));
      });
    });
  });
}
