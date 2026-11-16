# QA captures at 22b2d895 (qapool-qa3)

The PR's own still set covers the four after-approval states and the three blocked-card
states, but **not** the "and {n} earlier" disclosure added by the same head, so QA captured it.

Probe (temporary, reverted, not committed): a test appended to apps/web/tests/task-delivery.spec.ts
reusing openApproved() with three pull requests (#480 closed, #481 merged, #482 open), screenshotting
the closed and the opened disclosure. Run: QA_STILLS_DIR=... playwright test -g "QA still" -> 6 passed.

Files: qa-earlier-{closed,open}-{desktop,phone,desktop-dark}.png
