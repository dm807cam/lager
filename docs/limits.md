# Limits

The limits Lager enforces and what it deliberately does not do.

## Enforced limits

- **Storage per instance:** The data of an instance is limited to `LAGER_INSTANCE_QUOTA_MB` (default 50 MiB). This size includes the documents, the uploaded files (`assets`) and the pages an instance saved itself (`artifact`). When the limit is reached, Lager refuses further writes, uploads and saves with the error `quota_exceeded` (HTTP 507 for the database); reading and deleting keep working. Versions created by deploys, snapshots and the trash are not counted.
- **Instances per user:** Every account that is not an administrator may own at most as many instances as an administrator sets in the administration area under Settings (1 to 1000, default 20). This applies when creating further instances, including self-service.
- **New instances per day:** Accounts that are not administrators may create at most 10 instances within 24 hours; deleted instances count, and so does the instance created by the first deploy of an app. This stops anyone from filling the storage by creating, filling and deleting in a loop.
- **Open connections:** Per viewer and instance at most 8 live-update streams for the database and 8 for rooms; for anonymous visitors the viewer is the client address, and all of them together may hold at most 100 per instance. Further ones get HTTP 429, and the page works without live updates there.
- **Paths and documents:** Paths are limited to 16 segments and 1000 bytes; a document is at most 256 KiB.
- **Domains:** At most 10 custom domains per instance.
- **Saved versions:** An instance keeps its last 20 self-saved pages; older ones are deleted.
- **Snapshots:** They contain only the documents of the instance. `restore_snapshot` does not restore uploaded files or self-saved pages.
- **Reserved names:** The name of a deleted instance stays reserved for its former owner. Other accounts cannot take it over, because otherwise stored browser data and service workers of the old instance would carry over to the new one.

## What Lager cannot do

- No sign-in through external providers (single sign-on); accounts use email and password.
- The quota applies to the data of an instance (documents, uploaded files, self-saved pages), not to deployed versions, snapshots or the trash (which is emptied after the retention period). There is no limit on the total size.
- Snapshots back up only documents, not uploaded files and not self-saved pages.
- The trash is emptied after `LAGER_TRASH_DAYS` days (default 30) and cannot be restored through Lager.
- Only the building blocks `db`, `user`, `permissions`, `assets`, `room`, `artifact` (`self`) and `downloads`; all other names return `null`, `claude.complete` needs a model the administrator connects, and there are no messages to Claude from the page.
- Realtime rooms live only in memory: no history, nothing survives a restart, and several Lager processes do not share rooms.
- For custom domains, Lager does not check who owns the host name.
- No TLS of its own: HTTPS is handled by the proxy in front.
- No automatic backup and no replication.
