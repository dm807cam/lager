# Users and sharing

Accounts, roles, registration, groups and the ways to share an app.

## Accounts and roles

Lager has several accounts. Each account has exactly one role:

| Role | May |
| --- | --- |
| Administrator | Manage users, roles, invitations, groups and settings, disable instances, create reset links; also everything a publisher may do |
| Publisher | Deploy apps (dashboard, REST API, MCP), create API tokens, create instances of their apps for other accounts, maintain apps together with other publishers or administrators (collaboration) |
| User | Open instances that are shared with them or open to all signed-in users; create their own instances of apps that allow self-service |

How an account comes into being depends on the registration mode, which an administrator sets in the administration area under Settings:

- **Open:** Anyone can create a user account at `/register`.
- **Invitation only:** Registering works only through an invitation link.
- **Closed:** Nobody can register; invitation links do not work either.

The default depends on mail: if `LAGER_SMTP_URL` is set, registration is open, otherwise invitation only. Once an administrator has saved a mode, that choice applies.

An administrator creates invitations in the administration area (Invitations), with a role and optionally an email address that the link is bound to. The link is valid for 7 days and works once. Whoever creates an account through it is signed in immediately. Passwords need at least 10 characters.

Lager creates the first administrator at startup from `LAGER_ADMIN_EMAIL` and `LAGER_ADMIN_PASSWORD`, but only while there is no account at all. You appoint further administrators by changing the role of an existing account. The last active administrator can be neither demoted nor disabled. A disabled account can no longer sign in, and its sessions on the platform and on instances end immediately.

The interface shows administrators metadata only: which apps and instances exist, who owns them and how much storage they use. They can disable an instance, but the interface offers no way to open the data of someone else's instance; they cannot open another account's private instance, and they read data only if they have been granted a level, like any other account. This is a default of the interface, not a technical guarantee against a malicious administrator: administrators control the accounts (links to reset passwords, group memberships) and have access to the server and the data directory. Give the administrator role only to people whose access to the data of all instances you would accept.

## Sharing

There are two ways to let others use an app:

- **The same instance:** Everyone works in the same data. The owner of the instance shares it: with single accounts (by email address), with groups, or through the visibility "all signed-in users" or "public". This works on the instance page in the dashboard, through `PUT /api/instances/<slug>/grants` with `{"email": …, "level": …}` or `{"group": …, "level": …}`, and through the MCP tools `share_instance`, `unshare_instance` and `list_shares`.
- **A separate instance:** Everyone gets their own instance of the same app with separate data. A publisher can create instances for other accounts. In addition, the owner of an app can allow all signed-in users to create an instance themselves (the self-service setting on the app page); they then find the app in the catalog on their overview page and own their instance.

The levels on an instance:

| Level | May |
| --- | --- |
| Viewer (`view`) | Open the app and read data; a viewer stores nothing, not in their private area (`data/users/<id>/…`) either |
| Contributor (`interact`) | additionally write data, as far as the app's rules allow |
| Manager (`admin`) | additionally manage grants, visibility and versions, and see the snapshots |
| Owner (`owner`) | everything, and restore a snapshot or delete the instance; cannot be granted |

With several routes to the same instance (direct grant, group, visibility "all signed-in users"), the highest level applies. For "all signed-in users" the owner chooses whether these accounts are viewers or contributors (default: contributors). Without app rules, everyone from viewer level reads and everyone from contributor level writes; public visitors can never write.

Administrators create groups in the administration area (Groups) and fill them with accounts. A grant to a group applies to all its members.

An app itself, that is its versions, can be seen and changed only by its owner and the collaborators the owner adds on the app page (administrators or publishers).

## "Made with Lager"

People who open an app that was shared with them, and visitors of public instances, see a small "Made with Lager" link in a corner of the app, in their language. It leads to the Lager project and tells them where the app comes from. It carries no tracking.

- **Who sees it:** everyone on the instance below manager level. The owner and managers of the instance never see it when they are signed in on it. On a public instance, a visitor who has not signed in on the instance (you too, when you just open the link) counts as a public visitor.
- **Hiding it as a viewer:** the × closes it. The browser remembers this for that app on that device.
- **Turning it off for one instance:** the owner or a manager unticks "Show the “Made with Lager” badge" on the instance page, or sends `POST /api/instances/<slug>/badge` with `{"on": false}`.
- **Turning it off for the whole server:** an administrator unticks "Allow the badge in apps" under Administration → Settings. No app on the server shows it then, and the instance switch disappears.

The badge is drawn in its own shadow root, so the app's styles cannot change it and it cannot change the app. It sits above the home-screen safe area and is hidden when the page is printed.
