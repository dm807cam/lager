# 0018. Websites outside Lager may frame an instance its managers name them for

- Status: Proposed
- Date: 2026-11-21

## Context

Every instance page answers with `Content-Security-Policy: frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN`. The reason is written next to the header: instances under the apps domain are the same site as each other, so the browser sends an instance's `SameSite=Lax` session cookie into a frame that another instance opens. Without the header, any app on the server, code nobody reviewed, could show another instance with its visitor signed in and trick them into clicks there (clickjacking with that visitor's rights).

The header also rules out a whole kind of app: everything that is meant to sit on someone's own website. Comments under a static blog post, a poll, a booking or contact form, a guestbook. 0017 lets such a website *send* to an instance (`ingest`), but a comment box must also *show* what others wrote, and nothing on another website can read an instance: there is no CORS on the instance's routes, and ingest endpoints only append. The data is there, the rules for guests are there (`"write": "anyone"`), only the frame is closed. The workarounds people reach for are worse than a narrow door: rewriting the header in a proxy or CDN for the whole host (which also opens the frame to other instances and to every website), or a second server that copies the data out.

## Decision

An app declares `embed` (`{"embed": {}}`) when it is built to be framed. The declaration carries no websites. The people who manage an instance (`admin` and the owner) add the websites on the platform's instance page. While the active version declares `embed`, the instance page answers with `frame-ancestors 'self' <websites>`. `X-Frame-Options: SAMEORIGIN` stays: Chrome, Firefox and Safari (WebKit since 2019) ignore it when the policy has `frame-ancestors`, and a browser that knows only the older header keeps the old protection instead of none. Nothing else about the instance changes.

The app itself can read the list and remove websites (`lager.use("embed")`: `get()`, `setOrigins(origins)` with a list that only drops some, `PUT /__lager/embed/origins` with the `X-Lager-Request` header and the viewer's write budget), and `get()` gives the people who manage the instance `manageUrl`, the instance page, to link to. It cannot add a website. The app's code runs with the rights of whoever opens it: if it could add, the publisher's code would choose who may frame an instance every time a manager opened it, without a step the manager sees. The instance page is out of the app's reach (another origin, CSRF tokens, `frame-ancestors 'none'`).

What keeps this contained:

- **Never a host of this Lager.** The default exists because instances are same-site. So every host Lager serves is refused: the apps domain and everything under it, every custom domain of an instance, and the platform host.
- **Never a website on Lager's domain.** If the apps domain is not on the Public Suffix List, which is the normal state on a LAN, a Raspberry Pi or many self-hosted servers, a website on the same registrable domain is the same site, and the browser *would* send the session cookie into its frame. Lager ships no PSL, so it guesses the registrable domain of the apps domain and of the platform host: the last two labels, or three under a country code with a common second level (`example.co.uk`). Everything under either guess is refused (`origin_same_site`). With `apps.example.com` that is everything under `example.com`; with `apps.lager.fritz.box` everything under `fritz.box`, so `nas.fritz.box` too. Under a private suffix such as `duckdns.org` the guess is too short and refuses more than needed, which errs on the safe side.
- **Checked on every response.** Both checks run when a website is added *and* on every response (`Embed.frameAncestors`), as does a check that a stored entry is exactly an origin. A website that later becomes a custom domain, or the same site after a configuration change, stops counting at once (the instance page marks it, and it can still be removed). Instances therefore still cannot frame each other, which is the whole of what the header protected.
- **On another site the frame is a guest.** The session cookie is `SameSite=Lax`. Browsers send no `Lax` or `Strict` cookie into a frame whose ancestors are a different site, neither with the page nor with its own requests (the "site for cookies" of a nested frame is cross-site), and the platform's sign-in pages refuse every frame (`frame-ancestors 'none'`), so no sign-in can start inside it. The framed instance gets exactly what a guest gets on its own address: what the visibility and the `anyone` rules allow. A website that tricks a visitor into clicks in the frame gains nothing a guest could not do by opening the page. It cannot read the frame either: the same-origin policy is untouched. A headless Chrome run confirmed it: an owner signed in on the instance was a guest inside a frame on another site in the same browser, while an unlisted website and another instance were blocked.
- **Fetch metadata still holds.** The event streams and `/_blob/…` refuse requests marked cross-site (0003). The framed page's own requests are `same-origin` to it, so the app works; another website still cannot open those routes directly.
- **People decide, per instance.** A deploy can only declare that an app is embeddable, and the app's code can only remove. Only someone who manages the instance, on the platform's own page, can open a frame. Only exact web origins are taken (`*`, patterns and paths are refused), at most 20.
- **Storage is partitioned.** Current browsers keep `localStorage` and similar storage of a frame apart per top-level site, so an embedding sees nothing the instance stored on its own address.

Alternatives that lost:

- *Websites in the declaration* (`{"embed": {"origins": [...]}}`), like ingest's `origins`. A publisher deploying to instances that belong to others would open their frames for them; and the apps that need this (a comment system, a poll) are deployed once and used on many blogs.
- *Adding from the app, as `ingest.setOrigins` can.* It reads well, because the owner adds their blog where they use the app. But for ingest an added website can only send; here it would choose who frames the instance, and the app's code could do it whenever a manager opens it. Removing cannot open anything, so the app may do that.
- *Dropping `X-Frame-Options` when websites are named,* as first built, because it cannot list them. Browsers that implement `frame-ancestors` ignore it anyway, and those that do not would otherwise be left with no protection at all, also against other instances.
- *Only warning about websites on Lager's domain,* or refusing them only one level above the apps domain. A hint is not a guard, and one level up misses the LAN case (`nas.fritz.box` next to `apps.lager.fritz.box`).
- *Shipping the Public Suffix List.* It is large, changes often, and the guess errs only towards refusing too much.
- *Allowing only `https:`.* Ingest takes `http:` too, and local development needs it. A network attacker who can change an `http:` page can already show the instance there by linking to it; inside the frame they still only get a guest.
- *`frame-ancestors` for every public instance, `*`.* It would undo the reason for the header: other instances would be allowed again.
- *Doing it in the proxy or CDN.* Possible today, but it applies to the whole host and every app, cannot tell other instances from the owner's blog, and is invisible to the people who manage the instance.

## Consequences

- Apps for comments, polls, forms and guestbooks on static websites need no second server. Lager's guide tells assistants to ask for the website, give the user a snippet, link the owner to the instance page to add it, and keep moderation on the app's own address.
- Adding a website takes a visit to the instance page; the app can only show the list and remove from it.
- A website on the same registrable domain as the server cannot embed an instance. Where the guess refuses a website that is in fact another site (a private suffix), the instance has to be served from another domain.
- The platform database moves to schema version 5 (`embed_origins`), gone with the instance.
- Code that sets headers on instance pages must take `frame-ancestors` from `Embed.frameAncestors`; a new host that Lager serves must be covered by `Embed.isLagerHost`.
