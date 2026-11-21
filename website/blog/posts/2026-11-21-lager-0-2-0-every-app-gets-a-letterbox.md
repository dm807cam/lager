---
title: "Lager 0.2.0: every app gets a letterbox"
description: The new release lets data in from outside. A number from your phone, a message from your website, an answer from a party guest. Three small apps show how, and why the slot only opens one way.
date: 2026-11-21
author: The Lager team
tags: [release, ingest, data-rules]
ai: true
---

Monday, 7:02, before coffee. The bathroom scale says 81.4. By the time you've unlocked your phone and found the right app, the number has gone wherever numbers go before coffee.

Wednesday. Someone finds your little website and wants to know if the old bike is still for sale. Your website has no contact form, because a form needs a server or a form service, and you have neither.

Friday. Your aunt texts: *"Saturday, two of us. Is it OK if I bring the dog?"* That's answer number eleven, scattered across three chats.

All three end up on sticky notes. Lager had a good home for every one of them. It just had no way in. Until [Lager 0.2.0](/changelog/#v0.2.0), data reached an app only from signed-in people with contributor access, typed on the app's own page.

## A slot that only opens one way

0.2.0 gives every app a letterbox. You can push things through the slot. You can't reach through it and take anything out.

There are two kinds of slot:

- **Ingest endpoints**, for everything that isn't the app's own page: a phone shortcut, a script, a webhook, a sensor, a form on another website. Each endpoint has an address, `https://<instance>/_ingest/<name>`, and takes one JSON object per `POST`.
- **The `"write": "anyone"` rule**, for guests on a public app's own page. They can add a document. Nothing else.

Both only *add*. The server makes up the id of every new document, so nothing that already exists can be read, overwritten or deleted through the slot. What arrives is kept apart from the app's own data, with a quota of its own (10 MB per instance by default), so a flood can't fill your storage. And each instance page has a new card, "Data from outside", with every endpoint's address, its token, counters and a switch that closes it at once.

Here are the three sticky notes, turned into apps.

## Monday: a weight log your phone can post to

The app: a private chart of your weight, fed by one tap on your phone.

The declaration comes straight from the guide:

```json
{"db": {}, "user": {}, "ingest": {"endpoints": [
  {"name": "weight", "auth": "token", "maxBytes": 2048}
]}}
```

`auth: "token"` means only a sender with the endpoint's secret gets in. You find the token on the instance page under "Data from outside", and the app can show it to you too, because `ingest.endpoints()` hands it to managers and the owner only. If it ever leaks, one button replaces it and the old one stops working at once.

On an iPhone, the sender is a two-step Shortcut: *Ask for Input* (a number), then *Get Contents of URL* with the method `POST`, a header `Authorization: Bearer <token>` and a JSON body like `{"kg": 81.4}`. To test it from a laptop first:

```sh
curl -X POST -H "Authorization: Bearer $TOKEN" -d '{"kg": 81.4}' https://weight.apps.example.com/_ingest/weight
```

An accepted request answers `202`. The server stamps every document with `_receivedAt`, so the phone doesn't have to say when. And the app stays private: endpoints work on private instances, so the chart is yours alone.

> Build me a private Lager app that logs my weight. Give it a token endpoint called "weight" with maxBytes 2048, show the endpoint's address and token on a settings screen, and draw a chart of the last 90 days from the `_receivedAt` times.

## Wednesday: a contact form without a form service

The app: an inbox for messages from your own website.

```json
{"db": {}, "user": {}, "ingest": {"endpoints": [
  {"name": "contact", "auth": "none", "origins": ["https://www.example.com"]}
]}}
```

`auth: "none"` needs no secret, which is right for a web page, where any secret would sit in the page source for everyone to read. Instead, only pages on the listed websites may send, and browsers enforce that. On your website, the form sends with a few lines of script: `fetch(url, {method: "POST", body: JSON.stringify(data), keepalive: true})`, with no extra headers.

Two honest notes. First, endpoints take JSON only, so a plain HTML form that posts by itself won't work; it needs those few lines of script. Second, the list of websites keeps *other websites* out, not people with a script. Treat what arrives as untrusted. The guide tells your assistant to show messages as plain text, never as HTML.

Lager apps can't send email, so the inbox won't ping you. Add it to your home screen, and the messages are waiting when you open it.

> Build a Lager app that is the inbox for the contact form on https://www.example.com. Declare an ingest endpoint "contact" with auth "none" for that website, give me the HTML and script for the form to paste into my site, and show new messages first, as plain text.

## Friday: an RSVP page guests answer without an account

The app: a public invitation where guests say who's coming. No sign-up, no group chat.

This one needs no endpoint at all, because the guests are on the app's own page. One data rule does it:

```json
{"db": {"rules": [{"path": "rsvps", "read": "admin", "write": "anyone"}]}}
```

Make the instance public (your assistant can do that with `set_visibility`), and every visitor can add a document to `rsvps` with `collection.add()`. They can't change one, delete one or read the list: `"read": "admin"` keeps the answers for you and anyone who manages the instance. Each answer can be up to 4096 bytes, which is plenty for "two of us, and the dog".

> Make a public RSVP page on Lager for a garden party on Saturday at 3 pm. Guests enter their name, how many people they bring and an optional note. Use a "write": "anyone" rule so they don't need an account, and show the list and the total headcount only to me.

## The twist: after the party, a guestbook

Here's where the two halves of the rule get interesting. `write` decides who can add, `read` decides who sees. Turn the RSVP page into a guestbook after the party, and you want strangers to write, everyone to read, and nobody else to see anything you haven't checked first.

That's two collections:

```json
{"db": {"rules": [
  {"path": "entries", "read": "admin", "write": "anyone"},
  {"path": "guestbook", "read": "view", "write": "admin"}
]}}
```

Guests add to `entries`, which only you can see. You tap "approve", the app copies the entry into `guestbook`, which every visitor can read, and deletes the original. That copy step isn't just for moderation. Documents that came through the slot keep counting against the ingest quota until they're deleted, and they aren't part of snapshots. So the guide tells apps to copy what they want to keep into documents of their own.

One more thing the guide insists on: all endpoints and `anyone` rules of an instance share one ingest quota. An open guestbook that strangers fill could leave a token endpoint on the same instance without room. Give each its own instance. One letterbox per house.

## Handing a copy to a friend

Built the weight log and your sister wants one? Give her a separate instance with its own data. Its endpoints start **switched off**: on an instance whose owner doesn't run the app, they stay closed until that owner or a manager turns them on under "Data from outside". A deploy of yours never opens a slot in somebody else's door by itself.

## Also in 0.2.0

- Running Lager from source now needs **Node.js 24** or newer. The Docker image and the installer already use it.
- The Docker image no longer contains `npm` and its friends, which Lager never ran. For a backup inside the container, use `node dist/backup.js`.
- A manager who isn't the owner can no longer activate a version whose endpoints differ from the active one, the same as for data rules.

Coming in the next release, and already on `main` and the `:edge` image: endpoints whose websites each owner names in the app. We wrote about the app that needed it in [The app that taught Lager to listen](/blog/the-app-that-taught-lager-to-listen/).

## Try it this weekend

If you installed with the installer, run it again: the second run takes a backup and updates your server. With Docker Compose, `docker compose pull && docker compose up -d` does it. Then pick the sticky note that annoys you most and paste its prompt into your assistant. The full details are in [Receiving data from outside](https://github.com/dm807cam/lager/blob/main/docs/building-apps.md#receiving-data-from-outside).

And if you build something that takes its letters through the slot, tell us in [Discussions](https://github.com/dm807cam/lager/discussions).
