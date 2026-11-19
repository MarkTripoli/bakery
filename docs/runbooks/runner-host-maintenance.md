# Runner host maintenance

The self-hosted Bakery runners (`bakery-hetzner-N`) share a 75 GB root disk with
other projects' runners. A full disk hangs the host (SSH and Tailscale stop
answering) and takes every queued lane with it, so each host carries the guards
below. Everything here lives in `scripts/runner-host/`; the hosts run copies.

## What is installed

| file on the host                                                                                            | from                    | what it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/usr/local/sbin/runner-disk-guard.sh` + `/etc/cron.d/runner-disk-guard` (every 15 min)                     | `runner-disk-guard.sh`  | removes Docker objects no container uses, for the `ci-runner` user's Docker only (`GUARD_USERS`; other projects' runners share these hosts as `runner` and are never touched). At or above 75% of the disk: everything older than 2 h, and images and build cache older than 72 h. Below it: leaked containers and volumes older than 24 h, so a killed run's test databases do not pile up unseen. Stopped containers are pruned before volumes, and every failed removal is logged (`journalctl -t runner-disk-guard`). |
| `/usr/local/sbin/runner-job-started.sh` (`ACTIONS_RUNNER_HOOK_JOB_STARTED` in the runner's `.env`)          | `runner-job-started.sh` | fails a job in seconds with `RUNNER_DISK_LOW` when `/` has under 10 GB free, after one cleanup.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `/usr/local/sbin/runner-job-completed.sh` (`ACTIONS_RUNNER_HOOK_JOB_COMPLETED`) and `runner-job-cleanup.sh` | same names              | deletes the runner user's own `/tmp` leftovers (Bakery, Playwright, Chromium), test-result directories and old `_work/_temp` files after a job.                                                                                                                                                                                                                                                                                                                                                                           |
| `/usr/local/sbin/runner-git-guard.sh` + `/etc/cron.d/runner-git-guard` (hourly)                             | `runner-git-guard.sh`   | prunes pull refs and collects garbage in the runner checkout when no job runs.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `/etc/logrotate.d/rsyslog`, `logrotate.timer` drop-in, `journald.conf.d/size.conf`                          | (edited on the host)    | rotates syslog at 100 MB, hourly, with `su root syslog` (without it logrotate skips every log because `/var/log` is group-writable); the journal is capped at 500 MB.                                                                                                                                                                                                                                                                                                                                                     |

## Install or update

Copy the scripts to `/usr/local/sbin` (mode 0755, owner root), keep the
originals in `/root/runner-hardening-bak-<date>/`, and for the hooks add the two
`ACTIONS_RUNNER_HOOK_*` lines to the runner's `.env`. A runner reads `.env` only
when it starts: take it out of rotation first
(`gh api -X DELETE repos/MarkTripoli/bakery/actions/runners/<id>/labels`), wait
for `busy=false`, restart `actions.runner.MarkTripoli-bakery.<name>.service`,
then restore the labels `hetzner`, `amd`, `bakery-heavy`.

## Roll back

Restore the backed-up files, delete the scripts and cron entries above, remove
the two hook lines, and restart the runner service when idle.

## When a host stops answering

1. `tailscale status` and `tailscale ping`: a peer that is "active" with `rx 0`
   is hung, not gone.
2. Find the Hetzner server (`hcloud server list`; the instance id comes from
   `curl http://169.254.169.254/hetzner/v1/metadata/instance-id` on the other
   hosts) and `hcloud server reboot <id>`. A full disk makes the graceful
   shutdown take about 4 minutes.
3. After it is back, free space before restarting anything: `/var/log/syslog.*`,
   runner `_diag` older than 3 days, then leaked Docker volumes. Start the
   runner user's Docker
   (`systemctl --user reset-failed docker.service && systemctl --user start docker.service`
   as that user with `XDG_RUNTIME_DIR=/run/user/<uid>`), run the guard, then
   restart the runner service.
4. Do not touch the other projects' runners or their data on the same disk
   (`/opt/actions-runner-org`, `/home/runner`).
