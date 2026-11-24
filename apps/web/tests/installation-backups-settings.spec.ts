import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { mockAuthenticatedSession } from "./helpers/mock-session.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { still } from "./helpers/stills.ts";

registerPageHealth(test);

const NOW = Date.now();
const hoursAgo = (hours: number) =>
  new Date(NOW - hours * 3_600_000).toISOString();

const SECRET_ID = "AKIAEXAMPLEKEYID0001";
const SECRET_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY0001";
const RUNNER_KEY = "bkr_live_9f3a7c1e5b2d8046a1c9e7f3b5d2a8c4";

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

const problem = (
  status: number,
  code: string,
  options: { reason?: string; issueCode?: string } = {},
) => ({
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
    ...(options.reason === undefined ? {} : { reason: options.reason }),
    ...(options.issueCode === undefined ? {} : {
      issues: [{
        path: ["endpoint"],
        code: options.issueCode,
        message: options.issueCode.replaceAll("_", " "),
      }],
    }),
  }),
});

type Recorded = {
  body: Record<string, unknown>;
  headers: Record<string, string>;
};

type Options = {
  schedule?: Record<string, unknown>;
  offsite?: Record<string, unknown>;
  pointInTime?: Record<string, unknown>;
  status?: Record<string, unknown>;
  scheduleReadStatus?: number;
  failScheduleReadsUntilRetry?: boolean;
  hold?: Promise<void>;
};

async function fixture(page: Page, options: Options = {}) {
  await mockAuthenticatedSession(page);
  const server = {
    schedule: {
      enabled: true,
      interval: "daily",
      timeOfDayUtc: "03:00",
      daysToKeep: 30,
      updatedAt: hoursAgo(100),
      version: 2,
      ...options.schedule,
    },
    offsite: {
      configured: true,
      endpoint: "https://s3.example.com",
      region: "eu-west-1",
      bucket: "bakery-backups",
      prefix: "",
      credentialUpdatedAt: hoursAgo(100),
      credentialRevision: 1,
      updatedAt: hoursAgo(100),
      version: 1,
      ...options.offsite,
    },
    pointInTime: {
      enabled: false,
      earliestRestorableAt: null,
      latestRestorableAt: null,
      reportedAt: null,
      updatedAt: null,
      version: 0,
      ...options.pointInTime,
    },
  };
  const sent = {
    schedule: [] as Recorded[],
    offsite: [] as Recorded[],
    pointInTime: [] as Recorded[],
    verify: [] as Recorded[],
    credentials: 0,
    reads: { schedule: 0 },
  };
  const next = {
    scheduleAnswer: null as ReturnType<typeof problem> | null,
    offsiteAnswer: null as ReturnType<typeof problem> | null,
    pointInTimeAnswer: null as ReturnType<typeof problem> | null,
    verifyAnswer: {
      outcome: "verified",
      detail: null,
      checkedAt: new Date().toISOString(),
    } as Record<string, unknown> | ReturnType<typeof problem>,
    staleSchedule: false,
    staleOffsite: false,
    stalePointInTime: false,
    failScheduleReads: options.failScheduleReadsUntilRetry === true,
  };
  await page.route(
    "**/v1/installation/status",
    (route) =>
      route.fulfill(json({
        bootstrapped: true,
        restoreHeld: false,
        updatePaused: false,
        release: "4f2a9c1e7b3d5a60c8e2f1d9b7a5c3e1f0d2b4a6",
      })),
  );
  await page.route(
    "**/v1/installation/restore",
    (route) => route.fulfill(problem(409, "RESTORE_NOT_HELD")),
  );
  await page.route(
    (url) => url.pathname === "/v1/installation/updates/status",
    (route) => route.fulfill(problem(403, "AUTH_FORBIDDEN")),
  );
  await page.route(
    (url) => url.pathname === "/v1/installation/backups/status",
    async (route) => {
      await options.hold;
      return route.fulfill(json({
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
        ...options.status,
      }));
    },
  );
  await page.route(
    (url) => url.pathname === "/v1/installation/backup-schedule",
    async (route) => {
      const request = route.request();
      if (request.method() === "PUT") {
        sent.schedule.push({
          body: request.postDataJSON(),
          headers: request.headers(),
        });
        if (next.staleSchedule) {
          next.staleSchedule = false;
          server.schedule = {
            ...server.schedule,
            enabled: false,
            interval: "weekly",
            timeOfDayUtc: "05:15",
            daysToKeep: 90,
            version: Number(server.schedule.version) + 1,
          };
          return route.fulfill(problem(412, "PRECONDITION_FAILED"));
        }
        if (next.scheduleAnswer !== null) {
          return route.fulfill(next.scheduleAnswer);
        }
        server.schedule = {
          ...server.schedule,
          ...request.postDataJSON(),
          updatedAt: new Date().toISOString(),
          version: Number(server.schedule.version) + 1,
        };
        return route.fulfill(json(server.schedule));
      }
      sent.reads.schedule += 1;
      if (options.scheduleReadStatus !== undefined) {
        return route.fulfill(
          problem(
            options.scheduleReadStatus,
            options.scheduleReadStatus === 403
              ? "AUTH_FORBIDDEN"
              : "DEPENDENCY_UNAVAILABLE",
          ),
        );
      }
      if (next.failScheduleReads) {
        return route.fulfill(problem(503, "DEPENDENCY_UNAVAILABLE"));
      }
      await options.hold;
      return route.fulfill(json(server.schedule));
    },
  );
  await page.route(
    (url) => url.pathname === "/v1/installation/backup-offsite",
    (route) => {
      const request = route.request();
      if (request.method() === "PUT") {
        sent.offsite.push({
          body: request.postDataJSON(),
          headers: request.headers(),
        });
        if (next.staleOffsite) {
          next.staleOffsite = false;
          server.offsite = {
            ...server.offsite,
            bucket: "their-bucket",
            version: Number(server.offsite.version) + 1,
          };
          return route.fulfill(problem(412, "PRECONDITION_FAILED"));
        }
        if (next.offsiteAnswer !== null) {
          return route.fulfill(next.offsiteAnswer);
        }
        const body = request.postDataJSON() as Record<string, unknown>;
        const keyed = body.accessKeyId !== undefined;
        server.offsite = {
          ...server.offsite,
          endpoint: body.endpoint,
          region: body.region,
          bucket: body.bucket,
          prefix: body.prefix ?? "",
          configured: keyed ? true : server.offsite.configured,
          credentialRevision: keyed
            ? Number(server.offsite.credentialRevision ?? 0) + 1
            : server.offsite.credentialRevision,
          updatedAt: new Date().toISOString(),
          version: Number(server.offsite.version) + 1,
        };
        return route.fulfill(json(server.offsite));
      }
      return route.fulfill(json(server.offsite));
    },
  );
  await page.route(
    (url) => url.pathname === "/v1/installation/backup-offsite/verification",
    (route) => {
      const request = route.request();
      sent.verify.push({ body: {}, headers: request.headers() });
      const answer = next.verifyAnswer;
      return "status" in answer && "body" in answer
        ? route.fulfill(answer as ReturnType<typeof problem>)
        : route.fulfill(json(answer));
    },
  );
  await page.route(
    (url) => url.pathname === "/v1/installation/backup-point-in-time",
    (route) => {
      const request = route.request();
      if (request.method() === "PUT") {
        sent.pointInTime.push({
          body: request.postDataJSON(),
          headers: request.headers(),
        });
        if (next.pointInTimeAnswer !== null) {
          return route.fulfill(next.pointInTimeAnswer);
        }
        const enabled = (request.postDataJSON() as { enabled: boolean })
          .enabled;
        server.pointInTime = {
          ...server.pointInTime,
          enabled,
          earliestRestorableAt: enabled ? hoursAgo(72) : null,
          latestRestorableAt: enabled ? hoursAgo(0.2) : null,
          reportedAt: enabled ? hoursAgo(0.1) : null,
          updatedAt: new Date().toISOString(),
          version: Number(server.pointInTime.version) + 1,
        };
        return route.fulfill(json(server.pointInTime));
      }
      return route.fulfill(json(server.pointInTime));
    },
  );
  await page.route(
    (url) => url.pathname === "/v1/installation/backup-runner/credential",
    (route) => {
      sent.credentials += 1;
      return route.fulfill(json({
        credential: RUNNER_KEY,
        generation: 4,
        issuedAt: new Date().toISOString(),
      }, 201));
    },
  );
  return { server, sent, next };
}

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

const said = (page: Page, selector: string) =>
  page.locator(selector).evaluate((element) =>
    (element as HTMLElement).innerText.replace(/\s+/g, " ")
  );

const schedule = (page: Page) => page.locator("[data-section='schedule']");
const offsite = (page: Page) => page.locator("[data-section='offsite']");
const pitr = (page: Page) => page.locator("[data-section='pitr']");
const service = (page: Page) => page.locator("[data-section='service']");

async function open(page: Page) {
  await page.goto("/installation/backups/settings");
  await expect(
    page.getByRole("heading", { name: "Backup settings", level: 1 }),
  ).toBeVisible();
  await expect(schedule(page)).toBeVisible();
}

async function fillKeys(page: Page) {
  await offsite(page).getByLabel("Access key ID").fill(SECRET_ID);
  await offsite(page).getByLabel("Secret access key").fill(SECRET_KEY);
}

async function noSecretsInPage(page: Page) {
  const html = await page.content();
  expect(html).not.toContain(SECRET_ID);
  expect(html).not.toContain(SECRET_KEY);
  const values = await page.evaluate(() =>
    [...document.querySelectorAll("input")].map((input) => input.value)
  );
  expect(values).not.toContain(SECRET_ID);
  expect(values).not.toContain(SECRET_KEY);
}

for (
  const viewport of [
    { name: "desktop", width: 1440, height: 900 },
    { name: "phone", width: 390, height: 844 },
  ]
) {
  test.describe(`${viewport.name}: backup settings`, () => {
    test.use({
      viewport: { width: viewport.width, height: viewport.height },
      timezoneId: "America/New_York",
    });

    test("default: the four sections show what is saved", async ({ page }) => {
      await fixture(page);
      await open(page);
      await expect(page.locator("main h1")).toHaveCount(1);
      await expect(page.getByRole("link", { name: "Back to Backups" }))
        .toHaveAttribute("href", "/installation/backups");
      await expect(schedule(page).getByLabel("Back up automatically"))
        .toBeChecked();
      await expect(schedule(page).getByLabel("How often")).toHaveValue(
        "daily",
      );
      await expect(schedule(page).getByLabel("At (UTC)")).toHaveValue("03:00");
      await expect.poll(() => said(page, "[data-section='schedule']"))
        .toMatch(/\d\d:\d\d your time\./);
      await expect(schedule(page).getByLabel("Keep each backup for"))
        .toHaveValue("30");
      await expect(offsite(page).getByLabel("Service address")).toHaveValue(
        "https://s3.example.com",
      );
      await expect(offsite(page).getByLabel("Region")).toHaveValue(
        "eu-west-1",
      );
      await expect(offsite(page).getByLabel("Bucket")).toHaveValue(
        "bakery-backups",
      );
      await expect(offsite(page).getByLabel("Access key ID")).toHaveValue("");
      await expect(offsite(page).getByLabel("Secret access key")).toHaveValue(
        "",
      );
      await expect.poll(() => said(page, "[data-section='offsite']"))
        .toContain("Saved. Enter a new one to replace it.");
      await expect(pitr(page).getByLabel("Keep a running record"))
        .not.toBeChecked();
      await expect.poll(() => said(page, "[data-section='service']"))
        .toContain("A key is in use.");
      await expect.poll(() => said(page, "[data-section='service']"))
        .toContain("Last used");
      await noOverflow(page);
      await accessible(page);
      await page.mouse.move(5, 5);
      await still(page, "settings-default");
    });

    test("schedule: saves by itself with its body, key and version", async ({ page }) => {
      const { sent } = await fixture(page);
      await open(page);
      await schedule(page).getByLabel("How often").selectOption("weekly");
      await schedule(page).getByLabel("At (UTC)").fill("04:30");
      await schedule(page).getByLabel("Keep each backup for").fill("45");
      await schedule(page).getByRole("button", { name: "Save schedule" })
        .click();
      await expect(schedule(page).locator("[data-result='saved']"))
        .toContainText("Schedule saved.");
      expect(sent.schedule).toHaveLength(1);
      expect(sent.schedule[0].body).toEqual({
        enabled: true,
        interval: "weekly",
        timeOfDayUtc: "04:30",
        daysToKeep: 45,
      });
      expect(sent.schedule[0].headers["if-match"]).toBe('"v2"');
      expect(sent.schedule[0].headers["idempotency-key"]).toMatch(
        /^[0-9a-f-]{36}$/,
      );
      expect(sent.offsite).toHaveLength(0);
      expect(sent.pointInTime).toHaveLength(0);
      await expect(schedule(page).getByLabel("How often")).toHaveValue(
        "weekly",
      );
    });

    test("schedule: hourly asks for minutes and off keeps the other values", async ({ page }) => {
      const { sent } = await fixture(page);
      await open(page);
      await schedule(page).getByLabel("Back up automatically").uncheck();
      await schedule(page).getByLabel("How often").selectOption("hourly");
      await expect(schedule(page).getByLabel("Minutes past the hour"))
        .toBeVisible();
      await schedule(page).getByLabel("Minutes past the hour").fill("15");
      await schedule(page).getByRole("button", { name: "Save schedule" })
        .click();
      await expect(schedule(page).locator("[data-result='saved']"))
        .toBeVisible();
      expect(sent.schedule[0].body).toEqual({
        enabled: false,
        interval: "hourly",
        timeOfDayUtc: "00:15",
        daysToKeep: 30,
      });
    });

    test("schedule: validation in words, and nothing is sent", async ({ page }) => {
      const { sent } = await fixture(page);
      await open(page);
      const save = schedule(page).getByRole("button", {
        name: "Save schedule",
      });
      await schedule(page).getByLabel("At (UTC)").fill("25:00");
      await expect.poll(() => said(page, "[data-section='schedule']"))
        .toContain("Enter a time from 00:00 to 23:59.");
      await expect(save).toBeDisabled();
      await schedule(page).getByLabel("At (UTC)").fill("03:00");
      await schedule(page).getByLabel("Keep each backup for").fill("0");
      await expect.poll(() => said(page, "[data-section='schedule']"))
        .toContain("Enter a whole number of days from 1 to 3650.");
      await schedule(page).getByLabel("Keep each backup for").fill("3651");
      await expect(save).toBeDisabled();
      await page.mouse.move(5, 5);
      await still(page, "settings-validation");
      expect(sent.schedule).toHaveLength(0);
    });

    test("schedule: someone else saved first, their values are shown", async ({ page }) => {
      const { sent, next } = await fixture(page);
      next.staleSchedule = true;
      await open(page);
      await schedule(page).getByLabel("Keep each backup for").fill("45");
      await schedule(page).getByRole("button", { name: "Save schedule" })
        .click();
      const toast = schedule(page).locator("[data-result='stale']");
      await expect(toast).toContainText(
        "Schedule was changed by someone else. Their values are shown; make your change again.",
      );
      await expect(schedule(page).getByLabel("How often")).toHaveValue(
        "weekly",
      );
      await expect(schedule(page).getByLabel("At (UTC)")).toHaveValue("05:15");
      await expect(schedule(page).getByLabel("Keep each backup for"))
        .toHaveValue("90");
      await expect(schedule(page).getByLabel("Back up automatically"))
        .not.toBeChecked();
      expect(sent.schedule).toHaveLength(1);
      await page.mouse.move(5, 5);
      await still(page, "settings-stale");
      await schedule(page).getByLabel("Keep each backup for").fill("60");
      await schedule(page).getByRole("button", { name: "Save schedule" })
        .click();
      await expect(schedule(page).locator("[data-result='saved']"))
        .toBeVisible();
      expect(sent.schedule[1].headers["if-match"]).toBe('"v3"');
    });

    test("off-site: validation in words, the keys go together", async ({ page }) => {
      const { sent } = await fixture(page);
      await open(page);
      const save = offsite(page).getByRole("button", {
        name: "Save off-site copy",
      });
      await offsite(page).getByLabel("Service address").fill(
        "http://s3.example.com",
      );
      await expect.poll(() => said(page, "[data-section='offsite']"))
        .toContain("Start the address with https://.");
      await expect(save).toBeDisabled();
      await offsite(page).getByLabel("Service address").fill(
        "https://s3.example.com/bucket",
      );
      await expect.poll(() => said(page, "[data-section='offsite']"))
        .toContain("Use only the address, such as https://s3.example.com.");
      await offsite(page).getByLabel("Service address").fill(
        "https://s3.example.org",
      );
      await expect.poll(() => said(page, "[data-section='offsite']"))
        .toContain("Enter both keys.");
      await expect(save).toBeDisabled();
      await offsite(page).getByLabel("Access key ID").fill(SECRET_ID);
      await expect.poll(() => said(page, "[data-section='offsite']"))
        .toContain("Enter both keys.");
      await expect(save).toBeDisabled();
      await offsite(page).getByLabel("Bucket").fill("Bad_Bucket");
      await expect.poll(() => said(page, "[data-section='offsite']"))
        .toContain("Use 3 to 63 lowercase letters");
      await page.mouse.move(5, 5);
      await still(page, "settings-offsite-validation");
      expect(sent.offsite).toHaveLength(0);
    });

    test("off-site: saves with the keys, then clears them and never shows them", async ({ page }) => {
      const { sent } = await fixture(page);
      await open(page);
      await offsite(page).getByLabel("Service address").fill(
        "https://s3.example.org",
      );
      await offsite(page).getByLabel("Folder (optional)").fill("bakery/prod");
      await fillKeys(page);
      await offsite(page).getByRole("button", { name: "Save off-site copy" })
        .click();
      await expect(offsite(page).locator("[data-result='saved']"))
        .toContainText("Off-site copy saved.");
      expect(sent.offsite).toHaveLength(1);
      expect(sent.offsite[0].body).toEqual({
        endpoint: "https://s3.example.org",
        region: "eu-west-1",
        bucket: "bakery-backups",
        prefix: "bakery/prod",
        accessKeyId: SECRET_ID,
        secretAccessKey: SECRET_KEY,
      });
      expect(sent.offsite[0].headers["if-match"]).toBe('"v1"');
      expect(sent.offsite[0].headers["idempotency-key"]).toMatch(
        /^[0-9a-f-]{36}$/,
      );
      await expect(offsite(page).getByLabel("Access key ID")).toHaveValue("");
      await expect(offsite(page).getByLabel("Secret access key")).toHaveValue(
        "",
      );
      await expect(offsite(page).getByLabel("Service address")).toHaveValue(
        "https://s3.example.org",
      );
      await expect.poll(() => said(page, "[data-section='offsite']"))
        .toContain("Saved. Enter a new one to replace it.");
      await noSecretsInPage(page);
    });

    test("off-site: a folder-only change keeps the saved keys and sends none", async ({ page }) => {
      const { sent } = await fixture(page);
      await open(page);
      await offsite(page).getByLabel("Folder (optional)").fill("bakery/prod");
      await offsite(page).getByRole("button", { name: "Save off-site copy" })
        .click();
      await expect(offsite(page).locator("[data-result='saved']"))
        .toBeVisible();
      expect(sent.offsite[0].body).toEqual({
        endpoint: "https://s3.example.com",
        region: "eu-west-1",
        bucket: "bakery-backups",
        prefix: "bakery/prod",
      });
    });

    test("off-site: a new bucket needs its keys again", async ({ page }) => {
      const { sent } = await fixture(page);
      await open(page);
      await offsite(page).getByLabel("Bucket").fill("another-bucket");
      await expect.poll(() => said(page, "[data-section='offsite']"))
        .toContain("A new address, region or bucket needs its keys again.");
      await expect(
        offsite(page).getByRole("button", { name: "Save off-site copy" }),
      ).toBeDisabled();
      expect(sent.offsite).toHaveLength(0);
    });

    test("off-site: a refused save clears the typed keys and says so", async ({ page }) => {
      const { next, sent } = await fixture(page);
      next.offsiteAnswer = problem(422, "UNPROCESSABLE", {
        issueCode: "credentials_required",
      });
      await open(page);
      await fillKeys(page);
      await offsite(page).getByRole("button", { name: "Save off-site copy" })
        .click();
      const toast = offsite(page).locator(
        "[data-result='credentialsRequired']",
      );
      await expect(toast).toContainText(
        "A new address, region or bucket needs its keys entered again.",
      );
      await expect(toast).toContainText("Your keys were cleared.");
      await expect(offsite(page).getByLabel("Access key ID")).toHaveValue("");
      await expect(offsite(page).getByLabel("Secret access key")).toHaveValue(
        "",
      );
      expect(sent.offsite).toHaveLength(1);
      await noSecretsInPage(page);
    });

    test("off-site: someone else saved first, their values are shown", async ({ page }) => {
      const { next } = await fixture(page);
      next.staleOffsite = true;
      await open(page);
      await offsite(page).getByLabel("Region").fill("us-east-1");
      await fillKeys(page);
      await offsite(page).getByRole("button", { name: "Save off-site copy" })
        .click();
      await expect(offsite(page).locator("[data-result='stale']"))
        .toContainText(
          "Off-site copy was changed by someone else. Their values are shown; make your change again.",
        );
      await expect(offsite(page).getByLabel("Bucket")).toHaveValue(
        "their-bucket",
      );
      await expect(offsite(page).getByLabel("Region")).toHaveValue(
        "eu-west-1",
      );
      await noSecretsInPage(page);
    });

    test("off-site: the server has no secrets key", async ({ page }) => {
      const { next } = await fixture(page, {
        offsite: {
          configured: false,
          endpoint: null,
          region: null,
          bucket: null,
          prefix: null,
          credentialUpdatedAt: null,
          credentialRevision: null,
          updatedAt: null,
          version: 0,
        },
      });
      next.offsiteAnswer = problem(409, "STATE_CONFLICT");
      await open(page);
      await offsite(page).getByLabel("Service address").fill(
        "https://s3.example.org",
      );
      await offsite(page).getByLabel("Region").fill("eu-west-1");
      await offsite(page).getByLabel("Bucket").fill("bakery-backups");
      await fillKeys(page);
      await offsite(page).getByRole("button", { name: "Save off-site copy" })
        .click();
      await expect(offsite(page).locator("[data-result='unavailable']"))
        .toContainText(
          "This server cannot store the bucket's keys yet. The guide says how to set that up.",
        );
      await noSecretsInPage(page);
    });

    test("off-site: the first save sends no If-Match", async ({ page }) => {
      const { sent } = await fixture(page, {
        offsite: {
          configured: false,
          endpoint: null,
          region: null,
          bucket: null,
          prefix: null,
          credentialUpdatedAt: null,
          credentialRevision: null,
          updatedAt: null,
          version: 0,
        },
      });
      await open(page);
      await expect.poll(() => said(page, "[data-section='offsite']"))
        .toContain("Not saved yet.");
      await offsite(page).getByLabel("Service address").fill(
        "https://s3.example.org",
      );
      await offsite(page).getByLabel("Region").fill("eu-west-1");
      await offsite(page).getByLabel("Bucket").fill("bakery-backups");
      await fillKeys(page);
      await offsite(page).getByRole("button", { name: "Save off-site copy" })
        .click();
      await expect(offsite(page).locator("[data-result='saved']"))
        .toBeVisible();
      expect(sent.offsite[0].headers["if-match"]).toBeUndefined();
      expect(sent.offsite[0].body.prefix).toBe("");
    });

    test("off-site: a test passes and shows the time", async ({ page }) => {
      const { sent } = await fixture(page);
      await open(page);
      await offsite(page).getByRole("button", { name: "Send a test" }).click();
      await expect(offsite(page).locator("[data-outcome='verified']"))
        .toContainText("Test passed");
      expect(sent.verify).toHaveLength(1);
      expect(sent.verify[0].headers["idempotency-key"]).toMatch(
        /^[0-9a-f-]{36}$/,
      );
      await page.mouse.move(5, 5);
      await still(page, "settings-offsite-saved");
    });

    test("off-site: each refused test says what to do", async ({ page }) => {
      test.setTimeout(120_000);
      const { next } = await fixture(page);
      await open(page);
      const outcomes: [string, string | null, string][] = [
        ["not_configured", null, "Save the off-site copy first."],
        [
          "destination_refused",
          "AccessDenied: the bucket does not exist",
          "The service answered and said no: a wrong key, no access or a missing bucket. Its answer follows.",
        ],
        [
          "destination_unreachable",
          null,
          "The service could not be reached. Check the address.",
        ],
        [
          "destination_private_address",
          null,
          "That address is inside a private network. Bakery only sends backups to a public address.",
        ],
        [
          "integrity_failed",
          null,
          "The test file came back changed. Do not use this bucket for backups.",
        ],
      ];
      for (const [outcome, detail, words] of outcomes) {
        next.verifyAnswer = {
          outcome,
          detail,
          checkedAt: new Date().toISOString(),
        };
        await offsite(page).getByRole("button", { name: "Send a test" })
          .click();
        const result = offsite(page).locator(`[data-outcome='${outcome}']`);
        await expect(result).toContainText(words);
        if (detail !== null) await expect(result).toContainText(detail);
        if (outcome === "destination_refused") {
          await page.mouse.move(5, 5);
          await still(page, "settings-test-refused");
        }
      }
    });

    test("off-site: a test on a server with no secrets key says so", async ({ page }) => {
      const { next } = await fixture(page);
      next.verifyAnswer = problem(409, "STATE_CONFLICT");
      await open(page);
      await offsite(page).getByRole("button", { name: "Send a test" }).click();
      await expect(offsite(page).locator("[data-result='unavailable']"))
        .toContainText("This server cannot store the bucket's keys yet.");
    });

    test("running record: turning it on saves at once and shows the window", async ({ page }) => {
      const { sent } = await fixture(page);
      await open(page);
      await pitr(page).getByLabel("Keep a running record").click();
      await expect(pitr(page).locator("[data-result='saved']"))
        .toContainText("The running record is on.");
      expect(sent.pointInTime[0].body).toEqual({ enabled: true });
      expect(sent.pointInTime[0].headers["if-match"]).toBeUndefined();
      expect(sent.pointInTime[0].headers["idempotency-key"]).toMatch(
        /^[0-9a-f-]{36}$/,
      );
      await expect.poll(() => said(page, "[data-section='pitr']")).toContain(
        "A restore can go back to any minute from",
      );
      await expect.poll(() => said(page, "[data-section='pitr']")).toContain(
        "(UTC).",
      );
      await expect.poll(() => said(page, "[data-section='pitr']")).toContain(
        "Reported by the backup service",
      );
    });

    test("running record: on with nothing reported yet waits", async ({ page }) => {
      await fixture(page, { pointInTime: { enabled: true, version: 1 } });
      await open(page);
      await expect(pitr(page).locator("[data-result='pitr-waiting']"))
        .toContainText("Waiting for the backup service to report.");
    });

    test("running record: turning it off asks first", async ({ page }) => {
      const { sent } = await fixture(page, {
        pointInTime: {
          enabled: true,
          earliestRestorableAt: hoursAgo(72),
          latestRestorableAt: hoursAgo(0.2),
          reportedAt: hoursAgo(0.1),
          version: 3,
        },
      });
      await open(page);
      await pitr(page).getByLabel("Keep a running record").click();
      const dialog = page.getByRole("alertdialog", {
        name: "Turn off the running record?",
      });
      await expect(dialog).toContainText(
        "Bakery forgets the running record. Restores go back to a backup only.",
      );
      expect(sent.pointInTime).toHaveLength(0);
      await page.mouse.move(5, 5);
      await still(page, "settings-confirm-off", dialog);
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(pitr(page).getByLabel("Keep a running record"))
        .toBeChecked();
      expect(sent.pointInTime).toHaveLength(0);
      await pitr(page).getByLabel("Keep a running record").click();
      await dialog.getByRole("button", { name: "Turn off" }).click();
      await expect(pitr(page).locator("[data-result='saved']"))
        .toContainText("The running record is off.");
      expect(sent.pointInTime).toHaveLength(1);
      expect(sent.pointInTime[0].body).toEqual({ enabled: false });
      expect(sent.pointInTime[0].headers["if-match"]).toBe('"v3"');
      await expect(pitr(page).getByLabel("Keep a running record"))
        .not.toBeChecked();
    });

    test("backup service: replacing the key asks, then shows it once", async ({ page }) => {
      const { sent } = await fixture(page);
      await open(page);
      await service(page).getByRole("button", { name: "Replace the key…" })
        .click();
      const ask = page.getByRole("alertdialog", {
        name: "Replace the backup service's key?",
      });
      await expect(ask).toContainText(
        "The old key stops working at once. Backups stop until the new key is on the server.",
      );
      await page.mouse.move(5, 5);
      await still(page, "settings-replace-key", ask);
      await ask.getByRole("button", { name: "Cancel" }).click();
      await expect(ask).toHaveCount(0);
      expect(sent.credentials).toBe(0);
      await service(page).getByRole("button", { name: "Replace the key…" })
        .click();
      await ask.getByRole("button", { name: "Replace" }).click();
      const shown = page.getByRole("dialog", {
        name: "The backup service key",
      });
      await expect(shown.locator("[data-value='runner-key']")).toHaveText(
        RUNNER_KEY,
      );
      expect(sent.credentials).toBe(1);
      await expect(shown).toContainText(
        "Copy it now. Bakery cannot show it again.",
      );
      await page.mouse.move(5, 5);
      await still(page, "settings-key-shown", shown);
      await shown.getByRole("button", { name: "Done" }).click();
      await expect(shown).toContainText(
        "Tick this once you have copied the key.",
      );
      await shown.getByRole("checkbox", { name: "I have copied it" }).check();
      await shown.getByRole("button", { name: "Done" }).click();
      await expect(shown).toHaveCount(0);
      await expect(page.locator("body")).not.toContainText(RUNNER_KEY);
      await expect.poll(() => said(page, "[data-section='service']"))
        .toMatch(/Key 4, made .* UTC/);
    });

    test("not an administrator: only the sentence", async ({ page }) => {
      await fixture(page, { scheduleReadStatus: 403 });
      await page.goto("/installation/backups/settings");
      await expect(
        page.getByText("Only an installation administrator can see backups."),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "Save schedule" }))
        .toHaveCount(0);
      await page.mouse.move(5, 5);
      await still(page, "settings-forbidden");
    });

    test("load failed: Try again reads it again", async ({ page }) => {
      const { next, sent } = await fixture(page, {
        failScheduleReadsUntilRetry: true,
      });
      await page.goto("/installation/backups/settings");
      const failed = page.locator("[data-result='load-failed']");
      await expect(failed).toContainText(
        "Backup settings could not be loaded.",
      );
      const reads = sent.reads.schedule;
      next.failScheduleReads = false;
      await failed.getByRole("button", { name: "Try again" }).click();
      await expect(schedule(page)).toBeVisible();
      expect(sent.reads.schedule).toBeGreaterThan(reads);
    });

    test("loading: skeleton rows with the label", async ({ page }) => {
      let release: () => void = () => undefined;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      await fixture(page, { hold });
      await page.goto("/installation/backups/settings");
      await expect(page.getByLabel("Loading backup settings")).toBeVisible();
      release();
      await expect(schedule(page)).toBeVisible();
    });

    test("offline: the notice shows and every button is off", async ({ page }) => {
      await fixture(page);
      await open(page);
      await page.context().setOffline(true);
      await expect(page.locator("[data-result='offline']")).toContainText(
        "You are offline. This may be out of date.",
      );
      for (
        const name of [
          "Save schedule",
          "Save off-site copy",
          "Send a test",
          "Replace the key…",
        ]
      ) {
        await expect(page.getByRole("button", { name })).toBeDisabled();
      }
      await expect(pitr(page).getByLabel("Keep a running record"))
        .toBeDisabled();
      await expect(schedule(page).getByLabel("Back up automatically"))
        .toBeDisabled();
      await page.context().setOffline(false);
    });

    test("Back to Backups leads to the Backups page", async ({ page }) => {
      await fixture(page);
      await open(page);
      await page.getByRole("link", { name: "Back to Backups" }).click();
      await expect(page).toHaveURL(/\/installation\/backups$/);
    });

    if (viewport.name === "phone") {
      test("phone: one column, buttons at least 44px", async ({ page }) => {
        await fixture(page);
        await open(page);
        for (
          const name of ["Save schedule", "Save off-site copy", "Send a test"]
        ) {
          const box = await page.getByRole("button", { name }).boundingBox();
          expect(box!.height).toBeGreaterThanOrEqual(44);
        }
        const lefts = await page.locator("[data-section]").evaluateAll(
          (nodes) =>
            nodes.map((node) => Math.round(node.getBoundingClientRect().left)),
        );
        expect(new Set(lefts).size).toBe(1);
        await noOverflow(page);
        await accessible(page);
      });
    }
  });
}
