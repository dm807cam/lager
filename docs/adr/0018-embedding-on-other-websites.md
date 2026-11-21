# 0018. Websites outside Lager may frame an instance its managers name them for

- Status: Proposed
- Date: 2026-11-21

## Context

Every instance page answers with `Content-Security-Policy: frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN`. The reason is written next to the header: instances under the apps domain are the same site as each other, so the browser sends an instance's `SameSite=Lax` session cookie into a frame that another instance opens. Without the header, any app on the server, code nobody reviewed, could show another instance with its visitor signed in and trick them into clicks there (clickjacking with that visitor's rights).

The header also rules out a whole kind of app: everything that is meant to sit on someone's own website. Comments under a static blog post, a poll, a booking or contact form, a guestbook. 0017 lets such a website *send* to an instance (`ingest`), but a comment box must also *show* what others wrote, and nothing on another website can read an instance: there is no CORS on the instance's routes, and ingest endpoints only append. The data is there, the rules for guests are there (`"write": "anyone"`), only the frame is closed. The workarounds people reach for are worse than a narrow door: rewriting the header in a proxy or CDN for the whole host (which also opens the frame to other instances and to every website), or a second server that copies the data out.

## Decision

An app declares `embed` (`{"embed": {}}`) when it is built to be framed. The declaration carries no websites. The people who manage an instance (`admin` and the owner) name the websites, on the instance page or from the app (`lager.use("embed")`: `get()`, `setOrigins(origins)`, `PUT /__lager/embed/origins` with the `X-Lager-Request` header and the viewer's write budget). While the active version declares `embed`, the instance page answers with `frame-ancestors 'self' <websites>` and without `X-Frame-Options`, which cannot name websites. Nothing else about the instance changes.

What keeps this contained:

- **Never a host of this Lager.** The default exists because instances are same-site. So every host Lager serves is refused: the apps domain and everything under it, every custom domain of an instance, and the platform host. The check runs when a website is added *and* on every response, so a website that later becomes a custom domain stops counting at once (the instance page marks it, and it can still be removed). Instances therefore still cannot frame each other, which is the whole of what the header protected.
- **On another site the frame is a guest.** The session cookie is `SameSite=Lax`. Browsers send no `Lax` or `Strict` cookie into a frame whose ancestors are a different site, neither with the page nor with its own requests (the "site for cookies" of a nested frame is cross-site), and the platform's sign-in pages refuse every frame (`frame-ancestors 'none'`), so no sign-in can start inside it. The framed instance gets exactly what a guest gets on its own address: what the visibility and the `anyone` rules allow. A website that tricks a visitor into clicks in the frame gains nothing a guest could not do by opening the page. It cannot read the frame either: the same-origin policy is untouched.
- **Fetch metadata still holds.** The event streams and `/_blob/…` refuse requests marked cross-site (0003). The framed page's own requests are `same-origin` to it, so the app works; another website still cannot open those routes directly.
- **The owner decides, per instance.** A deploy can only declare that an app is embeddable. It opens nothing until someone who manages the instance names a website, so a publisher cannot make somebody else's instance frameable. Only exact web origins are taken (`*`, patterns and paths are refused), at most 20.
- **Storage is partitioned.** Current browsers keep `localStorage` and similar storage of a frame apart per top-level site, so an embedding sees nothing the instance stored on its own address.

Alternatives that lost:

- *Websites in the declaration* (`{"embed": {"origins": [...]}}`), like ingest's `origins`. A publisher deploying to instances that belong to others would open their frames for them; and the apps that need this (a comment system, a poll) are deployed once and used on many blogs. Kept out for now; it can be added like 0017's amendment did the other way round.
- *Allowing only `https:`.* Ingest takes `http:` too, and local development needs it. A network attacker who can change an `http:` page can already show the instance there by linking to it; inside the frame they still only get a guest.
- *`frame-ancestors` for every public instance, `*`.* It would undo the reason for the header: other instances would be allowed again.
- *Refusing every website on the same registrable domain as the apps domain.* Lager does not ship the Public Suffix List and cannot tell `blog.example.com` from a website on another site reliably; the operator's guide already recommends putting the apps domain on that list. Such a website gets the visitor's sign-in inside the frame, so the instance page says to name only websites the manager controls.
- *Doing it in the proxy or CDN.* Possible today, but it applies to the whole host and every app, cannot tell other instances from the owner's blog, and is invisible to the people who manage the instance.

## Consequences

- Apps for comments, polls, forms and guestbooks on static websites need no second server. Lager's guide tells assistants to ask for the website, give the user a snippet, and keep moderation on the app's own address.
- The platform database moves to schema version 5 (`embed_origins`), gone with the instance.
- Code that sets headers on instance pages must take `frame-ancestors` from `Embed.frameAncestors`; a new host that Lager serves must be covered by `Embed.isLagerHost`.
- An embedding website on the same site as the apps domain does pass the visitor's sign-in into the frame; that is the manager's choice and is documented.
- `X-Frame-Options` is missing on instances that name websites. Browsers that know only that header and not `frame-ancestors` are long out of support.
