# Contributing to Lager

Thank you for wanting to make Lager better! 🎉 Every contribution helps, whether it is a typo fix, a translation, a bug report, an example app or a new feature. This guide tells you how to take part and what to expect from us.

For **questions**, **ideas** and **help with your installation**, please use [GitHub Discussions](https://github.com/dm807cam/lager/discussions) rather than the issue tracker. That way the answers stay findable for the next person.

## Contents

- [Code of Conduct](#code-of-conduct)
- [Ways to contribute](#ways-to-contribute)
- [Reporting bugs](#reporting-bugs)
- [Suggesting features](#suggesting-features)
- [Development setup](#development-setup)
- [Project layout](#project-layout)
- [Tests and checks](#tests-and-checks)
- [Coding guidelines](#coding-guidelines)
- [Translations](#translations)
- [Example apps](#example-apps)
- [Documentation](#documentation)
- [Commit messages](#commit-messages)
- [Signing off your work (DCO)](#signing-off-your-work-dco)
- [AI-assisted contributions](#ai-assisted-contributions)
- [Submitting a pull request](#submitting-a-pull-request)
- [Licensing](#licensing)
- [Security issues](#security-issues)

## Code of Conduct

Everyone who takes part in this project agrees to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Be kind, assume good intent, and remember that the person on the other side is giving their free time.

## Ways to contribute

You do not need to write server code to make a real difference:

| You like… | You could… |
| --- | --- |
| Languages | [Translate the interface](#translations) into a new language or review an existing translation |
| Building things with AI | [Contribute an example app](#example-apps) that shows what Lager can do |
| Writing | Improve the [documentation](#documentation), write a how-to, or fix something that confused you |
| Testing | Try a release on your setup (Raspberry Pi, Unraid, a VPS, behind Traefik or Caddy…) and report what broke |
| Helping people | Answer questions in [Discussions](https://github.com/dm807cam/lager/discussions) |
| Code | Pick a [good first issue](https://github.com/dm807cam/lager/labels/good%20first%20issue) or something from [help wanted](https://github.com/dm807cam/lager/labels/help%20wanted) |

## Reporting bugs

1. **Search first.** Your problem may already be reported, or fixed on `main`. Search [open and closed issues](https://github.com/dm807cam/lager/issues?q=is%3Aissue).
2. **Use the bug report template.** It asks for what we need to reproduce the problem: the Lager version or commit, how you run it (Docker, from source, which reverse proxy), what you did, what you expected and what happened instead.
3. **Include logs.** `docker compose logs lager` shows the server log. Remove secrets, passwords, tokens and personal data before you paste anything.
4. **One problem per issue.** Several problems in one issue are hard to track and close.

> [!IMPORTANT]
> **Never report a security vulnerability in a public issue.** See [Security issues](#security-issues).

## Suggesting features

Open a [feature request](https://github.com/dm807cam/lager/issues/new?template=feature_request.yml) or start a thread in [Discussions → Ideas](https://github.com/dm807cam/lager/discussions/categories/ideas). Describe the problem you want to solve before the solution you have in mind. There may be a simpler way, or the problem may affect more people than you think.

**Please discuss larger changes before you build them.** We gladly merge straightforward bug fixes and small improvements right away. New features, new building blocks, new dependencies and changes to the architecture need agreement first, so that nobody spends weekends on a pull request we cannot accept.

What fits Lager well:

- **One process, one data directory.** Lager runs as a single Node.js process with SQLite. Features that need an extra service (Redis, Postgres, a message queue, a separate worker container) are very unlikely to be accepted.
- **One runtime for every AI.** Apps reach Lager only through `window.lager` (`lager.use(…)`, `lager.complete(…)`), and nothing in Lager depends on which assistant wrote an app. New features extend that runtime and the guide that explains it.
- **Safe by default.** Apps run code that nobody reviewed, and visitors may be anonymous. New features keep instances isolated from each other and from the platform.
- **Simple to run.** A person with a home server and a weekend should be able to operate Lager.

## Development setup

### Prerequisites

- [Node.js](https://nodejs.org/) **22.13 or newer** (Lager uses the built-in `node:sqlite`). CI tests on Node 22 and 24.
- npm (ships with Node.js)
- Git
- Optional: Docker, to test the container image

No database, DNS entry or certificate is needed for development.

### Getting started

1. **Fork** the repository on GitHub and clone your fork:

   ```sh
   git clone https://github.com/<your-username>/lager.git
   cd lager
   git remote add upstream https://github.com/dm807cam/lager.git
   ```

2. **Install the dependencies:**

   ```sh
   npm ci
   ```

3. **Start the development server.** The values in `.env.example` are already set up for local use:

   ```sh
   cp .env.example .env
   set -a; . ./.env; set +a
   LAGER_DATA_DIR=./data npm run dev
   ```

   `npm run dev` restarts the server whenever you change a file under `src/`.

4. **Open it:**

   - Platform: <http://localhost:8080>. Sign in with `LAGER_ADMIN_EMAIL` and `LAGER_ADMIN_PASSWORD` from `.env`.
   - Instances: `http://<slug>.apps.localhost:8080`. Browsers resolve `*.localhost` to your own machine, so no DNS entry is needed.

To start over with an empty server, stop it and delete `./data`.

### Deploying a test app

Create an API token in the dashboard (**Publish → API tokens**), then:

```sh
export LAGER_TOKEN=lgr_...
curl -X PUT -H "Authorization: Bearer $LAGER_TOKEN" -H "Content-Type: text/html" \
  --data-binary @examples/notes.html \
  "http://localhost:8080/api/apps/notes?title=Notes&capabilities=%7B%22db%22%3A%7B%7D%2C%22user%22%3A%7B%7D%7D"
```

Open <http://notes.apps.localhost:8080>.

### Connecting an AI assistant to your development server

OAuth also works without HTTPS on `localhost`, so you can connect any MCP client to your local server and let it deploy apps there. With Claude Code:

```sh
claude mcp add --transport http lager-dev http://localhost:8080/mcp
```

Then run `/mcp` in Claude Code and sign in. [Connecting your AI](docs/connecting-ai.md) has the setup for other assistants.

## Project layout

```
src/
├── server.ts          Entry point: reads the configuration, starts HTTP and background jobs
├── config.ts          Environment variables
├── core.ts            Wires the platform services together
├── platform/          Accounts, apps, versions, access rules, domains, AI providers, icons, mail
├── data/              Per-instance document store, query engine, data rules, assets, rooms, trash
├── http/              Express routers: platform pages, dashboard, admin, REST API, instance hosting
├── mcp/               MCP endpoint, its tools and the OAuth server
├── runtime/runtime.js The browser runtime injected into every app (`window.lager`)
├── static/            Stylesheet and script of the web interface
├── i18n/              Text catalogs (en, de, fr, es)
├── guide.md           The guide every AI reads (served over MCP, mirrored in the skill)
└── backup.ts          Online backup command
tests/                 Vitest suites (unit, HTTP and end-to-end)
examples/              Example apps, each with a test
skill/lager/           The Lager skill for Claude
docs/                  User documentation, plus architecture decision records in docs/adr/
```

## Tests and checks

Run these before you open a pull request. CI runs the same commands and must be green before we merge:

```sh
npm run typecheck   # TypeScript, strict mode
npm test            # all Vitest suites (about 900 tests, under a minute)
npm run build       # compiles to dist/ and copies the runtime, guide and assets
```

Useful variations:

```sh
npx vitest                            # watch mode, re-runs affected tests on save
npx vitest run tests/apps.test.ts     # a single file
npx vitest run -t "rollback"          # tests whose name matches
docker build -t lager:dev .           # check that the image still builds
```

**Every change in behaviour needs a test.** A bug fix comes with a test that fails without the fix. A new feature comes with tests for the normal case, the edge cases and the cases where access must be refused. Look at the existing suites for patterns: `tests/support/http.ts` starts a server in memory, and the `http-*.test.ts` suites show how to test routes with `supertest`.

Some tests protect rules of the project rather than single features. If one of them fails, the test message tells you what to change:

| Test | Protects |
| --- | --- |
| `tests/i18n.test.ts`, `tests/i18n-coverage.test.ts` | Every catalog has the same keys and placeholders, every key is used, no human-facing text is written inline in page handlers, and pages and mails render in every language without leftover placeholders |
| `tests/contrast.test.ts` | Text and controls in the interface keep WCAG contrast ratios in light and dark mode |
| `tests/dashboard.test.ts` (`skill`) | `skill/lager/SKILL.md` contains exactly the text of `src/guide.md` |
| `tests/example-*.test.ts` | The example apps keep working with the real browser runtime |

## Coding guidelines

- **TypeScript in strict mode, ES modules.** Imports of local files end in `.js` (`import { x } from './y.js'`), as `NodeNext` module resolution requires.
- **Follow the code around you.** Match the naming, structure and error handling of the file you are working in. Keep functions small and comments about *why*, not *what*.
- **Errors** that reach a client are thrown as `LagerError` (see `src/errors.ts`) with a code and a clear message. The error handler turns them into the right HTTP status.
- **User-facing text goes through the catalogs.** Never write interface text inline: add a key to `src/i18n/en.ts`, use it with `t(locale, 'key')`, and add the translation to every other catalog. If you cannot translate it, ask in the pull request and we will help.
- **Keep the guide and the skill in sync.** If you change `src/guide.md`, copy the same text into `skill/lager/SKILL.md` below its front matter.
- **Be careful with dependencies.** Lager has five runtime dependencies, and we want to keep it small. Discuss a new one in an issue first.
- **Security is part of the design.** Instances run untrusted code. For anything that touches sessions, cookies, origins, access levels, uploads or the runtime, explain in your pull request why the change is safe and add tests that check refusals as well as successes.
- **Accessibility.** Interface changes must work with a keyboard and a screen reader, keep visible focus and keep the contrast tests green.

## Translations

Lager is available in English, German, French and Spanish. English is the source of every text. Adding a language is one of the best first contributions: you need no knowledge of the server, and the tests tell you what is missing.

1. Copy `src/i18n/en.ts` to a new file named after the language code, for example `src/i18n/it.ts`, and translate the values. Keep the `{name}` placeholders, and keep "Lager", product names such as "Claude" or "ChatGPT", and the role name "Publisher" as they are.
2. In `src/i18n/index.ts`, import the catalog and add it to `CATALOGS`, `LOCALES` and `LOCALE_NAMES`.
3. In `src/runtime/runtime.js`, add the language to the small `SAVE_FILE` table. It holds the one sentence the browser runtime shows itself: the confirmation before a download.
4. Run `npm run typecheck && npm test`. The type checker reports every missing key. The tests check placeholders, unused keys, values left in English, and that every page and mail renders in your language.
5. Start the server, switch the language in the page footer and click through the pages. The tests cannot judge whether a translation reads well.

To improve an existing translation, edit its file and explain in the pull request why the new wording is better. If possible, ask another native speaker to review it.

## Example apps

Example apps show new users what Lager can do, and they are a good way to contribute without touching the server. An example in `examples/` should:

- be a **single HTML file**, with inline scripts and styles or scripts from a CDN;
- keep data only through `lager.use("db")` and the other [building blocks](docs/building-apps.md#building-blocks), never `localStorage`, `sessionStorage` or `indexedDB`;
- still load and explain itself when a building block is missing (`lager.use` then returns `null`);
- pass the check: `POST /api/check`, or the `check_app` MCP tool, reports no undeclared or unsupported building blocks;
- come with a test in `tests/example-<name>.test.ts` that runs it against the real runtime, like `tests/example-notes.test.ts`;
- be listed with its `capabilities` in the pull request description.

## Documentation

The user documentation lives in [`docs/`](docs/README.md), and the README gives the overview. If your change alters behaviour, a limit, a configuration variable or an API, update the matching page in the same pull request. Write short, direct sentences, show a working example where it helps, and state limits and defaults precisely.

Decisions that are hard to reverse, such as a new building block, a change to the security model or a new dependency, get an [architecture decision record](docs/adr/README.md) in `docs/adr/`, in the same pull request. For a substantial feature, a short description of the design in the issue makes the review much easier.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

```text
<type>: <summary in the present tense, at most 72 characters>

<why this change was made: the problem, and why this approach>

Fixes #123
Signed-off-by: Your Name <you@example.com>
```

| Type | Use for |
| --- | --- |
| `feat` | A new feature for users or app authors |
| `fix` | A bug fix |
| `docs` | Documentation only |
| `test` | Tests only |
| `refactor` | A code change that neither fixes a bug nor adds a feature |
| `perf` | A performance improvement |
| `ci`, `build`, `chore` | CI, Docker and build setup, maintenance |
| `i18n` | Translations |

The diff already shows *what* changed. Use the body to explain *why*. Pull requests are usually squash-merged, so the pull request title should follow the same format: it becomes the commit message on `main`.

## Signing off your work (DCO)

We use the [Developer Certificate of Origin](https://developercertificate.org/) (DCO), as Nextcloud, the Linux kernel and many other projects do. By signing off a commit you confirm that you wrote the change, or otherwise have the right to submit it under the project's license. There is no separate agreement to sign.

Add a `Signed-off-by` line with your real name to every commit:

```text
Signed-off-by: Ada Lovelace <ada@example.com>
```

Git does this for you with `-s`:

```sh
git commit -s -m "fix: keep the theme choice after sign-in"
```

If you forgot, sign off the commits of your branch afterwards and push again:

```sh
git rebase --signoff main
git push --force-with-lease
```

A CI check verifies the sign-off on every commit in a pull request.

## AI-assisted contributions

Lager exists so that people can build with AI, and you are welcome to use AI tools for your contributions too. The same standards apply as for any other code:

- **You are the author.** You must understand every line you submit and be able to explain and change it during review. "The AI wrote it" is not an answer to a review question.
- **Run it.** Code must have been executed and tested by you, on a running Lager, not only generated. Pull requests that move the debugging to the maintainers will be closed.
- **Say so.** Mention in the pull request description which tools you used and for what. A `Co-Authored-By:` or `Assisted-by:` trailer in the commit is welcome.
- **Communicate yourself.** Write issues, pull request descriptions and review replies in your own words. Short and imperfect is fine. A pasted wall of generated text is not.
- **Respect licenses.** Make sure generated code does not contain material that conflicts with the AGPL.

## Submitting a pull request

1. **Make sure there is an issue** for anything bigger than a small fix, and that a maintainer has agreed with the approach. Comment on the issue to say you are working on it.
2. **Create a branch** from an up-to-date `main`:

   ```sh
   git fetch upstream
   git switch -c fix/theme-after-sign-in upstream/main
   ```

3. **Keep it focused.** One pull request solves one problem. Unrelated clean-ups belong in their own pull request, because small pull requests get reviewed faster.
4. **Run the checks** from [Tests and checks](#tests-and-checks), and update the documentation where needed.
5. **Open the pull request** against `main` and fill in the template. Link the issue (`Fixes #123`), describe how you tested the change, and add screenshots for interface changes, in light and dark mode if they differ.
6. **Mark it as a draft** if you want early feedback on unfinished work.

### What happens next

- CI runs the type check, the tests, the build, the Docker build and the DCO check. A failing check means the pull request is not ready yet.
- A maintainer reviews the pull request. We aim to respond **within a week**. If you hear nothing after that, a friendly ping in the pull request is welcome.
- Review is a conversation. Questions are not rejections, and you are welcome to disagree with a reason.
- If `main` moves on, we may ask you to rebase, because you know your change best.
- Once approved and green, a maintainer squash-merges the pull request. Thank you! 🎉

We may close pull requests that stay inactive for a long time after a review request. You are always welcome to pick them up again.

## Licensing

Lager is licensed under the [GNU Affero General Public License v3.0 or later](LICENSE). Contributions are accepted under the same license ("inbound = outbound"). There is no Contributor License Agreement: you keep the copyright of your contribution, and the sign-off described above is all we ask for.

## Security issues

Please **do not** open public issues, discussions or pull requests for security problems. Follow the [security policy](SECURITY.md) to report them privately, so that we can fix them before they are known.

---

Thank you for contributing to Lager! 💛
