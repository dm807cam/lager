# 0012. English as the source language, translated interface

- Status: Accepted
- Date: 2026-11-11

## Context

Lager started in German. An open-source project for people everywhere needs one shared language for code and documentation, and an interface in the users' languages.

## Decision

- Code, identifiers, comments, documentation, the guide, the skill, MCP tools, API error messages and the app check are English. They are read by contributors, programs and assistants, and are not translated.
- Everything people read in the interface (pages, notices, mails) comes from catalogs in `src/i18n/`; the one sentence the browser runtime shows itself, the download confirmation, has its own small table in `src/runtime/runtime.js`. English is the source; German, French and Spanish are shipped. The language is chosen from the account setting, then the language switcher, then the browser, then `LAGER_DEFAULT_LOCALE`.
- Product copy names Lager and no particular AI vendor.

## Consequences

- Adding a language is one catalog file plus two registrations, and the tests report missing keys, placeholders and leftover English.
- Tests reject inline human-facing text in page handlers and German outside the catalogs.
