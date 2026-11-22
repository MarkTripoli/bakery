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
  // Required since #921: the run's pinned environment.
  environment: "live",
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
  /** When set, the stop answers only after this settles. */
  stopHold: Promise<void> | null;
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
    stopHold: null,
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
  await page.route(`**/v1/previews/${previewId}/stop`, async (route) => {
    world.stopped += 1;
    await world.stopHold;
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

const details = (page: Page) => card(page).getByTestId("run-preview-details");
/** Opens the card's Details; its facts and Stop preview are not read while it is closed. */
async function openDetails(page: Page) {
  await details(page).locator("summary").click();
}
const actions = (page: Page) =>
  card(page).getByRole("button", { name: /Prepare preview|Open|Stop preview/ });

test("a running preview says one thing and offers one button; its facts wait in Details", async ({ page }) => {
  await prepare(page);
  await page.goto(`/tasks/${taskId}`);
  await expect(card(page)).toBeVisible({ timeout: 20_000 });
  await expect(
    card(page).getByRole("heading", { name: "Preview of this change" }),
  ).toBeVisible();
  await expect(card(page).getByText("Running", { exact: true })).toBeVisible();
  await expect(card(page).getByTestId("run-preview-body")).toHaveText(
    "The app the agent is working on, as it runs now.",
  );
  // One button on the face; the commit, the stop time and Stop are in Details.
  await expect(actions(page)).toHaveCount(1);
  await expect(card(page).getByRole("button", { name: "Prepare preview" }))
    .toBeEnabled();
  await expect(card(page).getByText("not released")).toBeHidden();
  await expect(card(page).getByRole("button", { name: "Stop preview" }))
    .toBeHidden();
  // One status region announces the state; the countdown is not live.
  await expect(card(page).getByRole("status")).toHaveCount(1);
  // Nothing of the preview's address, route key or port is on the page.
  const text = await page.locator("body").innerText();
  expect(text).not.toContain("localhost:8789");
  expect(text).not.toContain("preview-0123456789");
  await cardStill(page, "run-preview-running");
  await still(page, "run-preview-in-pane");
  await openDetails(page);
  await expect(details(page).getByText("0123456, not released")).toBeVisible();
  await expect(
    details(page).getByText(/\(in \d+ minutes\) or when the run ends/),
  )
    .toBeVisible();
  await expect(details(page).getByText("separate from your Bakery account"))
    .toBeVisible();
  await expect(card(page).getByRole("button", { name: "Stop preview" }))
    .toBeVisible();
  await cardStill(page, "run-preview-running-details");
});

test("opening is two steps and the grant travels in a form body to the preview's own origin", async ({ page }) => {
  await prepare(page);
  await page.goto(`/tasks/${taskId}`);
  await card(page).getByRole("button", { name: "Prepare preview" }).click();
  const open = card(page).getByRole("button", { name: "Open preview" });
  await expect(open).toBeVisible();
  await expect(actions(page)).toHaveCount(1);
  await expect(card(page).getByRole("timer")).toHaveText(
    /Opens in a new tab\. This link expires in \d+ seconds?\./,
  );
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
  await expect(card(page).getByTestId("run-preview-body")).toHaveText(
    "Opened in a new tab. You stay signed in to it for 1 hour, on this browser only.",
  );
  // The secret is gone from the page; opening again prepares a new grant.
  await expect(page.locator("body")).not.toContainText("G".repeat(43));
  await expect(page.locator(`input[value="${"G".repeat(43)}"]`)).toHaveCount(0);
  await expect(actions(page)).toHaveCount(1);
  await expect(card(page).getByRole("button", { name: "Open again" }))
    .toBeVisible();
  await cardStill(page, "run-preview-opened");
});

test("stopping from Details ends it for everyone, says who, and moves focus to the heading", async ({ page }) => {
  const world = await prepare(page);
  await page.goto(`/tasks/${taskId}`);
  await openDetails(page);
  await card(page).getByRole("button", { name: "Stop preview" }).click();
  await expect(card(page).getByText("Stopped", { exact: true })).toBeVisible();
  await expect(card(page).getByTestId("run-preview-body")).toHaveText(
    /^Stopped by you at .+ A new preview appears here when the agent starts the app again\.$/,
  );
  await expect(actions(page)).toHaveCount(0);
  // Details stays open, and now says what stopping did to open tabs.
  await expect(
    card(page).getByText("Open tabs of this preview no longer load."),
  ).toBeVisible();
  // Focus moves to the card, which is named by its heading.
  await expect(card(page)).toBeFocused();
  await expect(
    card(page).getByRole("heading", { name: "Preview of this change" }),
  ).toBeVisible();
  expect(world.stopped).toBe(1);
  await cardStill(page, "run-preview-stopped");
});

const AGAIN = "A new preview appears here when the agent starts the app again.";
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
    text: new RegExp(`^Stopped by Dana Rivera at .+ ${AGAIN}$`),
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
    text: new RegExp(`^Stopped at .+ ${AGAIN}$`),
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
    text: new RegExp(`^Stopped when the run was cancelled at .+ ${AGAIN}$`),
    tabs: true,
  },
  {
    name: "replaced by a newer attempt",
    change: { status: "stopped", stopReason: "replaced", stoppedAt: ago(5) },
    badge: "Stopped",
    text: `A newer attempt replaced this preview. ${AGAIN}`,
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
      /^The machine running this preview stopped answering at .+\. If the run continues on another machine, a new preview appears here\.$/,
    tabs: false,
  },
  {
    name: "its time limit passed",
    change: { status: "expired", stopReason: "time_limit", stoppedAt: ago(5) },
    badge: "Ended",
    text: new RegExp(`^Ended at .+, its time limit\\. ${AGAIN}$`),
    tabs: true,
  },
  {
    name: "the run ended",
    change: { status: "stopped", stopReason: "run_ended", stoppedAt: ago(5) },
    badge: "Ended",
    text: new RegExp(`^Ended at .+, when the run finished\\. ${AGAIN}$`),
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
    // One sentence says what it means; nothing to press, and no second notice.
    await expect(card(page).getByTestId("run-preview-body")).toHaveText(
      reason.text,
    );
    await expect(card(page).getByText("Running", { exact: true })).toHaveCount(
      0,
    );
    await expect(actions(page)).toHaveCount(0);
    await expect(card(page).locator('[data-ui-component="inlineNotice"]'))
      .toHaveCount(0);
    // One status region announces the state.
    await expect(card(page).getByRole("status")).toHaveCount(1);
    if (reason.name === "starting") {
      await expect(details(page)).toHaveCount(0);
      await cardStill(page, "run-preview-starting");
    } else {
      if (reason.name === "the run was cancelled") {
        await cardStill(page, "run-preview-cancelled");
      }
      if (reason.name === "the machine was lost") {
        await cardStill(page, "run-preview-lost");
      }
      if (reason.name === "its time limit passed") {
        await cardStill(page, "run-preview-ended");
      }
      // The commit, and what stopping did to open tabs, are in Details.
      await openDetails(page);
      await expect(details(page).getByText("0123456, not released"))
        .toBeVisible();
      await expect(
        card(page).getByText("Open tabs of this preview no longer load."),
      ).toHaveCount(reason.tabs ? 1 : 0);
    }
  });
}

test("a deployment with no preview address says Not set up in one sentence and offers nothing", async ({ page }) => {
  await prepare(page, { available: false });
  await page.goto(`/tasks/${taskId}`);
  await expect(card(page).getByText("Not set up", { exact: true })).toBeVisible(
    {
      timeout: 20_000,
    },
  );
  await expect(card(page).getByTestId("run-preview-body")).toHaveText(
    "An administrator sets the preview address in the deployment settings.",
  );
  await expect(actions(page)).toHaveCount(0);
  await expect(details(page)).toHaveCount(0);
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

test("a preview that could not be opened says so once and can be tried again", async ({ page }) => {
  const world = await prepare(page, { accessStatus: 409 });
  await page.goto(`/tasks/${taskId}`);
  await card(page).getByRole("button", { name: "Prepare preview" }).click();
  await expect(
    card(page).getByText("The preview could not be opened. Try again."),
  ).toBeVisible();
  await expect(card(page).getByRole("alert")).toHaveCount(1);
  await expect(card(page).getByRole("button", { name: "Prepare preview" }))
    .toBeEnabled();
  expect(world.accessCalls).toBe(1);
  await cardStill(page, "run-preview-open-failed");
  // It tries again, and this time the grant comes; the error goes.
  world.accessStatus = 201;
  await card(page).getByRole("button", { name: "Prepare preview" }).click();
  await expect(card(page).getByRole("button", { name: "Open preview" }))
    .toBeVisible();
  await expect(card(page).getByRole("alert")).toHaveCount(0);
});

test("a stop that fails says so, keeps the preview running and can be tried again", async ({ page }) => {
  const world = await prepare(page, { stopStatus: 409 });
  await page.goto(`/tasks/${taskId}`);
  await openDetails(page);
  await card(page).getByRole("button", { name: "Stop preview" }).click();
  await expect(
    card(page).getByText("The preview could not be stopped. Try again."),
  ).toBeVisible();
  await expect(card(page).getByRole("alert")).toHaveCount(1);
  await expect(card(page).getByText("Running", { exact: true })).toBeVisible();
  await expect(card(page).getByRole("button", { name: "Stop preview" }))
    .toBeEnabled();
  expect(world.stopped).toBe(1);
  // The face is back as it was: the preview still runs and can be opened.
  await expect(card(page).getByRole("button", { name: "Prepare preview" }))
    .toBeVisible();
  await cardStill(page, "run-preview-stop-failed");
  world.stopStatus = 201;
  await card(page).getByRole("button", { name: "Stop preview" }).click();
  await expect(card(page).getByText("Stopped", { exact: true })).toBeVisible();
  await expect(card(page).getByRole("alert")).toHaveCount(0);
});

test("while a stop is out the face says so and offers nothing, and Details keeps the loading Stop", async ({ page }) => {
  let answer!: () => void;
  const world = await prepare(page, {
    stopHold: new Promise<void>((resolve) => {
      answer = resolve;
    }),
  });
  await page.goto(`/tasks/${taskId}`);
  await openDetails(page);
  await card(page).getByRole("button", { name: "Stop preview" }).click();
  await expect(card(page).getByRole("button", { name: "Stopping preview" }))
    .toBeVisible();
  await expect(card(page).getByTestId("run-preview-body")).toHaveText(
    "Stopping this preview…",
  );
  // Nothing to open, and no grant countdown, while the preview is going away.
  await expect(
    card(page).getByRole("button", { name: /Prepare preview|Open/ }),
  ).toHaveCount(0);
  await cardStill(page, "run-preview-stopping-details");
  answer();
  await expect(card(page).getByText("Stopped", { exact: true })).toBeVisible();
  await expect(card(page).getByRole("button", { name: "Stopping preview" }))
    .toHaveCount(0);
  expect(world.stopped).toBe(1);
  expect(world.accessCalls).toBe(0);
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
  await expect(actions(page)).toHaveCount(0);
});

test("when the live reads drop the card says it is checking, offers nothing, and recovers when read again", async ({ page }) => {
  await prepare(page);
  await page.goto(`/tasks/${taskId}`);
  await expect(card(page).getByRole("button", { name: "Prepare preview" }))
    .toBeEnabled({ timeout: 20_000 });
  await page.context().setOffline(true);
  // The sentence is replaced, not added to, and nothing can be pressed.
  await expect(card(page).getByTestId("run-preview-body")).toHaveText(
    "Checking whether this is still running…",
  );
  await expect(actions(page)).toHaveCount(0);
  await cardStill(page, "run-preview-checking");
  await page.context().setOffline(false);
  await expect(card(page).getByRole("button", { name: "Prepare preview" }))
    .toBeEnabled({ timeout: 15_000 });
  await expect(card(page).getByTestId("run-preview-body")).toHaveText(
    "The app the agent is working on, as it runs now.",
  );
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

const BEHIND =
  "The change has moved on since this preview started, so this is not what would be released.";

test("a preview behind the change says so once, and still opens when the person chooses to", async ({ page }) => {
  await prepare(page);
  const rows = { current: [pullRequestRow()] };
  await servePullRequests(page, rows);
  await page.goto(`/tasks/${taskId}`);
  await expect(card(page).getByText("Behind", { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await expect(card(page)).toHaveAttribute("data-preview-state", "running");
  // One badge and one sentence: no warning box, no commit id on the face.
  await expect(card(page).getByTestId("run-preview-body")).toHaveText(BEHIND);
  await expect(card(page).locator('[data-ui-component="inlineNotice"]'))
    .toHaveCount(0);
  await expect(card(page).getByText("fedcba9")).toBeHidden();
  await expect(card(page).getByText("Running", { exact: true })).toHaveCount(0);
  await expect(actions(page)).toHaveCount(1);
  await expect(card(page).getByRole("status")).toHaveCount(1);
  await cardStill(page, "run-preview-behind");
  await still(page, "run-preview-behind-in-pane");
  // The two commits are in Details.
  await openDetails(page);
  await expect(details(page).getByText("0123456, not released")).toBeVisible();
  await expect(details(page).getByText("fedcba9")).toBeVisible();
  await expect(card(page).getByRole("button", { name: "Stop preview" }))
    .toBeVisible();
  await cardStill(page, "run-preview-behind-details");
  // Opening anyway is still the two-step control, with the choice in its words.
  await card(page).getByRole("button", { name: "Prepare preview" }).click();
  await expect(card(page).getByRole("button", { name: "Open it anyway" }))
    .toBeVisible();
  await expect(card(page).getByRole("timer")).toContainText("expires in");
  // The change's pull request catches up with the preview: it reads as current.
  rows.current = [pullRequestRow({ headSha: SHA })];
  await expect(card(page).getByText("Behind", { exact: true })).toHaveCount(0, {
    timeout: 15_000,
  });
  await expect(card(page).getByText("Running", { exact: true })).toBeVisible();
  await expect(card(page).getByTestId("run-preview-body")).toHaveText(
    "The app the agent is working on, as it runs now.",
  );
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
    await expect(card(page).getByText("Behind")).toHaveCount(0);
    await openDetails(page);
    await expect(details(page).getByText("The change is now at"))
      .toHaveCount(0);
    await expect(card(page).getByRole("button", { name: "Prepare preview" }))
      .toBeEnabled();
  });
}

test("a preview that is not live shows its own state, never the behind state", async ({ page }) => {
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
  await expect(card(page).getByText("Behind")).toHaveCount(0);
});

test.afterEach(async ({ page }) => {
  await page.context().setOffline(false);
});

void MOCK_ORGANIZATION_ID;
