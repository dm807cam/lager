---
title: The app that taught Lager to listen
description: We asked an assistant for blog analytics on Lager and hit a wall. One afternoon later Lager could take data from any website, and this page is counted by an app that lives in our own storeroom.
date: 2026-11-20
author: The Lager team
tags: [ingest, analytics, behind-the-scenes]
ai: true
---

At 16:40 on a Friday, the request was one sentence: *"Design and build a web analytics app like Umami that runs on Lager, with all the metrics important to bloggers."*

By the evening there was **Byline**, a cookie-free dashboard that shows which posts people actually finish. Lager itself had grown a new ability along the way. This is the story of the wall we hit, the door we built into it, and what you can now build through that door.

## The wall: apps that only talk to friends

Until this week, a Lager app could only hear from people it knew. Data came in through the app's own page, from signed-in people with at least contributor access. That's a good default for a family grocery list. It's useless for analytics, where the "users" are strangers reading a blog on a completely different website.

The assistant noticed this before writing a single chart. Its first plan was honest about it: build a small collector server somewhere else and have Byline pull the numbers in. That works, but it means a second server, a second secret and a second thing to keep running. That's exactly what Lager exists to spare you.

So instead of working around the wall, we opened an issue to put a door in it.

## The door: endpoints that only ever add

The idea, written up in [issue #39](https://github.com/dm807cam/lager/issues/39) and shipped in [Lager 0.2.0](/changelog/), is called **ingest**. An app declares named endpoints, and each one can do exactly one thing: add a JSON document to one collection. It can't read, change or delete anything. Ever.

```json
{"ingest": {"endpoints": [
  {"name": "hits", "auth": "none", "managedOrigins": true,
   "visitor": "daily", "country": true, "onFull": "rotate"}
]}}
```

That's Byline's whole connection to the outside world. A few things happen around those five lines:

- **Anyone's website can send, if you say so.** The blog's pages post to `https://byline.example.com/_ingest/hits`. With `auth: "none"`, only pages from websites on the endpoint's list are accepted, and browsers enforce that.
- **No cookies, no IP addresses.** With `visitor: "daily"`, Lager adds a `_visitor` value that stays the same for one reader during one day and changes the next. You can count unique readers, but you can't follow anyone. The address itself is never stored.
- **It can't drown your app.** Data from outside lives in its own space with its own quota, 10 MB by default, apart from the app's storage. There are limits per sender and per day, too. With `onFull: "rotate"`, the oldest pings make room for new ones, which is right for a stream of page views.
- **It works on private apps.** The dashboard stays private while a public blog sends to it.

## The second door: websites you name in the app

There was one more snag. The first version of ingest wanted the list of websites in the app's declaration, so the blog's address had to be known when the app was deployed. But an analytics app gets deployed once and then pointed at *your* blog. Then your second blog. Then a friend's.

So came [`managedOrigins`](https://github.com/dm807cam/lager/blob/main/docs/building-apps.md#receiving-data-from-outside). It's on `main` and in the `:edge` image now, and it ships with the next release. When an endpoint declares it, the people who manage an instance name the websites themselves. They can do it on the instance page, or from inside the app:

```js
const ingest = await lager.use("ingest");
await ingest.setOrigins("hits", ["https://blog.example.com", "https://www.blog.example.com"]);
```

In Byline that call hides behind a friendly form: you type your blog's address and pick a time zone. Byline adds the `www` twin for you and hands you the snippet to paste into your blog's `<head>`.

## What Byline shows a blogger

Once the snippet is in place, page views appear within seconds. Behind the scenes, Byline turns the raw pings into one document per day and deletes the pings it has handled. The numbers last; the inbox stays small. Here's what you see:

- **Visitors, visits and pageviews**, each compared with the previous period.
- **Read time and read-through for every post.** Read time only counts while the tab is visible. Read-through is the share of readers who scrolled past 75% of the page. It's the number that tells you whether people *read* a post or just landed on it.
- **Where readers come from**, grouped the way a blogger thinks: search, social, newsletter, referral. It even has a group for AI assistants, so you can see when ChatGPT, Perplexity or Claude sent someone your way.
- **Trending posts**: the ones gaining most compared with last period.
- **Clicks on outbound links and downloads**, tracked automatically. Any button with `data-byline-event="Newsletter signup"` becomes a goal.
- **When readers show up**, as a weekday-by-hour heatmap with a plain sentence on top: *most readers arrive on Tuesdays, between 14:00 and 17:00*. Publish just before then.

There's an "Insights" button too. It hands the numbers to whatever language model your Lager server has set up and asks for a short, specific read of the period. That's `lager.complete`, the same building block any app on Lager can use.

## The same door opens for other apps

Analytics was just the first app to walk through. Here are a few more ideas, each one prompt away:

> Build me a Lager app that logs my weight. Give it a token endpoint called "weight" so an iPhone Shortcut can post to it, and show a chart of the last 90 days.

> Make a public RSVP page for my birthday on Lager. Guests add their name and how many people they bring. Only I can see the list.

> I have a soil-moisture sensor on a Raspberry Pi. Build a Lager app with an endpoint the sensor can post to every 10 minutes, and turn the screen red when a plant is thirsty.

The first and last use `auth: "token"`: the shortcut or the sensor sends a secret that only the instance's managers can see and replace. The RSVP page doesn't even need an endpoint. A data rule with `"write": "anyone"` lets guests of a public page add documents and nothing else.

## Counting ourselves

lager.im now runs Byline's snippet too. If you've read this far, a dashboard in a storeroom recorded a page view, your reading time and how far you scrolled. It didn't record who you are. Lager can't tell you, because it never wrote it down.

Want your own? Install Lager, then ask your assistant for an analytics app with an ingest endpoint and `managedOrigins`, or for any of the ideas above. Then tell us what you built in [Discussions](https://github.com/dm807cam/lager/discussions).
