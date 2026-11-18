# Notification badge-state evidence

Captures the bell's four badge states on the real top bar, and refuses to keep a
still that does not prove the state it claims.

This exists because the same three mistakes were re-derived by hand three times
in one night: a theme that was never actually applied, a selector that matched
the wrong element, and a module cache that served a stale build. Each produced a
set of stills that looked complete and proved nothing. The rules below are the
fix, written as code rather than as advice.

## The rules it encodes

1. **Assert the precondition before the shot, never after.** A still is only
   evidence of the state the page was in when the shutter opened.
2. **Assert both channels.** The badge is a drawn cap (`99+`); the accessible
   name is where the true count lives. A capture that checks only the drawing
   cannot tell "120 unread" from "99 unread", and a capture that checks only the
   name cannot tell a rendered badge from a missing one.
3. **Hash every still and fail on a duplicate.** Two identical frames under two
   names ("light" and "dark") prove nothing. `assertDistinct` throws naming the
   group.
4. **Write a manifest.** Every file gets its size and SHA-256, so the set is
   checkable later and "the file changed" is observable.

## The states

| id | seed       | server count  | badge       | accessible name                    |
| -- | ---------- | ------------- | ----------- | ---------------------------------- |
| B0 | `read-all` | 0             | none        | `Notifications`                    |
| B1 | `base`     | 6             | `6`         | `Notifications, 6 unread`          |
| B2 | `bulk`     | 120           | `99+`       | `Notifications, 120 unread`        |
| B3 | none       | request fails | hollow ring | `Notifications, count unavailable` |

B2 is the interesting one: the badge caps at `99+` while the name says 120, so
the cap and the truth disagree on purpose. B3 is the count request failing,
produced by aborting `/v1/notifications/count` at the network layer. At capture
time the underlying data is a true zero, so the ring is the app refusing to
claim a zero it could not confirm — which is the whole reason the state exists.

## Running it

Bring up a per-worktree stack and a web dev server pointed at it:

```sh
export BETTER_AUTH_SECRET=$(openssl rand -hex 24)
scripts/dev/compose-up.sh bakery-badges postgres redis inngest server
set -a; . ./.env.bakery-badges; set +a

(cd apps/web && BAKERY_WEB_PORT=5199 BAKERY_SERVER_PORT=<server port> \
  npx vite --port 5199 --strictPort &)
```

Then, with the stack's environment still sourced:

```sh
node scripts/evidence/notification-badge-states/capture.mjs \
  --web http://127.0.0.1:5199 \
  --api http://127.0.0.1:<server port> \
  --out /tmp/badge-states
```

It seeds between phases, so it needs `DATABASE_URL` and the server's auth
environment from the sourced `.env.<project>`. It prints
`EVIDENCE_MANIFEST=... files=32 distinct=32` on success and exits non-zero on
the first still that does not prove its state.

Tear the stack down when the run is done; the stills are the artifact.

## What it does not prove

200% zoom, 35% text expansion and RTL are not captured here. A set that is
neither proven nor named deferred is a set that quietly claims more than it
shows, so name them in the PR body.
