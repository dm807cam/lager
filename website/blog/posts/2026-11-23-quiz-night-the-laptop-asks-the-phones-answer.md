---
title: "Quiz night: the laptop asks, the phones answer"
description: A pub quiz on your own server. The questions stay hidden until you ask them, every team's phone hears the countdown at the same moment, and nobody needs an account.
date: 2026-11-23
author: The Lager team
tags: [rooms, data-rules, games]
ai: true
---

Round four, question seven. The quizmaster holds a soggy answer sheet up to the light. Is that "Lima" or "Lime"? Table three says Lima, obviously. Table five says if it's Lime, they want the point too. Someone's pencil has vanished. The scores are being added up on a napkin, and the napkin has opinions.

We love quiz night, not the paperwork. So we built a quiz app on Lager: the laptop asks, every team answers on a phone, and the scores add themselves up. No accounts for the players, no paper.

## The app in one paragraph

**Quiz night** has two faces. The quizmaster's screen shows the next question, a big "Go" button and every answer as it arrives, with a tick and a cross next to each. The players' page shows the current question, a countdown and one text field. A team types its name once, then answers until the night is over. When the quizmaster taps "Go", every phone at every table starts the same 30-second countdown. When it hits zero, the answer field locks. The scoreboard updates on everyone's screen as the quizmaster marks the answers.

## Two kinds of live: the database and the room

The app uses two live channels, and each does a different job.

The **database** holds everything that has to last: the questions, the current question, the answers and the scores. It has live updates: when the quizmaster moves on, every phone that listens with `onSnapshot` sees the new question within a moment.

The **room** carries the moments. A room is a live channel between everyone who has the app open right now: messages go out at once, and a list of who is connected comes with it. Rooms live in memory only. There's no history, and a server restart empties them. That's exactly right for "Go!": a countdown that started a minute ago is no use to anyone.

Here's the rule of thumb we ended up with. If a phone that missed it should still know about it, it goes in the database. If it only matters right now, it goes in the room. A phone whose screen went dark during question six still shows question six when it wakes up, because that's in the database. It just missed the countdown, because that was in the room.

The quizmaster's "Go" is one message:

```js
const room = await lager.use("room");
const quiz = await room.join("quiz");
await quiz.emit("go", { seconds: 30 });
```

And every phone does this:

```js
quiz.on("go", (msg) => startCountdown(msg.data.seconds));
```

Each phone counts down from the moment it hears the message, so nobody's clock has to agree with anybody else's. The quizmaster's screen also shows `quiz.peers().length`, the number of screens in the room, so you can see at a glance whether table five has actually opened the link yet.

## Who may do what, in four lines

The rules are what make it a fair quiz:

```json
{"db": {"rules": [
  {"path": "questions", "read": "admin", "write": "admin"},
  {"path": "live", "read": "view", "write": "admin"},
  {"path": "scores", "read": "view", "write": "admin"},
  {"path": "answers", "read": "admin", "write": "anyone"}
]}, "user": {}, "room": {}}
```

`admin` means managers of the instance and its owner, that's you and any co-host. `view` is the lowest level, and every visitor of a public instance has at least that. So:

- **The questions stay hidden.** Only managers can read `questions`. They aren't in the page either: your assistant writes them into the database after the deploy, with `db_write`. The teenager at table two who opens the page source finds a countdown and a text field, nothing more.
- **Everyone sees the question you're asking.** You copy it into `live/current`, which every visitor can read.
- **Players add answers, and that's all.** The `"write": "anyone"` rule lets every visitor add a document to `answers`, signed in or not. They can't change an answer, delete one or read anyone else's. If you saw the [0.2.0 post](/blog/lager-0-2-0-every-app-gets-a-letterbox/), this is the RSVP trick again, pointed at a pub table.
- **Only you score.** `scores` is readable by all and writable by managers.

Two details from the guide that matter on quiz night. Everything guests add is untrusted, so the app shows team names as text, never as HTML: a team called `<marquee>Winners</marquee>` appears as exactly those letters. And guest answers count against the instance's ingest quota until they're deleted. So the "End the night" button copies the final scores into a document of their own and deletes the answers. The quiz starts next week with an empty answer box and last week's winners on the wall.

Rooms follow the same levels: managers and the owner may send, viewers only listen. That's why a player can hear "Go", but can't send it.

## Before you head to the pub

One step trips people up, so here it is. A visitor of a public instance who hasn't signed in on it counts as a guest, even if it's you. Your first deploy creates a private instance, and opening a private instance signs you in on it. So open the quiz once on your laptop **before** you make it public. Your laptop then stays signed in on it as the owner for 30 days, which makes it the quizmaster's screen, and the phones arrive as guests.

The other thing is the pub wifi. For live connections, Lager counts guests by their internet address, and one address may hold at most 8 live room connections per instance. On a shared wifi, that means eight phones. One phone per team, and a pub table of eight teams is fine. If there are more, the extra teams can switch to mobile data.

## Try it: the prompt

> Build me a pub quiz app on Lager called "Quiz night". The quizmaster's screen (owner or managers) shows the next question from a `questions` collection only managers can read, copies it to `live/current`, and starts a 30-second countdown by sending one `go` message with `{seconds: 30}` in a room called `quiz`. Players open the public page on their phones, type a team name once, see the current question and send answers with `add` to an `answers` collection under a `"write": "anyone"` rule that only managers can read. Lock the answer field when the countdown ends. The quizmaster marks answers right or wrong, and the totals go to `scores/board`, which everyone can read. Show team names as plain text and show how many phones are in the room. An "End the night" button copies the final scores to `nights/<date>` and deletes the answers.

Then a second message: *"Write twenty questions about our town into `questions` with `db_write`, and make the instance public."* Read the questions before Thursday. A language model will happily tell you, with total confidence, that the town hall was built in a year when the town didn't exist yet.

## The twist: a buzzer round for the family

At the pub, players are guests and only listen. At home on a Sunday, everyone at the table has an account on your Lager server, and that opens up a round the pub can't have: the buzzer.

Give the same app a second instance, with its own data, and share it with the family at contributor level (your assistant does this with `create_instance` and `share_instance`). Then open one topic of the room to contributors:

```json
{"room": {"topics": {"buzz": "interact"}}}
```

It takes the place of `"room": {}` and is the only change to the declaration. Contributors may now send on `buzz`, and only on `buzz`. "Go" still belongs to the quizmaster. On the pub instance nothing changes, because guests are viewers and viewers never send. In the family instance, everyone's phone gets a big red button, the quizmaster's screen takes the first buzz it hears, and the room's message tells it who pressed. Grandma, it turns out, is very fast.

Same app, two instances, separate data: the pub never sees the family's scores.

## What to try next

Paste the prompt into your assistant, ask it for twenty questions about something your friends argue about, and open the quiz once before you make it public. The building blocks are in [Building apps](https://github.com/dm807cam/lager/blob/main/docs/building-apps.md), and the levels and instances in [Users and sharing](https://github.com/dm807cam/lager/blob/main/docs/users-and-sharing.md).

Then tell us in [Discussions](https://github.com/dm807cam/lager/discussions) which round you'd add. We're still arguing about Lima.
