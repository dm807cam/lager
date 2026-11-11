/* Lager browser runtime: provides window.claude.use("db" | "user" | "permissions") and window.storage
   on top of the /__lager/* endpoints. Plain ES2020, no dependencies. */
(function () {
  'use strict';

  var SESSION_URL = '/__lager/session';
  var USERS_URL = '/__lager/users?ids=';
  var DB_URL = '/__lager/db';
  var EVENTS_URL = '/__lager/db/events';
  var RETRY_MIN_MS = 1000;
  var RETRY_MAX_MS = 30000;
  var MAX_PROFILE_IDS = 100;
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

  function loadSession() {
    return fetch(SESSION_URL, { credentials: 'same-origin' }).then(function (res) {
      if (!res.ok) return null;
      return res.json().then(function (body) {
        return body && typeof body === 'object' && body.viewer && typeof body.viewer === 'object' ? body : null;
      });
    }).catch(function () { return null; });
  }

  function getSession() {
    if (!sessionPromise) sessionPromise = loadSession();
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
    else if (code !== 'invalid_argument') code = 'unavailable';
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
          if (json && json.error) throw mapError(json.error);
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

  function refreshWhere(match) {
    Array.from(listeners).forEach(function (l) { if (match(l)) l.refresh(); });
  }

  function openSource() {
    if (source || typeof EventSource === 'undefined') return;
    var es = new EventSource(EVENTS_URL);
    source = es;
    es.addEventListener('change', function (e) {
      var change;
      try { change = JSON.parse(e.data); } catch (_) { return; }
      if (!change || typeof change !== 'object') return;
      refreshWhere(function (l) { return l.matches(change); });
    });
    es.addEventListener('reset', function () { refreshWhere(function () { return true; }); });
    es.addEventListener('error', function () { sourceFailed = true; });
    es.addEventListener('open', function () {
      // Changes landing before the stream opened, or while it was down, are lost: catch up (deduplicated by key).
      sourceFailed = false;
      refreshWhere(function () { return true; });
    });
  }

  function closeSourceIfIdle() {
    if (listeners.size === 0 && source) {
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
            // Transient: keep the listener and retry with a bounded backoff (an event or reconnect retries sooner).
            retryTimer = setTimeout(function () { retryTimer = null; refresh(); }, retryDelay);
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
          if (!out.acquired) delete out.holder; // the holder of a busy lease is never revealed
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
      var ref = q.doc();
      return ref.set(data).then(function () { return ref; });
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
            // Unknown ids are cached as misses: an id the server does not know does not become known later.
            cache.set(i, entry ? toProfile(entry) : null);
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
        var need = list.filter(function (i) { return !cache.has(i) && !inflight.has(i); });
        for (var n = 0; n < need.length; n += MAX_PROFILE_IDS) fetchChunk(need.slice(n, n + MAX_PROFILE_IDS));
      }
      var waits = Array.from(new Set(list.map(function (i) { return inflight.get(i); }).filter(Boolean)));
      return Promise.all(waits).then(function () {
        var out = {};
        list.forEach(function (i) { var e = cache.get(i); if (e) out[i] = e; });
        return out;
      });
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
      search: function () { return Promise.resolve([]); },
    });
  }

  // ------------------------------------------------------------------ permissions

  function buildPermissions(session) {
    var states = { user: 'granted' };
    if (levelOf(session)) states.db = 'granted';
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
      manage: function () { return Promise.resolve(undefined); },
    });
  }

  // ------------------------------------------------------------------ use

  var memo = new Map();

  function build(name) {
    return getSession().then(function (session) {
      if (name === 'db') return levelOf(session) ? db : null;
      if (name === 'user') return buildUser(session);
      if (name === 'permissions') return buildPermissions(session);
      return null;
    });
  }

  function use(name) {
    if (typeof name !== 'string') return Promise.resolve(null);
    if (!memo.has(name)) memo.set(name, build(name).catch(function () { return null; }));
    return memo.get(name);
  }

  // ------------------------------------------------------------------ window.storage

  function storageError(e) {
    return e instanceof Error ? e : new Error(e && e.message ? String(e.message) : 'Storage request failed.');
  }

  function checkKey(key) {
    if (typeof key !== 'string' || key === '') throw new Error('Key must be a non-empty string.');
    // The key becomes one path segment in its encoded form, and the server allows at most 200 bytes per segment.
    var encoded;
    try { encoded = encodeURIComponent(key); } catch (e) { throw new Error('Invalid key'); }
    if (encoded.length > 200) throw new Error('Key too long');
  }

  /** Resolves the base collection path for a storage call, or throws. */
  function storageBase(shared) {
    return getSession().then(function (session) {
      if (shared) {
        if (!levelOf(session)) throw new Error('Storage is not available.');
        return 'kv';
      }
      var id = viewerId(session);
      if (!id) throw new Error('Not signed in');
      return 'data/users/' + id + '/storage/kv';
    });
  }

  function withBase(shared, fn) {
    return storageBase(shared).then(fn).catch(function (e) { throw storageError(e); });
  }

  var storage = Object.freeze({
    set: function (key, value, shared) {
      shared = !!shared;
      return Promise.resolve().then(function () {
        checkKey(key);
        if (typeof value !== 'string') throw new Error('Value must be a string.');
        return withBase(shared, function (base) {
          return makeDocRef(base + '/' + encodeURIComponent(key)).set({ key: key, value: value });
        });
      }).then(function () { return { key: key, value: value, shared: shared }; });
    },
    get: function (key, shared) {
      shared = !!shared;
      return Promise.resolve().then(function () {
        checkKey(key);
        return withBase(shared, function (base) { return makeDocRef(base + '/' + encodeURIComponent(key)).get(); });
      }).then(function (snap) {
        var data = snap.exists ? snap.data() : null;
        if (!data || typeof data.value !== 'string') throw new Error('Key not found: ' + key);
        return { key: key, value: data.value, shared: shared };
      });
    },
    delete: function (key, shared) {
      shared = !!shared;
      return Promise.resolve().then(function () {
        checkKey(key);
        return withBase(shared, function (base) { return makeDocRef(base + '/' + encodeURIComponent(key)).delete(); });
      }).then(function () { return { key: key, deleted: true, shared: shared }; });
    },
    list: function (prefix, shared) {
      shared = !!shared;
      prefix = prefix === undefined ? '' : prefix;
      return Promise.resolve().then(function () {
        if (typeof prefix !== 'string') throw new Error('Prefix must be a string.');
        return withBase(shared, function (base) { return makeQuery(base, {}).get(); });
      }).then(function (snap) {
        var keys = [];
        snap.docs.forEach(function (d) {
          var data = d.data();
          if (data && typeof data.key === 'string' && data.key.indexOf(prefix) === 0) keys.push(data.key);
        });
        keys.sort();
        return { keys: keys, prefix: prefix, shared: shared };
      });
    },
  });

  // ------------------------------------------------------------------ export

  window.claude = Object.freeze({
    use: use,
    complete: function () { return Promise.reject(new Error('claude.complete is not available on this Lager server')); },
  });
  window.storage = storage;
})();
