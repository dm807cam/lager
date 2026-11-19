# Limits

The limits Lager enforces and what it deliberately does not do.

## Enforced limits

- **Storage per instance:** The data of an instance is limited to `LAGER_INSTANCE_QUOTA_MB` (default 50 MiB). This size includes the documents, the uploaded files (`assets`) and the pages an instance saved itself (`page`). When the limit is reached, Lager refuses further writes, uploads and saves with the error `quota_exceeded` (HTTP 507 for the database); reading and deleting keep working. Versions created by deploys, snapshots and the trash are not counted; see [Storage outside the quota](#storage-outside-the-quota).
- **Instances per user:** Every account that is not an administrator may own at most as many instances as an administrator sets in the administration area under Settings (1 to 1000, default 20). This applies when creating further instances, including self-service.
- **New instances per day:** Accounts that are not administrators may create at most 10 instances within 24 hours; deleted instances count, and so does the instance created by the first deploy of an app. This stops anyone from filling the storage by creating, filling and deleting in a loop.
- **Open connections:** Per viewer and instance at most 8 live-update streams for the database and 8 for rooms; for anonymous visitors the viewer is the client address, and all of them together may hold at most 100 per instance. Further ones get HTTP 429, and the page works without live updates there.
- **Database requests:** Per viewer and instance at most 600 reads (`get`, query) and 300 writes (`set`, `update`, `add`, `delete`, `acquire`) per minute. Anonymous visitors are counted per client address and get half (300 and 150). Further requests get HTTP 429 with the error `rate_limited`; the browser runtime reports it to the app as `unavailable`, and live queries (`onSnapshot`) retry by themselves with a growing pause. Lager tells visitors apart by the client address the proxy reports, so `LAGER_TRUST_PROXY` must match your setup (see [Installation](installation.md)); otherwise all anonymous visitors share one budget.
- **Queries:** At most 10 `where` clauses, 5 `orderBy` fields, 30 values in the list of an `in`, `not-in` or `array-contains-any` clause, and 1000 results (`limit`). A query beyond that is refused with `invalid_argument`.
- **Paths and documents:** Paths are limited to 16 segments and 1000 bytes, and a segment to 200 bytes of letters, digits and `_ - . ~ : @ +` (not `.` or `..`); the server and the browser runtime enforce the same rule, so every stored document stays reachable from the app. A document is at most 256 KiB.
- **Domains:** At most 10 custom domains per instance.
- **Saved versions:** An instance keeps its last 20 self-saved pages; older ones are deleted.
- **Restores and version changes:** Restoring a snapshot and activating another version by hand each take a snapshot first. Together they are limited to 10 per instance and hour, in the dashboard, the REST API and the MCP tools alike; further ones get the error `rate_limited` (HTTP 429). Deploys are not counted.
- **Open databases:** Lager keeps the databases of at most 64 instances open at a time (and as many asset indexes) and closes the least recently used one; it is reopened on the next request. This is not configurable and needs no attention.
- **Snapshots:** They contain only the documents of the instance. `restore_snapshot` does not restore uploaded files or self-saved pages. Only the owner of the instance can restore one, in the dashboard or with `restore_snapshot`: a restore rolls back all documents, including other people's private areas and data the app's rules keep from managers.
- **Reserved names:** The name of a deleted instance stays reserved for its former owner. Other accounts cannot take it over, because otherwise stored browser data and service workers of the old instance would carry over to the new one.

## Storage outside the quota

Three things take disk space without counting against `LAGER_INSTANCE_QUOTA_MB`. Plan the disk for them:

- **Snapshots:** Lager takes one before every version change of an instance (a deploy to an instance that follows deploys, a manual activation) and before every restore. An instance keeps its newest `LAGER_SNAPSHOT_KEEP` snapshots (default 20), and all of them together may take at most 3 times the instance quota (150 MiB with the default quota); older ones are deleted first, and the newest one always stays. Without a quota (`LAGER_INSTANCE_QUOTA_MB=0`) only the count applies. A snapshot holds the documents only, so it is never larger than the quota. The instance page shows the space its snapshots take.
- **Trash:** A deleted instance moves to the trash with its documents, files, snapshots and saved pages, and stays there for `LAGER_TRASH_DAYS` days (default 30). The limit on new instances per day bounds how fast the trash can grow.
- **Deployed versions:** Every deploy with new content stores one HTML file of at most 16 MiB. There is no limit on the number of versions of an app.

## What Lager cannot do

- No sign-in through external providers (single sign-on); accounts use email and password.
- The quota applies to the data of an instance (documents, uploaded files, self-saved pages), not to deployed versions, snapshots or the trash (see [Storage outside the quota](#storage-outside-the-quota)). There is no limit on the total size.
- Snapshots back up only documents, not uploaded files and not self-saved pages.
- The trash is emptied after `LAGER_TRASH_DAYS` days (default 30) and cannot be restored through Lager.
- Only the building blocks `db`, `user`, `permissions`, `assets`, `room`, `page` and `downloads`; all other names return `null`, and `lager.complete` needs a model the administrator connects.
- Realtime rooms live only in memory: no history, nothing survives a restart, and several Lager processes do not share rooms.
- For custom domains, Lager does not check who owns the host name.
- No TLS of its own: HTTPS is handled by the proxy in front.
- No automatic backup and no replication.
