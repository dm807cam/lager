# Writing for the Lager blog

The blog lives at <https://lager.im/blog/>. Every post is one Markdown file in `website/blog/posts/`; `scripts/website.mjs` turns them into pages, the feed (`/blog/feed.xml`) and the sitemap when the website is published. Preview locally with:

```sh
node scripts/website.mjs _site && npx serve _site     # or any static file server
```

## The file

Name it `YYYY-MM-DD-short-slug.md`. The part after the date becomes the address: `/blog/short-slug/`.

```markdown
---
title: A plant that texts you when it's thirsty
description: One sentence that makes someone click. It is the summary in the list, in search results and in the feed.
date: 2026-11-22
author: The Lager team
tags: [ingest, sensors, raspberry-pi]
ai: true
---

The post, in Markdown.
```

- `title`, `description` and `date` are required. `author` defaults to "The Lager team". `tags`: two to four, lower case.
- `ai: true` is required for every post an AI assistant wrote or helped write. It adds a small grey note under the title: "This post was created with the assistance of AI and reviewed by the Lager team." Leave it out only for posts a person wrote alone.
- A post dated in the future stays hidden until that day, so a merged post can be scheduled. `draft: true` hides it for good.
- Markdown: headings (`##` and below; the title is the page's only `#`), paragraphs, **bold**, *italic*, `code`, links, lists, block quotes, tables, fenced code blocks with a language (`json`, `js`, `html`, `sh`), and images on a line of their own (the alt text becomes the caption).
- No raw HTML. It is shown as text, never run.
- Images go in `website/assets/blog/` and are linked as `/assets/blog/name.webp`. Only images we made or may use (screenshots of Lager with demo data, diagrams). Never photos of real people.

## The voice

Lager is a small, friendly thing: a storeroom where the apps your AI builds get a home. Write like a curious friend who just built something delightful and can't wait to show you.

- **Start with a moment, not a feature.** "Every Sunday my neighbour asks who has the ladder." Then show how a small app on Lager fixes it. The feature arrives as the hero of a story.
- **Concrete over abstract.** Name the app, show the prompt someone would type, show what appears on the phone, show the five lines of declaration that make it work.
- **Give readers something to do today.** Every post contains at least one prompt they can paste into their assistant, and says which Lager building blocks it uses.
- **Short sentences, active voice, no hype words** ("revolutionary", "game-changer", "seamless", "unlock", "leverage"). Excitement comes from what the thing does, not from adjectives.
- **Plain English.** Explain a term the first time it appears. One idea per paragraph. Headings that say what the section shows.
- **Length:** 700 to 1,400 words. A little humour is welcome; sarcasm and jokes at anyone's expense are not.

A good post has this shape, loosely: a hook (a moment or a problem) → the app in one paragraph → how it works on Lager (the building blocks, a short code block or prompt) → a twist or a second idea that builds on it → what to try next.

## Facts

Excitement only works if it is true.

- **Only describe what Lager can do today.** Check every capability, limit, field name and command against `src/guide.md`, `docs/`, `CHANGELOG.md` and the code. Copy declarations from the guide's examples and adjust them; never invent fields.
- If an idea needs something Lager does not have, say so plainly ("Lager can't send push notifications yet, so…") and show the workaround, or pick another idea.
- Name products and companies only in passing and neutrally. Lager is not affiliated with Anthropic, OpenAI or anyone else.
- No numbers about users, growth or performance that we have not measured.
- Links: to the docs on GitHub (`https://github.com/dm807cam/lager/blob/main/docs/…`), to other posts (`/blog/slug/`), to the changelog (`/changelog/`).

## Ideas

`website/blog/IDEAS.md` collects topics. Take one, or bring your own; tick it off in the same pull request.
