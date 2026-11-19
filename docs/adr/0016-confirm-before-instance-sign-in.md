# 0016. A visitor confirms before an instance learns who they are

- Status: Proposed
- Date: 2026-11-19

## Context

The handshake of 0005 signs a visitor in to an instance with two redirects and no click. The platform issued the code whenever the visitor's level on the instance was not `none`, and that is true for every signed-in account on every instance that is public or open to all signed-in users. So any publisher could put a public app online, send its visitors through `/auth/instance` and read their user id and name, and their email address if the app declares `user.scopes: ["email"]`, without the visitor doing or noticing anything. Apps are code nobody reviewed; who visits is personal data.

## Decision

The platform asks before the first sign-in to an instance that the visitor neither owns nor maintains. The page names the app, its host and the account, says what the app will see (the name, and the email address if the active version asks for it), and offers Cancel and Continue. No code is issued before Continue, which is a form post with the account's form token.

- The answer is stored per account and instance in `instance_signins`, with whether it covered the email address, and is asked once. Rows go with the instance and the account (foreign keys with `ON DELETE CASCADE`).
- If the app later starts to declare the email scope, the stored answer does not cover it: the question comes again at the next sign-in, and until then the instance does not get the address of that account, neither as the viewer nor in profiles. (The search among the people an instance is shared with still shows their addresses to an app that declared the email scope; that is unchanged.)
- Not asked: the owner of the instance, and the owner and collaborators of the app. They run the app themselves.
- Asked like everyone else: accounts the instance is shared with, directly or through a group. A share is made by whoever manages the instance, and that may be the publisher of the app: if a share answered the question, a publisher could share an app with somebody's address and learn from the sign-in who is behind it.
- Cancel leads back to a public instance, which serves anonymous visitors, and to the platform for an instance open to signed-in users, which would only redirect back to the question.

Alternatives that lost: asking every time (people stop reading a page they see daily); asking only for the email address (the name and a stable id already identify a person); an anonymous id per instance (apps could no longer show who wrote what, which shared apps are for).

## Consequences

- A public app cannot identify its signed-in visitors silently. The first visit costs them one click.
- People an instance is shared with see the question once as well, although its owner named them. Code that signs someone in to an instance, or hands an instance a name or address, must go through `Access.signInConfirmed`.
- A visitor whose instance session is still valid when the app starts to ask for the address is not asked until that session ends; the app sees no address for them until then.
- Sessions on instances that existed before this decision are not asked again for the name they already share.
