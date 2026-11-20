# Data, backup and operations

Moving data in and out, the trash, backups and logs.

## Export, import and moving

**Exporting data:** The instance page in the dashboard has a link to export the data as NDJSON. `GET /api/instances/<slug>/export` with a bearer token returns the same, as does the MCP tool `export_data`, which returns 200 documents by default (at most 1000, and about 8 MiB) and may stop early: its answer carries `truncated`, and when that is true you narrow the `prefix` and ask again. The REST export and the dashboard link are complete. The file contains one line `{"path": …, "data": …}` per document, plus the exporting account's own private area (`data/users/<id>/…`) but not the private areas of others. The account must manage the instance (owner or manager). The owner exports everything except other users' private areas; a manager gets only the documents that the app's rules let them read. Lager exports only the database as documents: uploads, snapshots, grants and domains are not included.

**Importing data:** `POST /api/instances/<slug>/import` with `Content-Type: application/x-ndjson` (one line per document, ideally the export file) or a JSON array of `{path, data}`; at most 20 MiB (a JSON array at most 5 MiB) and 100000 documents per call, and only one import runs at a time per instance (a second one is refused with HTTP 409). Document paths are limited to 1000 bytes. A manager can only write paths that the app's rules let them write; the owner is not restricted. The MCP tool `import_data` takes at most 1000 documents per call. An import replaces documents with the same path and deletes no others. Lager takes no snapshot before an import; back up existing data beforehand with an export if needed. You can import into the same instance or another one, also one of a different app, and so move data between servers. You create the second instance with `POST /api/apps/<slug>/instances` or `create_instance`.

```sh
curl -H "Authorization: Bearer $LAGER_TOKEN" https://lager.example.com/api/instances/board/export > board.ndjson
curl -X POST -H "Authorization: Bearer $LAGER_TOKEN" -H "Content-Type: application/x-ndjson" \
  --data-binary @board.ndjson https://lager.example.com/api/instances/board-2/import
```

**Downloading the HTML of a version:** The version list of an app has an HTML link per version; over REST it is `GET /api/apps/<slug>/versions/<n>`, and the MCP tool `get_version` returns the same HTML together with the version's capabilities and the app's title, so that an assistant can continue developing an app in a new conversation. The file arrives as an attachment (`text/plain`, with `X-Content-Type-Options: nosniff`) and is never rendered on the platform. Everyone who may read the app (owner and collaborators) can download deployed versions; self-saved versions only the managers of the instance that saved them.

**Moving an app from elsewhere with your assistant:** Give your assistant the source of the app (for example a claude.ai artifact) and let it, with the Lager connector connected, follow the section "Moving existing apps" of the guide (`get_guide`). It checks the HTML with `check_app` (used, unsupported and undeclared building blocks, browser storage, APIs of other hosts such as `window.claude` and `window.storage`), converts them to `window.lager`, declares the building blocks, deploys, transfers data with `import_data` and spot-checks the result.

**What cannot be moved automatically:**

- Data that lives only in the user's browser (`localStorage`, `sessionStorage`, `indexedDB`): the old app must save it once as a file, which you then import.
- Functions of the old host that Lager does not offer: the feature is dropped or must be replaced. A language model call becomes `lager.complete` and works when the app declares `complete` and a model is connected.
- Uploaded files: they must be uploaded again through the app, and the references to them change.
- Private areas of other users, grants, domains, snapshots and earlier versions from another platform.

## Deleting and trash

When the owner deletes an instance or an app in the dashboard, Lager removes it from the platform but only moves the files to `<data directory>/trash` (`/data/trash` in the container): the data of an instance, including its uploads, as `<instance id>-<timestamp>`, the versions of an app as `app-<app id>-<timestamp>`, and every page that a deleted instance had saved itself (building block `page`) as `version-<app id>-<version number>-<timestamp>`. Versions that Lager removes on its own never go to the trash and are deleted for good: deployed versions beyond the newest 100 of an app (a version an instance still runs is kept), and self-saved pages beyond the last 20 of an instance. Lager offers no restore for the trash; recovering is possible only by copying the files back. At startup and every 24 hours afterwards, Lager removes entries older than `LAGER_TRASH_DAYS` days (default 30; `0` turns the cleanup off, and you then empty the directory by hand). The age is taken from the timestamp in the name. Per run Lager writes one line to the log. An app can be deleted only while no instances of other accounts exist for it. Instances that an administrator has disabled can still be deleted by their owner.

## Backup

Everything lives in the data directory (with Docker Compose the volume `lager-data`, with a bind mount `./data`): the platform database, all versions, the data, uploads and snapshots of the instances, and `secret.key`. To back up, stop the service and copy the volume or directory. With the volume (Compose project name `lager`, otherwise `<directory name>_lager-data`; `docker volume ls` shows it):

```sh
docker compose stop
docker run --rm -v lager_lager-data:/data -v "$PWD":/backup alpine tar czf /backup/lager-backup-$(date +%F).tgz -C /data .
docker compose start
```

With a bind mount, stop the service as well and then `cp -a data data-backup-$(date +%F)`. Do not copy the directory while Lager runs: the databases are SQLite files in WAL mode, and a copy taken during a write can be unreadable.

**Without stopping Lager:** `node dist/backup.js <target directory>` (or `npm run backup -- <target directory>` in a source checkout; the Docker image has no `npm`) writes a consistent copy of the data directory while the server keeps running. It reads `LAGER_DATA_DIR`, copies every database with SQLite's own snapshot mechanism and the other files as they are, and leaves the trash out. The target must be a new or empty directory outside the data directory. In the container, mount a directory for it. Create that directory first and give it to the container's user (`node`, UID 1000): if it is missing, Docker creates it as root, and the backup fails with a permission error.

```sh
mkdir -p backup && sudo chown 1000:1000 backup
docker compose run --rm -v "$PWD/backup":/backup lager node dist/backup.js /backup/$(date +%F)
```

An installation made with the [one-command installer](installation.md#one-command-install) already mounts `/opt/lager/backups` at `/backups` with the right owner, and every update writes a backup there. For one in between:

```sh
cd /opt/lager && docker compose exec -T lager node dist/backup.js /backups/$(date +%Y-%m-%d-%H%M%S)
```

In every directory the databases are copied before the files, so the backup never lists an upload or a version whose file it lacks. An upload or a version that arrives while the backup runs may be missing from it, and one that is deleted during the backup may still be listed without its file; run it at a quiet time or accept that the last seconds are not included. The command exits with a non-zero status on failure, so a scheduler notices when it fails. Lager ships no scheduled backup: you create the schedule yourself. Two example lines for root's crontab (`sudo crontab -e`) for an installer-made installation: the first takes a backup every night at 03:00 (cron needs `%` written as `\%`), the second removes backups older than 14 days half an hour later:

```cron
0 3 * * * cd /opt/lager && docker compose exec -T lager node dist/backup.js /backups/$(date +\%Y-\%m-\%d-\%H\%M\%S)
30 3 * * * find /opt/lager/backups/* -prune -type d -name '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]' -mtime +14 -exec rm -rf {} +
```

The second line touches only folders directly in `/opt/lager/backups` whose name is such a timestamp, and judges their age by the time they were written. A systemd timer that runs the same commands works as well.

Without the second line the folder grows without bound: Lager never removes backups while it runs. The only other pruning happens when the installer updates Lager. It then keeps the newest `LAGER_BACKUPS_KEEP` (default 5) timestamp-named folders in total, whoever made them, so an update also removes all but the last five nightly backups. Set `LAGER_BACKUPS_KEEP` on the update to keep more (at most 9999). Copy backups to another machine if they should survive the loss of this one.

To restore, stop Lager and copy the contents back (or unpack the archive into an empty volume). Keep `secret.key` (or `LAGER_SECRET`) together with the data. Without it all sessions become invalid, and the keys of the AI providers stored in the database can no longer be decrypted: every provider that has a key stops working until an administrator enters the key again.

**File permissions.** Lager creates the data directory and every directory in it with mode 700, and every file (the databases with their WAL files, versions, uploads, snapshots, icons, `secret.key`) with mode 600: only the account Lager runs as can read them (in the container that is `node`, uid 1000). A data directory from an earlier build that other accounts could enter is closed at the next start with one `chmod 700` of the top directory, which Lager reports in one log line; the files below keep their old mode, which no longer matters once the directory above them is closed. A data directory that Lager does not own is left as it is. The backup command runs as the same account, so `docker compose exec` and `docker compose run` as shown above keep working, and the backup it writes has the same modes: a job on the host that copies the backups elsewhere has to run as that account or as root. A copy made by hand (`cp -a`, `tar`, `rsync`) has to run as that account or as root: on the host, a bind-mounted `./data` now needs `sudo`.

**Protect the backups.** A backup of the data directory contains `secret.key` next to the encrypted provider keys, so whoever can read the backup can read those keys, along with all app data and the password hashes. Keep backups as private as the server itself, and encrypt them before they leave it. If you set `LAGER_SECRET` in `.env` instead, the secret is not in the data directory: keep a copy of it in a separate place, because a backup is incomplete without it.

## Logs and crashes

Lager writes to standard output and standard error: one line at start, one per trash cleanup, every server error with its stack, and mail that could not be sent (with the recipient masked, as in `j***@example.com`). With Docker, `docker compose logs -f lager` shows them. Lager ships no systemd unit; if you run it from source under a unit you wrote yourself, `journalctl -u <your unit> -f` shows them. Set `LAGER_ACCESS_LOG=true` for one line per request if your proxy does not keep an access log.

If a bug escapes every handler, Lager logs it with a timestamp, closes its databases and exits with status 1, so the supervisor restarts it (`restart: unless-stopped` in the Compose file; in a systemd unit of your own, set `Restart=on-failure`). A port that is already taken ends the start with a clear message instead of a stack trace.
