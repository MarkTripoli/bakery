# Backups

How a Bakery installation takes, copies off-site and restores backups. This
page is for the person who runs the host.

## The parts

- **The API** (`/v1/installation/backups`, `/v1/installation/backup-schedule`,
  `/v1/installation/backup-offsite`, installation administrators only) records
  what was asked for, the schedule, the off-site destination and the result. It
  is unprivileged: it never holds backup bytes and never holds an age key.
- **The host runner** (`bakery-backup-runner.timer`, every minute) asks the API
  whether a backup is waiting. If one is, it runs `backup.sh` (every state store
  listed under "What a backup contains", encrypted to your **public** age
  recipient), checks the finished set against its manifest, copies the set
  off-site if you configured that, and reports back. It runs as
  root on the host because `backup.sh` needs Docker and the data directories.
- **`backup.sh`** takes the backup and is also run by the older
  `bakery-backup.timer` (daily, 03:00 UTC), which does not need the API. Its
  start, its exit codes and its `BACKUP_COMPLETED <name>` line are unchanged.
  It now refuses to finish a set that is missing a state store (below).

A backup is a directory `/var/lib/bakery/backups/<UTC time>-<uuid>/` holding
`bakery.dump.age`, `inngest.dump.age`, `redis.rdb.age`, `files.tar.gz.age`,
`references.json.age`, `release.json`, `manifest.json` and `SHA256SUMS`. A
`latest` file names the newest.

## What a backup contains

A backup is complete only when every store Bakery keeps state in is in it. The
list is declared in `scripts/deploy/backup-runner/manifest.ts`, and
`manifest.json` records, for each store, whether it was captured (with its file,
size and SHA-256), excluded (with the reason) or failed.

| store | what it is | in the set |
| ----- | ---------- | ---------- |
| `postgres-bakery` | the Bakery database | `bakery.dump.age` |
| `postgres-inngest` | the workflow engine database | `inngest.dump.age` |
| `redis` | the workflow engine queue state, a Redis `SAVE` snapshot | `redis.rdb.age` |
| `files` | `/var/lib/bakery/skills` and `/var/lib/bakery/worker` | `files.tar.gz.age` |
| `release-journal` | `/var/lib/bakery/deploy/state.json` | `release.json` |
| `object-references` | every skill file and blob the database refers to, by object key and SHA-256, so a restore can read each one back. The **bytes of an R2 or other object store are not copied**; filesystem skill bytes are in `files`. | `references.json.age` |
| `secrets-key-identity` | the **id** of the key that protects saved secrets (`BAKERY_SECRETS_KEY_ID`) and a **fingerprint** of the key file. The key itself is **never** in a backup. | `manifest.json` only |

Left out on purpose, and listed in the manifest with the reason: `incoming`
(transient upload staging), `host-configuration` (`/etc/bakery`: env files, the
secrets key and the age identity are operator-managed and secret) and
`postgres-roles` (recreated when a restore starts a database).

**The secrets key is yours to keep.** The manifest records only the key's id and
a fingerprint. The key file (`BAKERY_SECRETS_KEY_FILE`, `/etc/bakery/secrets.key`)
is read **once, only to compute the fingerprint**, and is never copied, printed
or stored; save it somewhere separate, because without it saved secrets cannot
be read after a restore. The fingerprint is the first 16 hex characters of
`SHA-256("bakery-backup-key-fingerprint-v1\n" + the key file's bytes)`
(`sha256-16hex-v1`): domain-separated, and too short to help anyone recover the
key, but enough for a restore to check it has the right one:

```sh
deno run --no-prompt --allow-read=<set>,<key file> \
  /opt/bakery/background/scripts/deploy/backup-manifest.ts verify <set> --key-file <key file>
```

It exits 70 with `key_mismatch` when the key file is not the one the backup was
taken with. A host with no secrets key configured records that as an explicit
exclusion; a key id without its file (or the reverse) makes the backup
incomplete.

The references list is read at the same moment as the database dump but not in
the same transaction. A backup taken by the runner holds the installation first
(see "While a backup is taken" below), so no new write is admitted in between and
the list matches the dump up to the limits stated there. The daily
`bakery-backup.timer` does not hold the installation, so for it the list can be
a little newer than the dump.

## The age key

The backups are encrypted with `age` to a **public recipient** in
`/etc/bakery/backup.env` (`BAKERY_BACKUP_RECIPIENT=age1...`). The matching
**private identity must not be on the server or on the host**: keep it with the
operator (a password manager, a hardware key). The host and the API can create
backups but cannot read them. Losing the identity means losing every backup, so
store a second copy somewhere separate.

To prove a backup restores, copy the identity to the host only for the check,
then remove it:

```sh
sudo bash /opt/bakery/deploy/restore-check.sh /var/lib/bakery/backups/<set> /path/to/identity
```

`restore-check.sh` first verifies the set against its manifest (every store
present, every size and hash matching, nothing unlisted) and stops with exit 70
before starting any container if it does not. Then it verifies the checksums,
decrypts, restores both databases into a throwaway container with no network,
and checks the release journal.

The verification needs **Deno on the `PATH` and the release checkout at
`/opt/bakery/background`**, the same two things `backup.sh` needs for the
manifest. A fresh disaster-recovery host may have neither. There,
`restore-check.sh` stops before anything is restored, exits 70 and says which
of the two is missing: install Deno, and install or enable a release so
`/opt/bakery/background` exists, then run it again.

A set taken **before manifests existed** has no manifest, so `restore-check.sh`
fails closed on it. If you know it is an old set, pass `--allow-legacy` as a
third argument to run only the older checks; the flag never excuses a set that
has a manifest and does not match it.

## Set up the runner

1. Make sure `/etc/bakery/backup.env` holds `BAKERY_BACKUP_RECIPIENT` and that
   `age` is installed on the host.
2. As an installation administrator, issue the runner credential. It is shown
   **once**; issuing again replaces it (the old one stops working at once):

   ```
   POST /v1/installation/backup-runner/credential
   ```

3. Write `/etc/bakery/backup-runner.env` (owner root, mode `0600`):

   ```
   BAKERY_API_URL=http://127.0.0.1:<api port>
   BAKERY_BACKUP_RUNNER_TOKEN=<the credential>
   ```

4. Enable the timer:

   ```sh
   sudo systemctl enable --now bakery-backup-runner.timer
   ```

The unit is installed with the other units by `bootstrap-host.sh`. It does
nothing until `/etc/bakery/backup-runner.env` exists and a release is active.

To take a backup now, an administrator calls `POST /v1/installation/backups`.
Asking again while one is waiting returns the waiting one; asking while one is
running queues exactly one more.

## Schedule and off-site copy

- **Schedule** (`PUT /v1/installation/backup-schedule`): on or off, how often
  (hourly, daily, weekly), the time of day in UTC, and how many days to keep.
  There is no scheduler process: when the schedule is due, the next claim by the
  runner creates the request itself. The first backup after turning the schedule
  on is due at once.
- **Off-site copy** (`PUT /v1/installation/backup-offsite`): any S3-compatible
  bucket (endpoint, region, bucket, folder, access key id and secret). The key
  pair is write-only: the API never shows it again, only that it is set. Saving
  sends a test object first and stores nothing if that fails.
- **Send a test**: `POST /v1/installation/backup-offsite/verification` puts a
  small object under `<folder>bakery-probe/`, reads it back, compares it and
  deletes it. The answer is `verified`, `not_configured`,
  `destination_refused` (the destination answered and said no, with its own
  words), `destination_unreachable` (no answer), `destination_private_address`
  or `integrity_failed` (the bytes read back differ from the bytes written).

An off-site set is stored as `<folder><set name>/` with the same five files; the
checksum list is uploaded last, so its presence marks a complete set. The runner
verifies every object's size at the destination before it reports the backup as
copied off-site.

### Private addresses are refused

The destination's name is resolved and every address must be public: loopback,
private (10/8, 172.16/12, 192.168/16), link-local, carrier-grade NAT, cloud
metadata (169.254.169.254, fd00:ec2::254), multicast and reserved ranges are
refused, for names and for literal addresses, including IPv4 inside IPv6. The
check runs when you save, when you send a test, when the API hands the runner
its settings, and again inside the runner right before it connects, on the very
address it then dials. A name re-pointed after you saved it is therefore
refused (`destination_private_address`) and the credentials are withheld. Only a
test environment (`BAKERY_ENV=test`) may use a loopback endpoint.

Each time the API releases the key pair to the runner it writes one audit row
(`backupRunner.settings`: the runner credential's generation, bucket, region and
endpoint host, never a key). The runner reads its settings only after it has
claimed a backup, so an idle minute writes nothing.

## States and failure causes

The status (`GET /v1/installation/backups/status`) answers "am I protected":

| state       | meaning                                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------------------------- |
| `protected` | the newest finished backup succeeded and is newer than twice the schedule interval (7 days with no schedule)     |
| `running`   | a backup holds a live claim                                                                                       |
| `not_copied` | the newest finished backup was **taken on the host** but its **off-site copy failed** (see below); a later good full backup replaces this state |
| `stale`     | the newest good backup is older than that                                                                         |
| `failed`    | the newest attempt failed, or a claim lapsed (the runner stopped reporting; the run keeps no cause until a new claim takes it over)           |

A failed backup keeps a stable code and the runner's plain-text detail:

| code                      | cause and fix                                                                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `disk_full`               | the host ran out of space writing the set. Free space or lower the days to keep; the half-written set is removed.                              |
| `key_missing`             | `BAKERY_BACKUP_RECIPIENT` is not set in `/etc/bakery/backup.env`, or `age` is not installed or rejects the recipient.                         |
| `destination_refused`     | only ever the cause of a `not_copied` backup (below): the off-site destination said no. |
| `destination_unreachable` | only ever the cause of a `not_copied` backup (below): no answer, or an unverifiable copy.                                                       |
| `incomplete_set`          | the finished set was missing a state store, or did not match its manifest, so it is **not a recoverable backup** and was not kept as `latest`. The detail names the store (for example `redis: store_not_captured`) or the cause `manifest_builder_missing` (below). Fix that and take another backup. |
| `drain_timeout`           | the installation did not go quiet within 10 minutes, so **no backup was taken** and the installation was released. The detail counts what was still in flight (worker attempts and open transactions). See "While a backup is taken" below. |
| `runner_error`            | anything else: `journalctl -u bakery-backup-runner` has the script's last lines.                                                               |

### Taken, but not copied off-site (`not_copied`)

When the backup on the host succeeded and only the off-site copy failed, the run
is **completed, not failed**: the backup exists on the host and is kept there. It
is reported with `locations: ["server-host"]` and a cause, and the status shows
its own state, `not_copied` (amber), never `failed`. The cause is one of:

| cause                     | meaning and fix                                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `destination_refused`     | the destination said no (wrong key, bucket or folder, no permission), or its address is private (`destination_private_address`), or the settings are invalid (`destination_invalid`). The detail quotes the destination's own answer. |
| `destination_unreachable` | no answer, the name does not resolve (`destination_unresolvable`), or the copy could not be verified (for example the destination holds a different size than was sent): the detail has the real cause. |

The local backup counts as taken (it moves "last backup"), but the installation
is **not** protected off-site. Fix the destination (**Send a test** is the quick
check), then ask for another backup; the next good full backup becomes the newest
finished attempt and the state returns to `protected`. If you leave it, the state
turns `stale` once the newest good backup is older than the stale threshold
(twice the schedule interval, or 7 days with no schedule): an old backup that
exists only on the host is the bigger risk, so `stale` wins over `not_copied`.
A failure *before or
while* taking the backup on the host (`disk_full`, `key_missing`, `runner_error`)
is still `failed`.

**The unit exits 1 for this case**, like a failed backup: a backup that was not
copied off-site is a problem worth seeing, so `bakery-backup-runner.service`
shows in `systemctl --failed` and the journal says plainly
`was taken but NOT copied off-site (<cause>)`. Retention after such a run prunes
the **local** sets only; off-site sets are left alone until a copy succeeds.

## While a backup is taken: the installation is held

A consistent snapshot needs the installation to stand still. After the runner
claims a backup it **holds the installation** (the maintenance switch), waits for
it to go quiet, takes the backup, and lets go with its final report.

| state | meaning |
| ----- | ------- |
| `off` | normal; nothing is held |
| `draining` | held: new work is refused, work already in flight is finishing |
| `quiesced` | held and quiet: nothing the server can see is still running; the snapshot is taken now |

The status shows it as `maintenanceState` and `maintenanceSince`.

**What is refused while held.** These entry points answer a retryable
`503 INSTALLATION_QUIESCED` with a `Retry-After` header (at most 30 seconds, and
never longer than what is left of the hold) and change nothing:

- starting a run (`runs.create`, `automations.run`) and starting a skill import
  (`skills.import`);
- importing an artifact version (`artifactVersions.import`);
- a worker's claim for new work (`worker.claim`): the worker treats the 503 as a
  temporary fault, backs off, and keeps renewing the lease of any attempt it
  already holds;
- collection and storage purges: the scheduled purge skips the round quietly.

**What is accepted and waits.** A GitHub webhook delivery (`intake.webhook`) is
**not** refused. GitHub does not redeliver a delivery that got a 503, and Bakery
does not ask it to, so a refusal would lose the event. The delivery is accepted
and stored as usual, with its routes. While the installation is held the two
route consumers (tickets and pull requests, and automations) leave a route
exactly as it is: not claimed, no attempt counted, no firing started. The
recovery sweep resends a route that has waited a minute, so a stored delivery is
processed about a minute or two after the hold ends. A hold of any length cannot
use up a route's ten attempts.

One limit: a delivery accepted during the hold is stored while the backup is
taken, so whether that backup contains it depends on when it arrived relative to
the dump. Restoring that backup can lack a delivery GitHub already saw
acknowledged, and GitHub will not send it again.

Everything else keeps working: reads, the administrator's backup routes, the
runner's routes, and attempts already running.

**What "quiet" means, and what it does not.** The server reports `quiesced` only
when all of this is true: no worker job attempt is leased, running or canceling
with an unexpired lease; no other open database transaction of the server's role
began before the hold; and the hold has lasted at least 5 seconds (the settle
window, which covers a write that passed the check just before the hold began).
It **cannot see** Inngest or Redis engine steps, work a worker does without a
lease, a transaction of another database role, or a transaction that began before
the hold and stays open past the settle window. An attempt whose lease has lapsed
is not waited for: the lease rule already fences it. The references list of a
backup (slice A) is read while the hold is on, so it matches the dump.

**The hold always ends.** It is lease-bound: it lasts only as long as the claim's
lease (5 minutes), and every running report from the runner extends both. A
terminal report (completed, failed or a drain timeout) lets go at once. If the
runner dies, the hold lapses within 5 minutes with **no action from anyone**; a
lapsed hold reads as `off` everywhere. A lapse runs no code, so it is written to
the audit trail (`backupRunner.maintenance.exit`, outcome `lease_expired`) the
next time the runner enters.

**`drain_timeout`.** The runner waits up to 10 minutes for the installation to go
quiet. If work is still in flight it reports `failed` with `drain_timeout`, takes
no backup, and the installation is released. The detail says how many worker
attempts and open transactions were still running. Fix: find the long-running
attempts (`GET /v1/workers`), let them finish or cancel them, or set the workers
to draining, then ask for another backup.

**Audit.** Entering and leaving are audited as `backupRunner.maintenance.enter`
and `backupRunner.maintenance.exit` with the runner credential's generation, the
run id and the outcome, never a token or a key.

## The cutoff: what may have happened after the backup

A backup is a picture of one moment. If you restore it, things may already have
happened **after** that moment that the backup knows nothing about: a pull request
merged, a message posted. A restore must never do such a thing a second time, so
every backup records its **cutoff**: when the picture was taken, and which external
effects could still reach a provider at that moment.

**Where it comes from.** Once the installation is held and quiet, and before any
dump starts, the runner asks the server for the cutoff (`backupRunner.cutoff`). The
server answers with its own **database clock** at that instant and a **census** of
the effects still `prepared`, `submitted` or `uncertain` (effects already
`confirmed` or `failed` are settled and are not counted). It records the answer
once per run: asking again returns the same cutoff. The record is written before
the dumps, so it is inside the dump it describes. The runner hands the same value to
`backup.sh`, which writes it into `manifest.json` (format 2) as
`cutoff: {at, source: "database", effects: {...}}`.

**What the census holds.** Counts by status (`prepared`, `submitted`, `uncertain`),
counts by operation name (a name the code did not define counts as `other`), and
one SHA-256 over the sorted ids of those effects. It holds no id, no target and no
argument: a restored database can be checked against it without the ids leaving it.

**What the cutoff proves, and what it does not.** It proves the installation was
held and quiet at `at`, so everything in the dumps was read at or after it and the
effects counted were the ones unsettled then. It does not prove what any
unsettled effect did at the provider: that is exactly what a restore must treat as
unknown. The administrator's status shows `lastBackupCutoffAt`, the cutoff of the
newest completed backup that recorded one.

**A backup no runner took (the weaker cutoff).** The daily `bakery-backup.timer`,
or `backup.sh` run by hand, has no quiet moment and no server to ask. Its manifest
records the **host clock** when the script started, marked `source: "host-clock"`,
with no census. The set is complete, but a restore that must know what may have
happened afterwards refuses it (`verify --require-database-cutoff` reports
`cutoff_not_database`). A set from before cutoffs (manifest format 1) is the same:
readable, but with no cutoff at all.

**When it goes wrong.** If the server cannot give the cutoff (it is no longer
quiesced for this run, or it is unreachable), the runner reports `failed` with
`runner_error` and takes no backup. If the finished set's manifest does not carry
exactly the cutoff the server recorded, the runner reports `failed` with
`incomplete_set`. A cutoff passed to `backup.sh` that is not valid fails the build
with `BACKUP_INCOMPLETE` and nothing is moved into place.

**What a restore will do with it (slice E).** Every effect still `prepared`,
`submitted` or `uncertain` in the restored data is treated as having an unknown
outcome and is blocked for reconciliation, never re-sent. The library function
`unknownOutcomeEffects` (cutoff time plus the restored effect rows) lists them, and
flags as an anomaly any effect changed after the cutoff, which a dump taken while
quiet cannot contain. `compareCensus` checks a restored database against the census
a backup recorded; the restore drill (slice D) uses it.

## The restore drill: proof that a backup restores

A backup you have never restored is a hope. The restore drill restores a
completed set into **isolated, throwaway copies** of the stores on the host,
checks them there, measures how old the backup is and how long the restore took,
and reports the result so the administrator can see it.

```sh
sudo bash /opt/bakery/deploy/restore-drill.sh /var/lib/bakery/backups/<set> /path/to/identity
```

It needs Deno, the release checkout in `/opt/bakery/background`, `age`, Docker,
the secrets key file named in `infra.env`, and the runner's credential in
`/etc/bakery/backup-runner.env` to report. Without Deno or the checkout it
stops with exit 70 and says which is missing. Pass `--no-report` to run it
without the credential: the result is printed and not recorded.

**It is isolated.** Every container runs with **no network**, nothing is mounted
from production, and nothing restored is sent anywhere. The restored data is
never written to a file on the host: the Redis snapshot is streamed into its
container, and the files archive is extracted into a scratch directory that is
removed at the end. The isolated databases, the scratch directory and the
containers are removed when the drill ends, whether it passed or not. The drill
never writes to a production store. It is **not** a restore in place.

**What it checks, in this order.** It stops at the first check that fails.

| check | what it proves | failure code |
| ----- | -------------- | ------------ |
| `manifest` | the set declares itself complete and every required store is captured | `set_incomplete` |
| `checksums` | every file is present with the recorded size and hash, and `SHA256SUMS` agrees | `set_incomplete` |
| `key` | the secrets key file is the one the backup was taken with | `key_mismatch` |
| `postgres` | both databases restore into an isolated Postgres of the image production runs | `restore_failed` |
| `redis` | the Redis snapshot is a readable RDB file | `restore_failed` |
| `files` | the files archive extracts, stays inside its directory, and holds the skills and worker trees | `restore_failed` |
| `references` | the references list matches the manifest's counts, and each skill file it names is there with its recorded size and hash | `references_missing` |
| `migrations` | every migration the restored database has applied is one this release knows | `migration_unsupported` |
| `cutoff` | the restored database holds the cutoff record of the manifest, and its live effects match the recorded census | `cutoff_mismatch` |

A set whose cutoff is only the host clock (a backup the timer took, not the
runner) passes every restore-side check and then fails `cutoff`: a restore that
must not replay unknown effects needs the database cutoff. An unexpected error
is reported as `drill_error`. A failure's detail says what to do about it and
holds no path, key or restored data.

**Age and time.** `rpoSeconds` is the age of the backup: the seconds from its
cutoff to the start of the drill, which is the data a failure at that moment
would have lost. `rtoSeconds` is the time the restore and its checks took on this
host for a set of this size: it measures the restore, not a failover to another
machine. Both clocks are the host's clock and the database's clock, so a skew
between them shows up in the age.

**What it does not cover.** Objects kept in a remote store (R2) are recorded by
key and hash and are counted, not read: their bytes are not in the set. The
drill cannot say what any unsettled effect did at its provider; that is what the
cutoff records and what a restore must treat as unknown (slice E).

**Where to read the result.** The administrator's `GET
/v1/installation/backups/drills` lists the drills, newest report first, with the
backup name, the outcome, the failed check and its code, the age and the time.
The drill prints `RESTORE_DRILL_PASSED` or `RESTORE_DRILL_FAILED` and exits 0 when
it passed, 1 when it failed, and 3 when it ran but its result could not be
reported (a network error is retried three times; a refusal is not). The drill's
own id is chosen by the host, so reporting the same drill twice records it once.

## Restore in place: replacing the installation from a set

This **replaces the whole installation**: Postgres (`bakery` and `inngest`),
Redis and the skills tree. It is a destructive step on the host, run as **root
on the host by the operator who holds the age identity**. No API call and no
role can do it. Plan it as an incident: say who runs it, which set, and why.

```sh
sudo bash /opt/bakery/deploy/restore.sh /var/lib/bakery/backups/<set> /path/to/identity --confirm <set>
```

`--confirm` must be the set's own directory name. Without `--confirm` the
script prints its usage line and exits 64; with another name it exits 65.
Either way it changes nothing.

**It refuses, and changes nothing, unless:**

| exit | refusal | meaning |
| ---- | ------- | ------- |
| 64 | | bad arguments: the set or identity is missing, or `--confirm` is absent (the usage line is printed) |
| 65 | `RESTORE_CONFIRMATION_REQUIRED` | the typed name is not the set's name |
| 66 | `RESTORE_REFUSED_DRILL_FAILED` | `restore-drill.sh` of this set did not pass just now (the drill runs here and reports nothing, because the API may be the thing being replaced) |
| 67 | `RESTORE_REFUSED_NO_PRE_BACKUP` | a backup of the installation as it is could not be taken first, so the restore could not be undone |
| 70 | | Deno or the release checkout is missing |
| 77 | | not run as root |

**What it does, in order.**

1. Takes the pre-restore backup and prints `PRE_RESTORE_BACKUP <name>`.
2. Puts the proxy's pending page up (503 "installation pending") and stops the
   api (both slots), dispatch, the worker and Inngest.
3. Replaces `bakery` and `inngest` from their dumps (owners and grants as dumped),
   Redis from its snapshot, and the skills tree. The old skills tree is kept as
   `skills.pre-restore-<time>`.
4. **Moves the worker's state aside** as `worker.pre-restore-<time>` and creates
   an empty directory in its place. It is never restored: a copied worker
   journal must not be replayed against older database truth.
5. Brings the schema up to the running release, then runs the **restore fence**:
   every effect that was prepared or submitted becomes `uncertain` (to be
   reconciled, never sent again), every active attempt is quarantined and its job
   waits for reconciliation, and every worker host is revoked.
6. Starts the api only and puts the proxy back. Dispatch, the worker and Inngest
   **stay stopped**. The restore hold keeps every guarded door answering 503
   until an installation administrator re-enables it (see the next section).
   It prints `RESTORE_COMPLETED_HELD`.

**Redis is loaded in a separate step on purpose.** With the append-only file on
(as production runs it) and only a snapshot present, Redis starts empty and
ignores the snapshot. The script loads the snapshot in a one-shot server with the
append-only file off, switches it on so a fresh file is written from memory, and
only then starts the real server.

**If it fails after the stores were touched** it exits 1, says
`RESTORE_FAILED` and names the pre-restore backup. The installation stays
stopped. Do not start any service by hand: restore the pre-restore backup the
same way, or fix the cause and run the script again.

**What it does not do.** It does not restore the secrets key (the operator keeps
it; the drill already checked it matches). It does not read or send anything to a
provider. What an unsettled effect did at its provider is not known, which is why
it is `uncertain`.

## After a restore: re-enabling the installation, step by step

`restore.sh` leaves the installation **held**: the api is up, every door that
starts or changes work answers `503 INSTALLATION_RESTORING`, and dispatch, the
worker and Inngest are stopped. An installation administrator opens it again in
a fixed order, one step at a time. There is no screen for it: it is two calls on
the API, made with the administrator's browser session (an access token is
refused).

```sh
# What is held, and which step is next
GET  /v1/installation/restore
# Take a step; Idempotency-Key is required
POST /v1/installation/restore/steps   {"step": "intake", "confirmation": "<backup name>"}
```

The confirmation is the restored backup's name, exactly as `GET` shows it as
`backupName`. A wrong one changes nothing.

| order | step | what opens | what you do on the host first |
| ----- | ---- | ---------- | ----------------------------- |
| 1 | `intake` | new work: runs, webhooks, imports, catalog changes | nothing; check the restore's counts first |
| 2 | `dispatch` | the background consumers (retention collector, storage purges) | start Inngest and dispatch: `runtime.sh background <sha>` without the worker, then `docker compose up -d inngest` |
| 3 | `workers` | workers claim work again, and the restore is **released** | enrol each revoked worker host again, then start the worker |

Look at what the restore held before step 1: `effectsHeld` is the number of
effects that were unsettled and are now `uncertain`. They are reconciled by
reading the provider, never sent again, and they stay `uncertain` until that is
done. `workersRevoked` hosts must be enrolled again; their old assignments were
quarantined and their jobs wait for reconciliation.

**Named refusals** (each changes nothing):

| code | status | meaning |
| ---- | ------ | ------- |
| `RESTORE_NOT_HELD` | 409 | no restore holds this installation |
| `RESTORE_CONFIRMATION_MISMATCH` | 422 | the confirmation is not the restored backup's name |
| `RESTORE_STEP_OUT_OF_ORDER` | 409 | a later step was asked for; the answer names the step to take |
| `RESTORE_STEP_ALREADY_TAKEN` | 409 | that step is done; read the restore for the next one |

The server keeps the order: no step opens a later door while an earlier one is
closed. Each step is audited with the step and the backup's name.

## Restore to a minute (Restore to any minute is on)

While the installation setting "Restore to any minute" is on, Postgres archives
its WAL (at least one segment a minute) into `/var/lib/bakery/wal-spool`, each
backup set also holds `base.tar.age` (a `pg_basebackup` of the cluster), and the
runner encrypts every segment and uploads it to `<prefix>wal/<segment>.age` at
the off-site destination. The window shown in the setting is the range of
minutes a restore can reach.

To restore to a minute inside that window:

1. Pick the newest set that has `base.tar.age` and finished **before** the
   minute you want.
2. Download the off-site WAL into an empty directory with any S3 client and the
   bucket credentials you hold, for example
   `aws s3 sync s3://<bucket>/<prefix>wal/ /root/wal-restore/`. Segments still
   in the local spool (not shipped yet) are read too.
3. Run, as root, with the minute in UTC:

```sh
sudo bash /opt/bakery/deploy/restore-to-time.sh /var/backups/bakery/<set> /root/backup-identity.txt \
  --to 2026-11-21T10:15:00Z --wal /root/wal-restore --confirm <set>
```

It runs the restore drill of the set, takes a backup of the current
installation, stops everything that writes, moves the Postgres data directory
aside (`/var/lib/bakery/postgres.pre-restore-<time>`), rebuilds it from the base
backup and replays the WAL up to the minute. Redis and the skills come from the
set. The restore fence then treats everything after the minute as uncertain,
and only the api is started: re-enable the installation as after any restore
("After a restore" above).

| exit | meaning |
| --- | --- |
| 0 | restored to the minute and held |
| 64 | bad arguments (`--to`, `--wal` and `--confirm` are required) |
| 65 | the confirmation was not the set's name; nothing changed |
| 66 | the set has no base backup (taken while the switch was off); nothing changed |
| 67 | the pre-restore backup could not be taken; nothing changed |
| 68 | the minute is not a UTC instant, or is before the set finished; nothing changed |
| 69 | the WAL ends before the minute: the old database is put back and services stay stopped; fetch the missing segments and run it again |
| 71 | the restore drill of the set did not pass; nothing changed |
| 1 | failed after the stores were touched; the message names the pre-restore backup |

## What the runner does when something goes wrong

The order of a pass is: claim, hold the installation, wait for quiet, read
the settings (only now, so an idle minute reads nothing), take the backup, copy
off-site, send the final report, which lets go.

- **The API cannot be reached** on a claim: the pass exits 3 and the next minute
  tries again.
- **A report cannot be delivered**: the same report (same sequence number, same
  body) is retried with a bounded backoff (1, 2, 4, 8, 16 seconds). The API
  answers a repeated sequence from its stored row, so nothing is applied twice or
  skipped.
- **The claim's lease lapses** (a backup claim lasts 5 minutes and every report
  extends it; the runner reports at least every 2 minutes while it works): the
  API refuses further reports, the runner cancels its work, sends no more, and
  exits 2.
- **A lost claim answer.** If the runner's claim request succeeded on the server
  but the answer never arrived, the retry is told there is nothing to claim until
  the 5-minute lease lapses, and then the lapsed claim is taken over and the
  backup starts again from the beginning. **Up to five minutes of apparent
  inactivity after a network failure is expected, not a fault.**
- **The deploy lock is held** (a release, or the daily backup): the pass exits 75
  at once, counted as success, and runs again next minute. The runner never
  queues behind a long backup.

Exit codes: `0` nothing to do or backed up, `1` the backup failed, or it was
taken but not copied off-site (reported either way),
`2` the lease was lost, `3` the API could not be reached or refused the runner,
`64` the environment file is missing or invalid.

## When the manifest cannot be built (`manifest_builder_missing`)

`backup.sh` never stops taking backups. The manifest is built by Deno from the
release checkout (`/opt/bakery/background/scripts/deploy/backup-manifest.ts`); if
Deno or that checkout is missing, the dumps are still taken and encrypted exactly
as always, so the bytes exist. The set is then **kept** (under its normal
`<UTC time>-<uuid>` name, not deleted) with an `INCOMPLETE.json` marker that says
`complete: false`, the cause `manifest_builder_missing` and which stores also
failed (no secret is in it), and the script exits 70 with
`BACKUP_INCOMPLETE manifest_builder_missing`. The runner reports the run as
`failed` with `incomplete_set` and that cause. Such a set is **never a usable
backup**:

- it is never `latest`;
- `restore-check.sh` and the verifier refuse it with the cause, and
  `--allow-legacy` does not excuse it;
- retention treats it as incomplete: it is never "the newest set", so it cannot
  shield an older complete set from pruning, and it is pruned by age like any
  other;
- it is not copied off-site.

**Fix:** install or enable a release so `/opt/bakery/background` exists (and
Deno is on the host's `PATH`), then take another backup. The older
`bakery-backup.timer` needs the same: on a host that has never had a release,
its backups are kept as incomplete sets until the first release is installed.

## Retention

After a backup completes the runner deletes sets **strictly older than the days
to keep**, locally and (if configured) off-site. It never deletes the newest
set, never the one it just took, and never anything whose name is not
`<UTC time>-<uuid>`. A days-to-keep that is not a positive whole number keeps
everything. A failed pruning is logged and never fails the backup; look in the
journal (`journalctl -u bakery-backup-runner`) for `retention failed`.

## How this relates to `bakery-backup.timer`

`bakery-backup.timer` still runs `backup.sh` daily at 03:00 UTC with no API
involved. Both units take the same exclusive lock
(`/run/lock/bakery-deploy.lock`) as the release tool, so they never overlap: the
daily service waits for it (up to 5 minutes), the runner skips the minute. If you
use the API schedule you usually want one mechanism, not two: disable the daily
timer (`systemctl disable --now bakery-backup.timer`) once the runner works.
Backups from either appear on disk the same way, but only runs that went through
the API are listed and counted in the status.

## Checking it works

```sh
systemctl list-timers bakery-backup-runner.timer
journalctl -u bakery-backup-runner --since -1h
```

Then take a backup from the API, wait a minute, and read its status. Finish with
a restore check (`restore-check.sh`, above) on the newest set, and, if you use an
off-site copy, download one object and compare its checksum with `SHA256SUMS`.
