# 0010. Pages that save themselves get versions of their own instance

- Status: Accepted
- Date: 2026-11-11

## Context

Some apps edit their own HTML: a note page that saves its text into itself, a page builder. Writing that back as an ordinary deploy would change the app for every instance and could be overwritten by the next deploy.

## Decision

With the `page` capability, `page.publish(html)` saves a complete HTML document as a new version that belongs to that instance only and becomes active there at once. Only managers and owners of the instance may save. A save based on an outdated version fails with `conflict`, and every open view reloads after a successful save. The instance stops following deploys until someone turns automatic updates back on. Self-saved versions never count as the app's latest version and cannot be activated on other instances. At most 60 saves per hour and instance, and the last 20 self-saved versions are kept.

## Consequences

- A deploy never overwrites what an instance saved itself. The deploy result lists such instances as `pinned`.
- Self-saved pages count toward the instance's storage quota, and only the instance's managers can download them.
