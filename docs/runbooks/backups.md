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
the same transaction, so a write in between can leave it a little newer than the
dump. Slice B of #64 (a maintenance state) makes the snapshot exact.

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

## What the runner does when something goes wrong

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
