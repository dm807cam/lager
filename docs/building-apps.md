# Building apps

What an app can use on Lager through `window.lager`, and how icons and home-screen install work.

## Building blocks

An app gets additional functions through `await lager.use("<name>")`. The call never throws and returns `null` when the instance does not offer the building block. `db` (for every viewer with an access level), `user` and `permissions` are always there; declaring `db` and `user` adds rules and scopes. Every other building block is available only if the active version declares it in `capabilities`. At deploy time you pass `capabilities` as JSON, for example as a query parameter of `PUT /api/apps/<slug>` or as an argument of `deploy_app`. The example [`examples/board.html`](../examples/board.html) (a shared pin board) uses `db`, `user`, `assets`, `room` and `downloads`, and [`examples/pageviews.html`](../examples/pageviews.html) (a page-view counter for a website of your own) uses `ingest`:

```sh
curl -X PUT -H "Authorization: Bearer $LAGER_TOKEN" -H "Content-Type: text/html" \
  --data-binary @examples/board.html \
  "https://lager.example.com/api/apps/board?title=Pin%20board&capabilities=%7B%22db%22%3A%7B%7D%2C%22user%22%3A%7B%7D%2C%22assets%22%3A%7B%7D%2C%22room%22%3A%7B%7D%2C%22downloads%22%3A%7B%7D%7D"
```

| Building block | What it does on Lager | Declaration | Limits |
| --- | --- | --- | --- |
| `db` | Document database of the instance with live updates | `{"db": {}}`, optionally `{"db": {"rules": [...]}}` | Document 256 KiB, path 1000 bytes, query 1000 results, 10 `where` clauses and 30 list values, 600 reads and 300 writes per viewer and minute (guests: 600 reads per address); instance storage is limited (see [Limits](limits.md)) |
| `user` | Name and id of the viewer, profiles of the people the instance knows (the owner, the people it is shared with, everyone who wrote one of its shared documents, people in its rooms), people search | `{"user": {}}`; email addresses only with `{"user": {"scopes": ["email"]}}`, search with scope `"profile"` | Every member is async, including `name()` |
| `permissions` | Shows which building blocks are available | none | none |
| `assets` | Upload, list and delete files; they are served from `/_blob/<id>` on the instance | `{"assets": {}}` | Managers and owners may upload; with `{"assets": {"upload": "interact"}}` contributors too (they see and delete only their own files); owners and managers can still list and delete files if the page no longer declares `assets`. An upload must state its `Content-Length`, and at most 2 uploads run at once per viewer and instance. At most 20 MiB per file (CSS and JavaScript 16 MiB, SVG 2 MiB) and 2000 files per instance. Allowed are images, video, audio, PDF, fonts, CSS, JavaScript, CSV, Markdown, JSON and text; HTML is refused, and the content must match the stated type. Files count toward the instance's storage |
| `room` | Ephemeral rooms with messages and presence; nothing is stored, and a server restart empties all rooms | `{"room": {}}`; contributors may send only on topics opened with `{"room": {"topics": {"<topic>": "interact"}}}` | Otherwise managers and owners send, viewers only listen. Message at most 4 KiB, presence at most 2 KiB; per viewer and instance at most 8 open connections (8 rooms) and 30 sends per second, and at most 100 open connections of anonymous visitors per instance; at most 50 rooms per instance and 100 participants per room |
| `page` | The page saves itself: `page.publish(html)` creates a version that belongs only to this instance and is active there at once | `{"page": {}}`; `{"page": {"publish": false}}` blocks saving | Managers and owners only. The document must start with `<!doctype html`, at most 16 MiB, 60 save attempts per hour and instance (refused ones count too), the last 20 saved versions are kept (older ones are deleted outright, not moved to the trash). Saved pages count toward the instance's storage |
| `downloads` | `downloads.save({filename, data})` offers the viewer a file to save after a confirmation in the browser; the server is not involved | `{"downloads": {}}` | At most 50 MiB, file name at most 240 bytes; the confirmation names the file and its size; allowed extensions: gif, png, jpg, jpeg, webp, mp4, webm, mov, txt, json, md, docx, pptx, epub, csv, ttf, html, svg, pdf, xlsx, zip, fig |
| `ingest` | The instance takes data from outside (another website, a webhook, a script, a device): each endpoint appends JSON documents to one collection and can do nothing else. `ingest.endpoints()` tells the page their addresses, and their tokens if the viewer manages the instance | `{"ingest": {"endpoints": [{"name": "hits", "auth": "none", "origins": ["https://blog.example.com"]}]}}` | See [Receiving data from outside](#receiving-data-from-outside): at most 8 endpoints, a request at most 64 KiB, limits per minute and day, and an ingest quota apart from the instance's storage |

Data rules (`db.rules`) set a minimum level per path, separately for reading and writing. A path that people may write but not read (a drop box such as `{"path": "inbox", "read": "admin", "write": "interact"}`) accepts `set`, `add` and `delete` from them, but not `update` or `acquire`: both work on the stored document and would reveal something about it, so they are refused with `not_granted`. A write there answers without the stored document. The private area `data/users/<id>/…` belongs to that user alone: they read and delete it from viewer level and write it from contributor level, and no rule changes that.

Whoever saves a page with `page.publish` detaches that instance from the app's deploys: it no longer follows new deploys automatically. A deploy lists such instances in the field `pinned` and in its warnings. To follow deploys again, turn "Update automatically" back on: on the instance page, with `POST /api/instances/<slug>/auto-update` and the body `{"on": true}`, or with the MCP tool `set_auto_update`; turning it on moves the instance to the latest deployed version at once (the saved page stays among that instance's saved versions). The saved versions do not appear in the app's version list; only the managers of the instance that saved them can download their HTML.

For every other name `lager.use` returns `null`, and `lager.complete` works only once an administrator connects a language model (see [Bring your own model](ai-models.md)). `check_app` (MCP) and `POST /api/check` show before a deploy what an app uses, what Lager does not offer, what is not yet declared, and which APIs of other hosts (`window.claude`, `window.storage` from claude.ai) still need converting. The check is best effort: it only sees `lager.use("…")` calls whose name is a string literal.

The event streams (`/__lager/db/events`, `/__lager/room/events`) and the files at `/_blob/<id>` answer only the instance's own page: a request that the browser marks as coming from another site or from another instance (even one under the same apps domain) is refused, so another page cannot open them or embed the files with the visitor's cookies.

## Receiving data from outside

Without this, only signed-in people with contributor level put data into an instance, and only from the instance's own page. Two declarations open a narrow way in for everything else: a counting snippet on your blog, a contact form on your website, a webhook, a script, a phone shortcut, a sensor, or a guest who answers an invitation. Both only **append**: the server makes up the id of every document, so nothing that exists can be read, overwritten or deleted through them.

### Endpoints

An app declares up to 8 named endpoints. Each one writes into one collection of the instance:

```json
{"db": {}, "user": {}, "ingest": {"endpoints": [
  {"name": "hits", "auth": "none", "origins": ["https://blog.example.com"], "visitor": "daily", "country": true, "onFull": "rotate", "maxPerDay": 100000},
  {"name": "weight", "collection": "weights", "auth": "token", "maxBytes": 2048}
]}}
```

| Field | Meaning | Default |
| --- | --- | --- |
| `name` | Part of the address: lowercase letters, digits, `-` and `_`, starting with a letter, at most 48 characters | required |
| `auth` | `"none"`: pages on the listed `origins` send without a secret. `"token"`: whoever holds the endpoint's token sends | required |
| `origins` | The websites whose pages may call the endpoint, as scheme and host (`https://blog.example.com`), at most 20. Required with `"none"`; `["*"]` (any website) is allowed with `"token"` only | none |
| `collection` | The collection the documents go to (a collection path, never inside a private area) | the name |
| `maxBytes` | Largest request body, 1 to 65536 | `4096` |
| `maxPerDay` | Documents the endpoint takes per day (UTC), 1 to 100000 | `10000` |
| `onFull` | What happens when the ingest quota of the instance is full: `"refuse"`, or `"rotate"`, which drops the oldest received documents of this collection to make room | `"refuse"` |
| `visitor` | `"daily"` adds `_visitor` to every document (see below) | off |
| `country` | `true` adds `_country`, if the operator named the proxy's header in `LAGER_COUNTRY_HEADER` | off |

A field Lager does not know is refused at deploy time, so a typing mistake such as `origin` never leaves an endpoint more open than intended.

**Sending.** `POST https://<instance>/_ingest/<name>` with one JSON object as the body, in any content type. An accepted request answers `202` with an empty body. Nothing stored is ever sent back, and no other method does anything.

```sh
curl -X POST -H "Authorization: Bearer $TOKEN" -d '{"kg": 71.5}' https://tracker.apps.example.com/_ingest/weight
```

```html
<script>
  navigator.sendBeacon("https://stats.apps.example.com/_ingest/hits", JSON.stringify({ path: location.pathname }));
</script>
```

| Answer | Meaning |
| --- | --- |
| `202` | Stored |
| `400` | The body is not one JSON object, or it breaks the rules for documents (32 levels, finite numbers) |
| `401` | `auth: "token"`: the token is missing or wrong. After 30 wrong tokens within a minute, an address gets `429` for the rest of that minute, whatever it sends |
| `403` | `auth: "none"`: the request names no origin, or one that is not listed |
| `404` | No such endpoint on this instance; also when it is switched off, when the instance is disabled, or when receiving is switched off on the server |
| `405` | Not `POST` |
| `413`, `415` | Larger than `maxBytes`; a compressed body |
| `429` | Too many requests; `Retry-After` says how long to wait |
| `507` | The ingest quota of the instance is full and the endpoint does not rotate |

**Who may send.** The endpoint never looks at cookies: a request is anonymous there, whoever's browser sent it, so another site cannot borrow the rights of a signed-in visitor, and nothing is stored under anybody's name. With `auth: "none"` Lager compares the `Origin` header, which browsers set themselves on every cross-site `POST`, with the list, and answers the CORS preflight for listed origins only. That keeps other websites from sending through their visitors' browsers. It does not keep out a script, which can claim any origin: **treat an endpoint without a token as open to anyone, and what arrives as untrusted input.** With `auth: "token"` the sender sets `Authorization: Bearer <token>`; for senders that cannot set a header, `?key=<token>` in the address works too, but addresses end up in the logs of proxies, so prefer the header. Every instance has its own token for every token endpoint.

**What the server adds.** Every document gets `_receivedAt` (ISO time). With `visitor: "daily"` it gets `_visitor`: a keyed hash of the instance, the client address (an IPv6 /64 counts as one) and the browser's user agent. The key is random, lives only in memory and is replaced every day (UTC) and at every restart. So the same visitor has the same value during one day, which is enough to count unique visitors without cookies, and nobody can link the value to another day or work back to an address, not even with the server's secret and database. With `country: true` it gets `_country`, the two letters from the header named in `LAGER_COUNTRY_HEADER` (Cloudflare sends `cf-ipcountry`); without that setting the field is missing. A sender cannot set these three fields. The client address, the user agent and the origin are never stored. (The access log, if you turned it on, lists client addresses as for every request.)

**Reading.** What arrives are ordinary documents: the app reads them with `db`, they are part of exports and snapshots, and the owner deletes them like any other. Because they come from strangers, the collection of an endpoint is readable **only by managers and the owner** unless the app sets `read` for that path in `db.rules`. Live queries hear of new documents at most every 2 seconds per collection, however fast they come in.

**On the instance page.** The card "Data from outside" lists every endpoint with its address, who may send, the token (with a button that replaces it; the old one stops working at once), how many requests were accepted, refused and turned away for a limit since the server started, and a switch that closes the endpoint at once. In the app, `lager.use("ingest")` gives `endpoints()`, which resolves `[{name, url, auth, collection, origins, maxBytes, enabled, token}]`; `token` is a string only for managers and the owner, so a page can show them a ready-made snippet.

### Guests on the instance's own page

For a public page that takes one small input from a visitor (an RSVP, a guestbook entry, a vote, "was this helpful?"), a data rule is enough:

```json
{"db": {"rules": [{"path": "rsvps", "read": "admin", "write": "anyone"}]}}
```

`"write": "anyone"` lets every visitor who can open the instance add documents below that path with `collection.add(data)`, signed in or not. They can do nothing else there: `set`, `update`, `delete` and `acquire` stay with contributors and above, and `anyone` is not a level for `read`. A visitor's document has at most 4096 bytes; all visitors together add at most 600 documents per minute and 10000 per day under one rule. The private area `data/users/<id>/…` never takes such documents.

### Limits and the ingest quota

- **Requests per minute:** 150 from one client address to one instance (for requests without a token; an IPv6 /64 is one address), 600 per endpoint or rule, and 1200 for everything an instance takes from outside. Guests who add through a rule are also held to the limits on database requests (see [Limits](limits.md)).
- **Ingest quota:** what came from outside counts against `LAGER_INGEST_QUOTA_MB` (default 10 MiB per instance), apart from the instance's own storage and on top of it: a flood of requests cannot use up the space the instance's own data needs, and the instance being full does not stop the endpoint. A document counts with the database pages it can take at worst, not with the length of its JSON: a few hundred bytes more than its JSON for a small document, and up to twice its JSON for one of 2 to 8 KiB. With the default quota an instance holds roughly 20000 small documents such as page views. The instance page shows what is used.
- **Becoming the instance's own.** A received document that someone with write access changes (the owner approves a guestbook entry, the app marks a message as read) stops counting against the ingest quota and counts against the instance's storage from then on; `rotate` never drops it. An app that keeps data for long therefore folds what came in into documents of its own (daily totals, say) and deletes the received ones.
- **Switching it off.** `LAGER_INGEST_QUOTA_MB=0` turns receiving off for the whole server: no endpoint answers, and `anyone` rules let nobody add. An administrator can also disable a single instance, and its managers can switch off single endpoints.

## App icons and home-screen install

Every app has an icon, a one-sentence description and a theme colour. The assistant supplies them when it deploys: `deploy_app` takes `icon_svg`, `description` and `theme_color`, `set_app_icon` changes them later. On REST, `PUT /api/apps/<slug>` accepts `description` and `theme_color` (query or JSON) and `icon_svg` (JSON only), `PUT /api/apps/<slug>/icon` takes a body of type `image/svg+xml`, and `PATCH /api/apps/<slug>` takes `{"description", "theme_color"}`. Results of `deploy_app`, `get_app` and `list_apps` carry `description`, `themeColor` and `iconUrl` (the public 192 px PNG on the platform host). Without an icon a new app gets a generated one (a gradient and a simple shape derived from its name) and the deploy result says so; a redeploy without `icon_svg` keeps the icon, and an icon that is refused never fails a deploy: the previous or generated icon stays and the reason is a warning (`set_app_icon` returns an error instead).

The SVG comes from a client you do not control, so it is checked before it is drawn and **only PNGs rendered on the server are ever served; the SVG itself never reaches a browser.** Only a small subset of SVG is accepted, so the cost of drawing is bounded by construction: shapes, paths, groups and gradients (`svg` root with `xmlns` and a square `viewBox`, `g`, `defs`, `linearGradient`, `radialGradient`, `stop`, `path`, `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon`, `title`, `desc`), a fixed list of attributes (no `style`, `class`, `href`, `mask`, `clip-path`, `filter` or `on…`), `fill`/`stroke` as colours or `url(#gradient)`, plain bounded numbers, at most 64 KiB, 500 elements and 16 levels. Masks, clip paths, `use`, filters, patterns, text, images, scripts, DOCTYPE and entity declarations and processing instructions are refused, and so is anything that is not well-formed XML. Drawing uses `@resvg/resvg-wasm`, which is read from `node_modules` at run time (it needs no native build and no system fonts) and runs in a worker thread that is ended after 3 seconds, replaced after any failed drawing, after 50 drawings or after a large memory growth. At most 20 drawings wait in total and 2 per user. Public icon routes never start a drawing: an app whose icon is not drawn yet is served a bundled placeholder, and existing apps get their generated icon in the background after start-up.

Icons are stored under `<data>/apps/<app id>/icon/` and go to the trash with the app. They are served at `<platform>/app-icons/<app id>/<icon version>/<64|192|512>.png` (public, cached for a year; the version changes with every icon change and a wrong version is redirected to the current one).

Every instance can be added to a phone's home screen. Its pages carry a manifest, `apple-touch-icon` and theme-colour tags (unless the app brings its own `rel="manifest"` link) and a viewport tag when the app has none. The manifest (`/__lager/manifest.webmanifest`), the icons (`/__lager/icon-180.png`, `-192`, `-512`, `-512-maskable`), `/apple-touch-icon.png` and `/favicon.ico` answer without a sign-in, because browsers fetch them on their own. For a public instance they show the name, description, colours and icon to everyone. For an instance that is not public, only a viewer with access gets those; anyone else gets a generic manifest named "Lager" with Lager's placeholder icon, so the address of a private instance does not tell what it holds. The injected manifest link carries `crossorigin="use-credentials"`, so a signed-in viewer's browser sends the instance cookie and installs the app under its real name and icon; an app that brings its own manifest link needs the same attribute. Phones often fetch the home-screen icon without any cookie, so the icon addresses in the page and in the manifest of such a viewer carry a token (`?v=<icon version>&t=…`) that opens the icon, and only the icon, without a sign-in; it is bound to the instance and to the icon version and stops working when the icon changes. Until then it stays valid: it does not expire and it is not tied to a person, so someone who had the address keeps it after losing access, and making the instance public for a while and private again does not replace it. It opens the icon only, never the name, the manifest or any data. To end it, change the icon. Name and icon of an instance that is not public are sent with `Cache-Control: private, no-cache`. A disabled instance serves none of them. The platform has its own manifest and icons as well. To install, open the app on the phone and choose "Add to Home Screen"; signing in happens in the browser the first time.
