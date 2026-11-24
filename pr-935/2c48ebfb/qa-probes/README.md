QA probes for PR 935 at 2c48ebfb6 (qa-qa). Copy a file into tests/integration/ and run it with `pnpm test:integration tests/integration/<file>` on a fresh Postgres.

- qa935-probe_test.ts: P1 to P6 (P1 and P2 there are superseded by qa935b P1b and qa935c P2c; P3 real workflow export, P4 mid-import failure, P5 packages with recomputed digests, P6 kind imported twice and two imports at once).
- qa935b-probe_test.ts: P1b a foreign id is refused exactly like a missing one, P2b, P7.
- qa935c-probe_test.ts: P2c developer-role member, P7b publish with another organization's skill or agent version.

These files are QA scratch: lift the cases you want into the PR's own test file.
