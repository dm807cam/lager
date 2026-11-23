# 0019. Two-step sign-in with TOTP and recovery codes, gated before the session

- Status: Proposed
- Date: 2026-11-21

## Context

An account was protected by its password alone. A password that leaks (reused elsewhere, phished, read over a shoulder) opened everything the account can reach: the dashboard, every instance it may enter (0005), and new MCP connections through OAuth (0008), which can deploy apps. Administrators can do far more. The limits on signing in slow down guessing, but they do nothing against a password that is already known.

Every way into an account starts from the platform session: the dashboard and the administration area read it, `/auth/instance` issues instance codes from it, and the OAuth consent page requires it. So the session is the one place to gate.

Constraints: one process and SQLite (0002), no new dependency without discussion, no outside service, and every authenticator app must work.

## Decision

Lager offers two-step sign-in per account: after the password, a time-based one-time code (TOTP, RFC 6238: HMAC-SHA-1, 6 digits, 30 seconds, the parameters every authenticator app supports) or one of 10 single-use recovery codes.

**Signing in.** When the password is right and the account has two-step sign-in on, `/login` issues no session and no device cookie. It sets a host-only, HttpOnly cookie (`__Host-lager_2fa` over https) with a signed token that names the account, its session epoch, a digest of its password hash, a random id and the return path, valid for 5 minutes, and redirects to `/login/two-factor`. That page takes the code, behind the same-origin check of the login form. Only a right code issues the session and the device cookie. The token is worth nothing once the password changes, the epoch moves on (sign-out everywhere, disabling) or the second step is turned off; one token finishes one sign-in and tries at most 3 codes.

**Codes.** A code is accepted for the current time step and one step on either side. The newest step that was accepted is stored, and only later steps are accepted afterwards, with a conditional `UPDATE`, so a code cannot be used twice, not even by two requests at the same moment. The count of wrong codes is written the same way, conditional on the values it was computed from. The three candidate steps are all compared, in constant time.

**Limits.** Whoever reaches the second step knows the password, so the count of wrong codes is the only barrier left. It is kept per account in the database (`user_two_factor`), whatever browser or address the codes come from, and survives a restart: 5 wrong codes in a row pause the second step for 1 minute, then 5 and 30 minutes, 2 and 8 hours, and at most 24 hours. Nothing is looked at or counted during a pause. A right code ends the run but not the length of the next pause, so the owner signing in now and then does not hand an attacker short pauses again; each full day without wrong codes, counted from the end of the last pause, takes the length back one step, never more. A test simulates a year of attacker rhythms (bursts of pauses with quiet days between, or guessing the moment each pause ends): none gets more than about 5 codes a day looked at, against a probability of 3 in 10⁶ each. (A first draft reset the length to the first step after a quiet day; four pauses and a day of waiting then gave about 18 guesses a day.) The owner gets a mail each time a pause starts, so a leaked password is noticed and changed; the in-memory per-sign-in and per-address limits come on top.

**Storage.** The 160-bit secret is encrypted with AES-256-GCM under a key derived with HKDF from the server secret (separate from the session and AI-key keys), with the account id as additional data, so a copy of the database does not reveal it and a secret moved into another account's row does not decrypt. Recovery codes (60 random bits each) are stored as HMAC-SHA-256 under another derived key, also bound to the account, so a stolen database cannot be searched for them offline. The secret is shown once during setup and never again.

**Changes.** Turning it on needs the current password, then a code from the new secret within 15 minutes. The page that shows the secret carries a signed form token bound to the account, its epoch and a digest of the pending setup; without it the secret is never shown again and the setup cannot be confirmed, so a session taken from elsewhere cannot read the key of a setup the owner started and enrol its own second factor. Confirming ends the account's sessions in other browsers, its OAuth grants and its API tokens, all of which were obtained with the password alone, and gives this browser a fresh session. Turning it off and creating new recovery codes need the password and a code. The owner gets a mail for every change and for every recovery code used; these mails are never held back by the mail budget, since each needs the password, a session or an administrator.

**Recovery.** A password reset through the mailbox does not turn two-step sign-in off: the mailbox must not be a way around it. An administrator can turn it off for another account after confirming with their own password, and their own code if they use two-step sign-in; it ends that account's sessions, OAuth grants and API tokens and mails its owner. Without that confirmation an open admin session could remove any other administrator's second factor and, with a reset link, take over the account. Not for their own account at all: they use the account page, with a code.

Alternatives that lost:

- **WebAuthn / passkeys** resist phishing, which TOTP does not, but need CBOR and COSE parsing and attestation handling, either a sizeable new dependency or a lot of security-critical code. A good next step on top of this decision, not instead of it.
- **Codes by mail** add nothing when the mailbox is also how the password is reset, and depend on SMTP being set up.
- **"Remember this browser for 30 days"** would make a stolen device cookie as good as the second factor. Not offered.
- **Keeping the count of wrong codes in memory**, like the password limits: a restart would reset it, and the password is already known at this step.
- **A QR code on the setup page** needs an encoder; Lager has no dependency for one and does not want an outside service to render it. The `otpauth://` link opens the app on the same device, and the key can be typed elsewhere. To be revisited.

## Consequences

- With two-step sign-in on, a leaked password alone opens nothing: no session, no instance, no new OAuth connection. API tokens are revoked when it is turned on, as after a password change, so a token minted with a leaked password before does not outlive it.
- TOTP codes can still be phished in real time by a page that relays them; phishing-resistant sign-in needs WebAuthn.
- Replacing the server secret (already said to sign everyone out and lose AI provider keys) also makes existing second factors unusable, recovery codes included, since their hash is keyed with it; an administrator then turns them off per account, and a sole administrator only at the database. Backups of the data directory must keep `secret.key` with them.
- A pause applies to the owner as well: someone who knows the password can keep the second step paused (at most a day per 5 codes). The owner's way out is a new password, after which the attacker no longer reaches the second step, and the pause runs out, or an administrator. Exempting the owner's known browsers was left out: a stolen device cookie with the password would then bypass the count.
- The per-address limit (30 codes in 15 minutes) is shared by everyone behind one address; the account-wide count is what protects an account.
- Any new code path that issues a platform session must check `TwoFactor.isEnabled` first and go through the second step. Today only `/login` issues one for an existing account without a session; registration creates accounts without a second factor, and the account page reissues a session only to a browser that already has one.
- The platform database gains `user_two_factor` and `user_recovery_codes` (schema version 6); both go with the account.
