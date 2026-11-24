import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { mockAuthenticatedSession } from "./helpers/mock-session.ts";
import { laneBudgetMs } from "./helpers/lane-budget.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { still } from "./helpers/stills.ts";

registerPageHealth(test);

const said = (region: Locator) =>
  region.evaluate((element) =>
    (element as HTMLElement).innerText.replace(/\s+/g, " ")
  );

const RUN_ID = "00000000-0000-4000-8000-0000000000aa";
const NOW = Date.now();
const hoursAgo = (hours: number) =>
  new Date(NOW - hours * 3_600_000).toISOString();

type Run = {
  id: string;
  triggerKind: "manual" | "scheduled";
  status: "requested" | "claimed" | "running" | "completed" | "failed";
  requestedAt: string;
  requestedByPrincipalId: string | null;
  claimedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  leaseExpiresAt: string | null;
  progressPercent: number | null;
  sizeBytes: string | null;
  locations: string[];
  failureCode: string | null;
  failureDetail: string | null;
};

function run(index: number, overrides: Partial<Run> = {}): Run {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    triggerKind: index % 2 === 0 ? "scheduled" : "manual",
    status: "completed",
    requestedAt: hoursAgo(index * 24 + 1),
    requestedByPrincipalId: index % 2 === 0
      ? null
      : "00000000-0000-4000-8000-000000000001",
    claimedAt: hoursAgo(index * 24 + 1),
    startedAt: hoursAgo(index * 24 + 1),
    finishedAt: hoursAgo(index * 24),
    leaseExpiresAt: null,
    progressPercent: 100,
    sizeBytes: "1572864000",
    locations: ["server-host", "off-site"],
    failureCode: null,
    failureDetail: null,
    ...overrides,
  };
}

function drill(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `00000000-0000-4000-8000-0000000001${String(index).padStart(2, "0")}`,
    backupName: `bakery-2026-11-${String(20 - index).padStart(2, "0")}`,
    startedAt: hoursAgo(index * 24 + 1),
    recordedAt: hoursAgo(index * 24),
    outcome: "passed",
    failureCode: null,
    detail: null,
    cutoffAt: hoursAgo(index * 24 + 2),
    rpoSeconds: 7200,
    rtoSeconds: 252,
    checksPassed: ["database", "files"],
    checksFailed: [],
    ...overrides,
  };
}

function statusBody(overrides: Record<string, unknown> = {}) {
  return {
    state: "protected",
    lastGoodBackupAt: hoursAgo(3),
    lastBackupCutoffAt: hoursAgo(3),
    lastAttemptAt: hoursAgo(3),
    runningRunId: null,
    runningProgressPercent: null,
    waitingRunId: null,
    runnerConfigured: true,
    runnerLastUsedAt: hoursAgo(0.05),
    maintenanceState: "off",
    maintenanceSince: null,
    ...overrides,
  };
}

const problem = (status: number, code: string) => ({
  status,
  contentType: "application/problem+json",
  body: JSON.stringify({
    type: "https://bakery.example/problems/test",
    title: "Refused",
    detail: "Refused.",
    status,
    code,
    retryable: false,
    requestId: crypto.randomUUID(),
    traceId: crypto.randomUUID(),
  }),
});

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

type Options = {
  status?: Record<string, unknown>;
  runs?: Run[];
  runsSecondPage?: Run[];
  drills?: ReturnType<typeof drill>[];
  scheduleEnabled?: boolean;
  offsiteConfigured?: boolean;
  pitrEnabled?: boolean;
  restoreHeld?: boolean;
  statusCode?: number;
  statusRefusedUntilRetried?: boolean;
  startConflict?: boolean;
  hold?: Promise<void>;
  keyDelay?: Promise<void>;
};

async function datesStayReadable(page: Page) {
  const rows = page.locator("[data-run]");
  const count = await rows.count();
  expect(count).toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) {
    const box = await rows.nth(index).getByText(/UTC/).first().boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(100);
    expect(box!.height).toBeLessThan(60);
  }
}

async function fixture(page: Page, options: Options = {}) {
  await mockAuthenticatedSession(page);
  const starts: { key: string | undefined }[] = [];
  const credentials: number[] = [];
  const statusReads: number[] = [];
  let status = statusBody(options.status);
  let refusing = options.statusRefusedUntilRetried === true;
  await page.route("**/v1/installation/status", (route) =>
    route.fulfill(json({
      bootstrapped: true,
      restoreHeld: options.restoreHeld ?? false,
      updatePaused: false,
      release: "4f2a9c1e7b3d5a60c8e2f1d9b7a5c3e1f0d2b4a6",
    })));
  await page.route(
    "**/v1/installation/restore",
    (route) =>
      options.restoreHeld
        ? route.fulfill(json({
          id: "00000000-0000-4000-8000-000000000901",
          backupName: "bakery-2026-11-20",
          cutoffAt: hoursAgo(50),
          restoredAt: hoursAgo(2),
          effectsHeld: 0,
          attemptsQuarantined: 0,
          jobsAwaitingReconciliation: 0,
          workersRevoked: 0,
          intakeEnabledAt: null,
          intakeEnabledBy: null,
          dispatchEnabledAt: null,
          dispatchEnabledBy: null,
          workersEnabledAt: null,
          workersEnabledBy: null,
          releasedAt: null,
          nextStep: "intake",
        }))
        : route.fulfill(problem(409, "RESTORE_NOT_HELD")),
  );
  await page.route(
    (url) => url.pathname === "/v1/installation/updates/status",
    (route) => route.fulfill(problem(403, "AUTH_FORBIDDEN")),
  );
  await page.route(
    (url) => url.pathname === "/v1/installation/backups/status",
    async (route) => {
      statusReads.push(Date.now());
      await options.hold;
      if (options.statusCode !== undefined) {
        return route.fulfill(
          problem(
            options.statusCode,
            options.statusCode === 403
              ? "AUTH_FORBIDDEN"
              : "DEPENDENCY_UNAVAILABLE",
          ),
        );
      }
      if (refusing) {
        return route.fulfill(problem(503, "DEPENDENCY_UNAVAILABLE"));
      }
      return route.fulfill(json(status));
    },
  );
  await page.route(
    (url) => url.pathname === "/v1/installation/backups",
    (route) => {
      const request = route.request();
      if (request.method() === "POST") {
        starts.push({ key: request.headers()["idempotency-key"] });
        if (options.startConflict) {
          return route.fulfill(problem(409, "STATE_CONFLICT"));
        }
        status = statusBody({
          ...options.status,
          state: "running",
          runningRunId: RUN_ID,
          runningProgressPercent: 5,
        });
        return route.fulfill(json(run(0, { status: "requested" }), 201));
      }
      const cursor = new URL(request.url()).searchParams.get("cursor");
      const first = options.runs ?? [run(1), run(2), run(3)];
      const second = options.runsSecondPage ?? [];
      return route.fulfill(json(
        cursor === "older" ? { items: second, nextCursor: null } : {
          items: first,
          nextCursor: second.length > 0 ? "older" : null,
        },
      ));
    },
  );
  await page.route(
    (url) => url.pathname === "/v1/installation/backups/drills",
    (route) =>
      route.fulfill(json({ items: options.drills ?? [], nextCursor: null })),
  );
  await page.route(
    (url) => url.pathname === "/v1/installation/backup-schedule",
    (route) =>
      route.fulfill(json({
        enabled: options.scheduleEnabled ?? true,
        interval: "daily",
        timeOfDayUtc: "03:00",
        daysToKeep: 30,
        updatedAt: hoursAgo(100),
        version: 2,
      })),
  );
  await page.route(
    (url) => url.pathname === "/v1/installation/backup-offsite",
    (route) =>
      route.fulfill(json({
        configured: options.offsiteConfigured ?? true,
        endpoint: "https://s3.example.com",
        region: "eu-west-1",
        bucket: "bakery-backups",
        prefix: "",
        credentialUpdatedAt: hoursAgo(100),
        credentialRevision: 1,
        updatedAt: hoursAgo(100),
        version: 1,
      })),
  );
  await page.route(
    (url) => url.pathname === "/v1/installation/backup-point-in-time",
    (route) =>
      route.fulfill(json({
        enabled: options.pitrEnabled ?? false,
        earliestRestorableAt: null,
        latestRestorableAt: null,
        reportedAt: null,
        updatedAt: null,
        version: 0,
      })),
  );
  await page.route(
    (url) => url.pathname === "/v1/installation/backup-runner/credential",
    async (route) => {
      credentials.push(Date.now());
      await options.keyDelay;
      status = statusBody({ ...options.status, runnerConfigured: true });
      return route.fulfill(json({
        credential: "bkr_live_9f3a7c1e5b2d8046a1c9e7f3b5d2a8c4",
        generation: 1,
        issuedAt: new Date().toISOString(),
      }, 201));
    },
  );
  return {
    starts,
    credentials,
    statusReads,
    stopRefusing: () => {
      refusing = false;
    },
  };
}

const body = (page: Page) => page.locator("[data-page='installation-backups']");

async function noOverflow(page: Page) {
  const overflow = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    return [...document.querySelectorAll("main, main *")].filter((element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.right > width + 1;
    }).map((element) => element.tagName).slice(0, 5);
  });
  expect(overflow).toEqual([]);
}

async function accessible(page: Page) {
  const results = await new AxeBuilder({ page }).include("main").analyze();
  expect(results.violations.map((violation) => violation.id)).toEqual([]);
}

for (
  const viewport of [
    { name: "desktop", width: 1440, height: 900 },
    { name: "tablet", width: 820, height: 1000 },
    { name: "phone", width: 390, height: 844 },
  ]
) {
  test.describe(`${viewport.name}: backups`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("protected: the notice, three facts, the list, restore checks and the cards", async ({ page }) => {
      await fixture(page, {
        drills: [drill(1)],
        runsSecondPage: [run(4), run(5)],
      });
      await page.goto("/installation/backups");
      await expect(page.getByRole("heading", { name: "Backups", level: 1 }))
        .toBeVisible();
      await expect(page.locator("main h1")).toHaveCount(1);
      const notice = page.locator("[data-notice='protected']");
      await expect.poll(() => said(notice)).toContain("Protected");
      await expect.poll(() => said(notice)).toContain(
        "The last backup finished 3 hours ago and a copy is off-site.",
      );
      await expect.poll(() => said(page.locator("[data-fact='last-good']")))
        .toContain("Last good backup");
      await expect.poll(() => said(page.locator("[data-fact='last-good']")))
        .not.toContain("ago");
      await expect.poll(() => said(page.locator("[data-fact='next']")))
        .toMatch(/Next backup.*03:00 UTC|Next backup.* UTC/);
      await expect.poll(() => said(page.locator("[data-fact='restore-check']")))
        .toContain("Passed");
      await expect.poll(() => said(page.locator("[data-fact='restore-check']")))
        .toContain("restored in 4 minutes");
      const rows = page.locator("[data-run]");
      await expect(rows).toHaveCount(3);
      await expect.poll(() => said(rows.first())).toContain("A person");
      await expect.poll(() => said(rows.nth(1))).toContain("Scheduled");
      await expect.poll(() => said(rows.first())).toContain("1.6 GB");
      await expect.poll(() => said(rows.first())).toContain(
        "This server, off-site",
      );
      if (viewport.name === "phone") {
        await expect(page.getByRole("table")).toHaveCount(0);
      } else {
        await expect(page.getByRole("table")).toHaveCount(2);
      }
      await expect(page.locator("[data-drill]")).toHaveCount(1);
      await expect.poll(() => said(page.locator("[data-section='settings']")))
        .toContain("Every day at 03:00 UTC");
      await expect.poll(() => said(page.locator("[data-section='settings']")))
        .not.toContain("Change settings");
      await expect(page.getByRole("heading", { name: "History" }))
        .toBeVisible();
      await expect(page.getByRole("heading", { name: "Backups" })).toHaveCount(
        1,
      );
      await expect.poll(() => said(page.locator("[data-fact='last-good']")))
        .not.toContain("—");
      const startButton = page.getByRole("button", { name: "Back up now" });
      const startBox = await startButton.boundingBox();
      expect(startBox!.height).toBeLessThan(60);
      expect(
        await startButton.evaluate((element) => {
          const walker = document.createTreeWalker(
            element,
            NodeFilter.SHOW_TEXT,
          );
          const tops = new Set<number>();
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const range = document.createRange();
            range.selectNodeContents(node);
            for (const rect of Array.from(range.getClientRects())) {
              tops.add(Math.round(rect.top));
            }
          }
          return tops.size;
        }),
      ).toBe(1);
      await expect.poll(() => said(page.locator("[data-section='service']")))
        .toContain("Running on the server. Last heard from");
      await expect.poll(() => said(page.locator("[data-section='restoring']")))
        .toContain("Bakery never restores by itself.");
      await expect(
        page.locator("[data-section='restoring']").getByRole("link", {
          name: "Finish the restore",
        }),
      ).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Back up now" }))
        .toBeEnabled();
      await page.getByRole("button", { name: "Show older" }).click();
      await expect(rows).toHaveCount(5);
      await expect(page.getByRole("button", { name: "Show older" }))
        .toHaveCount(0);
      await noOverflow(page);
      await accessible(page);
      await page.mouse.move(5, 5);
      await still(page, "backups-protected");
    });

    test("failed: the cause, the fix and the service's own answer", async ({ page }) => {
      await fixture(page, {
        status: {
          state: "failed",
          lastAttemptAt: hoursAgo(9),
          lastGoodBackupAt: hoursAgo(33),
        },
        runs: [
          run(1, {
            status: "failed",
            failureCode: "disk_full",
            failureDetail: "no space left on device",
            locations: [],
            sizeBytes: null,
          }),
          run(2, { failureCode: "destination_refused" }),
        ],
        offsiteConfigured: false,
      });
      await page.goto("/installation/backups");
      const notice = page.locator("[data-notice='failed']");
      await expect.poll(() => said(notice)).toContain("Not protected since");
      await expect.poll(() => said(notice)).toContain(
        "The last backup failed: the server's disk was full. Free space on the server, then back up now.",
      );
      await expect.poll(() => said(notice)).not.toContain(
        "The last good backup is from",
      );
      await expect.poll(() => said(page.locator("[data-fact='last-good']")))
        .toContain("ago");
      await expect.poll(() => said(notice)).not.toContain(
        "no space left on device",
      );
      await expect(page.locator("[data-run]").first()).toContainText("Failed");
      await expect(page.locator("[data-run]").first()).toContainText(
        "Disk full.",
      );
      await expect(page.locator("[data-run]").first()).not.toContainText(
        "Free space on the server",
      );
      await expect(page.locator("[data-run]").first()).toContainText(
        "Not taken",
      );
      await expect(page.locator("[data-run]").first()).not.toContainText(
        "Not taken · Not taken",
      );
      await datesStayReadable(page);
      await expect.poll(() => said(page.locator("[data-run]").nth(1)))
        .toContain("Not copied off-site");
      await expect.poll(() => said(page.locator("[data-run]").nth(1)))
        .toContain(
          "The off-site copy failed: the bucket refused the copy. Check the access key and the bucket in Settings.",
        );
      await noOverflow(page);
      await accessible(page);
      await page.mouse.move(5, 5);
      await still(page, "backups-failed");
    });

    test("never backed up: an error that asks for a first backup", async ({ page }) => {
      await fixture(page, {
        status: {
          state: "failed",
          lastGoodBackupAt: null,
          lastAttemptAt: null,
        },
        runs: [],
      });
      await page.goto("/installation/backups");
      const notice = page.locator("[data-notice='never']");
      await expect.poll(() => said(notice)).toContain("Not backed up yet");
      await expect.poll(() => said(notice)).toContain(
        "Take a first backup now.",
      );
      await expect(page.locator("[data-section='backups']")).toHaveCount(0);
      await expect.poll(() => said(page.locator("[data-fact='last-good']")))
        .toContain("Never");
      await expect.poll(() => said(page.locator("[data-fact='last-good']")))
        .not.toContain("No backup has finished yet");
      await expect(page.locator("[data-result='no-drills']")).toContainText(
        "No restore check has been run.",
      );
      await expect.poll(() => said(page.locator("[data-fact='restore-check']")))
        .toContain("Never run");
      await accessible(page);
      await page.mouse.move(5, 5);
      await still(page, "backups-never");
    });

    test("never backed up after a failed first run: the cause, and no raw answer", async ({ page }) => {
      await fixture(page, {
        status: {
          state: "failed",
          lastGoodBackupAt: null,
          lastAttemptAt: hoursAgo(1),
        },
        runs: [
          run(1, {
            status: "failed",
            failureCode: "disk_full",
            failureDetail: "no_space_left_on_device",
            locations: [],
            sizeBytes: null,
          }),
        ],
      });
      await page.goto("/installation/backups");
      const notice = page.locator("[data-notice='never']");
      await expect.poll(() => said(notice)).toContain(
        "The last backup failed: the server's disk was full. Free space on the server, then back up now.",
      );
      await expect.poll(() => said(body(page))).not.toContain(
        "no_space_left_on_device",
      );
      await noOverflow(page);
      await page.mouse.move(5, 5);
      await still(page, "backups-never-failed");
    });

    test("the other states: waiting, running, not copied and stale", async ({ page }) => {
      test.setTimeout(laneBudgetMs(180_000));
      const cases: {
        status: Record<string, unknown>;
        runs?: Run[];
        notice: string;
        said: string[];
        button: string;
      }[] = [
        {
          status: { state: "protected", waitingRunId: RUN_ID },
          notice: "waiting",
          said: [
            "Backup requested",
            "Waiting for the backup service to start it.",
            "It starts when the backup service picks it up.",
          ],
          button: "Backing up…",
        },
        {
          status: {
            state: "running",
            runningRunId: RUN_ID,
            runningProgressPercent: 42,
            maintenanceState: "draining",
          },
          notice: "running",
          said: [
            "Backing up now",
            "42% done.",
            "New work waits for a moment while the backup takes its snapshot.",
          ],
          button: "Backing up…",
        },
        {
          status: { state: "not_copied" },
          runs: [run(1, {
            failureCode: "destination_refused",
            locations: ["server-host"],
          })],
          notice: "not_copied",
          said: [
            "Backed up, but not copied off-site",
            "The off-site copy failed: the bucket refused the copy. Check the access key and the bucket in Settings.",
            "The copy on this server is good.",
          ],
          button: "Back up now",
        },
        {
          status: { state: "stale", lastGoodBackupAt: hoursAgo(24 * 9) },
          runs: [run(1, {
            status: "failed",
            failureCode: "destination_unreachable",
          })],
          notice: "stale",
          said: [
            "The last backup is 9 days old",
            "No backup has finished since",
            "The last attempt failed: the bucket could not be reached. Check the service address in Settings.",
          ],
          button: "Back up now",
        },
      ];
      for (const item of cases) {
        await page.unrouteAll();
        await fixture(page, { status: item.status, runs: item.runs });
        await page.goto("/installation/backups");
        const notice = page.locator(`[data-notice='${item.notice}']`);
        for (const words of item.said) {
          await expect.poll(() => said(body(page))).toContain(words);
        }
        await expect(notice).toBeVisible();
        const button = page.getByRole("button", { name: item.button });
        await expect(button).toBeVisible();
        if (item.button === "Backing up…") await expect(button).toBeDisabled();
        if (item.notice === "not_copied") {
          await page.mouse.move(5, 5);
          await still(page, "backups-not-copied");
        }
        if (item.notice === "stale") {
          await page.mouse.move(5, 5);
          await still(page, "backups-stale");
        }
      }
    });

    test("each failure cause says its sentence and its fix", async ({ page }) => {
      test.setTimeout(laneBudgetMs(180_000));
      const causes: [string, string][] = [
        [
          "destination_refused",
          "the bucket refused the copy. Check the access key and the bucket in Settings.",
        ],
        [
          "destination_unreachable",
          "the bucket could not be reached. Check the service address in Settings.",
        ],
        [
          "key_missing",
          "the server has no backup key. The guide says how to add one.",
        ],
        [
          "incomplete_set",
          "part of the installation could not be included, so this is not a usable backup. Back up again; if it repeats, see the guide.",
        ],
        [
          "drain_timeout",
          "running work did not pause in time. Back up again when less is running.",
        ],
        ["runner_error", "the backup service stopped with an error."],
      ];
      for (const [code, sentence] of causes) {
        await page.unrouteAll();
        await fixture(page, {
          status: { state: "failed" },
          runs: [run(1, { status: "failed", failureCode: code })],
        });
        await page.goto("/installation/backups");
        await expect.poll(() => said(page.locator("[data-notice='failed']")))
          .toContain(`The last backup failed: ${sentence}`);
      }
    });

    test("Back up now sends one Idempotency-Key and shows the busy state", async ({ page }) => {
      const sent = await fixture(page);
      await page.goto("/installation/backups");
      await page.getByRole("button", { name: "Back up now" }).click();
      await expect(page.locator("[data-notice='running']")).toBeVisible();
      await expect(page.getByRole("button", { name: "Backing up…" }))
        .toBeDisabled();
      expect(sent.starts).toHaveLength(1);
      expect(sent.starts[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
    });

    test("Back up now while one already waits is not an error", async ({ page }) => {
      const sent = await fixture(page, { startConflict: true });
      await page.goto("/installation/backups");
      await page.getByRole("button", { name: "Back up now" }).click();
      await expect.poll(() => sent.starts.length).toBe(1);
      await expect(page.locator("[data-result='start-failed']"))
        .toHaveCount(0);
    });

    test("restore checks: a failed row names its cause and the checks that did not pass", async ({ page }) => {
      await fixture(page, {
        drills: [
          drill(1, {
            outcome: "failed",
            failureCode: "key_mismatch",
            detail: "age: no identity matched",
            checksFailed: ["database", "files"],
          }),
          drill(2),
        ],
      });
      await page.goto("/installation/backups");
      const failed = page.locator("[data-drill]").first();
      await expect.poll(() => said(failed)).toContain("Failed");
      await expect.poll(() => said(failed)).toContain(
        "The backup key did not open the backup.",
      );
      await expect.poll(() => said(failed)).toContain(
        "Use the key file from the server that took this backup, then check it again.",
      );
      await expect.poll(() => said(failed)).toContain(
        "Did not pass: database, files",
      );
      await expect.poll(() => said(failed)).not.toContain(
        "age: no identity matched",
      );
      await expect.poll(() => said(page.locator("[data-fact='restore-check']")))
        .toContain("Failed");
      await expect.poll(() => said(page.locator("[data-drill]").nth(1)))
        .toContain("Backup was 2 hours old");
      await noOverflow(page);
      await page.mouse.move(5, 5);
      await still(page, "backups-drill-failed");
    });

    test("restore checks: every failure code says what to do next", async ({ page }) => {
      const fixes = {
        set_incomplete: "Take a new backup. This one cannot be restored.",
        key_mismatch:
          "Use the key file from the server that took this backup, then check it again.",
        migration_unsupported:
          "Install a release at least as new as the one that took the backup, then check it again.",
        cutoff_mismatch:
          "Take a new backup and check that one. Don't rely on this backup.",
        restore_failed:
          "Check it again. If it fails a second time, follow the guide.",
        references_missing:
          "Take a new backup and check that one. The guide says which files a backup must include.",
        drill_error:
          "Check it again. If it stops again, the server log says why.",
      };
      const codes = Object.keys(fixes) as (keyof typeof fixes)[];
      await fixture(page, {
        drills: codes.map((failureCode, index) =>
          drill(index + 1, { outcome: "failed", failureCode })
        ),
      });
      await page.goto("/installation/backups");
      for (const [index, code] of codes.entries()) {
        await expect.poll(() => said(page.locator("[data-drill]").nth(index)))
          .toContain(fixes[code]);
      }
      await expect(
        page.locator("[data-section='restore-checks']").getByRole("link", {
          name: "Read the guide",
        }),
      ).toHaveAttribute("href", /docs\/runbooks\/backups\.md/);
    });

    test("restore checks: a failure with no code still says what to do next", async ({ page }) => {
      await fixture(page, {
        drills: [drill(1, { outcome: "failed", failureCode: null })],
      });
      await page.goto("/installation/backups");
      await expect.poll(() => said(page.locator("[data-drill]").first()))
        .toMatch(/The check did not pass\..*Check it again\./);
      await page.mouse.move(5, 5);
      await still(page, "backups-drill-no-code");
    });

    test("a held restore offers Finish the restore", async ({ page }) => {
      await fixture(page, { restoreHeld: true });
      await page.goto("/installation/backups");
      const link = page.locator("[data-section='restoring']").getByRole(
        "link",
        {
          name: "Finish the restore",
        },
      );
      await expect(link).toHaveAttribute("href", "/installation/restore");
      await expect(link).toBeVisible();
    });

    test("a quiet service shows the warning badge", async ({ page }) => {
      await fixture(page, { status: { runnerLastUsedAt: hoursAgo(5) } });
      await page.goto("/installation/backups");
      await expect.poll(() => said(page.locator("[data-section='service']")))
        .toContain("Not heard from for 5 hours");
    });

    test("no backup service yet: the empty state, and the key shown once", async ({ page }) => {
      const sent = await fixture(page, {
        status: {
          runnerConfigured: false,
          runnerLastUsedAt: null,
          state: "failed",
          lastGoodBackupAt: null,
        },
        runs: [],
      });
      await page.goto("/installation/backups");
      await expect(
        page.getByRole("heading", { name: "Backups need the backup service" }),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "Back up now" }))
        .toHaveCount(0);
      await expect(page.getByRole("link", { name: "Read the guide" }))
        .toHaveAttribute("href", /docs\/runbooks\/backups\.md/);
      await accessible(page);
      await page.mouse.move(5, 5);
      await still(page, "backups-no-service");
      await page.getByRole("button", { name: "Make the key" }).click();
      const dialog = page.getByRole("dialog", {
        name: "The backup service key",
      });
      await expect(dialog).toBeVisible();
      await expect(dialog.locator("[data-value='runner-key']")).toHaveText(
        "bkr_live_9f3a7c1e5b2d8046a1c9e7f3b5d2a8c4",
      );
      await expect(dialog).toContainText(
        "Copy it now. Bakery cannot show it again.",
      );
      const done = dialog.getByRole("button", { name: "Done" });
      await expect(done).toBeEnabled();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeVisible();
      await done.click();
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(
        "Tick this once you have copied the key.",
      );
      await dialog.getByRole("checkbox", { name: "I have copied it" }).check();
      await expect(dialog).not.toContainText(
        "Tick this once you have copied the key.",
      );
      await expect(done).toBeEnabled();
      await page.mouse.move(5, 5);
      await still(page, "backups-key-dialog", dialog);
      await done.click();
      await expect(dialog).toHaveCount(0);
      expect(sent.credentials).toHaveLength(1);
      await expect(page.locator("body")).not.toContainText(
        "bkr_live_9f3a7c1e5b2d8046a1c9e7f3b5d2a8c4",
      );
      await expect.poll(() => said(page.locator("[data-section='service']")))
        .toContain(
          "Waiting for the backup service to sign in for the first time.",
        );
    });

    test("not an administrator: only the sentence, no page", async ({ page }) => {
      await fixture(page, { statusCode: 403 });
      await page.goto("/installation/backups");
      await expect(
        page.getByText("Only an installation administrator can see backups."),
      )
        .toBeVisible();
      await expect(page.getByRole("button", { name: "Back up now" }))
        .toHaveCount(0);
      await accessible(page);
      await still(page, "backups-forbidden");
    });

    test("load failed: Try again reads it again", async ({ page }) => {
      test.setTimeout(laneBudgetMs(120_000));
      const served = await fixture(page, { statusRefusedUntilRetried: true });
      await page.goto("/installation/backups");
      const failed = page.locator("[data-result='load-failed']");
      await expect(failed).toContainText("Backups could not be loaded.");
      const readsBefore = served.statusReads.length;
      served.stopRefusing();
      const tryAgain = failed.getByRole("button", { name: "Try again" });
      if (await tryAgain.isVisible()) {
        await tryAgain.click({ timeout: 5_000 }).catch(() => undefined);
      }
      await expect(page.locator("[data-notice='protected']")).toBeVisible();
      expect(served.statusReads.length).toBeGreaterThan(readsBefore);
    });

    test("loading: skeleton rows with the label", async ({ page }) => {
      let release = () => {};
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      await fixture(page, { hold });
      await page.goto("/installation/backups");
      await expect(page.getByLabel("Loading backups")).toBeVisible();
      release();
      await expect(page.locator("[data-notice='protected']")).toBeVisible();
    });

    test("Backups is second in Installation, after Installation settings", async ({ page }) => {
      test.skip(
        viewport.name !== "desktop",
        "the list is a sidebar on desktop only",
      );
      await fixture(page);
      await page.goto("/installation/backups");
      const links = page.getByRole("navigation", { name: "Installation" })
        .getByRole("link");
      await expect.poll(async () => (await links.allInnerTexts()).slice(0, 2))
        .toEqual(["Installation settings", "Backups"]);
    });
  });
}
