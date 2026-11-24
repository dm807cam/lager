# 0019. The runtime makes every app work offline and syncs when the server is back

- Status: Proposed
- Date: 2026-11-24

## Context

Apps on Lager are used on phones, often from the home screen, and phones lose their connection: on a train, in a cellar, at a market stall. Until now an app could not open at all without the server. The page was sent with `Cache-Control: no-store` and nothing in the browser kept it. When `/__lager/session` failed, `lager.use("db")` resolved to `null`, and every read and write rejected with `unavailable`.

Apps cannot fix this themselves. The guide tells every assistant to keep data only in `lager.use("db")` and never in `localStorage`, `sessionStorage` or `indexedDB`, because browser storage is lost when the device changes (see 0006). An app also has no way to keep its own HTML: it cannot serve a service worker, because a worker must be a script on the instance host, and an app is a single HTML file. Assistants that tried anyway each wrote their own queue in browser storage, with their own bugs, in every app. The work belongs in one place, and it has to be the runtime and the server.

The `db` API was already shaped for this. Its snapshots carry `metadata: {fromCache, hasPendingWrites}`, as in Firestore, and so far both are always `false`.

An earlier request for offline writes (#58) was closed as not planned, for four reasons this record has to answer:
- **Conflicts.** "Newest wins" would let a device that comes back online days later silently overwrite other people's newer data.
- **Refused writes.** A queued write the server refuses (`not_granted`, `quota_exceeded`) is lost after the person has left the app believing it was saved.
- **A second query engine** in the browser, which has to stay in step with the server's.
- **Data at rest.** Instance data kept on the device has to be cleared when the viewer changes or loses access, and that touches 0004.

## Decision

Lager makes every app work offline by default, in three steps. Each step ships on its own and keeps the API apps already use. An app turns all of it off with `{"db": {"offline": false}}`.

**1. The app opens without a connection (this record's first implementation).**

- The server serves a service worker at `/__lager/sw.js` with `Service-Worker-Allowed: /`. The runtime registers it with scope `/` after the page has loaded, using the session it reads anyway. It registers only on the top-level page in a secure context, never inside a frame on another website, where the instance only ever sees a guest (0018).
- The worker asks the network first. It answers from its copy when the network fails, the server is down (502, 503, 504) or no answer comes within 4 seconds and a copy exists. It handles only the page, the session, the runtime's scripts, the manifest and icons, and scripts, stylesheets and fonts from other hosts (at most 40). It never touches the database, event streams, uploads, rooms, sign-in or anything that is not a `GET`. A file from another host that the page requests without CORS is tried with CORS first, because browsers charge every opaque copy several megabytes of the storage quota. On install it fetches the page, the session, the runtime and the files from other hosts that the page names, so a single visit is enough.
- The server decides what may be kept, never the page. The page and the session carry `X-Lager-Offline: 1` for a viewer with access whose app does not turn offline off. An answer that sends the viewer to the sign-in, answers 401, 403, 404 or 410, or comes without the mark deletes everything the worker kept. When the app turns offline off, the runtime also unregisters the worker.
- Only the top-level page gets or replaces a kept page or session. A navigation inside a frame, or a session request from a framed page, always goes to the network, whatever the browser's partitioning does.
- The kept session holds the viewer's id, name, level and the app's capabilities, never their email address (it is `null` in the copy, as for an app without the `email` scope) and never the sign-in link. Opening the app offline needs neither.
- With the kept session, `lager.use("db")` and `lager.use("user")` resolve offline instead of returning `null`. A session answered from the copy (`X-Lager-From-Cache: 1`) is used for the moment and read again on the next `lager.use()`, so a page that comes back online does not keep a stale viewer.

**2. Reads come from a local copy.** The runtime keeps the documents and query results the server sends in IndexedDB, per instance and viewer. Offline, `get`, `query` and `onSnapshot` answer from it with `metadata.fromCache: true` and refresh once the server answers.

- **Queries** run in the browser on a copy of `src/data/query.ts`. A shared test suite runs the same cases against both, so the two cannot drift apart.
- **Rule filtering** is not copied to the browser. The local copy holds only what the server already let this viewer read.
- **The copy is a cache of the instance's data, never a second home for it.** The server stays the only source of truth, and 0004 is unchanged. Snapshots, restores, exports and quotas know nothing of the device.
- **The copy is deleted:**
  - when the session names a different viewer;
  - on every answer that also clears step 1's worker (a sign-in redirect, 401, 403, 404, 410, a page without the mark);
  - on the server's `reset` event, which follows a snapshot restore.

  The private area `data/users/<id>/…` of another viewer never reaches the device, because the server never sends it.

**3. Writes are queued while offline.** Online, `set`, `update`, `delete` and `add` keep their present contract: they wait for the server and reject with its error. Only when the request fails for lack of a network does the runtime apply the write to the local copy, store it in a queue in IndexedDB and resolve, with `metadata.hasPendingWrites: true` on the snapshots that show it. When the server is reachable again, one tab (Web Locks) replays the queue in order and respects `Retry-After`.

- **Conflicts are detected, never overwritten.** Every queued write carries the version and update time of the document as the device last saw it. That is the key the runtime already uses to tell snapshots apart, and "none" for a document the device saw as missing.
  - The server applies a replay only while the document still has exactly that key. The update time also catches a document that was deleted and created again, whose version starts over.
  - If someone else changed the document meanwhile, the server refuses the replay as `conflict`. The runtime then shows the server's state again and keeps the local change in the sync API, from where the app can offer to apply it anyway (a plain online write) or to drop it.
  - A device that comes back online days later can therefore never silently replace newer data. Writes made online keep their present behaviour: the version check is used only for replays.
- **Refused writes stay visible.** A write the server refuses for any reason (`conflict`, rules, quota) is undone in the local copy but not thrown away. It stays in the sync API until the app or the person dismisses it. The guide tells apps to show pending and refused writes, for example with a dot; `db.sync` notifies them of every change.
- A viewer with only `view` access is refused at once, from the kept session.
- **Safe replays.** `add` gets an id chosen in the browser, which the server accepts only where no document exists yet. A replay whose answer was lost therefore cannot create a duplicate.
- **Online only.** Leases (`acquire`), uploads, rooms, `complete` and `page.publish` reject with `unavailable` offline.

Alternatives we rejected:

- **Leaving it to apps.** That is what we had. Every app would need its own queue, contradicting the rule against browser storage, and would still not open offline.
- **An opt-in declaration such as `{"offline": {}}`.** Most apps benefit, the assistants writing them would rarely think to ask, and steps 1 and 2 change nothing for an app that is online. A capability is also a namespace of `lager.use` (0006), and offline is not one. Turning it off is the exception, so it is a flag on `db`.
- **Caching the page in the browser's HTTP cache** (dropping `no-store`). The HTTP cache cannot be cleared from the server when access ends, would also keep the page for people who lost access, and gives no control over what is kept.
- **Resolving every write at once, online too, as Firestore does.** That would change the meaning of `await set()` for existing apps: the guide's own example relies on a rejected `add` to tell a viewer that they can only read.
- **"Last writer wins" for replays**, by the device's clock or by the order in which writes reach the server. Either way, a device that was offline for a long time would overwrite newer data of other people without anyone noticing (#58). Online, concurrent writes do work that way, but there every writer sees the current state within moments.
- **Merging conflicts per field, or with CRDTs.** That costs far more than small apps need, and the app knows its own merge rule better than the runtime. The sync API hands the app both states.

## Consequences

- An app opens offline after one visit, with no change to the app. Apps written for the old behaviour keep working: offline they now see the last known viewer instead of `null`, and their requests fail as before (until steps 2 and 3).
- The device keeps the last page and session of every instance the viewer opened, including their name and access level but never their email address, until the next time the app is opened online after access ended. The docs tell people on shared devices to sign out and open the app once online. The platform's sign-out cannot reach the worker on instance hosts directly (0005), so clearing happens on the instance host the next time it is reached.
- Apps that need it can resolve conflicts themselves; apps that ignore the sync API lose nothing silently, because a refused write stays listed until it is dismissed.
- Steps 2 and 3 store data in IndexedDB, and Safari deletes the storage of sites that were not used for seven days unless they were added to the home screen. The runtime will ask for persistent storage, and the docs will recommend installing apps that people use offline.
- The runtime grows. Step 1 adds a separate worker script of about 200 lines and about 50 lines to `runtime.js`. Steps 2 and 3 will add several hundred more, The server needs `add` with a chosen id, an optional precondition on `set`, `update` and `delete` (the document's version and update time), and probably a `batch` operation, because a long offline session can queue more writes than the 300 per minute a viewer may make.
- Contributors must keep the worker narrow. A new route that answers with private data must not be added to what it handles without the same mark from the server, and every answer that ends access must keep clearing it.
- The guide tells assistants how apps behave offline and that they must not build queues of their own.
