---
title: The deploy that ate 143 books
description: A small change to a child's reading log wiped every title in it. Rolling back the code didn't bring them back. The snapshot Lager took just before the new version went live did.
date: 2026-11-25
author: The Lager team
tags: [versions, snapshots, family]
ai: true
---

Sunday evening. Mila is nine, and since the summer holidays she has logged every book she finished in **Bookworm**, a little app on the kitchen tablet. Title, author, a star rating, and a line about the best bit. There are 143 cards. The counter at the top says so, and she checks it daily.

At dinner she had one request: a heart, for the favourites. Her dad pasted it into his assistant between the soup and the pasta. Two minutes later, version 12 was live.

At 19:40 Mila opens the tablet. There are still 143 cards. Each one has a grey heart. None of them has a title.

"Where are my books?"

This is the story of the next ten minutes, and of the two parts of Lager that made them boring: versions and snapshots.

## What actually went wrong

The assistant had been tidy. Version 12 wanted every book to have a `favourite` field, so whenever it opened and found a book without one, it "upgraded" it:

```js
for (const book of snap.docs) {
  if (book.data().favourite === undefined) {
    await db.doc("books/" + book.id).set({ favourite: false });
  }
}
```

One word did it. In Lager's database, `set` replaces the whole document. `update` merges into it. So every book became `{favourite: false}` and nothing else. It took about a second, on the tablet, the first time Mila opened it.

People and models both make this mistake, and it hides until it meets real data. What matters is what happens next.

## First try: roll back the code

Every deploy on Lager creates a numbered version, and the old ones stay. An app keeps its newest 100. Going back to version 11 takes one sentence to the assistant (it calls `activate_version`), or one click on the instance page under "Version".

Dad does it. Version 11 comes back, with no hearts and the familiar layout. And still 143 empty cards.

That's the lesson the guide puts in one line: *data belongs to the instance, never to the version.* An instance is one running copy of an app, with its own address and its own data. Versions are just the code it runs. Swapping the code doesn't touch the books, which is usually what you want: a rollback shouldn't throw away the week's entries. But tonight the data itself is broken.

## Second try: the snapshot that was already there

Here's what Dad learned at 19:44. Before every version change of an instance, Lager quietly copies that instance's data. The copy is called a snapshot. It happens on a deploy that moves the instance to a new version, on a manual activation and before a restore.

So when version 12 arrived at dinner, a snapshot was taken first, a moment before the upgrade loop ever ran. Its name ends in `v11-to-v12`. It holds all 143 books, titles and all.

The instance page has a "Snapshots" list with a "Restore" button next to each one. Or ask the assistant:

> My Lager app "bookworm" lost all its book titles after the last deploy. Use get_app to show me the versions with their notes. Activate the last version before the broken one on the instance "bookworm". Then call list_snapshots and tell me which snapshot was taken just before the broken version arrived. Don't restore anything until I say so.

Two details matter here.

**Roll back the code first, then restore.** If you restore while version 12 is still active, the next time someone opens the app, the upgrade loop finds 143 books without a `favourite` field and runs again. Back to empty cards.

**Restoring is the owner's job.** People who manage an instance can change its version and see its snapshots, but only the owner can restore one. A restore rolls back *all* the documents, including ones the app's rules keep from managers.

At 19:47 Dad says "restore it". The cards fill up again: *The Lighthouse Cat*, five stars, "when the cat steers the boat".

## Nothing you try is lost

Every step left a copy behind, which is what kept this calm. The rollback to version 11 was a version change too, so it took a snapshot of its own: the 143 empty cards, named `v12-to-v11`. And a restore always saves the current data as a snapshot first, named `pre-restore`. Restore the wrong one, and you can step back. Pick the right one, and the broken state stays on the shelf too, in case you ever want it back.

There are limits, and they're worth knowing before a Sunday like this one:

- An instance keeps its newest 20 snapshots by default (`LAGER_SNAPSHOT_KEEP`), and all of them together take at most three times the instance's storage quota. The newest one, and the newest one that is at least a day old, are never deleted to make room.
- Snapshots hold the instance's documents only. Uploaded files, pages the app saved itself and data that came in from outside aren't in them.
- Restores and manual version changes are limited to 10 per instance and hour. Deploys don't count.
- Snapshots are for undoing an app's mistakes, not a backup of your server. For that, there's `node dist/backup.js`, described in [Data and backup](https://github.com/dm807cam/lager/blob/main/docs/data-and-backup.md).

## Version 13: the heart, done kindly

The fix isn't a better migration. It's no migration at all. The guide asks apps to change data formats in a way old data survives: read a missing field with a default value. A book without `favourite` simply isn't a favourite yet. When Mila taps the heart, the app calls `update`, which changes that one field and leaves the title alone.

```js
const isFavourite = book.data().favourite ?? false;
// on tap:
await db.doc("books/" + book.id).update({ favourite: !isFavourite });
```

The prompt, for your own apps:

> Add a favourite heart to each book in my Lager app "bookworm". Don't rewrite existing documents: treat a missing `favourite` field as false, and when the heart is tapped, change only that field with `update`, never `set`.

## The twist: a dress rehearsal on a copy

The deploy at dinner went straight to the one instance that mattered. Lager can give you a stage to try things on first.

Every instance either follows new deploys or stays on the version it has. So before version 13, the family runs it like a theatre:

1. **Pin the real one.** `set_auto_update` with `on: false` keeps the instance "bookworm" on version 11, whatever gets deployed.
2. **Make a stand-in.** `create_instance` makes "bookworm-test": same app, its own address, its own empty data. A new instance starts on the latest version and follows deploys.
3. **Copy the books over.** `export_data` reads the documents of "bookworm" (up to 1000 per call) and `import_data` writes them into the test copy.
4. **Deploy version 13.** The test copy moves to it. The real one stays put, and the deploy's answer lists it as pinned.
5. **Tap every heart you like.** On the test copy. Mila can help.
6. **Let the real one follow again.** Turning `set_auto_update` back on moves "bookworm" to the latest version at once. A snapshot is taken first, of course.

All of it fits in one message:

> Before you deploy the change to "bookworm", switch off automatic updates on the instance "bookworm", create a second instance "bookworm-test" of the same app, copy all documents into it with export_data and import_data, and only then deploy the change. Then give me the address of the test instance. When I say it looks right, switch automatic updates on "bookworm" back on.

A deploy note helps too: the `note` on every deploy (up to 500 characters) shows up in the version list, so "add favourite hearts" is easy to find at 19:41 on a Sunday.

## What to try tonight

Open one of your own apps on its instance page and look at the "Snapshots" list. If you've ever deployed a new version to an instance that had data in it, there's most likely a snapshot there already, waiting in case you need it. Then, next time you ask for a change to an app someone loves, paste the rehearsal prompt first.

The details are in the guide's section on [versions and rollback](https://github.com/dm807cam/lager/blob/main/src/guide.md#versions-and-rollback), in [Limits](https://github.com/dm807cam/lager/blob/main/docs/limits.md), and in [Data and backup](https://github.com/dm807cam/lager/blob/main/docs/data-and-backup.md). And if a snapshot has ever saved your Sunday, tell us in [Discussions](https://github.com/dm807cam/lager/discussions).

Mila, for the record, has 12 hearts so far. She says that's "not too many".
