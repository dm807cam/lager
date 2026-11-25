# Users and sharing

Accounts, roles, registration, groups and the ways to share an app.

## Accounts and roles

Lager has several accounts. Each account has exactly one role:

| Role | May |
| --- | --- |
| Administrator | Manage users, roles, invitations, groups and settings, disable instances, create reset links, turn off another account's two-step sign-in; also everything a publisher may do |
| Publisher | Deploy apps (dashboard, REST API, MCP), create API tokens (only publishers and administrators can; other accounts can still list and revoke tokens they already have), create instances of their apps for other accounts, maintain apps together with other publishers or administrators (collaboration) |
| User | Open instances that are shared with them or open to all signed-in users; create their own instances of apps that allow self-service |

How an account comes into being depends on the registration mode, which an administrator sets in the administration area under Settings:

- **Open:** Anyone can create a user account at `/register`.
- **Invitation only:** Registering works only through an invitation link.
- **Closed:** Nobody can register; invitation links do not work either.

The default depends on mail: if a mail server is set up at startup (`LAGER_SMTP_URL` or Administration → Mail), registration is open, otherwise invitation only. Saving a mail server in the administration area stores the mode in effect, so it does not change by itself. Once an administrator has saved a mode, that choice applies.

An administrator creates invitations in the administration area (Invitations), with a role and optionally an email address that the link is bound to. The link is valid for 7 days and works once. An invitation with an address was sent to that mailbox, so whoever creates the account through it is signed in immediately. An invitation without an address proves no mailbox: the new account gets the role, and confirms its email address like any other registration before it can sign in. Without mail (no mail server set up) nothing is confirmed, and both kinds sign in immediately.

To confirm an email address, the new account opens the link from the mail and enters the password chosen at registration. Whoever forgot it uses "Forgot your password?": setting a new password through the reset link confirms the address as well. The link alone confirms nothing, so nobody can register someone else's address and have its owner confirm it for them.

Passwords need at least 10 characters and may have at most 1024. Changing or resetting a password signs out every other device, disconnects all AI assistants and revokes all API tokens of the account.

With mail configured, the registration form does not say whether an address already has an account: it answers "check your mail" either way, and the owner of a taken address gets a mail that says someone tried to register with it, with the links to sign in and to set a new password. Without mail the form names the taken address, because there is no other way to tell the visitor.

### Two-step sign-in

Every account can add a second step to signing in, on its account page under **Two-step sign-in**. After the password, Lager then asks for a 6-digit code from an authenticator app on the phone (any app that supports time-based codes, TOTP, works). Somebody who learns the password still cannot get in. We recommend it for every administrator and publisher.

**Turning it on.** Enter your current password and choose "Set up two-step sign-in". Lager shows a key: on the same device, "Open in authenticator app" adds it directly; on another device, type the key into the app (time-based, 6 digits, 30 seconds). Enter the code the app shows to confirm. Until that code is accepted nothing changes, and the key expires after 15 minutes. The key and the confirmation belong to the page that showed them: another browser signed in to the same account cannot see the key or confirm the setup. When it is on:

- Lager shows **10 recovery codes**, once. Each signs you in one time if you cannot use the app. Save them in a password manager or print them. They can be replaced with new ones (password and a code needed); the old ones then stop working, and you get a mail about it.
- Every other browser is signed out, connected AI assistants are disconnected and the account's API tokens are revoked, because all of them were obtained with the password alone. Create new tokens afterwards where you need them.
- You get a mail.

**Signing in.** After the right password the browser has 5 minutes to enter a code; the password alone gives no session. A code from the app works once, and a code from the 30 seconds before or after is accepted too, for clocks that are a little off. Signing in on two devices one after the other within the same 30 seconds therefore needs the next code on the second device; the code already used counts as a wrong one. Instead of a code you can enter a recovery code; you get a mail whenever one is used.

**Limits.** One sign-in may try 3 codes, then the password has to be entered again. Per account, from whatever browser or address, 5 wrong codes in a row pause the second step: for 1 minute, then 5 and 30 minutes, 2 and 8 hours, and at most a day. During a pause no code is accepted, also not the right one, and nothing is counted. A right code ends the run of wrong codes but not the length of the next pause; each full day without wrong codes after a pause takes that length back one step. So however the guesses are timed, someone who knows the password gets about 5 codes a day looked at. The count is kept in the database and survives a restart. A pause also applies to the owner: if it happens to you, set a new password through "Forgot your password?" so that whoever knows the old one can no longer reach the second step, and wait for the pause to end, or ask an administrator to turn two-step sign-in off for you. Each time a pause starts, the owner gets a mail, because whoever typed the codes knew the password. Per client address, 30 codes per 15 minutes are accepted, for any accounts.

**Turning it off** needs your current password and a code (or a recovery code). You get a mail.

**Lost the phone and the recovery codes?** An administrator can turn two-step sign-in off for your account in the administration area (Users, "Turn off two-step sign-in"). They confirm with their own password, and their own code if they use two-step sign-in, so an administrator session left open is not enough. That signs the account out everywhere, disconnects its AI assistants, revokes its API tokens and sends a mail. Administrators cannot do this for their own account: they turn it off on their account page, with a code. A sole administrator who has lost both can only be helped at the server: delete the account's row from the `user_two_factor` table of `platform.sqlite` while Lager is stopped.

**Resetting the password** through "Forgot your password?" or a reset link does **not** turn two-step sign-in off: whoever controls the mailbox still needs the code.

**Keep `LAGER_SECRET` (or `secret.key`).** The key of the authenticator app is stored encrypted with a key derived from the server secret, and recovery codes only as a keyed hash. If the server secret is replaced, codes from the app and the existing recovery codes stop working; the account page says so, and an administrator turns two-step sign-in off for the account so that it can be set up again.

### Limits on signing in and registering

These limits are fixed; they are not settings.

- **Per client address:** 10 failed sign-ins in 15 minutes, and 5 registrations, 5 password-reset requests and 5 requests for a new confirmation mail per hour. An IPv6 address counts as its /64 network, so changing addresses inside one network does not help.
- **Per account:** after 10 failed sign-ins in a row, from whatever addresses, the account pauses for 30 seconds. While it is paused, every attempt from a browser the account does not know is turned away with the answer a wrong password gets (also for addresses without an account); such attempts are not counted and do not make the pause longer. When the pause is over, the account takes 10 attempts again; if they fail too, the next pause lasts 1 minute, then 2, then 5. No pause is longer than 5 minutes, each quiet 15 minutes after a pause take the next one back a step, and a correct password ends everything.
- **Your own browsers are not paused.** A browser in which you signed in, confirmed your address, or set or changed your password carries a cookie that says so, and the pause does not apply to it; the cookie stops counting when the password changes somewhere else. So somebody guessing at your account does not keep you out on your own devices. On a new browser you wait at most 5 minutes for a pause to end. If an attacker keeps guessing the moment each pause ends, use "Forgot your password?": setting a new password through the link in the mail ends the pause and makes that browser a known one, so the attack no longer concerns you there.
- **Without mail** there is no reset mail. Another administrator creates a reset link for the account in the administration area (Users); opening it has the same effect. A sole administrator who is kept out restarts the server: pauses are kept in memory only, so a restart clears them. This does not apply to the pause of [two-step sign-in](#two-step-sign-in), which is kept in the database on purpose and survives a restart.
- **For the whole server:** 30 self-registrations per hour (registrations through an invitation do not count; an attempt with an address that already has an account counts like a new one, so the limit does not reveal which it was), 60 confirmation and "someone tried to register" mails per hour, and separately 60 password-reset mails per hour, so that registrations cannot use up the reset mails. Reset mails for an account that is currently paused are sent beyond that limit, still at most 3 per hour and address. Invitation mails do not count. Beyond a limit, the forms answer "Too many requests" until the hour has passed. This keeps a flood of registrations from sending mail without end from your mail account. Lager also checks at most 2 passwords at the same time and lets 32 more sign-ins wait; one beyond that is told that the server is busy and asked to try again in a moment. Setting a password (reset link, account page, registration) and a sign-in from a browser the account knows go ahead of that queue (at most 64 of them wait), so a flood of guesses does not hold them up. A known browser gets this for one sign-in per account at a time, and no longer after 3 wrong passwords in a row from known browsers of that account, until a correct password or a new one; such sign-ins are not refused, they wait in the ordinary queue. A link or invitation that is posted several times at once is processed once; the other requests are asked to try again.

Lager creates the first administrator at startup from `LAGER_ADMIN_EMAIL` and `LAGER_ADMIN_PASSWORD`, but only while there is no account at all. You appoint further administrators by changing the role of an existing account. The last active administrator can be neither demoted nor disabled. A disabled account can no longer sign in, and its sessions on the platform and on instances end immediately.

**Deleting an account.** An administrator can remove a disabled account for good: disable it first, then choose "Delete account" in the administration area (Users). Nobody can delete their own account, and since only a disabled account can be deleted, the last active administrator always stays. The confirmation page lists the apps and instances the account owns and asks what becomes of them:

- **Hand everything over to another account** (the default, preset to the administrator who deletes): apps and instances change owner as they are, with their data, uploads, versions, custom domains and the shares given to other people. The new owner must be an active account, and an administrator or a publisher if apps are among them. The new owner's limit of instances is not checked here.
- **Delete them:** apps and instances are removed the way their owner would remove them, and their files and data go to the [trash](data-and-backup.md#deleting-and-trash). This is refused while other people have instances of one of the account's apps, because those instances would lose their app; hand the apps over instead.

To confirm, the administrator types the account's email address. Lager then removes the account together with its sessions, API tokens, connected AI assistants, pending reset and confirmation links, the invitations it issued, the shares given to it, its group memberships, its collaborator entries, its agreements to sign in to instances, its two-step sign-in and its AI group, in one step: either all of it happens or none. Afterwards Lager removes the person's private area (the documents under `data/users/<their id>/`, which nobody else can read) from every other instance, so it no longer counts against those instances' storage. This runs in the background after the Users page has confirmed the deletion, a few instances at a time, so that a server with many instances keeps answering; with more than a thousand instances it can take from seconds to a minute on a small machine. One line in the server log says when it is finished and how many documents went, or in how many instances it failed. If the server is stopped meanwhile, the pass is not continued after the restart: what it had not reached stays where it is. If the move to the trash fails, the account is deleted all the same, the Users page says so, and the server log has the details. What stays: the shared documents and the uploads the person wrote in other people's instances (their author can no longer be resolved to a name), versions they deployed to other people's apps (now attributed to the app's owner), and shares and custom domains they set up on other people's instances. Existing snapshots of those instances and the trash still contain the deleted account's private area, and restoring such a snapshot brings it back into the instance (nobody can read it there; it only takes space again). Names of instances that were deleted with the account, or by it earlier, stay reserved, for the new owner or for the administrator who deleted the account. The email address is free again afterwards. The page asks before it deletes: Cancel is its default button, and pressing Enter in a field never deletes. Deleting an account is possible only in the administration area, not through the REST API or MCP.

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

With several routes to the same instance (direct grant, group, visibility "all signed-in users"), the highest level applies. For "all signed-in users" the owner chooses whether these accounts are viewers or contributors (default: contributors). Without app rules, everyone from viewer level reads and everyone from contributor level writes; public visitors never write. The one exception is an app whose rules say `"write": "anyone"` for a path: there every visitor, signed in or not, can add new documents (an RSVP, a guestbook entry) and nothing else (see [Receiving data from outside](building-apps.md#receiving-data-from-outside)).

The first time someone opens an instance they neither own nor maintain, Lager asks before it signs them in there: "Continue to *app* as *name*?", with what the app will see: the name, and the email address if the app asks for it (`user.scopes: ["email"]`). This holds for an instance reached through its visibility ("public" or "all signed-in users") and equally for one that was shared with the person or with one of their groups: a share is the owner's decision, not the visitor's. Lager remembers the answer per account and instance and asks once. If the app later starts to ask for the email address, it keeps the address back from the app until the person has been asked again at their next sign-in to the instance. Cancel signs nobody in: a public instance then opens as for any anonymous visitor. Only the owner of the instance and the owner and collaborators of the app are not asked. Without this question, any publisher could put an app online, make it public or share it with somebody's address, send that person through the sign-in and learn who they are without their doing anything.

Administrators create groups in the administration area (Groups) and fill them with accounts. A grant to a group applies to all its members. A group can also give the instances its members own more or less storage than the server's default (see [Storage per group and per app](limits.md#storage-per-group-and-per-app)).

An app itself, that is its versions, can be seen and changed only by its owner and the collaborators the owner adds on the app page (administrators or publishers).

## "Made with Lager"

People who open an app that was shared with them, and visitors of public instances, see a small "Made with Lager" link in a corner of the app, in their language. It leads to the Lager project and tells them where the app comes from. It carries no tracking.

- **Who sees it:** everyone on the instance below manager level. The owner and managers of the instance never see it when they are signed in on it. On a public instance, a visitor who has not signed in on the instance (you too, when you just open the link) counts as a public visitor.
- **Hiding it as a viewer:** the × closes it. The browser remembers this for that app on that device.
- **Turning it off for one instance:** the owner or a manager unticks "Show the “Made with Lager” badge" on the instance page, or sends `POST /api/instances/<slug>/badge` with `{"on": false}`.
- **Turning it off for the whole server:** an administrator unticks "Allow the badge in apps" under Administration → Settings. No app on the server shows it then, and the instance switch disappears.

The badge is drawn in its own shadow root, so the app's styles cannot change it and it cannot change the app. It sits above the home-screen safe area and is hidden when the page is printed.
