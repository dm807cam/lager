# 0009. Accounts, roles and two ways of sharing

- Status: Accepted
- Date: 2026-11-11

## Context

Lager is for families, clubs and teams. People must be able to join, some may publish apps, and an app can be shared in two different ways: everyone in the same data (a family list), or everyone with their own copy (a training diary).

## Decision

- Accounts sign in with email and password. Registration is `open`, `invite` or `closed`; the default is `open` when mail is configured and `invite` otherwise. Without mail, invitations and password resets work through links an administrator passes on.
- Every account has one role: `admin` (users, invitations, groups, settings), `publisher` (deploy apps, create instances for others) or `user` (use what is shared, create own instances where allowed). The last active administrator can be neither demoted nor disabled.
- **Sharing the same instance:** grants to accounts or groups at `view`, `interact` or `admin`, plus the visibility (0007).
- **A separate instance:** a publisher creates one for another account, or the app's owner allows self-service, and every signed-in user can then create their own.
- An app's versions are visible and changeable only for its owner and the collaborators the owner names.
- Administrators see metadata (which apps and instances exist, owners, sizes) and can disable an instance, but the interface offers no way into the data of someone else's instance.
- Deleting moves files to a trash directory that is emptied after `LAGER_TRASH_DAYS`.

## Consequences

- People without an AI subscription can use and share apps; only publishers need an assistant.
- The administrator boundary is a property of the interface, not a technical guarantee: administrators run the server. The documentation says so plainly.
