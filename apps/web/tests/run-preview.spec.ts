import { expect, type Page, test } from "@playwright/test";
import {
  MOCK_ORGANIZATION_ID,
  MOCK_PRINCIPAL_ID,
  mockAuthenticatedSession,
} from "./helpers/mock-session.ts";
import { still } from "./helpers/stills.ts";
import { laneBudgetMs } from "./helpers/lane-budget.ts";

// #19: the Preview card in a task's run pane. Everything the browser asks for
// is stubbed; the preview routes are the real shapes of previews.list,
// previews.access, previews.stop and previews.availability.

const taskId = "00000000-0000-4000-8000-000000000012";
const runId = "00000000-0000-4000-8000-000000000020";
const previewId = "00000000-0000-4000-8000-000000000050";
const stamp = "2026-01-01T00:00:00.000Z";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const EXCHANGE =
  "http://preview-0123456789.localhost:8789/_bakery/preview/exchange";

const task = {
  id: taskId,
  applicationId: "00000000-0000-4000-8000-000000000004",
  repositoryId: "00000000-0000-4000-8000-000000000005",
  conversationId: "00000000-0000-4000-8000-000000000006",
  parentTaskId: null,
  title: "Authoritative task",
  description: "Persisted description",
  taskType: "feature",
  status: "active",
  priority: 50,
  createdBy: MOCK_PRINCIPAL_ID,
  currentRunId: runId,
  archivedAt: null,
  createdAt: stamp,
  updatedAt: stamp,
  version: 1,
  repositoryProfileId: null,
  repositoryProfileRevision: null,
  repositoryProfileDigest: null,
  observationId: null,
  observationDigest: null,
  baseSha: null,
};
const run = {
  id: runId,
  taskId,
  workflowVersionId: "00000000-0000-4000-8000-000000000023",
  repositoryProfileId: null,
  repositoryProfileRevision: null,
  repositoryProfileDigest: null,
  observationId: null,
  observationDigest: null,
  baseSha: null,
  workspaceBaseSha: null,
  requestedBy: MOCK_PRINCIPAL_ID,
  inngestRunId: null,
  status: "running",
  budgetLimitUsd: "10.00",
  startedAt: stamp,
  finishedAt: null,
  createdAt: stamp,
  updatedAt: stamp,
  version: 1,
  budgetSummary: {
    installation: null,
    run: {
      scope: "run",
      runId,
      periodStart: null,
      periodEnd: null,
      limitUsd: "10",
      reservedUsd: "0",
      settledUsd: "1",
      availableUsd: "9",
      unknownCount: 0,
    },
  },
};

type Preview = {
  id: string;
  runId: string;
  attemptId: string;
  headSha: string;
  status: "starting" | "ready" | "stopped" | "expired";
  stopReason:
    | null
    | "person"
    | "run_cancelled"
    | "run_ended"
    | "machine_lost"
    | "time_limit"
    | "replaced";
  stoppedBy: string | null;
  stoppedByName: string | null;
  stoppedAt: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  version: number;
};

// Stills pin the clock (BAKERY_STILL_FIXED=1, with -g on the still tests) so
// every state reads the same time on desktop and phone. Timer tests never do.
const FIXED = Date.parse("2026-11-20T09:00:00.000Z");
const pinned = process.env.BAKERY_STILL_FIXED === "1";
const now = () => (pinned ? FIXED : Date.now());
const inMinutes = (minutes: number) =>
  new Date(now() + minutes * 60_000).toISOString();
const ago = (minutes: number) => inMinutes(-minutes);

const preview = (change: Partial<Preview> = {}): Preview => ({
  id: previewId,
  runId,
  attemptId: "00000000-0000-4000-8000-000000000032",
  headSha: SHA,
  status: "ready",
  stopReason: null,
  stoppedBy: null,
  stoppedByName: null,
  stoppedAt: null,
  expiresAt: inMinutes(90),
  createdAt: ago(10),
  updatedAt: ago(10),
  version: 1,
  ...change,
});

type World = {
  current: Preview | null;
  available: boolean;
  accessStatus: number;
  grantSeconds: number;
  stopped: number;
  accessCalls: number;
  stopStatus: number;
};

async function prepare(page: Page, initial: Partial<World> = {}) {
  const world: World = {
    current: preview(),
    available: true,
    accessStatus: 201,
    grantSeconds: 30,
    stopped: 0,
    accessCalls: 0,
    stopStatus: 201,
    ...initial,
  };
  await page.route(
    "**/v1/**",
    (route) => route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  if (pinned) await page.clock.install({ time: new Date(FIXED) });
  await mockAuthenticatedSession(page);
  await page.route(
    `**/v1/tasks/${taskId}`,
    (route) => route.fulfill({ json: task }),
  );
  await page.route(
    `**/v1/runs/${runId}`,
    (route) => route.fulfill({ json: run }),
  );
  await page.route(
    `**/v1/runs/${runId}/steps*`,
    (route) => route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.route(
    `**/v1/runs/${runId}/controls`,
    (route) => route.fulfill({ json: { runId, actions: [] } }),
  );
  await page.route("**/v1/sync*", (route) =>
    route.fulfill({
      json: {
        resourceState: {},
        highwater: "0",
        events: [],
        nextCursor: new URL(route.request().url()).searchParams.has("after")
          ? null
          : "cursor-0",
        resetRequired: false,
      },
    }));
  await page.routeWebSocket("**/v1/events?*", () => {});
  await page.route(
    "**/v1/preview-availability",
    (route) => route.fulfill({ json: { available: world.available } }),
  );
  await page.route(
    (url) =>
      url.pathname === "/v1/previews" &&
      url.searchParams.get("runId") === runId,
    (route) =>
      route.fulfill({
        json: {
          items: world.current === null ? [] : [world.current],
          nextCursor: null,
        },
      }),
  );
  await page.route(`**/v1/previews/${previewId}/access`, (route) => {
    world.accessCalls += 1;
    if (world.accessStatus !== 201) {
      return route.fulfill({
        status: world.accessStatus,
        contentType: "application/problem+json",
        body: JSON.stringify({
          type: "about:blank",
          title: "Conflict",
          status: world.accessStatus,
          code: "STATE_CONFLICT",
        }),
      });
    }
    return route.fulfill({
      status: 201,
      json: {
        grantId: "00000000-0000-4000-8000-000000000060",
        grant: "G".repeat(43),
        exchangeUrl: EXCHANGE,
        previewUrl: "http://preview-0123456789.localhost:8789/",
        expiresAt: new Date(now() + world.grantSeconds * 1000)
          .toISOString(),
        sessionSeconds: 3600,
      },
    });
  });
  await page.route(`**/v1/previews/${previewId}/stop`, (route) => {
    world.stopped += 1;
    if (world.stopStatus !== 201) {
      return route.fulfill({
        status: world.stopStatus,
        json: {
          type: "about:blank",
          title: "Conflict",
          status: world.stopStatus,
        },
      });
    }
    world.current = preview({
      status: "stopped",
      stopReason: "person",
      stoppedBy: MOCK_PRINCIPAL_ID,
      stoppedAt: new Date(now()).toISOString(),
      version: 2,
    });
    return route.fulfill({ status: 201, json: world.current });
  });
  return world;
}

const card = (page: Page) => page.getByTestId("run-preview");

/**
 * A still of the card alone. On a phone the run pane keeps a sticky header at
 * the top and a sticky composer at the bottom of the window, and either can lie
 * over the card; the window is made tall first (as stills do on a wide screen)
 * so nothing needs scrolling and nothing overlaps it.
 */
async function cardStill(page: Page, name: string) {
  const size = page.viewportSize();
  if (size !== null && size.width <= 743) {
    await page.setViewportSize({ width: size.width, height: 3200 });
  }
  await still(page, name, card(page));
}

test.beforeEach(async ({ page }, testInfo) => {
  testInfo.setTimeout(laneBudgetMs(60_000));
  if (testInfo.project.name === "desktop") {
    // Evidence at one scale: the desktop project at a phone's width, so the
    // phone stills are not the mobile project's 3x output.
    await page.setViewportSize(
      process.env.BAKERY_STILL_PHONE === "1"
        ? { width: 390, height: 844 }
        : { width: 1440, height: 900 },
    );
  }
});

test("a running preview names its commit, says it is not a release, and offers Prepare and Stop", async ({ page }) => {
  await prepare(page);
  await page.goto(`/tasks/${taskId}`);
  await expect(card(page)).toBeVisible({ timeout: 20_000 });
  await expect(
    card(page).getByRole("heading", { name: "Preview of this change" }),
  )
    .toBeVisible();
  await expect(card(page).getByText("Running", { exact: true })).toBeVisible();
  await expect(card(page).getByTestId("run-preview-identity")).toHaveText(
    "Commit 0123456 · not released",
  );
  await expect(card(page).getByTestId("run-preview-body")).toHaveText(
    "The app the agent is working on, as it runs now. It opens in a new tab on a separate address that cannot reach your Bakery account.",
  );
  await expect(
    card(page).getByText(
      /Stops by itself at .* \(in \d+ minutes\) or when the run ends\./,
    ),
  )
    .toBeVisible();
  await expect(card(page).getByRole("button", { name: "Prepare preview" }))
    .toBeEnabled();
  await expect(card(page).getByRole("button", { name: "Stop preview" }))
    .toBeVisible();
  // One status region announces the state; the countdown is not live.
  await expect(card(page).getByRole("status")).toHaveCount(1);
  // Nothing of the preview's address, route key or port is on the page.
  const text = await page.locator("body").innerText();
  expect(text).not.toContain("localhost:8789");
  expect(text).not.toContain("preview-0123456789");
  await cardStill(page, "run-preview-running");
  await still(page, "run-preview-in-pane");
});

test("opening is two steps and the grant travels in a form body to the preview's own origin", async ({ page }) => {
  await prepare(page);
  await page.goto(`/tasks/${taskId}`);
  await card(page).getByRole("button", { name: "Prepare preview" }).click();
  const open = card(page).getByRole("button", { name: "Open preview" });
  await expect(open).toBeVisible();
  await expect(card(page).getByRole("timer")).toContainText("expires in");
  await cardStill(page, "run-preview-ready");

  const posted = page.context().waitForEvent(
    "request",
    (request) => request.url().startsWith(EXCHANGE),
  );
  await page.context().route(
    `${EXCHANGE}**`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<p>ok</p>",
      }),
  );
  await open.click();
  const request = await posted;
  expect(request.method()).toBe("POST");
  // The grant is in the body and never in the address.
  expect(request.url()).toBe(EXCHANGE);
  expect(request.postData()).toBe(`grant=${"G".repeat(43)}`);
  await expect(
    card(page).getByText(
      "Preview opened in a new tab. You stay signed in to it for 1 hour, on this browser only.",
    ),
  ).toBeVisible();
  // The secret is gone from the page; opening again prepares a new grant.
  await expect(page.locator("body")).not.toContainText("G".repeat(43));
  await expect(page.locator(`input[value="${"G".repeat(43)}"]`)).toHaveCount(0);
  await expect(card(page).getByRole("button", { name: "Open again" }))
    .toBeVisible();
  await cardStill(page, "run-preview-opened");
});

test("stopping ends it for everyone, says who, and moves focus to the heading", async ({ page }) => {
  const world = await prepare(page);
  await page.goto(`/tasks/${taskId}`);
  await card(page).getByRole("button", { name: "Stop preview" }).click();
  await expect(card(page).getByText("Stopped", { exact: true })).toBeVisible();
  await expect(card(page).getByText(/^Stopped by you at /)).toBeVisible();
  await expect(
    card(page).getByText("Open tabs of this preview no longer load."),
  )
    .toBeVisible();
  await expect(
    card(page).getByText(
      "A new preview appears here when the agent starts the app again.",
    ),
  ).toBeVisible();
  await expect(card(page).getByRole("button")).toHaveCount(0);
  // Focus moves to the card, which is named by its heading.
  await expect(card(page)).toBeFocused();
  await expect(
    card(page).getByRole("heading", { name: "Preview of this change" }),
  )
    .toBeVisible();
  expect(world.stopped).toBe(1);
  await cardStill(page, "run-preview-stopped");
});

const REASONS: {
  name: string;
  change: Partial<Preview>;
  badge: string;
  text: RegExp | string;
  tabs: boolean;
}[] = [
  {
    name: "starting",
    change: { status: "starting" },
    badge: "Starting",
    text: "The agent is starting the app. This usually takes under a minute.",
    tabs: false,
  },
  {
    name: "stopped by a teammate",
    change: {
      status: "stopped",
      stopReason: "person",
      stoppedBy: "00000000-0000-4000-8000-000000000999",
      stoppedByName: "Dana Rivera",
      stoppedAt: ago(5),
    },
    badge: "Stopped",
    text: /^Stopped by Dana Rivera at /,
    tabs: true,
  },
  {
    // The person has since left: no name to show, so none is invented.
    name: "stopped by someone no longer known",
    change: {
      status: "stopped",
      stopReason: "person",
      stoppedBy: "00000000-0000-4000-8000-000000000998",
      stoppedByName: null,
      stoppedAt: ago(5),
    },
    badge: "Stopped",
    text: /^Stopped at /,
    tabs: true,
  },
  {
    name: "the run was cancelled",
    change: {
      status: "stopped",
      stopReason: "run_cancelled",
      stoppedAt: ago(5),
    },
    badge: "Stopped",
    text: /^Stopped when the run was cancelled at /,
    tabs: true,
  },
  {
    name: "replaced by a newer attempt",
    change: { status: "stopped", stopReason: "replaced", stoppedAt: ago(5) },
    badge: "Stopped",
    text: "A newer attempt replaced this preview.",
    tabs: true,
  },
  {
    name: "the machine was lost",
    change: {
      status: "stopped",
      stopReason: "machine_lost",
      stoppedAt: ago(5),
    },
    badge: "Not reachable",
    text:
      /The machine running this preview stopped answering at .*\.\s*The preview is offline\. If the run continues on another machine, a new preview appears here\./,
    tabs: false,
  },
  {
    name: "its time limit passed",
    change: { status: "expired", stopReason: "time_limit", stoppedAt: ago(5) },
    badge: "Ended",
    text: /^Ended at .*, its time limit\./,
    tabs: true,
  },
  {
    name: "the run ended",
    change: { status: "stopped", stopReason: "run_ended", stoppedAt: ago(5) },
    badge: "Ended",
    text: /^Ended at .*, when the run finished\./,
    tabs: true,
  },
];

for (const reason of REASONS) {
  test(`a preview that is not live never looks like one: ${reason.name}`, async ({ page }) => {
    await prepare(page, { current: preview(reason.change) });
    await page.goto(`/tasks/${taskId}`);
    await expect(card(page)).toBeVisible({ timeout: 20_000 });
    await expect(card(page).getByText(reason.badge, { exact: true }))
      .toBeVisible();
    await expect(card(page).getByTestId("run-preview-body")).toContainText(
      reason.text,
    );
    await expect(card(page).getByText("Running", { exact: true })).toHaveCount(
      0,
    );
    await expect(card(page).getByText(/Stops by itself/)).toHaveCount(0);
    await expect(card(page).getByTestId("run-preview-identity")).toContainText(
      "not released",
    );
    // One status region announces the state, whichever notice shows it too.
    await expect(card(page).getByRole("status")).toHaveCount(1);
    if (reason.name === "starting" || reason.name === "the machine was lost") {
      // Open is off, with its reason as the description, until the app runs
      // (starting) or a preview is back (not reachable). Nothing else to press.
      const prepareButton = card(page).getByRole("button", {
        name: "Prepare preview",
      });
      await expect(prepareButton).toBeDisabled();
      await expect(prepareButton).toHaveAccessibleDescription(
        reason.name === "starting"
          ? "Available once the app is running."
          : "Not available while the preview is offline.",
      );
      await expect(card(page).getByRole("button")).toHaveCount(1);
      await expect(card(page).getByRole("button", { name: "Stop preview" }))
        .toHaveCount(0);
    }
    if (reason.name !== "starting") {
      if (reason.name !== "the machine was lost") {
        await expect(card(page).getByRole("button")).toHaveCount(0);
      }
      // The not-reachable card already says a new preview may appear.
      await expect(
        card(page).getByText(
          "A new preview appears here when the agent starts the app again.",
        ),
      ).toHaveCount(reason.name === "the machine was lost" ? 0 : 1);
      await expect(
        card(page).getByText("Open tabs of this preview no longer load."),
      ).toHaveCount(reason.tabs ? 1 : 0);
    }
    if (reason.name === "starting") {
      await cardStill(page, "run-preview-starting");
    }
    if (reason.name === "the run was cancelled") {
      await cardStill(page, "run-preview-cancelled");
    }
    if (reason.name === "the machine was lost") {
      await cardStill(page, "run-preview-lost");
    }
    if (reason.name === "its time limit passed") {
      await cardStill(page, "run-preview-ended");
    }
  });
}

test("a deployment with no preview address says Not set up and offers nothing", async ({ page }) => {
  await prepare(page, { available: false });
  await page.goto(`/tasks/${taskId}`);
  await expect(card(page).getByText("Not set up", { exact: true })).toBeVisible(
    {
      timeout: 20_000,
    },
  );
  await expect(card(page).getByTestId("run-preview-body")).toHaveText(
    "Previews are not set up for this deployment, so the running app cannot be opened from here.",
  );
  await expect(
    card(page).getByText(
      "An administrator sets the preview address in the deployment settings.",
    ),
  ).toBeVisible();
  await expect(card(page).getByRole("button")).toHaveCount(0);
  await cardStill(page, "run-preview-not-set-up");
});

test("a run with no preview shows no card", async ({ page }) => {
  await prepare(page, { current: null });
  await page.goto(`/tasks/${taskId}`);
  await expect(page.getByText("Authoritative task").first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(card(page)).toHaveCount(0);
});

test("a preview that could not be opened says so and can be tried again", async ({ page }) => {
  const world = await prepare(page, { accessStatus: 409 });
  await page.goto(`/tasks/${taskId}`);
  await card(page).getByRole("button", { name: "Prepare preview" }).click();
  await expect(
    card(page).getByText("The preview could not be opened. Try again."),
  )
    .toBeVisible();
  await expect(card(page).getByRole("button", { name: "Prepare preview" }))
    .toBeEnabled();
  expect(world.accessCalls).toBe(1);
  await cardStill(page, "run-preview-open-failed");
  // It tries again, and this time the grant comes.
  world.accessStatus = 201;
  await card(page).getByRole("button", { name: "Prepare preview" }).click();
  await expect(card(page).getByRole("button", { name: "Open preview" }))
    .toBeVisible();
});

test("a stop that fails says so, keeps the preview running and can be tried again", async ({ page }) => {
  const world = await prepare(page, { stopStatus: 409 });
  await page.goto(`/tasks/${taskId}`);
  await card(page).getByRole("button", { name: "Stop preview" }).click();
  await expect(
    card(page).getByText("The preview could not be stopped. Try again."),
  ).toBeVisible();
  await expect(card(page).getByText("Running", { exact: true })).toBeVisible();
  await expect(card(page).getByRole("button", { name: "Stop preview" }))
    .toBeEnabled();
  expect(world.stopped).toBe(1);
  await cardStill(page, "run-preview-stop-failed");
  world.stopStatus = 201;
  await card(page).getByRole("button", { name: "Stop preview" }).click();
  await expect(card(page).getByText("Stopped", { exact: true })).toBeVisible();
});

test("a grant that is not used in its 30 seconds is dropped and the card says to prepare again", async ({ page }) => {
  await prepare(page, { grantSeconds: 2 });
  await page.goto(`/tasks/${taskId}`);
  await card(page).getByRole("button", { name: "Prepare preview" }).click();
  await expect(card(page).getByRole("button", { name: "Open preview" }))
    .toBeVisible();
  await expect(
    card(page).getByText(
      "The preview link expired. Prepare it again to open a new tab.",
    ),
  ).toBeVisible({ timeout: 10_000 });
  await expect(card(page).getByRole("button", { name: "Open preview" }))
    .toHaveCount(0);
  await expect(page.locator(`input[value="${"G".repeat(43)}"]`)).toHaveCount(0);
  await cardStill(page, "run-preview-link-expired");
});

test("a preview that reaches its time limit while the page is open changes without a reload", async ({ page }) => {
  const world = await prepare(page, {
    current: preview({ expiresAt: new Date(now() + 3000).toISOString() }),
  });
  await page.goto(`/tasks/${taskId}`);
  await expect(card(page).getByText("Running", { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  // The server now reads it as expired; the page was sent nothing.
  world.current = preview({
    status: "expired",
    stopReason: "time_limit",
    stoppedAt: new Date(now()).toISOString(),
    expiresAt: new Date(now() - 1000).toISOString(),
  });
  await expect(card(page).getByText("Ended", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(card(page).getByRole("button")).toHaveCount(0);
});

test("when the live reads drop the card says it is checking and Open stays off until it is read again", async ({ page }) => {
  await prepare(page);
  await page.goto(`/tasks/${taskId}`);
  await expect(card(page).getByRole("button", { name: "Prepare preview" }))
    .toBeEnabled({ timeout: 20_000 });
  await page.context().setOffline(true);
  await expect(card(page).getByTestId("run-preview-checking")).toHaveText(
    "Checking whether this is still running…",
  );
  await cardStill(page, "run-preview-checking");
  const prepareButton = card(page).getByRole("button", {
    name: "Prepare preview",
  });
  await expect(prepareButton).toBeDisabled();
  await expect(prepareButton).toHaveAccessibleDescription(
    "Available once this has been checked.",
  );
  await page.context().setOffline(false);
  await expect(prepareButton).toBeEnabled({ timeout: 15_000 });
  await expect(card(page).getByTestId("run-preview-checking")).toHaveCount(0);
});

/** The task's pull requests as `pullRequests.list` returns them, served from `world`. */
const NEWER = "fedcba9876543210fedcba9876543210fedcba98";
const pullRequestRow = (over: Record<string, unknown> = {}) => ({
  id: "00000000-0000-4000-8000-000000000070",
  taskId,
  repositoryId: "00000000-0000-4000-8000-000000000005",
  runId,
  providerNumber: 7,
  url: "https://github.com/o/r/pull/7",
  headSha: NEWER,
  baseSha: "1111111111111111111111111111111111111111",
  status: "open",
  mergedSha: null,
  createdAt: stamp,
  updatedAt: stamp,
  version: 1,
  mayMerge: false,
  mergeMethod: "squash",
  targetBranch: "main",
  ...over,
});

async function servePullRequests(
  page: Page,
  rows: { current: Record<string, unknown>[] },
) {
  await page.route(
    "**/v1/pull-requests?*",
    (route) =>
      route.fulfill({ json: { items: rows.current, nextCursor: null } }),
  );
}

test("a preview of an older commit says so, and still opens when the person chooses to", async ({ page }) => {
  await prepare(page);
  const rows = { current: [pullRequestRow()] };
  await servePullRequests(page, rows);
  await page.goto(`/tasks/${taskId}`);
  await expect(card(page).getByText("Older commit", { exact: true }))
    .toBeVisible({ timeout: 20_000 });
  await expect(card(page)).toHaveAttribute("data-preview-state", "running");
  await expect(card(page).getByTestId("run-preview-body")).toContainText(
    "This preview shows an older commit.",
  );
  await expect(card(page).getByTestId("run-preview-newer")).toHaveText(
    "The change is now at fedcba9. What you see here is not what would be released.",
  );
  // The preview's own commit and "not released" still show, and it is not "Running".
  await expect(card(page).getByTestId("run-preview-identity")).toHaveText(
    "Commit 0123456 · not released",
  );
  await expect(card(page).getByText("Running", { exact: true })).toHaveCount(0);
  await expect(card(page).getByRole("button", { name: "Stop preview" }))
    .toBeVisible();
  await expect(card(page).getByRole("status")).toHaveCount(1);
  await cardStill(page, "run-preview-older-commit");
  await still(page, "run-preview-older-commit-in-pane");
  // Opening anyway is still the two-step control, with the choice in its words.
  await card(page).getByRole("button", { name: "Prepare preview" }).click();
  await expect(
    card(page).getByRole("button", { name: "Open preview anyway" }),
  ).toBeVisible();
  // The change's pull request catches up with the preview: the notice goes.
  rows.current = [pullRequestRow({ headSha: SHA })];
  await expect(card(page).getByText("Older commit", { exact: true }))
    .toHaveCount(0, { timeout: 15_000 });
  await expect(card(page).getByTestId("run-preview-body")).toBeVisible();
});

for (
  const [name, rows] of [
    ["no pull request", []],
    ["a pull request at the preview's commit", [{ headSha: SHA }]],
    ["a pull request that was merged", [{ status: "merged" }]],
    ["a pull request that was closed", [{ status: "closed" }]],
  ] as const
) {
  test(`a running preview says nothing about commits when the change has ${name}`, async ({ page }) => {
    await prepare(page);
    await servePullRequests(page, {
      current: rows.map((over) => pullRequestRow(over)),
    });
    await page.goto(`/tasks/${taskId}`);
    await expect(card(page).getByText("Running", { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(card(page).getByText("Older commit")).toHaveCount(0);
    await expect(card(page).getByTestId("run-preview-newer")).toHaveCount(0);
    await expect(card(page).getByRole("button", { name: "Prepare preview" }))
      .toBeEnabled();
  });
}

test("a preview that is not live shows its own state, never the older-commit notice", async ({ page }) => {
  await prepare(page, {
    current: preview({
      status: "stopped",
      stopReason: "person",
      stoppedBy: MOCK_PRINCIPAL_ID,
      stoppedAt: ago(5),
    }),
  });
  await servePullRequests(page, { current: [pullRequestRow()] });
  await page.goto(`/tasks/${taskId}`);
  await expect(card(page).getByText("Stopped", { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await expect(card(page).getByText("Older commit")).toHaveCount(0);
});

test.afterEach(async ({ page }) => {
  await page.context().setOffline(false);
});

void MOCK_ORGANIZATION_ID;
