# Users and sharing

Accounts, roles, registration, groups and the ways to share an app.

## Accounts and roles

Lager has several accounts. Each account has exactly one role:

| Role | May |
| --- | --- |
| Administrator | Manage users, roles, invitations, groups and settings, disable instances, create reset links; also everything a publisher may do |
| Publisher | Deploy apps (dashboard, REST API, MCP), create API tokens (only publishers and administrators can; other accounts can still list and revoke tokens they already have), create instances of their apps for other accounts, maintain apps together with other publishers or administrators (collaboration) |
| User | Open instances that are shared with them or open to all signed-in users; create their own instances of apps that allow self-service |

How an account comes into being depends on the registration mode, which an administrator sets in the administration area under Settings:

- **Open:** Anyone can create a user account at `/register`.
- **Invitation only:** Registering works only through an invitation link.
- **Closed:** Nobody can register; invitation links do not work either.

The default depends on mail: if `LAGER_SMTP_URL` is set, registration is open, otherwise invitation only. Once an administrator has saved a mode, that choice applies.

An administrator creates invitations in the administration area (Invitations), with a role and optionally an email address that the link is bound to. The link is valid for 7 days and works once. An invitation with an address was sent to that mailbox, so whoever creates the account through it is signed in immediately. An invitation without an address proves no mailbox: the new account gets the role, and confirms its email address like any other registration before it can sign in. Without mail (no `LAGER_SMTP_URL`) nothing is confirmed, and both kinds sign in immediately.

To confirm an email address, the new account opens the link from the mail and enters the password chosen at registration. Whoever forgot it uses "Forgot your password?": setting a new password through the reset link confirms the address as well. The link alone confirms nothing, so nobody can register someone else's address and have its owner confirm it for them.

Passwords need at least 10 characters and may have at most 1024. Changing or resetting a password signs out every other device, disconnects all AI assistants and revokes all API tokens of the account.

With mail configured, the registration form does not say whether an address already has an account: it answers "check your mail" either way, and the owner of a taken address gets a mail that says someone tried to register with it, with the links to sign in and to set a new password. Without mail the form names the taken address, because there is no other way to tell the visitor.

### Limits on signing in and registering

These limits are fixed; they are not settings.

- **Per client address:** 10 failed sign-ins in 15 minutes, and 5 registrations, 5 password-reset requests and 5 requests for a new confirmation mail per hour. An IPv6 address counts as its /64 network, so changing addresses inside one network does not help.
- **Per account:** after 10 failed sign-ins in a row, from whatever addresses, the account pauses: further attempts are turned away for 30 seconds, then twice as long after each further failure, up to 15 minutes. The answer is the one a wrong password gets, also for addresses without an account. A correct password ends the count, and so do 15 quiet minutes. A browser that has signed in to the account before is not paused (it carries a cookie that says so), so somebody guessing at your account does not keep you out of it on your own devices. On a new device you wait for the pause to end, or set a new password with "Forgot your password?", which ends it at once.
- **For the whole server:** 30 self-registrations per hour (registrations through an invitation do not count), and 60 confirmation, password-reset and "someone tried to register" mails per hour (invitation mails do not count). Beyond that, the forms answer "Too many requests" until the hour has passed. This keeps a flood of registrations from sending mail without end from your mail account.

Lager creates the first administrator at startup from `LAGER_ADMIN_EMAIL` and `LAGER_ADMIN_PASSWORD`, but only while there is no account at all. You appoint further administrators by changing the role of an existing account. The last active administrator can be neither demoted nor disabled. A disabled account can no longer sign in, and its sessions on the platform and on instances end immediately.

The interface shows administrators metadata only: which apps and instances exist, who owns them and how much storage they use. They can disable an instance, but the interface offers no way to open the data of someone else's instance; they cannot open another account's private instance, and they read data only if they have been granted a level, like any other account. This is a default of the interface, not a technical guarantee against a malicious administrator: administrators control the accounts (links to reset passwords, group memberships) and have access to the server and the data directory. Give the administrator role only to people whose access to the data of all instances you would accept.

## Sharing

There are two ways to let others use an app:

- **The same instance:** Everyone works in the same data. The owner of the instance shares it: with single accounts (by email address), with groups, or through the visibility "all signed-in users" or "public". This works on the instance page in the dashboard, through `PUT /api/instances/<slug>/grants` with `{"email": …, "level": …}` or `{"group": …, "level": …}`, and through the MCP tools `share_instance`, `unshare_instance` and `list_shares`.
- **A separate instance:** Everyone gets their own instance of the same app with separate data. A publisher can create instances for other accounts. In addition, the owner of an app can allow all signed-in users to create an instance themselves (the self-service setting on the app page); they then find the app in the catalog on their overview page and own their instance.

The levels on an instance:

| Level | May |
| --- | --- |
| Viewer (`view`) | Open the app and read data. By default a viewer writes nothing; an app's rules can open single paths to viewers, but never the private area (`data/users/<id>/…`): writing there always takes contributor level. Viewers can still delete their own private data |
| Contributor (`interact`) | additionally write data, as far as the app's rules allow |
| Manager (`admin`) | additionally manage grants, visibility and versions, and see the snapshots |
| Owner (`owner`) | everything, and restore a snapshot or delete the instance; cannot be granted |

With several routes to the same instance (direct grant, group, visibility "all signed-in users"), the highest level applies. For "all signed-in users" the owner chooses whether these accounts are viewers or contributors (default: contributors). Without app rules, everyone from viewer level reads and everyone from contributor level writes; public visitors can never write.

The first time someone opens an instance that they reach only through its visibility ("public" or "all signed-in users"), Lager asks before it signs them in there: "Continue to *app* as *name*?", with what the app will see: the name, and the email address if the app asks for it (`user.scopes: ["email"]`). Lager remembers the answer per account and instance and asks once. If the app later starts to ask for the email address, it keeps the address back from the app until the person has been asked again at their next sign-in to the instance. Cancel signs nobody in: a public instance then opens as for any anonymous visitor. The owner, the people and groups the instance is shared with, and the owner and collaborators of the app are not asked. Without this question, any publisher's public app could send a signed-in visitor through the sign-in and learn who they are without the visitor doing anything.

Administrators create groups in the administration area (Groups) and fill them with accounts. A grant to a group applies to all its members.

An app itself, that is its versions, can be seen and changed only by its owner and the collaborators the owner adds on the app page (administrators or publishers).

## "Made with Lager"

People who open an app that was shared with them, and visitors of public instances, see a small "Made with Lager" link in a corner of the app, in their language. It leads to the Lager project and tells them where the app comes from. It carries no tracking.

- **Who sees it:** everyone on the instance below manager level. The owner and managers of the instance never see it when they are signed in on it. On a public instance, a visitor who has not signed in on the instance (you too, when you just open the link) counts as a public visitor.
- **Hiding it as a viewer:** the × closes it. The browser remembers this for that app on that device.
- **Turning it off for one instance:** the owner or a manager unticks "Show the “Made with Lager” badge" on the instance page, or sends `POST /api/instances/<slug>/badge` with `{"on": false}`.
- **Turning it off for the whole server:** an administrator unticks "Allow the badge in apps" under Administration → Settings. No app on the server shows it then, and the instance switch disappears.

The badge is drawn in its own shadow root, so the app's styles cannot change it and it cannot change the app. It sits above the home-screen safe area and is hidden when the page is printed.
