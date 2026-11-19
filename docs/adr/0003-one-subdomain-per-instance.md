# 0003. One subdomain per instance, routed by host name

- Status: Accepted
- Date: 2026-11-11

## Context

Apps are pages that nobody reviewed. If two apps shared an origin, one could read the other's cookies, storage and service workers, and an app on the platform origin could act as the signed-in user.

## Decision

Every instance gets its own host name, `<slug>.<LAGER_APPS_DOMAIN>`, and the platform (sign-in, dashboard, REST API, MCP endpoint) has another one, from `LAGER_PUBLIC_URL`. One HTTP service on one port decides by the host name what to serve. TLS is the reverse proxy's job, which needs wildcard DNS and a wildcard certificate for the apps domain. An instance can additionally answer on custom domains, which follow the same rules.

## Consequences

- The browser's same-origin policy isolates apps from each other and from the platform without extra code.
- Endpoints that use cookies (the data streams, `/_blob/…` files) also refuse requests that the browser marks as cross-site or coming from another instance.
- Operators need a wildcard certificate, which requires a DNS challenge. The installation guide explains this.
- A deleted instance's slug stays reserved for its former owner, so that browser data of the old origin never passes to someone else.
- On a public server, the apps domain belongs on the Public Suffix List, so that browsers treat every subdomain as its own site.
