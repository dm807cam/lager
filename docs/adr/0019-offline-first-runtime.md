# 0019. The runtime makes every app work offline and syncs when the server is back

- Status: Proposed
- Date: 2026-11-24

## Context

Apps on Lager are used on phones, often from the home screen, and phones lose their connection: on a train, in a cellar, at a market stall. Until now an app could not open at all without the server. The page was sent with `Cache-Control: no-store` and nothing in the browser kept it. When `/__lager/session` failed, `lager.use("db")` resolved to `null`, and every read and write rejected with `unavailable`.

Apps cannot fix this themselves. The guide tells every assistant to keep data only in `lager.use("db")` and never in `localStorage`, `sessionStorage` or `indexedDB`, because browser storage is lost when the device changes (see 0006). An app also has no way to keep its own HTML: it cannot serve a service worker, because a worker must be a script on the instance host, and an app is a single HTML file. Assistants that tried anyway each wrote their own queue in browser storage, with their own bugs, in every app. The work belongs in one place, and it has to be the runtime and the server.

The `db` API was already shaped for this. Its snapshots carry `metadata: {fromCache, hasPendingWrites}`, as in Firestore, and so far both are always `false`.

## Decision

Lager makes every app work offline by default, in three steps. Each step ships on its own and keeps the API apps already use. An app turns all of it off with `{"db": {"offline": false}}`.

**1. The app opens without a connection (this record's first implementation).**

- The server serves a service worker at `/__lager/sw.js` with `Service-Worker-Allowed: /`. The runtime registers it with scope `/` after the page has loaded, using the session it reads anyway. It registers only on the top-level page in a secure context, never inside a frame on another website, where the instance only ever sees a guest (0018).
- The worker asks the network first. It answers from its copy when the network fails, the server is down (502, 503, 504) or no answer comes within 4 seconds and a copy exists. It handles only the page, the session, the runtime's scripts, the manifest and icons, and scripts, stylesheets and fonts from other hosts (at most 40). It never touches the database, event streams, uploads, rooms, sign-in or anything that is not a `GET`. On install it fetches the page, the session, the runtime and the files from other hosts that the page names, so a single visit is enough.
- The server decides what may be kept, never the page. The page and the session carry `X-Lager-Offline: 1` for a viewer with access whose app does not turn offline off. An answer that sends the viewer to the sign-in, answers 401, 403, 404 or 410, or comes without the mark deletes everything the worker kept. When the app turns offline off, the runtime also unregisters the worker.
- With the kept session, `lager.use("db")` and `lager.use("user")` resolve offline instead of returning `null`.

**2. Reads come from a local copy.** The runtime keeps the documents and query results the server sends in IndexedDB, per instance and viewer. Offline, `get`, `query` and `onSnapshot` answer from it with `metadata.fromCache: true` and refresh once the server answers. Queries run in the browser on a copy of `src/data/query.ts`. The server's `reset` event, which follows a snapshot restore, drops the copy.

**3. Writes are queued while offline.** Online, `set`, `update`, `delete` and `add` keep their present contract: they wait for the server and reject with its error. Only when the request fails for lack of a network does the runtime apply the write to the local copy, store it in a queue in IndexedDB and resolve, with `metadata.hasPendingWrites: true` on the snapshots that show it. When the server is reachable again, one tab (Web Locks) replays the queue in order and respects `Retry-After`. Conflicts are settled by "last writer wins" per document, with `update` merging fields, which is what concurrent writes already do online. A viewer with only `view` access is refused at once from the kept session. A write the server refuses later (rules, quota) is undone in the local copy and reported through a small sync API on `db`. For a replay to be safe, `add` gets an id chosen in the browser that the server accepts only where no document exists yet. Leases (`acquire`), uploads, rooms, `complete` and `page.publish` stay online-only and reject with `unavailable` offline.

Alternatives we rejected:

- **Leaving it to apps.** That is what we had. Every app would need its own queue, contradicting the rule against browser storage, and would still not open offline.
- **An opt-in declaration such as `{"offline": {}}`.** Most apps benefit, the assistants writing them would rarely think to ask, and steps 1 and 2 change nothing for an app that is online. A capability is also a namespace of `lager.use` (0006), and offline is not one. Turning it off is the exception, so it is a flag on `db`.
- **Caching the page in the browser's HTTP cache** (dropping `no-store`). The HTTP cache cannot be cleared from the server when access ends, would also keep the page for people who lost access, and gives no control over what is kept.
- **Resolving every write at once, online too, as Firestore does.** That would change the meaning of `await set()` for existing apps: the guide's own example relies on a rejected `add` to tell a viewer that they can only read.
- **Merging conflicts per field, or with CRDTs.** That costs far more than small apps need. Online they already work with "last writer wins".

## Consequences

- An app opens offline after one visit, with no change to the app. Apps written for the old behaviour keep working: offline they now see the last known viewer instead of `null`, and their requests fail as before (until steps 2 and 3).
- The device keeps the last page and session of every instance the viewer opened, including their name and, where the app may see it, their email address, until the next time the app is opened online after access ended. The docs tell people on shared devices to sign out and open the app once online. The platform's sign-out cannot reach the worker on instance hosts directly (0005), so clearing happens on the instance host the next time it is reached.
- Steps 2 and 3 store data in IndexedDB, and Safari deletes the storage of sites that were not used for seven days unless they were added to the home screen. The runtime will ask for persistent storage, and the docs will recommend installing apps that people use offline.
- The runtime grows. Step 1 adds a separate worker script of about 200 lines and about 50 lines to `runtime.js`. Steps 2 and 3 will add several hundred more, and the server needs `add` with a chosen id and probably a `batch` operation, because a long offline session can queue more writes than the 300 per minute a viewer may make.
- Contributors must keep the worker narrow. A new route that answers with private data must not be added to what it handles without the same mark from the server, and every answer that ends access must keep clearing it.
- The guide tells assistants how apps behave offline and that they must not build queues of their own.
