# 0005. A session per host, created by a redirect handshake

- Status: Accepted
- Date: 2026-11-11

## Context

Instances live on their own host names (0003), so a platform cookie cannot reach them, and a cookie shared across the apps domain would undo the isolation between apps.

## Decision

The platform keeps its own session cookie. Every instance host has its own session cookie, valid for that host only. It is created by a handshake: the instance redirects to the platform (`/auth/instance`), the platform checks the platform session and the visitor's access, then redirects back to the instance (`/__lager/callback`) with a signed code. The code is valid for 60 seconds, once, and only for that host name. Custom domains use the same handshake.

Sessions are signed tokens that carry the account's session epoch. Signing out, changing the password, a password reset and disabling the account raise the epoch, which ends every session of the account at once, on the platform and on every instance.

## Consequences

- A cookie or code for instance A is worthless on instance B and on the platform.
- A visitor signs in once on the platform and then passes each new host with a redirect.
- Lager does not verify who owns a custom domain. Whoever may add domains can point any host name that resolves to the proxy at an instance, so the right to add domains belongs to administrators by default.
