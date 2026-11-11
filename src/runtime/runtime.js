/* Lager browser runtime: provides window.claude.use("db" | "user" | "assets" | "room" | "artifact" | "self" | "downloads" | "permissions") and window.storage
   on top of the /__lager/* endpoints. Plain ES2020, no dependencies. */
(function () {
  'use strict';

  var SESSION_URL = '/__lager/session';
  var USERS_URL = '/__lager/users?ids=';
  var DB_URL = '/__lager/db';
  var ASSETS_URL = '/__lager/assets';
  var EVENTS_URL = '/__lager/db/events';
  var RETRY_MIN_MS = 1000;
  var RETRY_MAX_MS = 30000;
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
    es.addEventListener('reload', onReloadEvent);
    es.addEventListener('error', function () { sourceFailed = true; });
    es.addEventListener('open', function () {
      // Changes landing before the stream opened, or while it was down, are lost: catch up (deduplicated by key).
      sourceFailed = false;
      refreshWhere(function () { return true; });
    });
  }

  function closeSourceIfIdle() {
    if (listeners.size === 0 && source && !keepSourceOpen) {
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
  var ROOM_MAX_DEPTH = 8;
  var ROOM_MAX_JOINED = 16;
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

  /** Throws a room error unless `value` is plain JSON within the 4 KiB / depth bounds. */
  function checkRoomJson(value, what) {
    var text;
    try { text = JSON.stringify(value); } catch (e) { text = undefined; }
    if (text === undefined) throw roomError('invalid_argument', what + ' is not serializable as JSON.');
    if (byteLength(text) > ROOM_MAX_BYTES) throw roomError('invalid_argument', what + ' has at most ' + ROOM_MAX_BYTES + ' bytes of JSON text.');
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
      if (d && Array.isArray(d.peers)) reconcile(d.peers);
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
          checkRoomJson(merged, 'Presence');
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
      // Lager has no conversation with Claude beside the page.
      sendToClaudeSession: function () { return Promise.reject(roomError('claude_unavailable', 'Sending to Claude is not available on this Lager server.')); },
      canSendToClaudeSession: function () { return Promise.resolve('off'); },
    });
  }

  // ------------------------------------------------------------------ artifact, self, downloads

  var ARTIFACT_URL = '/__lager/artifact';
  var DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024;
  var DOWNLOAD_BLOCKED = ['exe', 'bat', 'cmd', 'scr', 'js', 'msi', 'dmg', 'app', 'sh'];
  var REVOKE_DELAY_MS = 1000;
  // The event stream carries `reload` events for as long as the page may publish, even without db listeners.
  var keepSourceOpen = false;
  var loadedVersion = null;
  var reloaded = false;
  var artifactNamespace = null;

  /**
   * location.reload() and window.confirm() go through here so a test (or an embedding page) can observe them:
   * `window.__lagerHost.reload` / `.confirm` replace the browser's own when present.
   */
  function hostCall(name, arg) {
    var host = window.__lagerHost;
    if (host && typeof host[name] === 'function') return host[name](arg);
    if (name === 'reload') return window.location.reload();
    return window.confirm(arg);
  }

  function declaredObject(session, name) {
    var caps = session && session.capabilities;
    return !!(caps && caps[name] && typeof caps[name] === 'object');
  }

  function artifactAvailable(session) {
    return declaredObject(session, 'artifact') || declaredObject(session, 'self');
  }

  function onReloadEvent(e) {
    var data;
    try { data = JSON.parse(e.data); } catch (_) { return; }
    var version = data && typeof data === 'object' ? Number(data.version) : NaN;
    if (!isFinite(version) || loadedVersion === null || version === loadedVersion || reloaded) return;
    reloaded = true;
    hostCall('reload');
  }

  function artifactError(code, message) { return { code: code, message: message }; }

  function artifactFailure(res, json) {
    var error = json && json.error;
    var message = error && typeof error.message === 'string' ? error.message : 'Request failed (' + res.status + ').';
    var raw = error && typeof error.code === 'string' ? error.code : '';
    var code;
    if (res.status === 401 || (res.status === 403 && raw !== 'not_declared')) code = 'not_writer';
    else if (res.status === 403) code = 'not_declared';
    else if (res.status === 409) code = 'conflict';
    else if (res.status === 413) code = 'too_large';
    else if (res.status === 429) code = 'rate_limited';
    else if (res.status === 400 && raw === 'invalid_content') code = 'invalid_content';
    else code = 'upstream_error';
    return artifactError(code, message);
  }

  function buildArtifact(session) {
    if (artifactNamespace) return artifactNamespace;
    var level = levelOf(session);
    var editor = level === 'admin' || level === 'owner';
    var instance = session && session.instance;
    loadedVersion = instance && isFinite(Number(instance.version)) ? Number(instance.version) : null;
    keepSourceOpen = true;
    openSource();

    function unsupported(code, what) {
      return function () { return Promise.reject(artifactError(code, what + ' is not available on this Lager server.')); };
    }

    function publish(arg) {
      return Promise.resolve().then(function () {
        if (arg !== null && typeof arg === 'object') throw artifactError('capability_disabled', 'Publishing several files is not available on this Lager server.');
        if (!editor) throw artifactError('not_writer', 'This view cannot save the page.');
        if (typeof arg !== 'string' || arg.trim() === '') throw artifactError('invalid_content', 'publish expects the complete html as a non-empty string.');
        return fetch(ARTIFACT_URL, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'X-Lager-Request': '1' },
          body: JSON.stringify({ html: arg, baseVersion: loadedVersion }),
        }).then(
          function (res) {
            return res.json().catch(function () { return null; }).then(function (json) {
              if (!res.ok) throw artifactFailure(res, json);
              if (!json || typeof json.version !== 'string') throw artifactError('upstream_error', 'Unexpected response (' + res.status + ').');
              return Object.freeze({ version: json.version });
            });
          },
          function (e) { throw artifactError('upstream_error', e && e.message ? String(e.message) : 'Network error.'); }
        );
      });
    }

    artifactNamespace = Object.freeze({
      publish: publish,
      edit: unsupported('capability_removed', 'edit'),
      sync: unsupported('capability_removed', 'sync'),
      metadata: unsupported('capability_removed', 'metadata'),
    });
    return artifactNamespace;
  }

  function downloadError(code, message) { return { code: code, message: message }; }

  /** The base name of the file the viewer would get: no directories, no control characters, no trailing dots or spaces. */
  function downloadName(filename) {
    var name = filename.replace(/[\u0000-\u001f\u007f]/g, '');
    name = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1).trim().replace(/[. ]+$/, '');
    return name;
  }

  function downloadBlob(data) {
    if (typeof data === 'string') {
      if (data.length > DOWNLOAD_MAX_BYTES) throw downloadError('too_large', 'The file is larger than 50 MiB.');
      return data === '' ? null : new Blob([data]);
    }
    var size = -1;
    if (typeof Blob !== 'undefined' && data instanceof Blob) size = data.size;
    else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) size = data.byteLength;
    if (size < 0) throw downloadError('bad_request', 'data must be a string, Blob, ArrayBuffer or typed array.');
    if (size > DOWNLOAD_MAX_BYTES) throw downloadError('too_large', 'The file is larger than 50 MiB.');
    return size === 0 ? null : (data instanceof Blob ? data : new Blob([data]));
  }

  function buildDownloads() {
    function save(request) {
      return Promise.resolve().then(function () {
        if (!request || typeof request !== 'object' || typeof request.filename !== 'string' || request.filename.length > 512) {
          throw downloadError('bad_request', 'save expects {filename, data}.');
        }
        var name = downloadName(request.filename);
        if (name === '') throw downloadError('bad_request', 'The filename is empty.');
        var dot = name.lastIndexOf('.');
        if (dot >= 0 && DOWNLOAD_BLOCKED.indexOf(name.slice(dot + 1).toLowerCase()) >= 0) {
          throw downloadError('rejected_extension', 'Files of this type cannot be saved.');
        }
        var blob = downloadBlob(request.data);
        if (blob === null) throw downloadError('bad_request', 'data must not be empty.');
        if (!hostCall('confirm', 'Datei „' + name + '" speichern?')) throw downloadError('declined', 'The viewer declined the download.');
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

  // ------------------------------------------------------------------ permissions

  function buildPermissions(session) {
    var states = { user: 'granted' };
    if (levelOf(session)) states.db = 'granted';
    if (assetsAllowed(session)) states.assets = 'granted';
    if (roomAvailable(session)) states.room = 'granted';
    if (declaredObject(session, 'artifact')) states.artifact = 'granted';
    if (declaredObject(session, 'self')) states.self = 'granted';
    if (declaredObject(session, 'downloads')) states.downloads = 'granted';
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
      if (name === 'assets') return assetsAllowed(session) ? buildAssets() : null;
      if (name === 'room') return roomAvailable(session) ? buildRoom(session) : null;
      if (name === 'artifact' || name === 'self') return artifactAvailable(session) ? buildArtifact(session) : null;
      if (name === 'downloads') return declaredObject(session, 'downloads') ? buildDownloads() : null;
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
