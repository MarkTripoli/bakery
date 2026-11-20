# Backups

How a Bakery installation takes, copies off-site and restores backups. This
page is for the person who runs the host.

## The parts

- **The API** (`/v1/installation/backups`, `/v1/installation/backup-schedule`,
  `/v1/installation/backup-offsite`, installation administrators only) records
  what was asked for, the schedule, the off-site destination and the result. It
  is unprivileged: it never holds backup bytes and never holds an age key.
- **The host runner** (`bakery-backup-runner.timer`, every minute) asks the API
  whether a backup is waiting. If one is, it runs `backup.sh` (both databases,
  the skill and worker files, encrypted to your **public** age recipient),
  copies the set off-site if you configured that, and reports back. It runs as
  root on the host because `backup.sh` needs Docker and the data directories.
- **`backup.sh`** is unchanged. It is also run by the older
  `bakery-backup.timer` (daily, 03:00 UTC), which does not need the API.

A backup is a directory `/var/lib/bakery/backups/<UTC time>-<uuid>/` holding
`bakery.dump.age`, `inngest.dump.age`, `files.tar.gz.age`, `release.json` and
`SHA256SUMS`. A `latest` file names the newest.

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

`restore-check.sh` verifies the checksums, decrypts, restores both databases
into a throwaway container with no network, and checks the release journal.

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
| `failed`    | the newest attempt failed, or a claim lapsed (the runner stopped reporting: the cause is `runner_lost`)           |

A failed backup keeps a stable code and the runner's plain-text detail:

| code                      | cause and fix                                                                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `disk_full`               | the host ran out of space writing the set. Free space or lower the days to keep; the half-written set is removed.                              |
| `key_missing`             | `BAKERY_BACKUP_RECIPIENT` is not set in `/etc/bakery/backup.env`, or `age` is not installed or rejects the recipient.                         |
| `destination_refused`     | only ever the cause of a `not_copied` backup (below): the off-site destination said no. |
| `destination_unreachable` | only ever the cause of a `not_copied` backup (below): no answer, or an unverifiable copy.                                                       |
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
finished attempt and the state returns to `protected`. A failure *before or
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
