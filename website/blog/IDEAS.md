# Blog ideas

Topics for the Lager blog. Tick one off (`- [x]`) in the pull request that publishes its post, with the post's slug after it. Add new ideas at the end of their section. A new release always comes first: when `CHANGELOG.md` has a release without a post about it, write that post next.

## Releases

- [ ] "What's new in Lager x.y": one post per release, built around the two or three changes people will feel, with an app that shows each
- [x] What's new in Lager 0.2.0: ingest endpoints and `"write": "anyone"`, as three sticky notes turned into apps (lager-0-2-0-every-app-gets-a-letterbox)

## Home and family

- [ ] The ladder, the drill and the lawnmower: a lending list for the street (one shared instance, everyone `interact`)
- [ ] One copy each: a homework planner per kid with separate instances, and why that beats one big app
- [ ] The family recipe box that finally has photos (`assets` uploads)
- [ ] A chore wheel that is fair, because the data lives in one place everyone can see
- [ ] Holiday budget splitter for a group trip, shared by link
- [ ] A reading log for the kitchen tablet: a card per book, a heart for favourites, and a sticker for every tenth book

## Data from outside

- [ ] A plant that tells you when it's thirsty: a soil sensor posting to a token endpoint
- [ ] Log your weight from an iPhone Shortcut in one tap (`auth: "token"`, header or `?key=`)
- [ ] A contact form for your website without a form service (`auth: "none"`, `managedOrigins`)
- [ ] Webhooks without a server: catch GitHub or form-service events in an app
- [ ] RSVP for the birthday party on a public page with a `"write": "anyone"` rule
- [ ] A guestbook for your blog, with a manager who approves entries
- [ ] "Was this helpful?" on every page of your docs: an `auth: "none"` endpoint, daily totals the app keeps, and a weekly summary from `lager.complete`

## Together, live

- [x] Quiz night: a realtime quiz with rooms and presence for the whole pub table (quiz-night-the-laptop-asks-the-phones-answer)
- [ ] Planning poker for a small team, live in the browser
- [ ] A shared whiteboard of sticky notes that moves as people type
- [ ] Questions from the floor: a talk's audience sends questions through a `"write": "anyone"` rule, the moderator picks one, and a room puts it on the big screen

## Apps that think

- [ ] A recipe app that turns "what's in my fridge" into dinner with `lager.complete`
- [ ] A language-learning flashcard app whose cards write themselves
- [ ] Choosing the right model per app: a fast one for sorting, a strong one for writing
- [ ] The quiz that writes itself, and the fact-checker that doesn't: `lager.complete` drafts questions, a person approves each before it reaches `questions`

## Under the hood

- [x] Versions you can undo: the story of a deploy that broke a list, and the snapshot that saved it (the-deploy-that-ate-143-books)
- [ ] Your own domain for one app: notes.example.org pointing at a Lager instance
- [ ] Five minutes on a Raspberry Pi, step by step, with what each installer question means
- [ ] Pages that save themselves: an app the owner edits without asking the AI again
- [ ] Private by default: who can see what, explained with one shared grocery list
- [ ] Why Lager has no telemetry, and what "your data" means in practice
- [ ] One letterbox per house: why an open guestbook and a token endpoint belong on separate instances, told through the ingest quota
- [ ] Growing an app without migrating it: new fields with defaults on read, `update` instead of `set`, and old documents that never need touching

## Small business and clubs

- [ ] The club's booking sheet for the court, with a slot each and no double bookings
- [ ] A tiny shop's stock list that the whole team updates from their phones
- [ ] Shift swaps for a café, with a rule that only managers confirm
