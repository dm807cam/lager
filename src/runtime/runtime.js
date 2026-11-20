/* Lager browser runtime: provides window.lager.use("db" | "user" | "assets" | "room" | "page" | "downloads" | "ingest" | "permissions")
   and window.lager.complete on top of the /__lager/* endpoints. Plain ES2020, no dependencies. */
(function () {
  'use strict';

  // A second inclusion of this script (a page that lists it twice) must not replace the first one's state.
  if (window.__lagerRuntime) return;
  Object.defineProperty(window, '__lagerRuntime', { value: true, configurable: true });

  var SESSION_URL = '/__lager/session';
  var USERS_URL = '/__lager/users?ids=';
  var PROFILE_MISS_MS = 60000;
  var DB_URL = '/__lager/db';
  var ASSETS_URL = '/__lager/assets';
  var EVENTS_URL = '/__lager/db/events';
  var COMPLETE_URL = '/__lager/complete';
  var INGEST_URL = '/__lager/ingest';
  var RETRY_MIN_MS = 1000;
  var RETRY_MAX_MS = 30000;
  // A listener reloads at most this often: changes arriving sooner are answered by one reload at the end of the interval.
  var MIN_REFRESH_MS = 250;
  var MAX_PROFILE_IDS = 100;
  var MAX_SEARCH_HITS = 8;
  var SEARCH_URL = '/__lager/users?q=';
  var META = Object.freeze({ fromCache: false, hasPendingWrites: false });
  var ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

  function reportError(e) {
    if (typeof window.reportError === 'function') window.reportError(e);
    else if (typeof console !== 'undefined') console.error(e);
  }

  function deepFreeze(v) {
    if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
      Object.freeze(v);
      Object.keys(v).forEach(function (k) { deepFreeze(v[k]); });
    }
    return v;
  }

  // ---------------------------------------------------------------- session

  var sessionPromise = null;

  /** Resolves `{session, transient}`; `transient` marks an answer that says nothing about the viewer (network trouble, a server error). */
  function loadSession() {
    return fetch(SESSION_URL, { credentials: 'same-origin' }).then(function (res) {
      if (!res.ok) return { session: null, transient: res.status >= 500 || res.status === 429 };
      return res.json().then(function (body) {
        return { session: body && typeof body === 'object' && body.viewer && typeof body.viewer === 'object' ? body : null, transient: false };
      });
    }).catch(function () { return { session: null, transient: true }; });
  }

  /** The session is fetched once per page; a transient failure is not kept, so the next call asks again. */
  function getSession() {
    if (!sessionPromise) {
      var p = loadSession().then(function (r) {
        if (r.transient && sessionPromise === p) sessionPromise = null;
        return r.session;
      });
      sessionPromise = p;
    }
    return sessionPromise;
  }

  function viewerOf(session) { return session ? session.viewer : null; }
  function levelOf(session) {
    var v = viewerOf(session);
    return v && typeof v.level === 'string' && v.level !== '' ? v.level : null;
  }
  function viewerId(session) {
    var v = viewerOf(session);
    return v && typeof v.id === 'string' && v.id !== '' ? v.id : null;
  }

  // ------------------------------------------------------------------ db transport

  function mapError(error) {
    var code = error && error.code;
    var message = error && typeof error.message === 'string' ? error.message : 'Request failed.';
    if (code === 'forbidden') code = 'not_granted';
    else if (code !== 'invalid_argument' && code !== 'quota_exceeded') code = 'unavailable';
    return { code: code, message: message };
  }

  function dbCall(body) {
    var payload;
    try {
      payload = JSON.stringify(body);
    } catch (e) {
      return Promise.reject({ code: 'invalid_argument', message: 'Document is not serializable as JSON.' });
    }
    return fetch(DB_URL, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Lager-Request': '1' },
      body: payload,
    }).then(
      function (res) {
        return res.json().catch(function () { return null; }).then(function (json) {
          if (json && json.error) {
            var mapped = mapError(json.error);
            // Too many requests: the server says how long to wait. Kept off the enumerable fields, apps see {code, message}.
            var wait = res.status === 429 && res.headers && typeof res.headers.get === 'function' ? Number(res.headers.get('Retry-After')) : NaN;
            if (wait > 0) Object.defineProperty(mapped, 'retryAfterMs', { value: Math.min(wait * 1000, RETRY_MAX_MS) });
            throw mapped;
          }
          if (!res.ok || !json) throw { code: 'unavailable', message: 'Unexpected response (' + res.status + ').' };
          return json;
        });
      },
      function (e) { throw { code: 'unavailable', message: e && e.message ? String(e.message) : 'Network error.' }; }
    );
  }

  // ------------------------------------------------------------------ paths

  var SEGMENT_RE = /^[A-Za-z0-9_\-.~:@+]+$/;

  function byteLength(s) {
    return typeof TextEncoder === 'function' ? new TextEncoder().encode(s).length : unescape(encodeURIComponent(s)).length;
  }

  /** Throws TypeError unless `path` is a valid document (`doc`) or collection path. */
  function checkPath(path, isDoc) {
    var what = isDoc ? 'document' : 'collection';
    if (typeof path !== 'string' || path === '') throw new TypeError('A ' + what + ' path must be a non-empty string.');
    var segs = path.split('/');
    if (segs.length > 16) throw new TypeError('A path has at most 16 segments.');
    if (byteLength(path) > 1000) throw new TypeError('A path has at most 1000 bytes.');
    segs.forEach(function (s) {
      if (s === '') throw new TypeError('A path must not contain empty segments.');
      if (s === '.' || s === '..') throw new TypeError('A path segment must not be "." or "..".');
      if (!SEGMENT_RE.test(s)) throw new TypeError('Path segment "' + s + '" has characters outside letters, digits and _ - . ~ : @ +.');
      if (byteLength(s) > 200) throw new TypeError('A path segment has at most 200 bytes.');
    });
    if (isDoc && segs.length % 2 !== 0) throw new TypeError('"' + path + '" has an odd number of segments; a document path needs an even number.');
    if (!isDoc && segs.length % 2 !== 1) throw new TypeError('"' + path + '" has an even number of segments; a collection path needs an odd number.');
    return path;
  }

  function autoId() {
    var out = '';
    var c = typeof crypto !== 'undefined' && crypto.getRandomValues ? crypto : null;
    while (out.length < 20) {
      if (c) {
        // Rejection sampling keeps the 62-character alphabet uniform.
        var bytes = c.getRandomValues(new Uint8Array(32));
        for (var i = 0; i < bytes.length && out.length < 20; i++) if (bytes[i] < 248) out += ALPHABET[bytes[i] % 62];
      } else {
        out += ALPHABET[Math.floor(Math.random() * 62)];
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ snapshots

  var versions = new WeakMap();

  function docKey(doc) { return doc ? doc.version + '@' + doc.updatedAt : null; }

  /** Builds a DocumentSnapshot, reusing `prev` when the stored document did not change. */
  function makeDocSnapshot(id, doc, prev) {
    var key = docKey(doc);
    if (prev && versions.get(prev) === key && prev.exists === !!doc) return prev;
    var exists = !!doc;
    var data = exists ? deepFreeze(doc.data) : undefined;
    var snap = Object.freeze({ id: id, exists: exists, data: function () { return data; }, metadata: META });
    versions.set(snap, key);
    return snap;
  }

  function makeQuerySnapshot(rawDocs, prev) {
    var prevDocs = prev ? prev.docs : [];
    var prevIndex = new Map();
    prevDocs.forEach(function (d, i) { prevIndex.set(d.id, i); });
    var docs = rawDocs.map(function (raw) {
      var i = prevIndex.get(raw.id);
      return makeDocSnapshot(raw.id, raw, i === undefined ? null : prevDocs[i]);
    });
    var newIndex = new Map();
    docs.forEach(function (d, i) { newIndex.set(d.id, i); });
    var changes = [];
    prevDocs.forEach(function (d, i) {
      if (!newIndex.has(d.id)) changes.push(Object.freeze({ type: 'removed', doc: d, oldIndex: i, newIndex: -1 }));
    });
    docs.forEach(function (d, i) {
      var old = prevIndex.get(d.id);
      if (old === undefined) changes.push(Object.freeze({ type: 'added', doc: d, oldIndex: -1, newIndex: i }));
      else if (prevDocs[old] !== d) changes.push(Object.freeze({ type: 'modified', doc: d, oldIndex: old, newIndex: i }));
    });
    Object.freeze(docs);
    Object.freeze(changes);
    return Object.freeze({
      docs: docs, size: docs.length, empty: docs.length === 0,
      docChanges: function () { return changes; }, metadata: META,
    });
  }

  // ------------------------------------------------------------------ live updates

  var listeners = new Set();
  var source = null;
  var sourceFailed = false;
  var sourceRetryTimer = null;
  var sourceRetryDelay = RETRY_MIN_MS;

  function refreshWhere(match) {
    Array.from(listeners).forEach(function (l) { if (match(l)) l.refresh(); });
  }

  function openSource() {
    if (source || sourceRetryTimer !== null || typeof EventSource === 'undefined') return;
    var es = new EventSource(EVENTS_URL);
    source = es;
    es.addEventListener('change', function (e) {
      var change;
      try { change = JSON.parse(e.data); } catch (_) { return; }
      if (!change || typeof change !== 'object') return;
      refreshWhere(function (l) { return l.matches(change); });
    });
    es.addEventListener('reset', function () { refreshWhere(function () { return true; }); });
    es.addEventListener('reload', onReloadEvent);
    es.addEventListener('error', function () {
      sourceFailed = true;
      onStreamError();
      // The browser retries by itself after a dropped connection, but gives up for good on an HTTP error
      // (a 502 from the proxy while the server restarts, a 429): then the stream has to be opened anew.
      if (source !== es || es.readyState !== 2) return;
      source = null;
      if (listeners.size === 0 && !keepSourceOpen) return;
      sourceRetryTimer = setTimeout(function () { sourceRetryTimer = null; openSource(); }, sourceRetryDelay);
      sourceRetryDelay = Math.min(sourceRetryDelay * 2, RETRY_MAX_MS);
    });
    es.addEventListener('open', function () {
      sourceRetryDelay = RETRY_MIN_MS;
      onStreamOpen();
      // Changes landing before the stream opened, or while it was down, are lost: catch up (deduplicated by key).
      sourceFailed = false;
      refreshWhere(function () { return true; });
    });
  }

  function closeSourceIfIdle() {
    if (listeners.size !== 0 || keepSourceOpen) return;
    if (sourceRetryTimer !== null) { clearTimeout(sourceRetryTimer); sourceRetryTimer = null; }
    if (source) {
      source.close();
      source = null;
      sourceFailed = false;
    }
  }

  /**
   * Registers a listener. `load()` resolves `{key, value}`; `value` is delivered to `next` the first time and
   * whenever `key` differs from the previous delivery. Returns the unsubscribe function.
   */
  function listen(matches, load, next, error) {
    var active = true;
    var running = false;
    var dirty = false;
    var first = true;
    var lastKey = null;
    var retryTimer = null;
    var retryDelay = RETRY_MIN_MS;
    // No reload starts before this time: the minimum interval after the last one, or what the server asked for.
    var notBefore = 0;
    var listener = { matches: matches, refresh: refresh };

    function stop() {
      active = false;
      if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; }
      listeners.delete(listener);
      closeSourceIfIdle();
    }

    function fail(e) {
      stop();
      if (typeof error === 'function') {
        try { error(e); } catch (cbErr) { reportError(cbErr); }
      } else {
        reportError(e);
      }
    }

    function refresh() {
      if (!active) return;
      if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; }
      if (running) { dirty = true; return; }
      var now = Date.now();
      if (now < notBefore) {
        // Too soon: one reload when the wait is over answers every change that arrives until then.
        retryTimer = setTimeout(function () { retryTimer = null; refresh(); }, notBefore - now);
        return;
      }
      notBefore = now + MIN_REFRESH_MS;
      running = true;
      dirty = false;
      load().then(
        function (result) {
          running = false;
          if (!active) return;
          retryDelay = RETRY_MIN_MS;
          if (first || result.key !== lastKey) {
            first = false;
            lastKey = result.key;
            try { next(result.value); } catch (cbErr) { reportError(cbErr); }
          }
          if (dirty && active) refresh();
        },
        function (e) {
          running = false;
          if (!active) return;
          if (e && e.code === 'unavailable') {
            // Transient: keep the listener and retry with a bounded backoff (an event or reconnect retries sooner,
            // but never before the time a rate-limited answer asked to wait).
            var wait = Math.max(retryDelay, e.retryAfterMs || 0);
            if (e.retryAfterMs) notBefore = Math.max(notBefore, Date.now() + e.retryAfterMs);
            retryTimer = setTimeout(function () { retryTimer = null; refresh(); }, wait);
            retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
          } else {
            fail(e);
          }
        }
      );
    }

    listeners.add(listener);
    openSource();
    refresh();
    return function unsubscribe() { if (active) stop(); };
  }

  // ------------------------------------------------------------------ references

  function makeDocRef(path) {
    var segs = path.split('/');
    var id = segs[segs.length - 1];
    return Object.freeze({
      id: id,
      path: path,
      get: function () {
        return dbCall({ op: 'get', path: path }).then(function (r) { return makeDocSnapshot(id, r.doc || null, null); });
      },
      set: function (data) { return dbCall({ op: 'set', path: path, data: data }).then(function () {}); },
      update: function (data) { return dbCall({ op: 'update', path: path, data: data }).then(function () {}); },
      delete: function () { return dbCall({ op: 'delete', path: path }).then(function () {}); },
      acquire: function (options) {
        return dbCall({ op: 'acquire', path: path, options: options }).then(function (r) {
          var out = {};
          ['acquired', 'version', 'expiresAt', 'holder'].forEach(function (k) { if (r[k] !== undefined) out[k] = r[k]; });
          if (!out.acquired) delete out.holder; // the server never names the holder of a busy lease; older servers did
          return out;
        });
      },
      onSnapshot: function (next, error) {
        var prev = null;
        return listen(
          function (change) { return change.path === path; },
          function () {
            return dbCall({ op: 'get', path: path }).then(function (r) {
              var snap = makeDocSnapshot(id, r.doc || null, prev);
              prev = snap;
              return { key: versions.get(snap), value: snap };
            });
          },
          next, error
        );
      },
      collection: function (sub) {
        if (typeof sub !== 'string') throw new TypeError('A collection path must be a string.');
        return makeCollectionRef(checkPath(path + '/' + sub, false));
      },
    });
  }

  function makeQuery(path, spec) {
    function extend(patch) {
      var next = {};
      Object.keys(spec).forEach(function (k) { next[k] = spec[k]; });
      Object.keys(patch).forEach(function (k) { next[k] = patch[k]; });
      return makeQuery(path, next);
    }
    return Object.freeze({
      where: function (field, op, value) { return extend({ where: (spec.where || []).concat([[field, op, value]]) }); },
      orderBy: function (field, dir) { return extend({ orderBy: (spec.orderBy || []).concat([[field, dir === undefined ? 'asc' : dir]]) }); },
      limit: function (n) { return extend({ limit: n }); },
      get: function () {
        return dbCall({ op: 'query', path: path, query: spec }).then(function (r) { return makeQuerySnapshot(r.docs || [], null); });
      },
      onSnapshot: function (next, error) {
        var prev = null;
        return listen(
          function (change) { return change.parent === path; },
          function () {
            return dbCall({ op: 'query', path: path, query: spec }).then(function (r) {
              var rawDocs = r.docs || [];
              var snap = makeQuerySnapshot(rawDocs, prev);
              // `prev` only advances when the snapshot is actually delivered (see the wrapper below).
              return { key: JSON.stringify(rawDocs.map(function (d) { return [d.id, docKey(d)]; })), value: snap };
            });
          },
          function (snap) { prev = snap; next(snap); },
          error
        );
      },
    });
  }

  function makeCollectionRef(path) {
    var q = Object.assign({}, makeQuery(path, {}));
    q.path = path;
    q.doc = function (id) {
      if (id !== undefined && typeof id !== 'string') throw new TypeError('A document id must be a string.');
      return makeDocRef(checkPath(path + '/' + (id === undefined ? autoId() : id), true));
    };
    q.add = function (data) {
      // The server makes up the id and decides by the rules whether this viewer writes here or may only append
      // (`write: "anyone"`); the page cannot know which, and an id of its own choosing could name a document that exists.
      return dbCall({ op: 'add', path: path, data: data }).then(function (r) {
        if (typeof r.id !== 'string') throw { code: 'unavailable', message: 'Unexpected response.' };
        return makeDocRef(checkPath(path + '/' + r.id, true));
      });
    };
    return Object.freeze(q);
  }

  var db = Object.freeze({
    doc: function (path) { return makeDocRef(checkPath(path, true)); },
    collection: function (path) { return makeCollectionRef(checkPath(path, false)); },
  });

  // ------------------------------------------------------------------ user

  function hash(s) {
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  function colorFor(id) { return 'hsl(' + (hash(id || '') % 360) + ' 65% 45%)'; }

  function buildUser(session) {
    var v = viewerOf(session) || {};
    var id = viewerId(session);
    var level = levelOf(session);
    var cache = new Map();
    var misses = new Map(); // id -> time until which it is not asked again
    var inflight = new Map();

    function toProfile(p) {
      return Object.freeze({
        id: p.id, name: typeof p.name === 'string' ? p.name : '', avatarUrl: '', color: colorFor(p.id),
        email: typeof p.email === 'string' ? p.email : null, isMe: p.isMe === true, guest: false,
      });
    }

    function fetchChunk(ids) {
      var p = fetch(USERS_URL + ids.map(encodeURIComponent).join(','), { credentials: 'same-origin' })
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(function (body) {
          var found = body && body.profiles && typeof body.profiles === 'object' ? body.profiles : null;
          if (!found) return;
          ids.forEach(function (i) {
            var entry = Object.prototype.hasOwnProperty.call(found, i) && found[i] && typeof found[i].id === 'string' ? found[i] : null;
            // A miss is only kept for a short while: the server names the people this instance knows, and someone
            // who writes here, joins a room or is given access becomes known later.
            if (entry) { cache.set(i, toProfile(entry)); misses.delete(i); } else misses.set(i, Date.now() + PROFILE_MISS_MS);
          });
        })
        .catch(function () { /* never rejects; the ids are retried on the next call */ })
        .then(function () { ids.forEach(function (i) { inflight.delete(i); }); });
      ids.forEach(function (i) { inflight.set(i, p); });
    }

    function profiles(input) {
      var list = (Array.isArray(input) ? input : [input]).filter(function (i) { return typeof i === 'string' && i !== ''; });
      list = Array.from(new Set(list));
      if (session) {
        var now = Date.now();
        var need = list.filter(function (i) { return !cache.has(i) && !inflight.has(i) && !(misses.get(i) > now); });
        for (var n = 0; n < need.length; n += MAX_PROFILE_IDS) fetchChunk(need.slice(n, n + MAX_PROFILE_IDS));
      }
      var waits = Array.from(new Set(list.map(function (i) { return inflight.get(i); }).filter(Boolean)));
      return Promise.all(waits).then(function () {
        var out = {};
        list.forEach(function (i) { var e = cache.get(i); if (e) out[i] = e; });
        return out;
      });
    }

    var searchSeq = 0;
    var latestSearch = null;

    // A typeahead over the people who can open this instance; never rejects. A call that a newer one
    // supersedes resolves with the newer call's result, so handlers wired straight to oninput paint the final list.
    function search(query) {
      var mine = ++searchSeq;
      var run = typeof query !== 'string' || !session ? Promise.resolve([]) : fetch(SEARCH_URL + encodeURIComponent(query), { credentials: 'same-origin' })
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(function (body) {
          var list = body && Array.isArray(body.profiles) ? body.profiles : [];
          var out = [];
          for (var n = 0; n < list.length && out.length < MAX_SEARCH_HITS; n++) {
            var entry = list[n];
            if (!entry || typeof entry.id !== 'string' || entry.id === '' || typeof entry.name !== 'string' || entry.name === '') continue;
            var hit = toProfile(entry);
            cache.set(hit.id, hit);
            out.push(hit);
          }
          return out;
        })
        .catch(function () { return []; });
      latestSearch = run;
      return run.then(function (hits) { return mine === searchSeq ? hits : latestSearch; });
    }

    function me() {
      return Object.freeze({
        id: id, name: typeof v.name === 'string' ? v.name : '', avatarUrl: '', color: colorFor(id),
        email: typeof v.email === 'string' ? v.email : null, isOwner: v.isOwner === true, canEdit: v.canEdit === true,
      });
    }

    return Object.freeze({
      isOwner: function () { return Promise.resolve(v.isOwner === true); },
      canEdit: function () { return Promise.resolve(v.canEdit === true); },
      can: function (capability) {
        if (capability !== 'data.write') return Promise.resolve(null);
        if (level === 'interact' || level === 'admin' || level === 'owner') return Promise.resolve(true);
        return Promise.resolve(level === 'view' ? false : null);
      },
      id: function () { return Promise.resolve(id); },
      me: function () { return Promise.resolve(me()); },
      name: function () { return Promise.resolve(me().name); },
      email: function () { return Promise.resolve(me().email); },
      avatarUrl: function () { return Promise.resolve(null); },
      profiles: profiles,
      search: search,
    });
  }

  // ------------------------------------------------------------------ assets

  var ASSET_ID_RE = /^[0-9a-f]{32}$/;
  var BLOB_PREFIX = '/_blob/';

  function assetsAllowed(session) {
    var caps = session && session.capabilities;
    var decl = caps && caps.assets;
    if (!decl || typeof decl !== 'object') return false;
    var level = levelOf(session);
    return level === 'admin' || level === 'owner' || (level === 'interact' && decl.upload === 'interact');
  }

  function assetError(code, message) { return { code: code, message: message }; }

  /** Maps a failed asset response to the contract's upload error codes. */
  function assetFailure(res, json) {
    var error = json && json.error;
    var message = error && typeof error.message === 'string' ? error.message : 'Request failed (' + res.status + ').';
    var reason = error && typeof error.reason === 'string' ? error.reason : '';
    var code;
    if (res.status === 413 || reason === 'too_large') code = 'too_large';
    else if (res.status === 403) code = 'not_uploader';
    else if (res.status === 507 || res.status === 409) code = 'quota_or_state';
    else if (res.status === 401) code = 'upstream_auth';
    else if (res.status === 429) code = 'rate_limited';
    else if (res.status === 400) code = reason === 'unsupported_type' || reason === 'invalid_request' ? reason : 'invalid_request';
    else code = 'upstream_error';
    return assetError(code, message);
  }

  function assetCall(url, init, body) {
    init.credentials = 'same-origin';
    init.body = body;
    return fetch(url, init).then(
      function (res) {
        return res.json().catch(function () { return null; }).then(function (json) {
          if (!res.ok) throw assetFailure(res, json);
          if (!json || typeof json !== 'object') throw assetError('upstream_error', 'Unexpected response (' + res.status + ').');
          return json;
        });
      },
      function (e) { throw assetError('store_unavailable', e && e.message ? String(e.message) : 'Network error.'); }
    );
  }

  function buildAssets() {
    function upload(blob, options) {
      return Promise.resolve().then(function () {
        if (typeof Blob === 'undefined' || !(blob instanceof Blob)) throw assetError('invalid_request', 'upload expects a Blob or File.');
        if (blob.size === 0) throw assetError('invalid_request', 'The file is empty.');
        if (options !== undefined && options !== null && (typeof options !== 'object' || (options.type !== undefined && typeof options.type !== 'string'))) {
          throw assetError('invalid_request', 'options.type must be a string.');
        }
        var type = options && options.type ? options.type : blob.type;
        if (!type) throw assetError('invalid_request', 'The blob has no type; pass options.type.');
        return assetCall(ASSETS_URL, { method: 'POST', headers: { 'Content-Type': type, 'X-Lager-Request': '1' } }, blob);
      }).then(function (r) {
        return Object.freeze({ id: r.id, url: r.url, sizeBytes: r.sizeBytes, contentType: r.contentType });
      });
    }

    function list() {
      return assetCall(ASSETS_URL, { method: 'GET' }, undefined).then(function (r) {
        // The server answers newest first; the contract lists oldest first.
        var items = (Array.isArray(r.assets) ? r.assets : []).slice().reverse().map(function (a) {
          return Object.freeze({ id: a.id, url: a.url, contentType: a.contentType, sizeBytes: a.sizeBytes, createdAt: a.createdAt });
        });
        var u = r.usage || {};
        return Object.freeze({
          assets: Object.freeze(items),
          usage: Object.freeze({ files: u.files, bytes: u.bytes, maxFiles: u.maxFiles, maxBytes: u.maxBytes }),
        });
      });
    }

    function remove(ref) {
      return Promise.resolve().then(function () {
        var id = typeof ref === 'string' && ref.indexOf(BLOB_PREFIX) === 0 ? ref.slice(BLOB_PREFIX.length) : ref;
        if (typeof id !== 'string' || !ASSET_ID_RE.test(id)) throw assetError('invalid_request', 'delete expects an asset id or its url.');
        return assetCall(ASSETS_URL + '/' + id, { method: 'DELETE', headers: { 'X-Lager-Request': '1' } }, undefined);
      }).then(function (r) { return Object.freeze({ deleted: r.deleted === true }); });
    }

    return Object.freeze({ upload: upload, list: list, delete: remove });
  }

  // ------------------------------------------------------------------ room

  var ROOM_URL = '/__lager/room';
  var ROOM_EVENTS_URL = '/__lager/room/events';
  var TOPIC_RE = /^[a-z][a-z0-9_.-]{0,47}$/;
  var ROOM_NAME_RE = /^[a-z0-9][a-z0-9_.-]{0,47}$/;
  var PRESENCE_KEY_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
  var ROOM_MAX_BYTES = 4096;
  var PRESENCE_MAX_BYTES = 2048;
  var ROOM_MAX_DEPTH = 8;
  // The server admits 8 streams per viewer and instance; the lobby takes one, so a page can join 7 named rooms.
  var ROOM_MAX_JOINED = 7;
  var PRESENCE_FLUSH_MS = 50;
  var PRESENCE_RETRY_MS = 1000;
  var FIRST_CONNECT_WAIT_MS = 5000;
  var JOIN_TIMEOUT_MS = 10000;

  function roomError(code, message) { return { code: code, message: message }; }

  function roomAvailable(session) {
    var decl = session && session.capabilities && session.capabilities.room;
    return !!decl && typeof decl === 'object' && !!levelOf(session);
  }

  /** The server decides; this mirrors its rule so a refused emit rejects without a request. */
  function roomMayEmit(session, topic) {
    var level = levelOf(session);
    if (level === 'admin' || level === 'owner') return true;
    var topics = session.capabilities.room.topics;
    return level === 'interact' && !!topics && typeof topics === 'object'
      && Object.prototype.hasOwnProperty.call(topics, topic) && topics[topic] === 'interact';
  }

  function jsonDepth(v) {
    if (v === null || typeof v !== 'object') return 0;
    var max = 0;
    Object.keys(v).forEach(function (k) { max = Math.max(max, jsonDepth(v[k])); });
    return max + 1;
  }

  /** Throws a room error unless `value` is plain JSON within the size (4 KiB unless `maxBytes` says otherwise) and depth bounds. */
  function checkRoomJson(value, what, maxBytes) {
    var max = maxBytes || ROOM_MAX_BYTES;
    var text;
    try { text = JSON.stringify(value); } catch (e) { text = undefined; }
    if (text === undefined) throw roomError('invalid_argument', what + ' is not serializable as JSON.');
    if (byteLength(text) > max) throw roomError('invalid_argument', what + ' has at most ' + max + ' bytes of JSON text.');
    if (jsonDepth(JSON.parse(text)) > ROOM_MAX_DEPTH) throw roomError('invalid_argument', what + ' is nested too deeply.');
  }

  function roomFailure(res, json) {
    var error = json && json.error;
    var message = error && typeof error.message === 'string' ? error.message : 'Request failed (' + res.status + ').';
    var code = 'upstream_error';
    if (res.status === 429) code = 'rate_limited';
    else if (res.status === 403) code = 'not_permitted';
    else if (res.status === 401) code = 'not_granted';
    else if (res.status === 400 || res.status === 413) code = 'invalid_argument';
    return roomError(code, message);
  }

  function roomPost(body) {
    var payload;
    try { payload = JSON.stringify(body); } catch (e) { return Promise.reject(roomError('invalid_argument', 'Not serializable as JSON.')); }
    return fetch(ROOM_URL, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Lager-Request': '1' },
      body: payload,
    }).then(
      function (res) {
        return res.json().catch(function () { return null; }).then(function (json) {
          if (!res.ok) throw roomFailure(res, json);
        });
      },
      function (e) { throw roomError('upstream_error', e && e.message ? String(e.message) : 'Network error.'); }
    );
  }

  var scheduleFrame = function (fn) {
    return typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 16);
  };

  /**
   * One room (the lobby or a named one): one EventSource, opened lazily and re-opened with backoff after an error,
   * its peer snapshot, listeners and own presence. `named` rooms report a failed first connect to `onFirstFailure`.
   */
  function createRoom(session, roomName, named) {
    var userDeclared = !!(session.capabilities && session.capabilities.user && typeof session.capabilities.user === 'object');
    var myUserId = viewerId(session);
    var es = null;
    var peerId = null;
    var secret = null;
    var connected = false;
    var everConnected = false;
    var left = false;
    var retryTimer = null;
    var retryDelay = RETRY_MIN_MS;
    var onFirstFailure = null;
    var helloWaiters = [];
    var peerMap = new Map();
    var peerKeys = new Map();
    var rawPeers = new Map();
    var snapshot = Object.freeze([]);
    var myPresence = {};
    var pending = null;
    var flushTimer = null;
    var frameQueued = false;
    var topicListeners = new Map();
    var peerListeners = new Set();
    var connListeners = new Set();

    function guard(fn) { try { fn(); } catch (cbErr) { reportError(cbErr); } }

    // -- peers

    function makePeer(info) {
      var mine = info.peer === peerId;
      var presence = mine ? myPresence : (info.presence && typeof info.presence === 'object' ? info.presence : {});
      return Object.freeze({
        peer: info.peer,
        by: userDeclared && typeof info.by === 'string' ? info.by : null,
        isMe: mine || (myUserId !== null && info.by === myUserId),
        sameTab: mine,
        kind: 'viewer',
        guest: info.guest === true,
        presence: deepFreeze(JSON.parse(JSON.stringify(presence))),
        updatedAt: Date.now(),
      });
    }

    function peerKey(info) {
      var mine = info.peer === peerId;
      return JSON.stringify([mine, info.by, info.guest === true, mine ? myPresence : info.presence]);
    }

    /** Rebuilds the peer map from a full list, keeping the object of every peer that did not change. */
    function reconcile(list) {
      var next = new Map();
      var keys = new Map();
      var raw = new Map();
      var changed = false;
      (Array.isArray(list) ? list : []).forEach(function (info) {
        if (!info || typeof info.peer !== 'string') return;
        var key = peerKey(info);
        var prev = peerMap.get(info.peer);
        if (prev && peerKeys.get(info.peer) === key) next.set(info.peer, prev);
        else { next.set(info.peer, makePeer(info)); changed = true; }
        keys.set(info.peer, key);
        raw.set(info.peer, info);
      });
      if (next.size !== peerMap.size) changed = true;
      peerMap = next;
      peerKeys = keys;
      rawPeers = raw;
      if (changed) {
        snapshot = Object.freeze(Array.from(next.values()));
        queueFrame();
      }
    }

    function deliverPeers(entry) {
      if (!entry.active) return;
      var joined = [];
      var updated = [];
      var gone = [];
      peerMap.forEach(function (p, id) {
        var old = entry.last.get(id);
        if (!old) joined.push(p);
        else if (old !== p) updated.push(p);
      });
      entry.last.forEach(function (p, id) { if (!peerMap.has(id)) gone.push(p); });
      if (joined.length === 0 && updated.length === 0 && gone.length === 0) return;
      entry.last = new Map(peerMap);
      var change = Object.freeze({ peers: snapshot, joined: Object.freeze(joined), left: Object.freeze(gone), updated: Object.freeze(updated) });
      guard(function () { entry.fn(change); });
    }

    function queueFrame() {
      if (frameQueued || peerListeners.size === 0) return;
      frameQueued = true;
      scheduleFrame(function () {
        frameQueued = false;
        Array.from(peerListeners).forEach(deliverPeers);
      });
    }

    // -- connection

    function setConnected(value) {
      if (connected === value) return;
      connected = value;
      Array.from(connListeners).forEach(function (entry) { if (entry.active) guard(function () { entry.fn(value); }); });
    }

    function flushPresence() {
      flushTimer = null;
      if (!pending || !connected) return;
      var patch = pending;
      pending = null;
      sendPresence(patch);
    }

    function sendPresence(patch) {
      roomPost(withIdentity({ op: 'presence', patch: patch })).catch(function (e) {
        // Rate limits and network trouble are transient: keep the state and try again. Anything else is a bug or a stale peer.
        if (left || (e.code !== 'rate_limited' && e.code !== 'upstream_error')) return;
        pending = Object.assign({}, patch, pending || {});
        queuePresence(PRESENCE_RETRY_MS);
      });
    }

    function queuePresence(delay) {
      if (flushTimer === null) flushTimer = setTimeout(flushPresence, delay === undefined ? PRESENCE_FLUSH_MS : delay);
    }

    function withIdentity(body) {
      body.room = roomName;
      body.peer = peerId;
      if (secret !== null) body.secret = secret;
      return body;
    }

    function onHello(e) {
      var d;
      try { d = JSON.parse(e.data); } catch (_) { return; }
      if (!d || typeof d.peer !== 'string') return;
      peerId = d.peer;
      secret = typeof d.secret === 'string' ? d.secret : null;
      everConnected = true;
      retryDelay = RETRY_MIN_MS;
      reconcile(d.peers);
      setConnected(true);
      // A new connection is a new peer: assert the whole presence state again.
      pending = null;
      if (Object.keys(myPresence).length > 0) sendPresence(Object.assign({}, myPresence));
      helloWaiters.splice(0).forEach(function (w) { w(); });
    }

    function onMessage(e) {
      var d;
      try { d = JSON.parse(e.data); } catch (_) { return; }
      if (!d || typeof d.topic !== 'string' || !d.from || typeof d.from.peer !== 'string') return;
      var set = topicListeners.get(d.topic);
      if (!set || set.size === 0) return;
      var from = d.from;
      var msg = {
        topic: d.topic, peer: from.peer, by: userDeclared && typeof from.by === 'string' ? from.by : null,
        isMe: from.peer === peerId || (myUserId !== null && from.by === myUserId), sameTab: from.peer === peerId,
        kind: 'viewer', guest: from.guest === true,
      };
      if (d.data !== undefined) msg.data = deepFreeze(d.data);
      Object.freeze(msg);
      Array.from(set).forEach(function (entry) { if (entry.active) guard(function () { entry.fn(msg); }); });
    }

    function onPeers(e) {
      var d;
      try { d = JSON.parse(e.data); } catch (_) { return; }
      if (!d || typeof d !== 'object') return;
      // The server sends deltas only; the full list was in the hello.
      var next = new Map(rawPeers);
      (Array.isArray(d.left) ? d.left : []).forEach(function (p) { if (p && typeof p.peer === 'string') next.delete(p.peer); });
      [d.joined, d.updated].forEach(function (list) {
        (Array.isArray(list) ? list : []).forEach(function (p) { if (p && typeof p.peer === 'string') next.set(p.peer, p); });
      });
      reconcile(Array.from(next.values()));
    }

    function onStreamError() {
      if (!es) return;
      es.close();
      es = null;
      peerId = null;
      secret = null;
      setConnected(false);
      if (left) return;
      if (named && !everConnected) {
        if (onFirstFailure) onFirstFailure(roomError('upstream_error', 'Could not join the room.'));
        return;
      }
      retryTimer = setTimeout(function () { retryTimer = null; open(); }, retryDelay);
      retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
    }

    function open() {
      if (es || left || retryTimer !== null || typeof EventSource === 'undefined') return;
      var source = new EventSource(ROOM_EVENTS_URL + (roomName ? '?room=' + encodeURIComponent(roomName) : ''));
      es = source;
      source.addEventListener('hello', onHello);
      source.addEventListener('message', onMessage);
      source.addEventListener('peers', onPeers);
      source.addEventListener('error', function () { if (es === source) onStreamError(); });
    }

    /** Opens the stream; the very first send waits briefly for it, as there is nobody to tell before that. */
    function ready() {
      open();
      if (connected || everConnected || !es) return Promise.resolve();
      return new Promise(function (resolve) {
        var timer = setTimeout(resolve, FIRST_CONNECT_WAIT_MS);
        helloWaiters.push(function () { clearTimeout(timer); resolve(); });
      });
    }

    function destroy() {
      if (left) return;
      left = true;
      if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; }
      if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
      if (es) { es.close(); es = null; }
      peerId = null;
      connected = false;
      topicListeners.forEach(function (set) { set.forEach(function (entry) { entry.active = false; }); });
      [peerListeners, connListeners].forEach(function (set) { set.forEach(function (entry) { entry.active = false; }); });
      topicListeners.clear();
      peerListeners.clear();
      connListeners.clear();
      helloWaiters.splice(0).forEach(function (w) { w(); });
    }

    // -- verbs

    function ensureLive() {
      if (left) throw roomError('invalid_argument', 'This room was left.');
    }

    function addListener(set, entry) {
      set.add(entry);
      return function unsubscribe() { entry.active = false; set.delete(entry); };
    }

    var verbs = {
      emit: function (topic, data) {
        return Promise.resolve().then(function () {
          ensureLive();
          if (typeof topic !== 'string' || !TOPIC_RE.test(topic)) throw roomError('invalid_argument', 'A topic matches ^[a-z][a-z0-9_.-]{0,47}$.');
          if (data !== undefined) checkRoomJson(data, 'data');
          if (!roomMayEmit(session, topic)) throw roomError('not_permitted', 'This viewer may not send on this topic.');
          return ready();
        }).then(function () {
          // Not connected: the moment is dropped, never queued.
          if (!connected || left) return undefined;
          return roomPost(withIdentity({ op: 'emit', topic: topic, data: data }));
        });
      },
      on: function (topic, handler, error) {
        if (typeof handler !== 'function') throw new TypeError('The handler must be a function.');
        if (typeof topic !== 'string' || !TOPIC_RE.test(topic)) {
          Promise.resolve().then(function () {
            if (typeof error === 'function') guard(function () { error(roomError('invalid_argument', 'A topic matches ^[a-z][a-z0-9_.-]{0,47}$.')); });
          });
          return function () {};
        }
        var set = topicListeners.get(topic);
        if (!set) topicListeners.set(topic, (set = new Set()));
        open();
        return addListener(set, { fn: handler, active: true });
      },
      presence: function (patch) {
        return Promise.resolve().then(function () {
          ensureLive();
          if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) throw roomError('invalid_argument', 'presence expects an object.');
          var merged = Object.assign({}, myPresence);
          Object.keys(patch).forEach(function (k) {
            if (!PRESENCE_KEY_RE.test(k) || k === 'prototype' || k in Object.prototype) {
              throw roomError('invalid_argument', 'Presence key "' + k + '" is not a plain identifier.');
            }
            var v = patch[k];
            if (v === null) delete merged[k];
            else { checkRoomJson(v, 'Presence field "' + k + '"'); merged[k] = v; }
          });
          // The server holds the whole presence to this size; a larger one would never reach the other peers.
          checkRoomJson(merged, 'Presence', PRESENCE_MAX_BYTES);
          myPresence = merged;
          pending = Object.assign(pending || {}, patch);
          if (peerId !== null && rawPeers.has(peerId)) reconcile(Array.from(rawPeers.values()));
          open();
          queuePresence();
        });
      },
      peers: function () { open(); return snapshot; },
      onPeers: function (handler, error) {
        if (typeof handler !== 'function') throw new TypeError('The handler must be a function.');
        void error;
        var entry = { fn: handler, active: true, last: new Map() };
        open();
        // The first delivery presents the room so far as `joined`; later ones carry the net change.
        Promise.resolve().then(function () { deliverPeers(entry); });
        return addListener(peerListeners, entry);
      },
      connected: function () { return connected; },
      onConnection: function (handler, error) {
        if (typeof handler !== 'function') throw new TypeError('The handler must be a function.');
        void error;
        var entry = { fn: handler, active: true };
        open();
        Promise.resolve().then(function () { if (entry.active) guard(function () { handler(connected); }); });
        return addListener(connListeners, entry);
      },
    };

    return {
      verbs: verbs,
      open: open,
      destroy: destroy,
      /** Resolves once admitted (the hello arrived), or rejects like `join`. */
      admit: function () {
        return new Promise(function (resolve, reject) {
          var timer = setTimeout(function () { onFirstFailure = null; destroy(); reject(roomError('upstream_error', 'The room did not answer in time.')); }, JOIN_TIMEOUT_MS);
          onFirstFailure = function (e) { clearTimeout(timer); onFirstFailure = null; destroy(); reject(e); };
          helloWaiters.push(function () { if (!connected) return; clearTimeout(timer); onFirstFailure = null; resolve(); });
          open();
        });
      },
    };
  }

  function buildRoom(session) {
    var lobby = createRoom(session, '', false);
    var joined = new Map();

    function join(name) {
      return Promise.resolve().then(function () {
        if (typeof name !== 'string' || !ROOM_NAME_RE.test(name)) throw roomError('invalid_argument', 'A room name matches ^[a-z0-9][a-z0-9_.-]{0,47}$.');
        if (joined.has(name)) return joined.get(name);
        if (joined.size >= ROOM_MAX_JOINED) throw roomError('limit_reached', 'At most ' + ROOM_MAX_JOINED + ' named rooms at once.');
        var room = createRoom(session, name, true);
        var handle = null;
        var promise = room.admit().then(function () {
          handle = Object.freeze({
            name: name,
            emit: room.verbs.emit, on: room.verbs.on, presence: room.verbs.presence, peers: room.verbs.peers, onPeers: room.verbs.onPeers,
            connected: room.verbs.connected, onConnection: room.verbs.onConnection,
            leave: function () { room.destroy(); if (joined.get(name) === promise) joined.delete(name); return Promise.resolve(); },
          });
          return handle;
        });
        joined.set(name, promise);
        promise.catch(function () { if (joined.get(name) === promise) joined.delete(name); });
        return promise;
      });
    }

    var v = lobby.verbs;
    return Object.freeze({
      emit: v.emit, on: v.on, presence: v.presence, peers: v.peers, onPeers: v.onPeers,
      connected: v.connected, onConnection: v.onConnection, join: join,
    });
  }

  // ------------------------------------------------------------------ page, downloads

  var PAGE_URL = '/__lager/page';
  var DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024;
  var DOWNLOAD_NAME_MAX_BYTES = 240;
  var DOWNLOAD_ALLOWED = ['gif', 'png', 'jpg', 'jpeg', 'webp', 'mp4', 'webm', 'mov', 'txt', 'json', 'md',
    'docx', 'pptx', 'epub', 'csv', 'ttf', 'html', 'svg', 'pdf', 'xlsx', 'zip', 'fig'];
  var DOCTYPE_RE = /^\uFEFF?\s*<!doctype html/i;
  var INVISIBLE_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;
  var REVOKE_DELAY_MS = 1000;
  // The event stream carries `reload` events for as long as the page may publish, even without db listeners.
  var keepSourceOpen = false;
  var loadedVersion = null;
  var reloaded = false;
  var streamOpen = false;
  var pageNamespace = null;

  /**
   * location.reload() and window.confirm() go through here so a test (or an embedding page) can observe them:
   * `.reload` / `.confirm` of `window.__lagerHost`, read once when the runtime starts, replace the browser's own.
   */
  var lagerHost = window.__lagerHost;
  function hostCall(name, arg) {
    var host = lagerHost;
    if (host && typeof host[name] === 'function') return host[name](arg);
    if (name === 'reload') return window.location.reload();
    return window.confirm(arg);
  }

  function declaredObject(session, name) {
    var caps = session && session.capabilities;
    return !!(caps && caps[name] && typeof caps[name] === 'object');
  }

  function pageAvailable(session) {
    return declaredObject(session, 'page');
  }

  function doReload() {
    if (reloaded) return;
    reloaded = true;
    hostCall('reload');
  }

  function onReloadEvent(e) {
    var data;
    try { data = JSON.parse(e.data); } catch (_) { return; }
    var version = data && typeof data === 'object' ? Number(data.version) : NaN;
    if (!isFinite(version) || loadedVersion === null || version === loadedVersion) return;
    doReload();
  }

  function onStreamError() { streamOpen = false; }

  /** Reload events sent while the stream was down or not yet open are lost: compare with the live version instead. */
  function catchUp() {
    if (!keepSourceOpen || loadedVersion === null) return;
    fetch(SESSION_URL, { credentials: 'same-origin', cache: 'no-store' }).then(function (res) {
      return res.ok ? res.json() : null;
    }).then(function (body) {
      var live = body && body.instance ? Number(body.instance.version) : NaN;
      if (isFinite(live) && live !== loadedVersion) doReload();
    }).catch(function () { /* the next event or reconnect catches up */ });
  }

  function onStreamOpen() {
    streamOpen = true;
    catchUp();
  }

  /**
   * Every view of an instance whose active version declares `page` follows its saves, whether or not the page
   * uses the capability: the event stream stays open and a `reload` event with another version reloads the page.
   */
  function watchReloads(session) {
    if (keepSourceOpen || !pageAvailable(session)) return;
    var instance = session && session.instance;
    loadedVersion = instance && isFinite(Number(instance.version)) ? Number(instance.version) : null;
    keepSourceOpen = true;
    // A stream that db listeners opened earlier has already fired its open event: compare versions now.
    if (streamOpen) catchUp(); else openSource();
  }

  function pageError(code, message) { return { code: code, message: message }; }

  function pageFailure(res, json) {
    var error = json && json.error;
    var message = error && typeof error.message === 'string' ? error.message : 'Request failed (' + res.status + ').';
    var raw = error && typeof error.code === 'string' ? error.code : '';
    var code;
    if (res.status === 403 && raw === 'not_declared') code = 'not_declared';
    else if (res.status === 403 && raw === 'not_granted') code = 'not_granted';
    else if (res.status === 401 || res.status === 403) code = 'not_writer';
    else if (res.status === 409) code = 'conflict';
    else if (res.status === 413 || res.status === 507) code = 'too_large';
    else if (res.status === 429) code = 'rate_limited';
    else if (res.status === 400 && raw === 'invalid_content') code = 'invalid_content';
    else code = 'upstream_error';
    return pageError(code, message);
  }

  function buildPage(session) {
    if (pageNamespace) return pageNamespace;
    var level = levelOf(session);
    var editor = level === 'admin' || level === 'owner';
    var saveOff = session.capabilities.page.publish === false;
    watchReloads(session);

    function publish(arg) {
      return Promise.resolve().then(function () {
        if (saveOff) throw pageError('not_granted', 'This page may not save itself.');
        if (!editor) throw pageError('not_writer', 'This view cannot save the page.');
        if (typeof arg !== 'string' || !DOCTYPE_RE.test(arg)) throw pageError('invalid_content', 'publish expects a complete html document starting with <!doctype html>.');
        return fetch(PAGE_URL, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'X-Lager-Request': '1' },
          body: JSON.stringify({ html: arg, baseVersion: loadedVersion }),
        }).then(
          function (res) {
            return res.json().catch(function () { return null; }).then(function (json) {
              if (!res.ok) {
                var failure = pageFailure(res, json);
                // Somebody else saved first: this view is stale, show the winning version.
                if (failure.code === 'conflict') doReload();
                throw failure;
              }
              if (!json || typeof json.version !== 'string') throw pageError('upstream_error', 'Unexpected response (' + res.status + ').');
              // Normally the reload event does this; without an open stream nobody would tell this view.
              if (!streamOpen) doReload();
              return Object.freeze({ version: json.version });
            });
          },
          function (e) { throw pageError('upstream_error', e && e.message ? String(e.message) : 'Network error.'); }
        );
      });
    }

    pageNamespace = Object.freeze({ publish: publish });
    return pageNamespace;
  }

  function downloadError(code, message) { return { code: code, message: message }; }

  /** The base name of the file the viewer would get: no directories, no control characters, no trailing dots or spaces. */
  function downloadName(filename) {
    var name = filename.replace(INVISIBLE_RE, '');
    name = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1).replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
    return name;
  }

  function downloadBlob(data) {
    if (typeof data === 'string') {
      if (data.length > DOWNLOAD_MAX_BYTES) throw downloadError('too_large', 'The file is larger than 50 MiB.');
      if (data === '') return null;
      var encoded = new Blob([data]);
      if (encoded.size > DOWNLOAD_MAX_BYTES) throw downloadError('too_large', 'The file is larger than 50 MiB.');
      return encoded;
    }
    var size = -1;
    if (typeof Blob !== 'undefined' && data instanceof Blob) size = data.size;
    else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) size = data.byteLength;
    if (size < 0) throw downloadError('bad_request', 'data must be a string, Blob, ArrayBuffer or typed array.');
    if (size > DOWNLOAD_MAX_BYTES) throw downloadError('too_large', 'The file is larger than 50 MiB.');
    return size === 0 ? null : (data instanceof Blob ? data : new Blob([data]));
  }

  /** The one sentence the runtime shows to people: the download confirmation, in the viewer's language (English when unknown). */
  var SAVE_FILE = {
    en: function (n, s) { return 'Save file \u201C' + n + '\u201D (' + s + ')?'; },
    de: function (n, s) { return 'Datei \u201E' + n + '\u201C (' + s + ') speichern?'; },
    fr: function (n, s) { return 'Enregistrer le fichier \u00AB\u00A0' + n + '\u00A0\u00BB (' + s + ')\u00A0?'; },
    es: function (n, s) { return '\u00BFGuardar el archivo \u00AB' + n + '\u00BB (' + s + ')?'; }
  };
  /** A size for people: 1.5 KB, 12 MB; the decimal mark follows the viewer's language. */
  function sizeText(bytes, locale) {
    var units = ['B', 'KB', 'MB', 'GB'];
    var value = bytes;
    var i = 0;
    while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
    var number;
    try { number = value.toLocaleString(locale, { maximumFractionDigits: i === 0 ? 0 : 1 }); } catch (_) { number = String(Math.round(value * 10) / 10); }
    return number + '\u00A0' + units[i];
  }
  function saveFileQuestion(session, name, bytes) {
    var v = viewerOf(session);
    var locale = v && typeof v.locale === 'string' && Object.prototype.hasOwnProperty.call(SAVE_FILE, v.locale) ? v.locale : 'en';
    return SAVE_FILE[locale](name, sizeText(bytes, locale));
  }

  function buildDownloads(session) {
    function save(request) {
      return Promise.resolve().then(function () {
        if (!request || typeof request !== 'object' || typeof request.filename !== 'string' || request.filename.length > 512) {
          throw downloadError('bad_request', 'save expects {filename, data}.');
        }
        var name = downloadName(request.filename);
        if (name === '') throw downloadError('bad_request', 'The filename is empty.');
        if (new Blob([name]).size > DOWNLOAD_NAME_MAX_BYTES) throw downloadError('bad_request', 'The filename is longer than 240 bytes.');
        var dot = name.lastIndexOf('.');
        // A name that is only an extension (".txt") has no base name and no extension of its own.
        if (dot <= 0 || DOWNLOAD_ALLOWED.indexOf(name.slice(dot + 1).toLowerCase()) < 0) {
          throw downloadError('rejected_extension', 'Only files with an allowed extension can be saved.');
        }
        var blob = downloadBlob(request.data);
        if (blob === null) throw downloadError('bad_request', 'data must not be empty.');
        if (!hostCall('confirm', saveFileQuestion(session, name, blob.size))) throw downloadError('declined', 'The viewer declined the download.');
        var url = URL.createObjectURL(blob);
        var link = document.createElement('a');
        link.href = url;
        link.download = name;
        link.style.display = 'none';
        document.body.appendChild(link);
        try { link.click(); } finally {
          document.body.removeChild(link);
          setTimeout(function () { URL.revokeObjectURL(url); }, REVOKE_DELAY_MS);
        }
        return Object.freeze({ status: 'saved' });
      });
    }
    return Object.freeze({ save: save });
  }

  // ------------------------------------------------------------------ ingest

  /**
   * The endpoints through which the instance takes data from outside, for a page that tells its owner what to paste where:
   * `{name, url, auth, collection, origins, managedOrigins, instanceOrigins, maxBytes, enabled, token, canManage}`. `canManage`
   * says whether the viewer manages the instance; only then is `token` a string (for an endpoint that needs one), `origins`
   * every website that may send, and `instanceOrigins` the websites the managers added with `setOrigins`. Everyone else gets
   * the declared websites and an empty `instanceOrigins`.
   */
  function buildIngest() {
    function endpointOf(e) {
      var list = function (v) { return Object.freeze(Array.isArray(v) ? v.slice() : []); };
      return Object.freeze({
        name: e.name, url: window.location.origin + e.path, auth: e.auth, collection: e.collection,
        origins: list(e.origins), managedOrigins: e.managedOrigins === true, instanceOrigins: list(e.instanceOrigins), maxBytes: e.maxBytes,
        enabled: e.enabled === true, token: typeof e.token === 'string' ? e.token : null, canManage: e.canManage === true,
      });
    }
    function networkError(e) { throw { code: 'unavailable', message: e && e.message ? String(e.message) : 'Network error.' }; }
    function endpoints() {
      return fetch(INGEST_URL, { credentials: 'same-origin' }).then(
        function (res) {
          return res.json().catch(function () { return null; }).then(function (json) {
            if (!res.ok || !json || !Array.isArray(json.endpoints)) throw { code: 'unavailable', message: 'The endpoints could not be read.' };
            return json.endpoints.map(endpointOf);
          });
        },
        networkError
      );
    }
    /**
     * Replaces the websites this instance adds to an endpoint that declares `managedOrigins: true`, for example the blogs an
     * owner names in the app. Only for the people who manage the instance. Resolves the endpoint as `endpoints()` shows it, or
     * rejects `{code, message}`: `not_granted`, `invalid_argument` (a bad address, too many, or websites the app fixes),
     * `not_found` or `unavailable`.
     */
    function setOrigins(name, origins) {
      if (typeof name !== 'string' || !Array.isArray(origins)) {
        return Promise.reject({ code: 'invalid_argument', message: 'setOrigins takes the endpoint name and a list of websites.' });
      }
      return fetch(INGEST_URL + '/' + encodeURIComponent(name) + '/origins', {
        method: 'PUT', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Lager-Request': '1' },
        body: JSON.stringify({ origins: origins }),
      }).then(
        function (res) {
          return res.json().catch(function () { return null; }).then(function (json) {
            if (res.ok && json && json.endpoint) return endpointOf(json.endpoint);
            var err = json && json.error ? json.error : {};
            var code = err.code === 'forbidden' || err.code === 'unauthenticated' ? 'not_granted'
              : err.code === 'invalid_argument' || err.code === 'not_found' ? err.code : 'unavailable';
            throw { code: code, message: err.message || 'The websites could not be saved.' };
          });
        },
        networkError
      );
    }
    return Object.freeze({ endpoints: endpoints, setOrigins: setOrigins });
  }

  // ------------------------------------------------------------------ permissions

  function buildPermissions(session) {
    var states = { user: 'granted' };
    if (levelOf(session)) states.db = 'granted';
    if (assetsAllowed(session)) states.assets = 'granted';
    if (roomAvailable(session)) states.room = 'granted';
    if (pageAvailable(session)) states.page = 'granted';
    if (declaredObject(session, 'downloads')) states.downloads = 'granted';
    if (declaredObject(session, 'ingest')) states.ingest = 'granted';
    var one = function (name) { return typeof name === 'string' && Object.prototype.hasOwnProperty.call(states, name) ? states[name] : 'unavailable'; };
    var all = function () { var o = {}; Object.keys(states).sort().forEach(function (k) { o[k] = states[k]; }); return o; };
    return Object.freeze({
      state: function (name) { return Promise.resolve(name === undefined ? all() : one(name)); },
      request: function (names) {
        if (!Array.isArray(names)) return Promise.resolve(all());
        var o = {};
        names.forEach(function (n) { o[n] = one(n); });
        return Promise.resolve(o);
      },
    });
  }

  // ------------------------------------------------------------------ use

  var memo = new Map();

  function build(name) {
    return getSession().then(function (session) {
      if (name === 'db') return levelOf(session) ? db : null;
      if (name === 'user') return buildUser(session);
      if (name === 'assets') return assetsAllowed(session) ? buildAssets() : null;
      if (name === 'room') return roomAvailable(session) ? buildRoom(session) : null;
      if (name === 'page') return pageAvailable(session) ? buildPage(session) : null;
      if (name === 'downloads') return declaredObject(session, 'downloads') ? buildDownloads(session) : null;
      if (name === 'ingest') return declaredObject(session, 'ingest') ? buildIngest() : null;
      if (name === 'permissions') return buildPermissions(session);
      return null;
    });
  }

  function use(name) {
    if (typeof name !== 'string') return Promise.resolve(null);
    if (!memo.has(name)) {
      var p = build(name).catch(function () { return null; }).then(function (ns) {
        // Built without a session because the fetch failed: forget it, so a later call gets the real namespace.
        if (sessionPromise === null && memo.get(name) === p) memo.delete(name);
        return ns;
      });
      memo.set(name, p);
    }
    return memo.get(name);
  }

  // ------------------------------------------------------------------ export

  // Pages whose version declares `page` follow saves of any view, so the session is read once the page has settled.
  // It is shared with the first `lager.use()`; pages that do not declare it open no event stream.
  setTimeout(function () { getSession().then(watchReloads).catch(function () { /* no session, no watching */ }); }, 0);

  // ------------------------------------------------------------------ complete

  function completeError(code, message) {
    var e = new Error(message || 'The language model request failed.');
    e.code = code || 'unavailable';
    return e;
  }

  /**
   * Asks the language model the server's administrator set up. `prompt` is a string or a list of `{role, content}`
   * messages; `options` may carry `system`, `maxTokens` and `full`. Resolves the answer text; with
   * `full: true` it resolves `{text, model, stopReason, truncated}` instead, so an app can tell a cut-off answer from a bad one.
   */
  function complete(prompt, options) {
    var wantFull = !!options && typeof options === 'object' && options.full === true;
    return Promise.resolve().then(function () {
      if (typeof prompt !== 'string' && !Array.isArray(prompt)) throw completeError('invalid_argument', 'complete expects a prompt string or a list of messages.');
      var body = { messages: prompt };
      if (options && typeof options === 'object') {
        if (options.system !== undefined) body.system = options.system;
        if (options.maxTokens !== undefined) body.maxTokens = options.maxTokens;
      }
      return fetch(COMPLETE_URL, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Lager-Request': '1' },
        body: JSON.stringify(body),
      });
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        if (!res.ok || !data || typeof data.text !== 'string') {
          var err = data && data.error;
          throw completeError(err && err.code, err && err.message);
        }
        if (!wantFull) return data.text;
        return { text: data.text, model: typeof data.model === 'string' ? data.model : null, stopReason: typeof data.stopReason === 'string' ? data.stopReason : null, truncated: data.truncated === true };
      });
    }, function (e) {
      throw e && e.code ? e : completeError('unavailable', 'The language model could not be reached.');
    });
  }

  window.lager = Object.freeze({
    use: use,
    complete: complete,
  });
})();
