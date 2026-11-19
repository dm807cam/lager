# Security policy

Lager runs code that nobody reviewed (the apps) next to accounts, sessions and data that belong to real people. We take security reports seriously and are grateful to everyone who helps keep Lager safe.

## Supported versions

Lager is young and has a single line of development. Security fixes go into `main` and the next release.

| Version | Supported |
| --- | --- |
| Latest release and `main` | ✅ |
| Older releases | ❌, please update |

## Reporting a vulnerability

**Please do not report security problems through public issues, discussions or pull requests.**

Report them privately through GitHub instead:

1. Open the [Security tab](https://github.com/dm807cam/lager/security) of this repository.
2. Choose **Report a vulnerability**.
3. Describe the problem.

Please include as much of this as you can:

- what kind of problem it is (for example instance isolation, access control, session handling, XSS, SSRF, path traversal);
- the affected version or commit and your configuration (Docker or from source, reverse proxy, custom domains);
- step-by-step instructions to reproduce it, ideally with a proof of concept;
- what an attacker could do with it, and what they need first (an account, a role, a shared instance, nothing).

## What to expect

- We confirm that we received your report **within 3 working days**.
- We assess it and keep you informed about our progress, usually at least once a week.
- We develop the fix in a private advisory, and we are happy to have you review it.
- When the fix is released, we publish a GitHub security advisory and credit you by name, unless you prefer to stay anonymous.

Please give us reasonable time to release a fix before you disclose the problem publicly. We aim for 90 days at most and are usually much faster.

## Scope

In scope is the code in this repository: the server, the browser runtime injected into apps, the MCP endpoint and its OAuth server, the Docker image and the documented default configuration.

Especially interesting:

- an app, or a visitor of an app, reading or changing data of another instance or of the platform;
- getting around access levels, grants, visibility or app data rules;
- taking over sessions or sign-in flows, including custom domains and OAuth;
- getting around limits in a way that harms other users of the same server;
- the stored API keys of language-model providers leaking.

Out of scope:

- vulnerabilities in apps that users deploy themselves;
- problems that need administrator access or access to the server or the data directory (administrators are trusted by design, see [Users and sharing](docs/users-and-sharing.md#accounts-and-roles));
- custom domains pointing to an instance without proof of ownership: this is documented behaviour, controlled by the administrator setting (see [Custom domains](docs/custom-domains.md));
- missing hardening of a reverse proxy or server that Lager does not ship;
- denial of service through sheer traffic volume, and reports produced by automated scanners without a demonstrated impact.

## Running Lager safely

The [installation guide](docs/installation.md) describes a safe setup. In short:

- Run Lager behind a reverse proxy with TLS, and do not expose port 8080 directly.
- Set `LAGER_TRUST_PROXY` to match your proxy setup.
- Use a separate domain for the apps (`LAGER_APPS_DOMAIN`). If you run a public server, consider adding it to the [Public Suffix List](https://publicsuffix.org/), so that browsers treat every app subdomain as its own site.
- Give the administrator role, and the right to add custom domains, only to people you trust.
- Keep Lager up to date, and back up the data directory and `secret.key`.
