import { expect, type Locator, type Page, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createHash } from "node:crypto";
import {
  mockAuthenticatedSession,
  mockUserPreferences,
} from "./helpers/mock-session.ts";
import { revealShellNavigation } from "./helpers/shell-navigation.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { firstRender } from "./helpers/first-render.ts";
import { still } from "./helpers/stills.ts";
import {
  cancelRun,
  chooseRunAction,
  openRunActions,
  runAction,
  runActionsTrigger,
} from "./helpers/run-actions.ts";
import { NOT_PROBED } from "./helpers/artifact-page-fixture.ts";

registerPageHealth(test);

/**
 * Work list filter bar: on desktop the search is a field in the toolbar row
 * ("Search tasks"); on a phone it sits behind the "Search" popover, which also
 * holds the status select. Repository scope is behind "All applications".
 * Open the owning popover before touching a field; values persist while it is
 * closed.
 */
async function openFilter(page: Page, name: "Search" | "All applications") {
  // On a phone the Search trigger is named "Search"; once a term is applied it
  // is named "Search filter" and holds "Search: <term>".
  const trigger = page.getByRole(
    "button",
    name === "Search" ? { name: /^Search( filter)?$/ } : { name, exact: true },
  );
  if (await trigger.getAttribute("aria-expanded") !== "true") {
    await trigger.click();
  }
}

async function searchField(page: Page) {
  // 743px and below is a phone (the shell's own rule).
  if ((page.viewportSize()?.width ?? 1280) > 743) {
    return page.getByRole("searchbox", { name: "Search tasks" });
  }
  await openFilter(page, "Search");
  return page.getByLabel("Search titles and descriptions");
}

async function repositoryField(page: Page) {
  await openFilter(page, "All applications");
  return page.getByLabel("Repository UUID (optional)");
}

/** Close an open filter popover the way a person would before using the queue. */
async function dismissFilters(page: Page) {
  if (
    await page.locator('[data-ui-component="popover"][data-state="open"]')
      .count()
  ) {
    await page.keyboard.press("Escape");
  }
}

async function statusField(page: Page) {
  const status = page.getByRole("combobox", {
    name: "Task status",
    exact: true,
  });
  if (!(await status.isVisible())) await openFilter(page, "Search");
  return status;
}

const id = "00000000-0000-4000-8000-000000000012";
const runId = "00000000-0000-4000-8000-000000000020";
const stepId = "00000000-0000-4000-8000-000000000021";
const run = {
  id: runId,
  taskId: id,
  workflowVersionId: "00000000-0000-4000-8000-000000000022",
  repositoryProfileId: null,
  repositoryProfileRevision: null,
  repositoryProfileDigest: null,
  observationId: null,
  observationDigest: null,
  baseSha: null,
  workspaceBaseSha: null,
  requestedBy: "00000000-0000-4000-8000-000000000001",
  inngestRunId: null,
  // Required since #921: the run's pinned environment.
  environment: "live",
  status: "completed",
  budgetLimitUsd: "10.00",
  startedAt: "2026-01-01T00:00:01.000Z",
  finishedAt: "2026-01-01T00:01:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:01:00.000Z",
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
const step = {
  id: stepId,
  runId,
  stepKey: "publish",
  iteration: 1,
  status: "completed",
  input: {},
  output: null,
  error: null,
  startedAt: "2026-01-01T00:00:02.000Z",
  finishedAt: "2026-01-01T00:00:03.000Z",
  createdAt: "2026-01-01T00:00:02.000Z",
  updatedAt: "2026-01-01T00:00:03.000Z",
  version: 1,
  handoffManifest: null,
};
const syncEvent = {
  id: "00000000-0000-4000-8000-000000000023",
  sequence: "1",
  type: "run.completed",
  schemaVersion: 1,
  occurredAt: "2026-01-01T00:01:00.000Z",
  taskId: id,
  repositoryId: "00000000-0000-4000-8000-000000000005",
  payload: { runId },
  conversationId: "00000000-0000-4000-8000-000000000006",
};
const task = {
  id,
  applicationId: "00000000-0000-4000-8000-000000000004",
  repositoryId: "00000000-0000-4000-8000-000000000005",
  conversationId: "00000000-0000-4000-8000-000000000006",
  parentTaskId: null,
  title: "Authoritative task",
  description: "Persisted description",
  taskType: "feature",
  status: "draft",
  priority: 50,
  createdBy: "00000000-0000-4000-8000-000000000001",
  currentRunId: null,
  archivedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  version: 1,
  repositoryProfileId: null,
  repositoryProfileRevision: null,
  repositoryProfileDigest: null,
  observationId: null,
  observationDigest: null,
  baseSha: null,
};

async function mockControlReads(page: Page, status: () => string) {
  await page.route(
    `**/v1/tasks/${id}`,
    (route) => route.fulfill({ json: { ...task, currentRunId: runId } }),
  );
  await page.route(
    `**/v1/runs/${runId}`,
    (route) => route.fulfill({ json: { ...run, status: status() } }),
  );
  await page.route(
    `**/v1/runs/${runId}/steps*`,
    (route) => route.fulfill({ json: { items: [step], nextCursor: null } }),
  );
}
const controlSnapshot = (terminal = false) => ({
  runId,
  actions: ["pause", "resume", "cancel", "interrupt"].map((action) => ({
    action,
    canRequest: !terminal,
    reason: terminal ? "already_terminal" : "allowed",
  })),
});
const controlProblem = (status: number, retryable = false) => ({
  type: "about:blank",
  title: status === 403 ? "Forbidden" : "Conflict",
  status,
  code: retryable
    ? "IDEMPOTENCY_IN_FLIGHT"
    : status === 403
    ? "AUTH_FORBIDDEN"
    : "STATE_CONFLICT",
  detail: "Control admission was rejected by the server.",
  requestId: "00000000-0000-4000-8000-000000000110",
  traceId: "00000000-0000-4000-8000-000000000111",
  retryable,
});

test.beforeEach(async ({ page }) => {
  await mockAuthenticatedSession(page);
  await page.route(
    `**/v1/runs/${runId}/controls`,
    (route) => route.fulfill({ json: controlSnapshot(true) }),
  );
  await page.route(
    "**/v1/artifacts?*",
    (route) => route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.route(
    "**/v1/sync*",
    (route) =>
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
      }),
  );
});

test("task filters reset cursors, preserve focus, and navigate real routes", async ({ page }) => {
  const requests: URL[] = [];
  await page.route("**/v1/tasks?*", (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    expect(route.request().headers()["bakery-organization-id"]).toBe(
      "00000000-0000-4000-8000-000000000003",
    );
    return route.fulfill({
      json: {
        items: [{
          ...task,
          title: url.searchParams.has("cursor") ? "Second page" : task.title,
        }],
        nextCursor: url.searchParams.has("cursor") ? null : "opaque-next",
      },
    });
  });
  await page.route(
    `**/v1/tasks/${id}`,
    (route) => route.fulfill({ json: task }),
  );
  await page.route(
    "**/v1/artifacts?*",
    (route) => route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.goto("/tasks");
  await expect(page.getByRole("link", { name: task.title })).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByRole("link", { name: "Second page" })).toBeVisible();
  const search = await searchField(page);
  await search.pressSequentially("needle");
  await expect(search).toBeFocused();
  await expect.poll(() => requests.at(-1)?.searchParams.get("search")).toBe(
    "needle",
  );
  expect(requests.at(-1)?.searchParams.has("cursor")).toBe(false);
  await (await statusField(page)).selectOption("draft");
  await (await repositoryField(page)).fill(task.repositoryId);
  await expect.poll(() => requests.at(-1)?.searchParams.get("repositoryId"))
    .toBe(task.repositoryId);
  expect(requests.at(-1)?.searchParams.get("status")).toBe("draft");
  await expect(page.getByRole("banner").getByRole("link", { name: "New task" }))
    .toHaveAttribute(
      "href",
      "/tasks/new",
    );
  await dismissFilters(page);
  await page.getByRole("link", { name: task.title }).click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${id}$`));
  await expect(page.getByText(task.description)).toBeVisible();
  await expect(
    page.getByText(
      "This task has no run yet. Choose a workflow to start one.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Start run", exact: true }))
    .toBeVisible();
  await expect(page.getByText("No artifacts to show.")).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("queue inspector asks the server for open questions so an open one past the first page still shows", async ({ page }) => {
  test.skip(
    page.viewportSize()!.width <= 900,
    "inspector rail is desktop only",
  );
  const base = {
    taskId: id,
    runId: null,
    conversationId: task.conversationId,
    responseSchema: null,
    answer: null,
    answeredBy: null,
    answeredAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    version: 1,
    kind: "question",
    turnId: null,
    generation: 1,
    options: [{ id: "yes", label: "Yes please" }],
    allowFreeText: false,
    audience: { type: "task_participants" },
    expiresAt: null,
  };
  const answered = Array.from({ length: 25 }, (_, index) => ({
    ...base,
    id: `00000000-0000-4000-8000-0000000007${String(index).padStart(2, "0")}`,
    prompt: `Old question ${index}`,
    status: "answered",
    answer: { optionId: "yes" },
  }));
  const open = {
    ...base,
    id: "00000000-0000-4000-8000-000000000799",
    prompt: "Newest unanswered question beyond page one",
    status: "open",
  };
  const statuses: (string | null)[] = [];
  await page.route("**/v1/tasks?*", (route) =>
    route.fulfill({
      json: {
        items: [{ ...task, status: "waiting_input" }],
        nextCursor: null,
      },
    }));
  await page.route("**/v1/questions?*", (route) => {
    const status = new URL(route.request().url()).searchParams.get("status");
    statuses.push(status);
    // Unfiltered, the 25 newest answered questions fill page one.
    return route.fulfill({
      json: {
        items: status === "open" ? [open] : answered,
        nextCursor: status === "open" ? null : "more",
      },
    });
  });
  await page.goto("/tasks");
  await expect(
    page.getByRole("complementary").getByRole("heading", { name: open.prompt }),
  ).toBeVisible();
  expect(statuses).toContain("open");
});

test("queue inspector answers the selected task's open question and the page has one search", async ({ page }) => {
  // Phones have no inspector rail; the question shows on the task page.
  test.skip(
    page.viewportSize()!.width <= 900,
    "inspector rail is desktop only",
  );
  const questionId = "00000000-0000-4000-8000-000000000601";
  const open = {
    id: questionId,
    taskId: id,
    runId: null,
    conversationId: task.conversationId,
    prompt: "Which repositories should we import?",
    responseSchema: null,
    status: "open",
    answer: null,
    answeredBy: null,
    answeredAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    version: 1,
    kind: "question",
    turnId: null,
    generation: 1,
    options: [
      { id: "bakery", label: "Bakery only" },
      { id: "choose", label: "Choose repositories" },
    ],
    allowFreeText: false,
    audience: { type: "task_participants" },
    expiresAt: null,
  };
  let answered = false;
  const answers: unknown[] = [];
  await page.route("**/v1/tasks?*", (route) =>
    route.fulfill({
      json: {
        items: [{ ...task, status: "waiting_input" }],
        nextCursor: null,
      },
    }));
  await page.route("**/v1/questions?*", (route) =>
    route.fulfill({
      json: {
        items: answered ? [] : [open],
        nextCursor: null,
      },
    }));
  await page.route("**/v1/questions/*/answer", (route) => {
    answers.push(route.request().postDataJSON());
    answered = true;
    return route.fulfill({
      json: { ...open, status: "answered", answer: { optionId: "bakery" } },
    });
  });
  await page.goto("/tasks");
  const inspector = page.getByRole("complementary");
  await expect(
    inspector.getByRole("heading", { name: open.prompt }),
  ).toBeVisible();
  await inspector.getByLabel("Bakery only").check({ force: true });
  await inspector.getByRole("button", { name: "Send answer" }).click();
  await expect.poll(() => answers).toEqual([{
    answer: { optionId: "bakery" },
  }]);
  await expect(inspector.getByRole("heading", { name: open.prompt }))
    .toHaveCount(0);
  // One search on the page: the field in the toolbar row, no second entry in
  // the top bar.
  await expect(page.getByRole("button", { name: "Search work" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("searchbox", { name: "Search tasks" }))
    .toBeVisible();
  await expect(page.getByPlaceholder("Search titles and descriptions"))
    .toBeVisible();
});

test("queue inspector Details shows the short task id and copies the whole one", async ({ page, context }) => {
  test.skip(
    page.viewportSize()!.width <= 900,
    "inspector rail is desktop only",
  );
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await stillQueue(page, stillTasks);
  const inspector = page.getByRole("complementary");
  await inspector.getByRole("tab", { name: "Details" }).click();
  const row = inspector.getByTestId("task-id-row");
  await expect(row).toContainText("Task ID");
  // Eight characters on screen, the whole id on the clipboard.
  await expect(row).toContainText(stillTasks[0].id.slice(0, 8));
  await expect(row).not.toContainText(stillTasks[0].id.slice(0, 9));
  await row.getByRole("button", { name: "Copy" }).click();
  await expect(row.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    stillTasks[0].id,
  );
});

test("on a phone an applied search shows the icon and the term on one row, with Clear beside it", async ({ page }) => {
  test.skip(
    (page.viewportSize()?.width ?? 1280) > 743,
    "on a wider screen the field itself is in the toolbar",
  );
  await page.route(
    "**/v1/tasks?*",
    (route) => route.fulfill({ json: { items: stillTasks, nextCursor: null } }),
  );
  await page.route(
    "**/v1/artifacts?*",
    (route) => route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.goto("/tasks");
  const searchButton = (name: string | RegExp) =>
    page.getByRole("button", { name, exact: typeof name === "string" });
  const clear = page.getByRole("button", { name: "Clear search", exact: true });
  await expect(searchButton("Search")).toBeVisible();
  await expect(clear).toHaveCount(0);
  const applications = page.getByRole("button", {
    name: "All applications",
    exact: true,
  });
  // With no term the applications filter keeps its label, even at 320.
  await page.setViewportSize({ width: 320, height: 800 });
  expect((await applications.boundingBox())!.width).toBeGreaterThan(100);
  const terms = [
    "repository",
    "a very long search term \u{1F9C1} indeed, and then some more words",
    "x".repeat(120),
  ];
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 800 });
    for (const term of terms) {
      await (await searchField(page)).fill(term);
      await dismissFilters(page);
      // The button's name is "Search filter" and it holds "Search: <term>"; what
      // is drawn is the search icon and the term, which shrinks (ellipsis) only
      // when it is itself too long.
      const trigger = searchButton("Search filter");
      await expect(trigger).toBeVisible();
      // The button says which term it holds, to a screen reader as well as to the eye.
      await expect(trigger).toContainText(`Search: ${term}`);
      const drawn = trigger.locator('[data-ui-component="dataText"]');
      await expect(drawn).toHaveText(term);
      if (term === terms[0]) {
        expect(
          await drawn.evaluate((node) => node.scrollWidth <= node.clientWidth),
        ).toBe(true);
      }
      // At 360 px and below the applications filter is its icon alone while a
      // term is applied (name and tooltip kept); wider it keeps its label.
      await expect(applications).toBeVisible();
      const icon = (await applications.boundingBox())!;
      if (width <= 360) {
        expect(icon.width).toBeLessThan(60);
        await expect(applications).toHaveAttribute("title", "All applications");
      } else {
        expect(icon.width).toBeGreaterThan(100);
      }
      await expect(clear).toBeVisible();
      const [a, b] = [await trigger.boundingBox(), await clear.boundingBox()];
      // One row: Clear is beside the button, never under it, inside the screen.
      expect(Math.abs((a!.y + a!.height / 2) - (b!.y + b!.height / 2)))
        .toBeLessThan(4);
      expect(b!.x).toBeGreaterThanOrEqual(a!.x + a!.width - 1);
      expect(b!.x + b!.width).toBeLessThanOrEqual(width);
      expect(Math.min(b!.width, b!.height)).toBeGreaterThanOrEqual(44);
      expect(
        await page.evaluate(() =>
          document.documentElement.scrollWidth <= globalThis.innerWidth
        ),
      ).toBe(true);
    }
  }
  await clear.click();
  await expect(searchButton("Search")).toBeFocused();
  await expect(clear).toHaveCount(0);
  // The applications filter has its label back (the width is still 320).
  expect((await applications.boundingBox())!.width).toBeGreaterThan(100);
  // What a person sees: the whole list is back and the field is empty again.
  await expect(page.getByRole("link", { name: stillTasks[0].title }))
    .toBeVisible();
  await expect(await searchField(page)).toHaveValue("");
});

// Evidence stills of the Work list (BAKERY_STILLS_DIR): the list with tasks,
// a search with a term, and the empty list; skipped in a normal run.
// The reference under a title is the first eight characters of the id, and the
// age is read from `createdAt`, so the fixtures carry readable ids and recent times.
const stillTasks = [
  ["Add repository onboarding", "waiting_input", "a104b3c1", 2],
  ["Confirm error tracking provider", "waiting_input", "e041d7f2", 15],
  ["Refine activity filters", "active", "c038a9e4", 4],
  ["Preserve worker checkpoints", "active", "d102f5b6", 12],
  ["Improve empty state copy", "active", "b037c8a0", 19],
  ["Add notification preferences", "queued", "f027e1d3", 8],
  ["Add webhook intake", "queued", "a101b9c7", 32],
].map(([title, status, prefix, minutes]) => ({
  ...task,
  id: `${prefix}-0000-4000-8000-000000000700`,
  title,
  status,
  createdAt: new Date(Date.now() - Number(minutes) * 60_000).toISOString(),
  updatedAt: new Date(Date.now() - Number(minutes) * 60_000).toISOString(),
}));

async function stillQueue(page: Page, items: unknown[]) {
  await page.route("**/v1/tasks?*", (route) => {
    // The list answers a search the way the server does: by title or description.
    const term = new URL(route.request().url()).searchParams.get("search")
      ?.toLowerCase();
    const shown = term
      ? (items as { title: string; description: string }[]).filter((item) =>
        `${item.title} ${item.description}`.toLowerCase().includes(term)
      )
      : items;
    return route.fulfill({ json: { items: shown, nextCursor: null } });
  });
  await page.route(
    "**/v1/artifacts?*",
    (route) => route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.goto("/tasks");
}

test("still: the Work list with tasks", async ({ page }) => {
  test.skip(!process.env.BAKERY_STILLS_DIR, "BAKERY_STILLS_DIR is not set");
  await stillQueue(page, stillTasks);
  await expect(page.getByRole("link", { name: stillTasks[0].title }))
    .toBeVisible();
  await still(page, "work-list");
});

test("still: the Work list with a search term", async ({ page }) => {
  test.skip(!process.env.BAKERY_STILLS_DIR, "BAKERY_STILLS_DIR is not set");
  await stillQueue(page, stillTasks);
  await expect(page.getByRole("link", { name: stillTasks[0].title }))
    .toBeVisible();
  const search = await searchField(page);
  await search.fill("repository");
  await dismissFilters(page);
  await still(page, "work-list-search");
});

test("still: the Details tab with the task id and Copy", async ({ page }) => {
  test.skip(!process.env.BAKERY_STILLS_DIR, "BAKERY_STILLS_DIR is not set");
  test.skip(
    page.viewportSize()!.width <= 900,
    "inspector rail is desktop only",
  );
  await stillQueue(page, stillTasks);
  const inspector = page.getByRole("complementary");
  await inspector.getByRole("tab", { name: "Details" }).click();
  await expect(inspector.getByTestId("task-id-row")).toBeVisible();
  await still(page, "work-list-details");
});

test("still: the phone with a search term applied", async ({ page }) => {
  test.skip(!process.env.BAKERY_STILLS_DIR, "BAKERY_STILLS_DIR is not set");
  test.skip(
    (page.viewportSize()?.width ?? 1280) > 743,
    "the phone's Search button only",
  );
  await stillQueue(page, stillTasks);
  await expect(page.getByRole("link", { name: stillTasks[0].title }))
    .toBeVisible();
  const search = await searchField(page);
  await search.fill("repository");
  await dismissFilters(page);
  await expect(page.getByRole("button", { name: "Clear search", exact: true }))
    .toBeVisible();
  await still(page, "work-list-search-applied");
  // The narrowest phone keeps the same single row.
  await page.setViewportSize({ width: 320, height: 800 });
  await expect(page.getByRole("button", { name: "Clear search", exact: true }))
    .toBeVisible();
  await still(page, "work-list-search-applied-narrow");
  await page.getByRole("button", { name: "Clear search", exact: true }).click();
  await expect(page.getByRole("button", { name: "Search", exact: true }))
    .toBeFocused();
  await still(page, "work-list-narrow");
});

test("still: the empty Work list", async ({ page }) => {
  test.skip(!process.env.BAKERY_STILLS_DIR, "BAKERY_STILLS_DIR is not set");
  await stillQueue(page, []);
  await expect(page.getByText("No tasks yet", { exact: true })).toBeVisible();
  await still(page, "work-list-empty");
});

test("trailing slash task entry renders the canonical inbox", async ({ page }) => {
  await page.route(
    "**/v1/tasks?*",
    (route) => route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.goto("/tasks/");
  await expect(page.locator('[data-ui-component="taskInbox"]')).toBeVisible();
  await expect(page.getByRole("banner").getByRole("link", { name: "New task" }))
    .toHaveAttribute(
      "href",
      "/tasks/new",
    );
});

test("cursor controls reject stale continuation during a changed-filter fetch", async ({ page }) => {
  const requests: URL[] = [];
  let releaseFilter!: () => void;
  const filterGate = new Promise<void>((resolve) => {
    releaseFilter = resolve;
  });
  await page.route("**/v1/tasks?*", async (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    if (
      url.searchParams.get("search") === "needle" &&
      url.searchParams.has("cursor")
    ) {
      return route.fulfill({
        json: {
          items: [{ ...task, title: "Filtered second page" }],
          nextCursor: null,
        },
      });
    }
    if (url.searchParams.get("search") === "needle") {
      await filterGate;
      return route.fulfill({
        json: {
          items: [{ ...task, title: "Filtered task" }],
          nextCursor: "filtered-next",
        },
      });
    }
    return route.fulfill({
      json: { items: [task], nextCursor: "opaque-next" },
    });
  });
  await page.goto("/tasks");
  await expect(page.getByRole("link", { name: task.title })).toBeVisible();
  const next = page.locator(
    '[data-ui-component="cursorControls"] button',
  ).nth(1);
  await expect(next).toBeEnabled();
  await (await searchField(page)).fill("needle");
  await expect.poll(() =>
    requests.some((url) => url.searchParams.get("search") === "needle")
  ).toBe(true);
  await expect(next).toBeDisabled();
  const heldRequests = requests.filter((url) =>
    url.searchParams.get("search") === "needle"
  );
  expect(heldRequests.every((url) => !url.searchParams.has("cursor"))).toBe(
    true,
  );
  await next.evaluate((element) => (element as HTMLButtonElement).click());
  expect(
    requests.filter((url) =>
      url.searchParams.get("search") === "needle" &&
      url.searchParams.has("cursor")
    ),
  ).toHaveLength(0);
  releaseFilter();
  await expect(page.getByRole("link", { name: "Filtered task" })).toBeVisible();
  await expect(next).toBeEnabled();
  await dismissFilters(page);
  await next.click();
  await expect(
    page.getByRole("link", { name: "Filtered second page" }),
  ).toBeVisible();
  expect(
    requests.some((url) =>
      url.searchParams.get("search") === "needle" &&
      url.searchParams.get("cursor") === "filtered-next"
    ),
  ).toBe(true);
});

test("cursor controls stay disabled after a cached-page refetch fails", async ({ page, context }) => {
  await page.clock.install();
  const requests: URL[] = [];
  let rejectRefetch = false;
  let recovered = false;
  await page.route("**/v1/tasks?*", (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    if (rejectRefetch) {
      return route.fulfill({ status: 500, body: "unavailable" });
    }
    const cursor = url.searchParams.get("cursor");
    return route.fulfill({
      json: cursor === "opaque-next"
        ? {
          items: [{ ...task, title: "Second page" }],
          nextCursor: recovered ? "fresh-next" : "stale-next",
        }
        : cursor === "fresh-next"
        ? {
          items: [{ ...task, title: "Recovered third page" }],
          nextCursor: null,
        }
        : { items: [task], nextCursor: "opaque-next" },
    });
  });
  await page.goto("/tasks");
  await expect(page.getByRole("link", { name: task.title })).toBeVisible();
  const inbox = page.locator('[data-ui-component="taskInbox"]');
  const controls = page.locator('[data-ui-component="cursorControls"] button');
  const previous = controls.nth(0);
  const next = controls.nth(1);
  await next.click();
  await expect(page.getByRole("link", { name: "Second page" })).toBeVisible();
  await expect(previous).toBeEnabled();
  await expect(next).toBeEnabled();

  // Reconnect after the cached page becomes stale, without changing its key.
  await page.clock.fastForward(60_000);
  await context.setOffline(true);
  await expect(inbox).toHaveAttribute("data-state", "offline");
  rejectRefetch = true;
  await context.setOffline(false);
  await expect(inbox).toHaveAttribute("data-state", "error");
  expect(requests.at(-1)?.searchParams.get("cursor")).toBe("opaque-next");
  await expect(previous).toBeDisabled();
  await expect(next).toBeDisabled();
  const failedRequests = requests.map((url) => url.href);
  await controls.evaluateAll((buttons) => {
    for (const button of buttons) (button as HTMLButtonElement).click();
  });
  expect(requests.map((url) => url.href)).toEqual(failedRequests);

  rejectRefetch = false;
  recovered = true;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("link", { name: "Second page" })).toBeVisible();
  await expect(previous).toBeEnabled();
  await expect(next).toBeEnabled();
  await next.click();
  await expect(page.getByRole("link", { name: "Recovered third page" }))
    .toBeVisible();
  expect(
    requests.some((url) => url.searchParams.get("cursor") === "stale-next"),
  )
    .toBe(false);
  expect(requests.at(-1)?.searchParams.get("cursor")).toBe("fresh-next");
});

test("inbox distinguishes empty, forbidden, retryable error, and offline", async ({ page, context }) => {
  let state = "empty";
  await page.route(
    "**/v1/tasks?*",
    (route) =>
      state === "empty"
        ? route.fulfill({ json: { items: [], nextCursor: null } })
        : state === "error"
        ? route.fulfill({ status: 500, body: "unavailable" })
        : route.fulfill({
          status: 403,
          contentType: "application/problem+json",
          json: {
            type: "https://bakery.example/problems/forbidden",
            title: "Forbidden",
            status: 403,
            detail: "Not permitted",
            code: "FORBIDDEN",
            requestId: id,
            traceId: id,
            retryable: false,
          },
        }),
  );
  await page.goto("/tasks");
  const inbox = page.locator('[data-ui-component="taskInbox"]');
  await expect(inbox).toHaveAttribute("data-state", "empty");
  // Nothing is filtered: there are no tasks yet, and the way forward is offered.
  await expect(inbox).toContainText("No tasks yet");
  await expect(inbox).not.toContainText("No tasks match");
  await expect(inbox.getByRole("button", { name: "New task" })).toBeVisible();
  state = "forbidden";
  await page.reload();
  await expect(inbox).toHaveAttribute("data-state", "forbidden");
  await expect(inbox).toContainText("You do not have access to Work");
  state = "error";
  await page.reload();
  await expect(inbox).toHaveAttribute("data-state", "error");
  state = "empty";
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(inbox).toHaveAttribute("data-state", "empty");
  await context.setOffline(true);
  await expect(inbox).toHaveAttribute("data-state", "offline");
  await context.setOffline(false);
});
/** Collects every rejection no handler caught, in the page and its console. */
async function collectRejections(page: Page) {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    const seen: string[] = [];
    (globalThis as unknown as { __rejections: string[] }).__rejections = seen;
    globalThis.addEventListener("unhandledrejection", (event) => {
      seen.push(String(event.reason));
    });
  });
  return {
    pageErrors,
    rejections: () =>
      page.evaluate(() =>
        (globalThis as unknown as { __rejections?: string[] }).__rejections ??
          []
      ),
  };
}

const organizationsProblem = (status: number, code: string) => ({
  status,
  contentType: "application/problem+json",
  body: JSON.stringify({
    type: "about:blank",
    title: code,
    status,
    code,
    detail: `Stubbed ${code}.`,
    requestId: "00000000-0000-4000-8000-000000000301",
    traceId: "00000000-0000-4000-8000-000000000302",
    retryable: false,
  }),
});

test.describe("tasks organization restore", () => {
  test.beforeEach(async ({ page }) => {
    await page.route(
      "**/v1/tasks?*",
      (route) => route.fulfill({ json: { items: [task], nextCursor: null } }),
    );
  });

  test("an aborted lookup on load is not an unhandled rejection", async ({ page }) => {
    const observed = await collectRejections(page);
    await page.goto("/tasks");
    await expect(page.getByRole("link", { name: "Authoritative task" }))
      .toBeVisible();
    expect(await observed.rejections()).toEqual([]);
    expect(observed.pageErrors).toEqual([]);
  });

  test("leaving mid-lookup is not an unhandled rejection", async ({ page }) => {
    const observed = await collectRejections(page);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let lookups = 0;
    await page.route("**/v1/organizations", async (route) => {
      lookups += 1;
      await held;
      await route.fallback();
    });
    await page.goto("/tasks");
    await expect.poll(() => lookups).toBeGreaterThan(0);
    await revealShellNavigation(page);
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(page).toHaveURL(/\/settings/);
    release();
    await page.waitForTimeout(300);
    expect(await observed.rejections()).toEqual([]);
    expect(observed.pageErrors).toEqual([]);
  });

  // The organization lookup is the startup gate's (#343): until it answers,
  // no page content shows, and a failure is the gate's own state.
  test("a failed lookup is reported by the startup gate and Try again recovers the queue", async ({ page }) => {
    const observed = await collectRejections(page);
    let failing = true;
    await page.route(
      "**/v1/organizations",
      (route) =>
        failing
          ? route.fulfill(organizationsProblem(500, "INTERNAL_ERROR"))
          : route.fallback(),
    );
    await page.goto("/tasks");
    const gate = page.getByTestId("startup-error");
    await expect(gate).toContainText("Bakery could not load your organization");
    await expect(page.locator('[data-ui-component="taskInbox"]'))
      .toHaveCount(0);
    failing = false;
    const taskRequest = page.waitForRequest((request) =>
      new URL(request.url()).pathname === "/v1/tasks"
    );
    await gate.getByRole("button", { name: "Try again", exact: true }).click();
    await taskRequest;
    await expect(page.getByRole("link", { name: "Authoritative task" }))
      .toBeVisible();
    expect(await observed.rejections()).toEqual([]);
    expect(observed.pageErrors).toEqual([]);
  });

  test("an unreachable lookup reads as offline with Try again", async ({ page }) => {
    await page.route("**/v1/organizations", (route) => route.abort("failed"));
    await page.goto("/tasks");
    const gate = page.getByTestId("startup-error");
    await expect(gate).toContainText("You are offline");
    await expect(gate.getByRole("button", { name: "Try again", exact: true }))
      .toBeVisible();
  });

  test("a forbidden lookup says so, offers another organization and no Try again", async ({ page }) => {
    await page.route(
      "**/v1/organizations",
      (route) => route.fulfill(organizationsProblem(403, "AUTH_FORBIDDEN")),
    );
    await page.goto("/tasks");
    await expect(page.getByRole("heading", {
      name: "You do not have access to this organization",
    })).toBeVisible();
    await expect(page.getByRole("button", {
      name: "Choose another organization",
    })).toBeVisible();
    await expect(page.getByRole("button", { name: "Try again", exact: true }))
      .toHaveCount(0);
    await expect(page.locator('[data-ui-component="taskInbox"]'))
      .toHaveCount(0);
  });

  test("a failed lookup on a task is the startup gate's error, and Try again opens the task", async ({ page }) => {
    const observed = await collectRejections(page);
    let failing = true;
    await page.route(
      "**/v1/organizations",
      (route) =>
        failing
          ? route.fulfill(organizationsProblem(500, "INTERNAL_ERROR"))
          : route.fallback(),
    );
    await page.route(
      `**/v1/tasks/${id}`,
      (route) => route.fulfill({ json: task }),
    );
    await page.goto(`/tasks/${id}`);
    const gate = page.getByTestId("startup-error");
    await expect(gate).toContainText("Bakery could not load your organization");
    failing = false;
    await gate.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(page.getByText("Persisted description").first())
      .toBeVisible();
    expect(await observed.rejections()).toEqual([]);
    expect(observed.pageErrors).toEqual([]);
  });
});

test("inbox keeps results visible through reconnecting refresh", async ({ page, context }) => {
  let holdRefresh = false;
  let release!: () => void;
  const refresh = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/v1/tasks?*", async (route) => {
    if (holdRefresh) await refresh;
    await route.fulfill({
      json: {
        items: [{ ...task, title: "Reconnected task" }],
        nextCursor: null,
      },
    });
  });
  await page.goto("/tasks");
  const inbox = page.locator('[data-ui-component="taskInbox"]');
  await expect(page.getByRole("link", { name: "Reconnected task" }))
    .toBeVisible();
  holdRefresh = true;
  const search = await searchField(page);
  await context.setOffline(true);
  await expect(inbox).toHaveAttribute("data-state", "offline");
  await search.fill("reconnect");
  await context.setOffline(false);
  await expect(inbox).toHaveAttribute("data-state", "reconnecting");
  await expect(page.getByRole("link", { name: "Reconnected task" }))
    .toBeVisible();
  release();
  await expect(inbox).toHaveAttribute("data-state", "ready");
});

test("invalid deep link never requests invented task identity", async ({ page }) => {
  let calls = 0;
  await page.route("**/v1/tasks/**", (route) => {
    calls++;
    return route.abort();
  });
  await page.goto("/tasks/not-a-uuid");
  await expect(page.getByText("This task is not available"))
    .toBeVisible();
  expect(calls).toBe(0);
});

test("late filter response cannot replace current results", async ({ page }) => {
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let slowStarted = false;
  await page.route("**/v1/tasks?*", async (route) => {
    const search = new URL(route.request().url()).searchParams.get("search");
    if (search === "slow") {
      slowStarted = true;
      await pending;
    }
    await route.fulfill({
      json: {
        items: [{
          ...task,
          title: search === "slow" ? "Stale result" : "Current result",
        }],
        nextCursor: null,
      },
    });
  });
  await page.goto("/tasks");
  await expect(page.getByRole("link", { name: "Current result" }))
    .toBeVisible();
  const search = await searchField(page);
  await search.fill("slow");
  await expect.poll(() => slowStarted).toBe(true);
  await expect(page.locator('[data-ui-component="taskInbox"]')).toHaveAttribute(
    "data-state",
    "loading",
  );
  await search.fill("fast");
  await expect(page.getByRole("link", { name: "Current result" }))
    .toBeVisible();
  release();
  await expect(page.getByRole("link", { name: "Stale result" })).toHaveCount(0);
  await expect(search).toHaveValue("fast");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

for (const locale of ["en-XA", "ar-XB"]) {
  test(`live inbox supports dark narrow ${locale} presentation`, async ({ page }) => {
    await page.addInitScript((value) => {
      localStorage.setItem("bakery.theme.v1", "dark");
      Object.defineProperty(navigator, "languages", {
        configurable: true,
        value: [value],
      });
    }, locale);
    // The server's answer wins over the browser, so it asks for the same.
    await mockUserPreferences(page, {
      theme: "dark",
      effectiveLocale: locale,
      direction: locale === "ar-XB" ? "rtl" : "ltr",
    });
    await page.setViewportSize({ width: 320, height: 800 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.route(
      "**/v1/tasks?*",
      (route) =>
        route.fulfill({
          json: { items: [{ ...task, currentRunId: null }], nextCursor: null },
        }),
    );
    await page.goto("/tasks");
    await expect(page.getByRole("link", { name: task.title })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute(
      "dir",
      locale === "ar-XB" ? "rtl" : "ltr",
    );
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(
      await page.evaluate(() =>
        document.documentElement.scrollWidth <=
          document.documentElement.clientWidth
      ),
    ).toBe(true);
  });
}

test("review: empty continuation retains previous navigation", async ({ page }) => {
  await page.route(
    "**/v1/tasks?*",
    (route) =>
      route.fulfill({
        json: new URL(route.request().url()).searchParams.has("cursor")
          ? { items: [], nextCursor: null }
          : { items: [task], nextCursor: "next" },
      }),
  );
  await page.goto("/tasks");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.locator('[data-ui-component="taskInbox"]')).toHaveAttribute(
    "data-state",
    "empty",
  );
  await expect(page.getByRole("button", { name: "Previous", exact: true }))
    .toBeVisible();
});

test("review: actual route targets and reload", async ({ page }, testInfo) => {
  await page.route(
    "**/v1/tasks?*",
    (route) =>
      route.fulfill({
        json: { items: [{ ...task, currentRunId: null }], nextCursor: null },
      }),
  );
  await page.route(
    `**/v1/tasks/${id}`,
    (route) => route.fulfill({ json: task }),
  );
  await page.route(
    "**/v1/artifacts?*",
    (route) => route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.goto("/tasks");
  await expect(page.getByRole("link", { name: task.title })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("task129-fix-inbox.png"),
    fullPage: true,
  });
  const targets = await page.locator(
    '[data-ui-component="taskInbox"] a, [data-ui-component="taskInbox"] input, [data-ui-component="taskInbox"] select',
  ).evaluateAll((nodes) =>
    nodes.map((node) => ({
      name: node.textContent || node.getAttribute("id"),
      width: node.getBoundingClientRect().width,
      height: node.getBoundingClientRect().height,
    }))
  );
  console.log("REVIEW_TARGETS", testInfo.project.name, JSON.stringify(targets));
  await page.getByRole("link", { name: task.title }).click();
  await page.reload();
  await expect(page.getByText(task.description)).toBeVisible();
  await expect(page.locator('.bakery-application-rail a[href="/tasks"]'))
    .toHaveAttribute("aria-current", "page");
  await page.screenshot({
    path: testInfo.outputPath("task129-fix-detail.png"),
    fullPage: true,
  });
  for (const target of targets) {
    expect.soft(target.height, target.name || "target").toBeGreaterThanOrEqual(
      44,
    );
  }
});

test("intercepted run view renders server current run and survives reload", async ({ page }) => {
  await page.route(
    "**/v1/tasks?*",
    (route) => route.fulfill({ json: { items: [task], nextCursor: null } }),
  );
  await page.route(
    `**/v1/tasks/${id}`,
    (route) => route.fulfill({ json: { ...task, currentRunId: runId } }),
  );
  await page.route(
    `**/v1/runs/${runId}`,
    (route) => route.fulfill({ json: run }),
  );
  await page.route(
    `**/v1/runs/${runId}/steps*`,
    (route) => route.fulfill({ json: { items: [step], nextCursor: null } }),
  );
  await page.route(
    "**/v1/sync*",
    (route) =>
      route.fulfill({
        json: {
          resourceState: {},
          highwater: "0",
          events: [],
          nextCursor: null,
          resetRequired: false,
        },
      }),
  );
  await page.goto("/tasks");
  await page.getByRole("link", { name: task.title }).click();
  // The run id is not on the page until Details is opened, and then it is short.
  await page.getByText("Run details", { exact: true }).first().click();
  await expect(page.getByTestId("run-id-row")).toContainText(runId.slice(0, 8));
  await expect(page.getByText("publish", { exact: true })).toBeVisible();
  await page.reload();
  await page.getByText("Run details", { exact: true }).first().click();
  await expect(page.getByTestId("run-id-row")).toContainText(runId.slice(0, 8));
  await expect(page.getByText("publish", { exact: true })).toBeVisible();
});

test("intercepted duplicate sync event invalidates without duplicate step rows", async ({ page }) => {
  let syncCalls = 0;
  await page.route(
    "**/v1/tasks?*",
    (route) => route.fulfill({ json: { items: [task], nextCursor: null } }),
  );
  await page.route(
    `**/v1/tasks/${id}`,
    (route) => route.fulfill({ json: { ...task, currentRunId: runId } }),
  );
  await page.route(
    `**/v1/runs/${runId}`,
    (route) => route.fulfill({ json: run }),
  );
  await page.route(
    `**/v1/runs/${runId}/steps*`,
    (route) => route.fulfill({ json: { items: [step], nextCursor: null } }),
  );
  await page.route("**/v1/sync*", (route) => {
    syncCalls++;
    return route.fulfill({
      json: {
        resourceState: {},
        highwater: "1",
        events: [syncEvent],
        nextCursor: "cursor-1",
        resetRequired: false,
      },
    });
  });
  await page.goto("/tasks");
  await page.getByRole("link", { name: task.title }).click();
  await expect(page.getByText("publish", { exact: true })).toHaveCount(1);
  await page.evaluate(() => globalThis.dispatchEvent(new Event("online")));
  await expect.poll(() => syncCalls).toBeGreaterThan(1);
  await expect(page.getByText("publish", { exact: true })).toHaveCount(1);
});

test("background run and step transitions announce politely without moving focus", async ({ page }) => {
  let phase = 0;
  await page.route(
    `**/v1/tasks/${id}`,
    (route) => route.fulfill({ json: { ...task, currentRunId: runId } }),
  );
  await page.route(
    `**/v1/runs/${runId}`,
    (route) =>
      route.fulfill({
        json: { ...run, status: phase === 0 ? "running" : "completed" },
      }),
  );
  await page.route(
    `**/v1/runs/${runId}/steps*`,
    (route) =>
      route.fulfill({
        json: {
          items: [{
            ...step,
            status: phase === 0
              ? "running"
              : phase === 1
              ? "completed"
              : "failed",
          }],
          nextCursor: null,
        },
      }),
  );
  await page.route("**/v1/sync*", (route) => {
    const after = new URL(route.request().url()).searchParams.get("after");
    const cursor = `phase-${phase}`;
    return route.fulfill({
      json: {
        resourceState: {},
        highwater: String(phase),
        events: phase && after !== cursor
          ? [{
            ...syncEvent,
            id: `00000000-0000-4000-8000-00000000002${phase + 3}`,
            sequence: String(phase),
          }]
          : [],
        nextCursor: after === cursor ? null : cursor,
        resetRequired: false,
      },
    });
  });
  const summary = page.getByRole("status", { name: "Run updates" });
  await firstRender(
    () => page.goto(`/tasks/${id}`),
    (timeout) =>
      expect(summary).toHaveAttribute("aria-live", "polite", { timeout }),
  );
  await expect(summary).toHaveAttribute("aria-atomic", "true");
  await expect(summary).toHaveText("Current run: Running");
  await expect(page.getByText("publish", { exact: true })).toBeVisible();
  await summary.evaluate((element) =>
    element.setAttribute("data-persistent-probe", "original")
  );
  const focused = page.getByRole("link").first();
  await focused.focus();
  phase = 1;
  await page.evaluate(() => globalThis.dispatchEvent(new Event("online")));
  await expect(summary).toContainText("Current run: Completed");
  await expect(summary).toContainText(
    "Latest step update: publish — Completed",
  );
  await expect(focused).toBeFocused();
  phase = 2;
  await page.evaluate(() => globalThis.dispatchEvent(new Event("online")));
  await expect(summary).toContainText("Latest step update: publish — Failed");
  await expect(summary).toHaveAttribute("data-persistent-probe", "original");
  await expect(focused).toBeFocused();
});

test("intercepted wrong-run response suppresses child reads and controls", async ({ page }) => {
  let stepReads = 0;
  let controlReads = 0;
  page.on("request", (request) => {
    if (request.method() !== "GET") return;
    const path = new URL(request.url()).pathname;
    if (path === `/v1/runs/${runId}/steps`) stepReads += 1;
    if (path === `/v1/runs/${runId}/controls`) controlReads += 1;
  });
  await page.route(
    "**/v1/tasks?*",
    (route) => route.fulfill({ json: { items: [task], nextCursor: null } }),
  );
  await page.route(
    `**/v1/tasks/${id}`,
    (route) => route.fulfill({ json: { ...task, currentRunId: runId } }),
  );
  await page.route(
    `**/v1/runs/${runId}`,
    (route) =>
      route.fulfill({
        json: { ...run, taskId: "00000000-0000-4000-8000-000000000099" },
      }),
  );
  await page.route(
    "**/v1/sync*",
    (route) =>
      route.fulfill({
        json: {
          resourceState: {},
          highwater: "0",
          events: [],
          nextCursor: null,
          resetRequired: false,
        },
      }),
  );
  await page.goto("/tasks");
  await page.getByRole("link", { name: task.title }).click();
  await expect(
    page.getByRole("heading", {
      name: "This run could not be loaded.",
    }),
  ).toBeVisible();
  await expect(page.getByText(step.stepKey, { exact: true })).toHaveCount(0);
  expect(stepReads).toBe(0);
  expect(controlReads).toBe(0);
});

test("empty continuation returns with unchanged filters", async ({ page }) => {
  const requests: URL[] = [];
  await page.route("**/v1/tasks?*", (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    return route.fulfill({
      json: url.searchParams.has("cursor")
        ? { items: [], nextCursor: null }
        : { items: [task], nextCursor: "next" },
    });
  });
  await page.goto("/tasks");
  await (await searchField(page)).fill("needle");
  await (await statusField(page)).selectOption("draft");
  await (await repositoryField(page)).fill(task.repositoryId);
  const next = page.getByRole("button", { name: "Next", exact: true });
  await expect(next).toBeEnabled();
  await next.focus();
  await next.press("Enter");
  await expect(page.locator('[data-ui-component="taskInbox"]')).toHaveAttribute(
    "data-state",
    "empty",
  );
  const previous = page.getByRole("button", { name: "Previous", exact: true });
  await expect(previous).toBeEnabled();
  await previous.focus();
  await previous.press("Enter");
  await expect(page.getByRole("link", { name: task.title })).toBeVisible();
  await expect(previous).toBeVisible();
  // Returning to a fresh cached page need not issue another network request.
  await expect(previous).toBeDisabled();
  await expect(next).toBeEnabled();
  await expect(await searchField(page)).toHaveValue(
    "needle",
  );
  await expect(await statusField(page)).toHaveValue("draft");
  await expect(await repositoryField(page)).toHaveValue(
    task.repositoryId,
  );
  const continuation = requests.find((url) => url.searchParams.has("cursor"))!;
  expect(continuation.searchParams.get("search")).toBe("needle");
  expect(continuation.searchParams.get("status")).toBe("draft");
  expect(continuation.searchParams.get("repositoryId")).toBe(task.repositoryId);
});

test("controls recover one uncertain intent and render completion over a replayed response", async ({ page }) => {
  let winner = "running";
  const requests: { key: string | undefined; body: unknown }[] = [];
  await mockControlReads(page, () => winner);
  await page.route(`**/v1/runs/${runId}/controls`, (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({ json: controlSnapshot(winner === "completed") });
    }
    const headers = route.request().headers();
    expect(headers["bakery-organization-id"]).toBe(
      "00000000-0000-4000-8000-000000000003",
    );
    requests.push({
      key: headers["idempotency-key"],
      body: route.request().postDataJSON(),
    });
    winner = "completed";
    if (requests.length === 1) return route.abort("failed");
    // An idempotent replay may return an old admission snapshot. GET must win.
    return route.fulfill({ json: { ...run, status: "running" } });
  });
  await page.goto(`/tasks/${id}`);
  await cancelRun(page);
  const receipt = page.getByRole("status", { name: "Request sent" });
  await expect(receipt).toContainText("Request outcome unknown.");
  const observedReceipts = timeline(page).locator('[data-scope="control"]');
  await expect(observedReceipts).toHaveCount(1);
  await expect(observedReceipts.first()).toContainText("Request cancellation");
  await expect(observedReceipts.first()).toContainText(
    "Request outcome unknown.",
  );
  await expect(page.getByRole("status", { name: "Run updates" })).toHaveText(
    "Current run: Completed",
  );
  // The run finished, so the only entry left is the one that confirms what happened.
  await openRunActions(page);
  await expect(runAction(page, "Cancel run")).toHaveCount(0);
  await runAction(page, "Check again").click();
  await expect(receipt).toContainText("Request admitted.");
  await expect(receipt).toContainText("does not confirm what the machine did");
  await expect(observedReceipts).toHaveCount(2);
  // The list is newest first.
  await expect(observedReceipts.first()).toContainText("Request admitted.");
  await expect(observedReceipts.first()).toContainText(
    "does not confirm what the machine did",
  );
  await expect(observedReceipts.first()).not.toHaveAttribute("data-state");
  await expect(page.getByRole("status", { name: "Run updates" })).toHaveText(
    "Current run: Completed",
  );
  expect(requests).toHaveLength(2);
  expect(requests[0].key).toMatch(/^[0-9a-f-]{36}$/);
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[0].body).toEqual({ action: "cancel" });
  // Answered and the run is over: there is nothing left to ask for.
  await expect(runActionsTrigger(page)).toHaveCount(0);
  await expect(page.getByRole("status", { name: "Run updates" })).not
    .toContainText("Canceled");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("controls reject duplicate pending clicks and keep same intent through retryable conflict", async ({ page }) => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const keys: string[] = [];
  await mockControlReads(page, () => "running");
  await page.route(`**/v1/runs/${runId}/controls`, async (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({ json: controlSnapshot() });
    }
    keys.push(route.request().headers()["idempotency-key"]);
    if (keys.length === 1) {
      await wait;
      return route.fulfill({
        status: 409,
        contentType: "application/problem+json",
        json: controlProblem(409, true),
      });
    }
    return route.fulfill({ json: { ...run, status: "running" } });
  });
  await page.goto(`/tasks/${id}`);
  await openRunActions(page);
  const pause = runAction(page, "Pause run");
  await expect(pause).toBeEnabled();
  // Both clicks occur in one task, before a disabled React render can protect us.
  await pause.evaluate((element: HTMLButtonElement) => {
    element.click();
    element.click();
  });
  await expect.poll(() => keys.length).toBe(1);
  await expect(page.getByRole("status", { name: "Request sent" }))
    .toContainText("Request pending.");
  release();
  await expect(page.getByRole("status", { name: "Request sent" }))
    .toContainText("Request outcome unknown.");
  await chooseRunAction(page, "Check again");
  await expect(page.getByRole("status", { name: "Request sent" }))
    .toContainText("Request admitted.");
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
  await expect(page.getByRole("status", { name: "Run updates" })).toHaveText(
    "Current run: Running",
  );
});

for (const status of [403, 409, 422]) {
  test(`controls show definitive ${status} receipt and refetch the winner`, async ({ page }) => {
    let winner = "running";
    let posts = 0;
    await mockControlReads(page, () => winner);
    await page.route(`**/v1/runs/${runId}/controls`, (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({ json: controlSnapshot(winner === "completed") });
      }
      posts++;
      winner = "completed";
      return route.fulfill({
        status,
        contentType: "application/problem+json",
        json: controlProblem(status),
      });
    });
    await page.goto(`/tasks/${id}`);
    await chooseRunAction(page, "Interrupt the agent");
    const receipt = page.getByRole("status", {
      name: "Request sent",
    });
    await expect(receipt).toContainText(
      status === 403
        ? "not authorized"
        : status === 409
        ? "conflicted"
        : "rejected",
    );
    const observed = timeline(page).locator('[data-scope="control"]');
    await expect(observed).toHaveCount(1);
    await expect(observed).toContainText("Request interrupt");
    await expect(observed).toContainText(
      status === 403
        ? "not authorized"
        : status === 409
        ? "conflicted"
        : "rejected",
    );
    await expect(page.getByRole("status", { name: "Run updates" })).toHaveText(
      "Current run: Completed",
    );
    // Answered, and the run is over: no menu, nothing to retry.
    await expect(runActionsTrigger(page)).toHaveCount(0);
    expect(posts).toBe(1);
  });
}

test("controls are capability gated, keyboard operable, and offline safe", async ({ page, context }) => {
  let posts = 0;
  let runStatus = "paused";
  await mockControlReads(page, () => runStatus);
  await page.route(`**/v1/runs/${runId}/controls`, (route) => {
    if (route.request().method() !== "GET") {
      posts++;
      expect(route.request().postDataJSON()).toEqual({ action: "resume" });
      runStatus = "running";
      return route.fulfill({ json: { ...run, status: "running" } });
    }
    return route.fulfill({
      json: {
        runId,
        actions: controlSnapshot().actions.map((item) => ({
          ...item,
          canRequest: item.action === "resume",
          reason: item.action === "resume" ? "allowed" : "no_active_attempt",
        })),
      },
    });
  });
  await page.goto(`/tasks/${id}`);
  // A paused run shows Resume run as the one primary button; the server
  // allows nothing else, so there is no menu to open.
  const resume = page.getByRole("button", { name: "Resume run", exact: true });
  await expect(resume).toBeEnabled();
  await expect(runActionsTrigger(page)).toHaveCount(0);
  // Offline, nothing can be sent, so the button is not offered at all.
  await context.setOffline(true);
  await expect(resume).toHaveCount(0);
  expect(posts).toBe(0);
  await context.setOffline(false);
  await expect(resume).toBeEnabled();
  await resume.focus();
  await resume.press("Enter");
  await expect(page.getByRole("status", { name: "Request sent" }))
    .toContainText("Request admitted.");
  expect(posts).toBe(1);
  await expect(page.getByRole("status", { name: "Run updates" })).toHaveText(
    "Current run: Running",
  );
  await expect(resume).toHaveCount(0);
});

test("a waiting run offers cancel only and cancels from the run view", async ({ page }) => {
  let status = "running";
  const posts: unknown[] = [];
  await mockControlReads(page, () => status);
  await page.route(`**/v1/runs/${runId}/controls`, (route) => {
    if (route.request().method() !== "GET") {
      posts.push(route.request().postDataJSON());
      status = "canceled";
      return route.fulfill({ json: { ...run, status } });
    }
    const terminal = status === "canceled";
    return route.fulfill({
      json: {
        runId,
        actions: ["pause", "resume", "cancel", "interrupt"].map((action) => ({
          action,
          canRequest: !terminal && action === "cancel",
          reason: terminal
            ? "already_terminal"
            : action === "cancel"
            ? "allowed"
            : "no_active_attempt",
        })),
      },
    });
  });
  await page.goto(`/tasks/${id}`);
  // Only what the server allows is listed: no faded Pause, Resume or Interrupt.
  await openRunActions(page);
  await expect(runAction(page, "Cancel run")).toBeEnabled();
  for (const name of ["Pause run", "Resume run", "Interrupt the agent"]) {
    await expect(page.getByRole("button", { name, exact: true })).toHaveCount(
      0,
    );
  }
  await runAction(page, "Cancel run").click();
  // Cancel asks first; keeping the run sends nothing.
  await page.getByRole("alertdialog").getByRole("button", {
    name: "Keep running",
    exact: true,
  }).click();
  expect(posts).toEqual([]);
  await cancelRun(page);
  await expect(page.getByRole("status", { name: "Request sent" }))
    .toContainText("Request admitted.");
  expect(posts).toEqual([{ action: "cancel" }]);
  await expect(page.getByRole("status", { name: "Run updates" })).toHaveText(
    "Current run: Canceled",
  );
  await expect(runActionsTrigger(page)).toHaveCount(0);
});

test("controls preserve uncertain receipt through a failed parent task refresh", async ({ page }) => {
  let failedTask = false;
  const keys: string[] = [];
  await mockControlReads(page, () => "running");
  await page.route(
    `**/v1/tasks/${id}`,
    (route) =>
      failedTask
        ? route.fulfill({ status: 500, json: {} })
        : route.fulfill({ json: { ...task, currentRunId: runId } }),
  );
  await page.route(`**/v1/runs/${runId}/controls`, (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({ json: controlSnapshot() });
    }
    keys.push(route.request().headers()["idempotency-key"]);
    if (keys.length === 1) {
      failedTask = true;
      return route.abort("failed");
    }
    return route.fulfill({ json: { ...run, status: "running" } });
  });
  await page.goto(`/tasks/${id}`);
  await cancelRun(page);
  await expect(page.getByRole("status", { name: "Request sent" }))
    .toContainText("Request outcome unknown.");
  // While the task could not be refreshed nothing can be sent: no menu.
  await expect(runActionsTrigger(page)).toHaveCount(0);
  failedTask = false;
  // The refresh of the task failed: the warning notice about it has the retry.
  await page.locator('[data-ui-component="inlineNotice"]', {
    hasText: "This task could not be refreshed.",
  }).getByRole("button", { name: "Try again", exact: true }).click();
  await openRunActions(page);
  await expect(runAction(page, "Check again")).toBeEnabled();
  await runAction(page, "Check again").click();
  await expect(page.getByRole("status", { name: "Request sent" }))
    .toContainText("Request admitted.");
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
});

/**
 * Session detail (paper-session structure): the run timeline is built from
 * server run, step and error records only, and the artifact pane reads the
 * task's artifact through the extract endpoint.
 */
const stepOf = (
  stepKey: string,
  status: string,
  extra: Record<string, unknown> = {},
) => ({
  ...step,
  id: `00000000-0000-4000-8000-0000000001${stepKey === "brief" ? "01" : "02"}`,
  stepKey,
  status,
  ...extra,
});
const harnessFault = {
  type: "about:blank",
  title: "Deterministic executor cannot produce action evidence",
  status: 501,
  code: "DETERMINISTIC_EVIDENCE_UNAVAILABLE",
  retryable: false,
};

async function mockSession(
  page: Page,
  options: {
    runStatus: string;
    steps: unknown[];
    finishedAt?: string | null;
    capabilities?: unknown;
  },
) {
  await mockControlReads(page, () => options.runStatus);
  await page.route(
    `**/v1/runs/${runId}`,
    (route) =>
      route.fulfill({
        json: {
          ...run,
          status: options.runStatus,
          finishedAt: options.finishedAt ?? null,
        },
      }),
  );
  await page.route(
    `**/v1/runs/${runId}/steps*`,
    (route) =>
      route.fulfill({ json: { items: options.steps, nextCursor: null } }),
  );
  await page.route(
    `**/v1/runs/${runId}/controls`,
    (route) =>
      route.fulfill({
        json: options.capabilities ?? controlSnapshot(
          ["completed", "failed", "canceled", "blocked"].includes(
            options.runStatus,
          ),
        ),
      }),
  );
}

const timeline = (page: Page) =>
  page.getByRole("list", { name: "Run steps", exact: true });

test("timeline shows a queued run from the server record only", async ({ page }) => {
  await mockSession(page, { runStatus: "queued", steps: [] });
  await page.goto(`/tasks/${id}`);
  // The run line says it once; a run with no steps draws no empty step list.
  await expect(timeline(page)).toHaveCount(0);
  await expect(page.getByText("Waiting for a machine to pick it up."))
    .toBeVisible();
  await expect(page.getByText("No steps have been recorded.")).toHaveCount(0);
  await expect(page.getByRole("status", { name: "Run updates" })).toHaveText(
    "Current run: Queued",
  );
});

test("a blocked run says why, stays blocked and offers no controls", async ({ page }) => {
  await mockSession(page, { runStatus: "blocked", steps: [] });
  await page.goto(`/tasks/${id}`);
  await expect(timeline(page)).toHaveCount(0);
  await expect(
    page.getByText("This run is waiting for another task to finish."),
  )
    .toBeVisible();
  await expect(page.getByRole("status", { name: "Run updates" })).toHaveText(
    "Current run: Blocked",
  );
  await expect(runActionsTrigger(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Resume run", exact: true }))
    .toHaveCount(0);
  // It does not turn into a running or terminal row by itself.
  await expect(page.getByText(/Run (completed|failed|canceled)/))
    .toHaveCount(0);
});

test("a running run shows step progress without a terminal row", async ({ page }) => {
  await mockSession(page, {
    runStatus: "running",
    steps: [
      stepOf("brief", "completed"),
      stepOf("implement", "running", { finishedAt: null }),
    ],
  });
  await page.goto(`/tasks/${id}`);
  // Newest first: the step being worked on is the top row. The run itself is
  // not a row: the badge says it once.
  const items = timeline(page).getByRole("listitem");
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText("Implement");
  await expect(items.nth(0)).toContainText("Running");
  await expect(items.nth(1)).toContainText("Write task brief");
  await expect(items.nth(1)).toContainText("Completed");
  await expect(
    timeline(page).getByText(/Run (queued|completed|failed|canceled)/),
  )
    .toHaveCount(0);
});

test("a completed run lists its steps only and says how it went on the run line", async ({ page }) => {
  await mockSession(page, {
    runStatus: "completed",
    finishedAt: "2026-01-01T00:01:00.000Z",
    steps: [stepOf("brief", "completed"), stepOf("implement", "completed")],
  });
  await page.goto(`/tasks/${id}`);
  const items = timeline(page).getByRole("listitem");
  // Newest first, and no "Run completed" row: the badge and the run line say it.
  await expect(items).toHaveCount(2);
  await expect(items.first()).toContainText("Implement");
  await expect(timeline(page).getByText("Run completed")).toHaveCount(0);
  await expect(page.getByText("2 steps in 59 s", { exact: true }))
    .toBeVisible();
});

test("a failed implement step shows the honest no-harness copy", async ({ page }) => {
  await mockSession(page, {
    runStatus: "failed",
    finishedAt: "2026-01-01T00:01:00.000Z",
    steps: [
      stepOf("brief", "completed"),
      stepOf("implement", "failed", { error: harnessFault }),
    ],
  });
  await page.goto(`/tasks/${id}`);
  const items = timeline(page).getByRole("listitem");
  // Newest first: the failed step with the reason, then the step before it.
  await expect(items).toHaveCount(2);
  await expect(items.first()).toContainText(
    "No coding agent is installed on this machine yet.",
  );
  await expect(timeline(page).getByText("Run failed")).toHaveCount(0);
  await expect(page.getByText("Send a message to try again.")).toBeVisible();
  await expect(page.getByText("Run completed")).toHaveCount(0);
});

test("a failed step with another fault does not claim the harness is missing", async ({ page }) => {
  await mockSession(page, {
    runStatus: "failed",
    finishedAt: "2026-01-01T00:01:00.000Z",
    steps: [
      stepOf("brief", "completed"),
      stepOf("implement", "failed", { error: { code: "WORKER_LOST" } }),
    ],
  });
  await page.goto(`/tasks/${id}`);
  await expect(timeline(page).getByRole("listitem").first()).toContainText(
    "Failed",
  );
  await expect(page.getByText("No coding agent")).toHaveCount(0);
});

test("a run failed by the budget cap names the reason", async ({ page }) => {
  await mockSession(page, {
    runStatus: "failed",
    finishedAt: "2026-01-01T00:01:00.000Z",
    steps: [
      stepOf("brief", "completed"),
      stepOf("implement", "failed", {
        error: {
          code: "BUDGET_CAP_EXCEEDED",
          message: "The run budget cannot cover this step's model reservation.",
        },
      }),
    ],
  });
  await page.goto(`/tasks/${id}`);
  await expect(timeline(page).getByRole("listitem").first()).toContainText(
    "The run budget cannot cover this step's model reservation. Start a new run with a higher budget limit.",
  );
  await expect(timeline(page).getByText("Run failed")).toHaveCount(0);
  await expect(page.getByText("No coding agent")).toHaveCount(0);
});

test("a canceled run says when on the run line and adds no row of its own", async ({ page }) => {
  await mockSession(page, {
    runStatus: "canceled",
    finishedAt: "2026-01-01T00:01:00.000Z",
    steps: [stepOf("brief", "completed")],
  });
  await page.goto(`/tasks/${id}`);
  await expect(timeline(page).getByRole("listitem")).toHaveCount(1);
  await expect(timeline(page).getByText("Run canceled")).toHaveCount(0);
  await expect(page.getByText(/^Canceled .+\.$/)).toBeVisible();
});

/**
 * The reads around the run section (conversation, plan, delivery) answer
 * empty pages, so a still of the run section shows no unrelated error panel.
 */
async function quietTaskReads(page: Page) {
  for (
    const pattern of [
      "**/v1/runs/*/checks*",
      "**/v1/runs/*/reviews*",
      "**/v1/runs/*/delivery-decisions*",
      "**/v1/pull-requests?*",
      "**/v1/merge-attempts?*",
      "**/v1/merge-entries?*",
      "**/v1/approvals?*",
      "**/v1/questions?*",
      "**/v1/plan-revisions?*",
      "**/v1/conversations/*/messages*",
      "**/v1/conversations/*/turns*",
      "**/v1/conversations/*/participants*",
    ]
  ) {
    await page.route(
      pattern,
      (route) => route.fulfill({ json: { items: [], nextCursor: null } }),
    );
  }
}

/** What the server lets this person do to the run; the rest is not listed. */
const allowing = (...allowed: string[]) => ({
  runId,
  actions: ["pause", "resume", "cancel", "interrupt"].map((action) => ({
    action,
    canRequest: allowed.includes(action),
    reason: allowed.includes(action) ? "allowed" : "no_active_attempt",
  })),
});

test("still: the run line while it works, with the Run actions menu open", async ({ page }) => {
  await mockSession(page, {
    runStatus: "running",
    steps: [
      stepOf("brief", "completed"),
      stepOf("implement", "running", { finishedAt: null }),
    ],
    capabilities: allowing("pause", "interrupt", "cancel"),
  });
  await quietTaskReads(page);
  await page.goto(`/tasks/${id}`);
  await expect(page.getByText(/^Started /)).toBeVisible();
  await openRunActions(page);
  // Only what the server allows is listed, and Resume is not a menu entry.
  await expect(runAction(page, "Pause run")).toBeVisible();
  await expect(runAction(page, "Interrupt the agent")).toBeVisible();
  await expect(runAction(page, "Cancel run")).toBeVisible();
  await expect(runAction(page, "Resume run")).toHaveCount(0);
  await still(page, "run-line-running-menu");
});

test("still: the run line when it is paused, with Resume run as the one button", async ({ page }) => {
  await mockSession(page, {
    runStatus: "paused",
    // A run paused at a safe point has finished its steps so far and has none running.
    steps: [stepOf("brief", "completed")],
    capabilities: allowing("resume", "cancel"),
  });
  await quietTaskReads(page);
  await page.goto(`/tasks/${id}`);
  await expect(page.getByText("Nothing runs until it is resumed."))
    .toBeVisible();
  await expect(page.getByRole("button", { name: "Resume run", exact: true }))
    .toBeVisible();
  // No step still reads Running, and the composer does not say a run is in progress.
  await expect(timeline(page).getByText("Running", { exact: true }))
    .toHaveCount(0);
  await expect(
    page.getByText(
      "This run is paused. Your message is saved and the agent reads it when the run is resumed.",
    ),
  ).toBeVisible();
  await expect(page.getByText("A run is in progress.")).toHaveCount(0);
  // With one step there is no Step select, so the sentence names its step.
  await expect(page.getByText("Write task brief has no agent session."))
    .toBeVisible();
  await expect(page.getByText("This step has no agent session."))
    .toHaveCount(0);
  await still(page, "run-line-paused");
});

test(
  "the run section draws only what has something in it, and Run actions ends the run line",
  async ({ page }, testInfo) => {
    await mockSession(page, {
      runStatus: "running",
      steps: [
        stepOf("brief", "completed"),
        stepOf("implement", "running", { finishedAt: null }),
      ],
      capabilities: allowing("pause", "interrupt", "cancel"),
    });
    await quietTaskReads(page);
    await page.goto(`/tasks/${id}`);
    await expect(page.getByRole("heading", { name: "Current run" }))
      .toBeVisible();
    // Nothing recorded yet means nothing drawn: no empty box, no empty sentence,
    // no empty pane section.
    for (
      const absent of [
        "No artifacts to show.",
        "Bakery has not recorded any changes for this run yet.",
        "This run has published no artifact yet.",
      ]
    ) {
      await expect(page.getByText(absent)).toHaveCount(0);
    }
    await expect(page.getByRole("heading", { name: "Changes" })).toHaveCount(0);
    await expect(page.getByRole("complementary", { name: "Artifact" }))
      .toHaveCount(0);
    // Raw output is one click away, never open on its own.
    for (
      const raw of await page.locator("details", { hasText: "Raw output" })
        .all()
    ) {
      await expect(raw).not.toHaveAttribute("open", "");
    }
    // The run notice replaces the mode hint inside the box on a wide screen; a
    // phone has no hint, so its notice keeps the line above the box.
    const composer = page.locator('[data-ui-region="composer"]');
    await expect(composer.getByText(/^A run is in progress\./)).toBeVisible();
    if (testInfo.project.name === "desktop") {
      await expect(composer.locator(".ui-message-composer__hint"))
        .toContainText(
          "A run is in progress.",
        );
      await expect(composer.locator(".ui-inline-notice")).toHaveCount(0);
      // The page's own Implementing pill is gone: the stage strip marks the stage.
      await expect(page.getByText("Implementing", { exact: true })).toHaveCount(
        0,
      );
      // Run actions sits at the end of the run line, level with the step list's end.
      const trigger = (await runActionsTrigger(page).boundingBox())!;
      const list = (await timeline(page).boundingBox())!;
      expect(trigger.x + trigger.width).toBeGreaterThan(
        list.x + list.width - 8,
      );
    } else {
      // A phone: the heading, the badge and Run actions share the first row,
      // the button at its end; the line of text goes under them.
      const trigger = (await runActionsTrigger(page).boundingBox())!;
      const heading = (await page.getByRole("heading", { name: "Current run" })
        .boundingBox())!;
      const started = (await page.getByText(/^Started /).boundingBox())!;
      const viewport = page.viewportSize()!.width;
      expect(Math.abs(
        (trigger.y + trigger.height / 2) - (heading.y + heading.height / 2),
      )).toBeLessThan(heading.height);
      expect(trigger.x + trigger.width).toBeGreaterThan(viewport - 40);
      expect(started.y).toBeGreaterThan(trigger.y + trigger.height - 2);
    }
  },
);

test("still: the run line once it finished, with its steps folded", async ({ page }) => {
  await mockSession(page, {
    runStatus: "completed",
    finishedAt: "2026-01-01T00:01:00.000Z",
    steps: [stepOf("brief", "completed"), stepOf("implement", "completed")],
  });
  await quietTaskReads(page);
  await page.goto(`/tasks/${id}`);
  await expect(page.getByText("2 steps in 59 s", { exact: true }))
    .toBeVisible();
  await expect(runActionsTrigger(page)).toHaveCount(0);
  await still(page, "run-line-finished");
});

test("still: the run line after a failure, with the reason on the failed step", async ({ page }) => {
  await mockSession(page, {
    runStatus: "failed",
    finishedAt: "2026-01-01T00:01:00.000Z",
    steps: [
      stepOf("brief", "completed"),
      stepOf("implement", "failed", { error: harnessFault }),
    ],
  });
  await quietTaskReads(page);
  await page.goto(`/tasks/${id}`);
  await expect(page.getByText("Send a message to try again.")).toBeVisible();
  await expect(runActionsTrigger(page)).toHaveCount(0);
  await still(page, "run-line-failed");
});

for (
  const [status, steps] of [
    ["completed", [
      stepOf("brief", "completed"),
      stepOf("implement", "completed"),
    ]],
    ["failed", [
      stepOf("brief", "completed"),
      stepOf("implement", "failed", { error: harnessFault }),
    ]],
    ["running", [
      stepOf("brief", "completed"),
      stepOf("implement", "running", { finishedAt: null }),
    ]],
  ] as const
) {
  test(`the step list sits close under the run line: ${status}`, async ({ page }) => {
    await mockSession(page, {
      runStatus: status,
      finishedAt: status === "running" ? null : "2026-01-01T00:01:00.000Z",
      steps: [...steps],
    });
    await quietTaskReads(page);
    await page.goto(`/tasks/${id}`);
    const line = page.locator("#task-run-heading").locator("..");
    await expect(line).toBeVisible();
    await expect(timeline(page)).toBeVisible();
    const above = (await line.boundingBox())!;
    const list = (await timeline(page).boundingBox())!;
    // Other gaps in the section are 24 to 40px: an empty part must not add its own.
    expect(list.y - (above.y + above.height)).toBeLessThanOrEqual(40);
  });
}

test("cancel losing to completion with ALREADY_TERMINAL renders the server winner", async ({ page }) => {
  let winner = "running";
  let posts = 0;
  await mockControlReads(page, () => winner);
  await page.route(
    `**/v1/runs/${runId}`,
    (route) =>
      route.fulfill({
        json: {
          ...run,
          status: winner,
          finishedAt: winner === "completed" ? run.finishedAt : null,
        },
      }),
  );
  await page.route(`**/v1/runs/${runId}/controls`, (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({ json: controlSnapshot(winner === "completed") });
    }
    posts++;
    winner = "completed";
    return route.fulfill({
      status: 409,
      contentType: "application/problem+json",
      json: { ...controlProblem(409), code: "ALREADY_TERMINAL" },
    });
  });
  await page.goto(`/tasks/${id}`);
  await cancelRun(page);
  await expect(page.getByRole("status", { name: "Run updates" })).toHaveText(
    "Current run: Completed",
  );
  // The finish is the badge and the run line, never a row of the list.
  await expect(timeline(page).locator('[data-scope="run"]')).toHaveCount(0);
  const receipt = timeline(page).locator('[data-scope="control"]');
  await expect(receipt).toHaveCount(1);
  await expect(receipt).toContainText("Request cancellation");
  await expect(receipt).toContainText("conflicted with current server state");
  await expect(receipt).not.toHaveAttribute("data-state");
  await expect(timeline(page).getByText("Run canceled")).toHaveCount(0);
  await expect(runActionsTrigger(page)).toHaveCount(0);
  expect(posts).toBe(1);
});

test("offline and reconnecting are announced in the timeline banner, never as rows", async ({ page, context }) => {
  await mockSession(page, {
    runStatus: "running",
    steps: [stepOf("brief", "completed")],
  });
  await page.goto(`/tasks/${id}`);
  // The banner is a persistent status region beside the list, not a row of it.
  const banner = page.locator('[role="status"].ui-run-timeline__connectivity');
  await expect(banner).toHaveAttribute("aria-live", "polite");
  await expect(timeline(page).getByRole("listitem")).toHaveCount(1);
  await context.setOffline(true);
  await expect(banner).toContainText(
    "Offline. Showing the last confirmed record.",
  );
  await expect(timeline(page).getByRole("listitem")).toHaveCount(1);
  await context.setOffline(false);
  await expect(banner).not.toContainText("Offline.");
  await expect(timeline(page).getByRole("listitem")).toHaveCount(1);
});

/**
 * The aside's facts sit under a closed Details control: open it and read the
 * short fingerprint (the first 12 characters, with Copy) and, when given, the size.
 */
async function expectAsideFacts(pane: Locator, sha256: string, size?: string) {
  // The control by its element, so a pseudo-locale label does not matter.
  await pane.locator("summary").click();
  const fingerprint = pane.getByTestId("artifact-fingerprint-row");
  await expect(fingerprint).toContainText(sha256.slice(0, 12));
  await expect(fingerprint).not.toContainText(sha256.slice(0, 13));
  if (size !== undefined) await expect(pane).toContainText(size);
}

const artifactId = "00000000-0000-4000-8000-000000000030";
const versionIds = [
  "00000000-0000-4000-8000-000000000031",
  "00000000-0000-4000-8000-000000000032",
];
const digest = (char: string) => char.repeat(64);
const artifact = {
  id: artifactId,
  taskId: id,
  // The brief is a run-owned document; type does not gate the card.
  artifactType: "other",
  name: "Task brief",
  currentVersionId: versionIds[1],
  createdAt: "2026-01-01T00:00:02.000Z",
  updatedAt: "2026-01-01T00:00:03.000Z",
  version: 2,
};
const artifactVersion = (index: number, mediaType = "text/markdown") => ({
  id: versionIds[index],
  artifactId,
  revision: index + 1,
  // Published by a step of the current run, which the aside requires.
  runStepId: stepOf("brief", "completed").id,
  authorId: "00000000-0000-4000-8000-000000000001",
  mediaType,
  sizeBytes: 120 + index,
  sha256: digest(index === 0 ? "a" : "b"),
  subjectHeadSha: null,
  subjectBaseSha: null,
  metadata: {},
  createdAt: "2026-01-01T00:00:02.000Z",
  updatedAt: "2026-01-01T00:00:02.000Z",
  version: 1,
});

/** The bytes of one version of the brief; the digest and size below describe these exact bytes. */
const briefText = (index: number, mediaType?: string) =>
  mediaType === "application/json"
    ? JSON.stringify(
      {
        schema: "bakery.task-brief/v1",
        title: `Brief v${index + 1}`,
        description: "<script>alert(1)</script>",
      },
      null,
      2,
    )
    : `# Brief v${index + 1}\n<script>alert(1)</script>`;
const briefDigest = (index: number, mediaType?: string) =>
  createHash("sha256").update(briefText(index, mediaType)).digest("hex");
const briefSize = (index: number, mediaType?: string) =>
  new TextEncoder().encode(briefText(index, mediaType)).byteLength;
/**
 * A version whose record matches its bytes: the preview reads the bytes from
 * /content and refuses any whose digest or length differs from the record.
 */
const briefVersion = (index: number, mediaType = "text/markdown") => ({
  ...artifactVersion(index, mediaType),
  sizeBytes: briefSize(index, mediaType),
  sha256: briefDigest(index, mediaType),
});

async function mockArtifact(
  page: Page,
  options: { mediaType?: string; hasMore?: boolean } = {},
) {
  await mockSession(page, {
    runStatus: "completed",
    finishedAt: "2026-01-01T00:01:00.000Z",
    steps: [stepOf("brief", "completed")],
  });
  await page.route(
    "**/v1/artifacts?*",
    (route) => route.fulfill({ json: { items: [artifact], nextCursor: null } }),
  );
  await page.route(
    `**/v1/artifacts/${artifactId}/versions*`,
    (route) =>
      route.fulfill({
        json: {
          items: [
            briefVersion(0, options.mediaType),
            briefVersion(1, options.mediaType),
          ],
          nextCursor: null,
        },
      }),
  );
  const extracts: string[] = [];
  const contents: string[] = [];
  // Nobody has measured the bytes: the preview falls back to the declared media type.
  await page.route(
    "**/v1/artifact-versions/*/probe",
    (route) => route.fulfill({ json: NOT_PROBED }),
  );
  // The bytes the preview shows, with the headers its digest check reads.
  await page.route("**/v1/artifact-versions/*/content", (route) => {
    const versionId =
      route.request().url().match(/artifact-versions\/([^/]+)/)![1];
    contents.push(versionId);
    const index = versionIds.indexOf(versionId);
    return route.fulfill({
      status: 200,
      headers: {
        "content-type": options.mediaType ?? "text/markdown",
        "content-length": String(briefSize(index, options.mediaType)),
        "content-disposition": 'attachment; filename="brief.md"',
        etag: `"${briefDigest(index, options.mediaType)}"`,
      },
      body: briefText(index, options.mediaType),
    });
  });
  await page.route("**/v1/artifact-versions/*/extract*", (route) => {
    const versionId =
      route.request().url().match(/artifact-versions\/([^/]+)/)![1];
    extracts.push(versionId);
    const index = versionIds.indexOf(versionId);
    const text = briefText(index, options.mediaType);
    return route.fulfill({
      json: {
        versionId,
        sha256: briefDigest(index, options.mediaType),
        mediaType: options.mediaType ?? "text/markdown",
        startByte: 0,
        endByteExclusive: new TextEncoder().encode(text).byteLength,
        text,
        hasMore: options.hasMore ?? false,
      },
    });
  });
  return { extracts, contents };
}

test(
  "the artifact pane previews the current version as inert text with a safe link",
  async ({ page }) => {
    const { extracts } = await mockArtifact(page);
    await page.goto(`/tasks/${id}`);
    const pane = page.getByRole("complementary", {
      name: "Artifact",
      exact: true,
    });
    await expect(pane).toBeVisible();
    await expect(pane.getByRole("heading", { name: "Task brief" }))
      .toBeVisible();
    const versions = pane.getByRole("combobox", { name: "Artifact version" });
    await expect(versions).toHaveValue(versionIds[1]);
    const preview = pane.getByRole("region", { name: "Preview" });
    // The markdown is drawn as a document: the heading reads "Brief v2".
    await expect(preview).toContainText("Brief v2");
    // The extract is text, never markup.
    await expect(preview).toContainText("<script>alert(1)</script>");
    await expect(preview.locator("script")).toHaveCount(0);
    // The facts sit under a closed Details control, in short form.
    await expect(pane).toContainText("text/markdown");
    await expectAsideFacts(pane, briefDigest(1), `${briefSize(1)} B`);
    const open = pane.getByRole("link", { name: "Open", exact: true });
    await expect(open).toHaveAttribute(
      "href",
      `/tasks/${id}/artifacts/${artifactId}`,
    );
    const box = await open.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.width).toBeGreaterThanOrEqual(44);
    await versions.selectOption(versionIds[0]);
    await expect(preview).toContainText("Brief v1");
    await expect(pane.getByTestId("artifact-fingerprint-row")).toContainText(
      briefDigest(0).slice(0, 12),
    );
    expect(extracts).toContain(versionIds[0]);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  },
);

test("a truncated extract says so", async ({ page }) => {
  await mockArtifact(page, { hasMore: true });
  await page.goto(`/tasks/${id}`);
  const pane = page.getByRole("complementary", {
    name: "Artifact",
    exact: true,
  });
  await expect(pane.getByRole("status")).toContainText(
    "Preview truncated. Download the artifact to read all of it.",
  );
  await expect(pane.getByRole("region", { name: "Preview" }))
    .toBeVisible();
});

test("an unsupported media type says no preview and never asks for the bytes", async ({ page }) => {
  const asked: string[] = [];
  page.on("request", (request) => {
    if (/\/(extract|content)(\?|$)/.test(request.url())) {
      asked.push(request.url());
    }
  });
  await mockArtifact(page, { mediaType: "application/zip" });
  await page.goto(`/tasks/${id}`);
  const pane = page.getByRole("complementary", {
    name: "Artifact",
    exact: true,
  });
  // The refusal is the preview's own content: no bytes are shown or asked for.
  await expect(pane.getByRole("region", { name: "Preview" })).toContainText(
    "No preview for this kind of file.",
  );
  await expect(pane.getByRole("link", { name: "Open", exact: true }))
    .toBeVisible();
  expect(asked).toEqual([]);
});

test("a task with no artifact draws no artifact pane", async ({ page }) => {
  await mockSession(page, { runStatus: "queued", steps: [] });
  await page.goto(`/tasks/${id}`);
  // The section appears with the run's first artifact, so an empty one is not
  // drawn: no heading, no "published no artifact yet" sentence.
  await expect(page.getByRole("heading", { name: "Current run" }))
    .toBeVisible();
  const pane = page.getByRole("complementary", {
    name: "Artifact",
    exact: true,
  });
  await expect(pane).toHaveCount(0);
  await expect(page.getByText("This run has published no artifact yet."))
    .toHaveCount(0);
});

/**
 * Fan-out artifact list: `entries` pairs one artifact with its in-order
 * versions. Routes serve the right list and the matching versions route.
 */
async function mockArtifacts(
  page: Page,
  entries: {
    artifact: Record<string, unknown>;
    versions: Record<string, unknown>[];
  }[],
  options: { pageSize?: number } = {},
) {
  await mockSession(page, {
    runStatus: "completed",
    finishedAt: "2026-01-01T00:01:00.000Z",
    steps: [stepOf("brief", "completed"), stepOf("implement", "completed")],
  });
  const pageSize = options.pageSize ?? entries.length;
  await page.route(
    "**/v1/artifacts?*",
    (route) => {
      const start = Number(
        new URL(route.request().url()).searchParams.get("cursor") ?? 0,
      );
      const end = start + pageSize;
      return route.fulfill({
        json: {
          items: entries.slice(start, end).map((entry) => entry.artifact),
          nextCursor: end < entries.length ? String(end) : null,
        },
      });
    },
  );
  for (const entry of entries) {
    await page.route(
      `**/v1/artifacts/${entry.artifact.id}/versions*`,
      (route) =>
        route.fulfill({ json: { items: entry.versions, nextCursor: null } }),
    );
  }
  await page.route(
    "**/v1/artifact-versions/*/extract*",
    (route) => {
      const versionId =
        route.request().url().match(/artifact-versions\/([^/]+)/)![1];
      const entry = entries.find((candidate) =>
        candidate.versions.some((version) => version.id === versionId)
      )!;
      const version = entry.versions.find((item) => item.id === versionId)!;
      const mediaType = version.mediaType as string;
      const text = mediaType === "text/x-diff"
        ? "diff --git a/x b/x"
        : `# ${entry.artifact.name as string} ${version.revision as number}`;
      return route.fulfill({
        json: {
          versionId,
          sha256: version.sha256,
          mediaType,
          startByte: 0,
          endByteExclusive: new TextEncoder().encode(text).byteLength,
          text,
          hasMore: false,
        },
      });
    },
  );
}

const briefStepId = stepOf("brief", "completed").id;
const implementStepId = stepOf("implement", "completed").id;

test("the aside prefers this run's patch over another run-owned artifact type", async ({ page }) => {
  const patchId = "00000000-0000-4000-8000-000000000040";
  const brief = {
    ...artifact,
    artifactType: "other",
    currentVersionId: versionIds[1],
  };
  const mockPatch = {
    id: patchId,
    taskId: id,
    artifactType: "patch",
    name: "Implement patch",
    currentVersionId: "00000000-0000-4000-8000-000000000041",
    createdAt: "2026-01-01T00:00:04.000Z",
    updatedAt: "2026-01-01T00:00:05.000Z",
    version: 1,
  };
  await mockArtifacts(page, [
    {
      artifact: brief,
      versions: [artifactVersion(1), artifactVersion(0)],
    },
    {
      artifact: mockPatch,
      versions: [{
        id: mockPatch.currentVersionId,
        artifactId: patchId,
        revision: 1,
        runStepId: implementStepId,
        authorId: "00000000-0000-4000-8000-000000000001",
        mediaType: "text/x-diff",
        sizeBytes: 32,
        sha256: digest("c"),
        subjectHeadSha: "a".repeat(40),
        subjectBaseSha: "b".repeat(40),
        metadata: {},
        createdAt: "2026-01-01T00:00:04.000Z",
        updatedAt: "2026-01-01T00:00:04.000Z",
        version: 1,
      }],
    },
  ]);
  await page.goto(`/tasks/${id}`);
  const pane = page.getByRole("complementary", {
    name: "Artifact",
    exact: true,
  });
  await expect(pane).toBeVisible();
  await expect(pane.getByRole("heading", { name: "Implement patch" }))
    .toBeVisible();
  await expectAsideFacts(pane, digest("c"));
  await expect(pane.getByRole("heading", { name: "Task brief" }))
    .toHaveCount(0);
});

test("the aside shows a run-owned non-patch artifact when the run has no patch", async ({ page }) => {
  // The progress-phase shape: the brief step published its markdown document,
  // the implement step has produced nothing yet.
  const document = {
    ...artifact,
    artifactType: "other",
    currentVersionId: versionIds[1],
  };
  await mockArtifacts(page, [
    {
      artifact: document,
      versions: [{
        id: versionIds[1],
        artifactId,
        revision: 1,
        runStepId: briefStepId,
        authorId: "00000000-0000-4000-8000-000000000001",
        mediaType: "text/markdown",
        sizeBytes: 96,
        sha256: digest("a"),
        subjectHeadSha: null,
        subjectBaseSha: null,
        metadata: {},
        createdAt: "2026-01-01T00:00:02.000Z",
        updatedAt: "2026-01-01T00:00:02.000Z",
        version: 1,
      }],
    },
  ]);
  await page.goto(`/tasks/${id}`);
  const pane = page.getByRole("complementary", {
    name: "Artifact",
    exact: true,
  });
  await expect(pane.getByRole("heading", { name: "Task brief" })).toBeVisible();
  await expectAsideFacts(pane, digest("a"));
});

test("an artifact published outside this run never becomes the aside card", async ({ page }) => {
  const foreign = {
    ...artifact,
    artifactType: "patch",
    name: "Prior run patch",
    currentVersionId: versionIds[0],
  };
  await mockArtifacts(page, [
    {
      artifact: foreign,
      versions: [{
        ...artifactVersion(0, "text/x-diff"),
        // A foreign run's version: no run step of this run published it.
        runStepId: "00000000-0000-4000-8000-00000000ffff",
      }],
    },
  ]);
  await page.goto(`/tasks/${id}`);
  const pane = page.getByRole("complementary", {
    name: "Artifact",
    exact: true,
  });
  await expect(pane.getByRole("heading", { name: "Prior run patch" }))
    .toHaveCount(0);
  // Nothing of this run to show: the pane is not drawn at all.
  await expect(pane).toHaveCount(0);
  await expect(page.getByText("Prior run patch")).toHaveCount(0);
});

test("a transcript log owned by this run never becomes the aside card", async ({ page }) => {
  const log = {
    ...artifact,
    artifactType: "log",
    name: "output-transcript/session/segment",
    currentVersionId: versionIds[0],
  };
  await mockArtifacts(page, [
    { artifact: log, versions: [artifactVersion(0, "text/plain")] },
  ]);
  await page.goto(`/tasks/${id}`);
  const pane = page.getByRole("complementary", {
    name: "Artifact",
    exact: true,
  });
  await expect(pane).toHaveCount(0);
  await expect(page.getByText("output-transcript/session/segment"))
    .toHaveCount(0);
});

test("the aside prefers this run's patch even when it sits on a later page", async ({ page }) => {
  const patchId = "00000000-0000-4000-8000-000000000040";
  const brief = {
    ...artifact,
    artifactType: "other",
    currentVersionId: versionIds[1],
  };
  const laterPatch = {
    id: patchId,
    taskId: id,
    artifactType: "patch",
    name: "Implement patch",
    currentVersionId: "00000000-0000-4000-8000-000000000041",
    createdAt: "2026-01-01T00:00:04.000Z",
    updatedAt: "2026-01-01T00:00:05.000Z",
    version: 1,
  };
  await mockArtifacts(page, [
    {
      artifact: brief,
      versions: [artifactVersion(1), artifactVersion(0)],
    },
    {
      artifact: laterPatch,
      versions: [{
        id: laterPatch.currentVersionId,
        artifactId: patchId,
        revision: 1,
        runStepId: implementStepId,
        authorId: "00000000-0000-4000-8000-000000000001",
        mediaType: "text/x-diff",
        sizeBytes: 32,
        sha256: digest("c"),
        subjectHeadSha: "a".repeat(40),
        subjectBaseSha: "b".repeat(40),
        metadata: {},
        createdAt: "2026-01-01T00:00:04.000Z",
        updatedAt: "2026-01-01T00:00:04.000Z",
        version: 1,
      }],
    },
  ], { pageSize: 1 });
  await page.goto(`/tasks/${id}`);
  const pane = page.getByRole("complementary", {
    name: "Artifact",
    exact: true,
  });
  await expect(pane.getByRole("heading", { name: "Implement patch" }))
    .toBeVisible();
  await expect(pane.getByRole("heading", { name: "Task brief" }))
    .toHaveCount(0);
});

test("the aside prefers this run's patch and never flashes the brief while that page loads", async ({ page }) => {
  const patchId = "00000000-0000-4000-8000-000000000040";
  const brief = {
    ...artifact,
    artifactType: "other",
    currentVersionId: versionIds[1],
  };
  const laterPatch = {
    id: patchId,
    taskId: id,
    artifactType: "patch",
    name: "Implement patch",
    currentVersionId: "00000000-0000-4000-8000-000000000041",
    createdAt: "2026-01-01T00:00:04.000Z",
    updatedAt: "2026-01-01T00:00:05.000Z",
    version: 1,
  };
  await mockArtifacts(page, [
    {
      artifact: brief,
      versions: [artifactVersion(1), artifactVersion(0)],
    },
    {
      artifact: laterPatch,
      versions: [{
        id: laterPatch.currentVersionId,
        artifactId: patchId,
        revision: 1,
        runStepId: implementStepId,
        authorId: "00000000-0000-4000-8000-000000000001",
        mediaType: "text/x-diff",
        sizeBytes: 32,
        sha256: digest("c"),
        subjectHeadSha: "a".repeat(40),
        subjectBaseSha: "b".repeat(40),
        metadata: {},
        createdAt: "2026-01-01T00:00:04.000Z",
        updatedAt: "2026-01-01T00:00:04.000Z",
        version: 1,
      }],
    },
  ], { pageSize: 1 });
  // Registered last, so it runs first: hold the second page back.
  let requested!: () => void;
  const secondPageRequested = new Promise<void>((resolve) => {
    requested = resolve;
  });
  await page.route("**/v1/artifacts?*cursor=*", async (route) => {
    requested();
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await route.fallback();
  });
  await page.goto(`/tasks/${id}`);
  const pane = page.getByRole("complementary", {
    name: "Artifact",
    exact: true,
  });
  await secondPageRequested;
  // Long enough for the pane to settle on the brief if it wrongly did.
  await page.waitForTimeout(1000);
  // One immediate count: `toHaveCount` would retry until the page arrives.
  expect(await pane.getByText("Task brief", { exact: true }).count()).toBe(0);
  await expect(pane.getByRole("heading", { name: "Implement patch" }))
    .toBeVisible();
  await expect(pane.getByRole("heading", { name: "Task brief" }))
    .toHaveCount(0);
});

test("the aside is not empty while a later page may hold this run's patch", async ({ page }) => {
  const patchId = "00000000-0000-4000-8000-000000000040";
  const log = {
    ...artifact,
    artifactType: "log",
    name: "output-transcript/session/segment",
    currentVersionId: versionIds[0],
  };
  const laterPatch = {
    id: patchId,
    taskId: id,
    artifactType: "patch",
    name: "Implement patch",
    currentVersionId: "00000000-0000-4000-8000-000000000041",
    createdAt: "2026-01-01T00:00:04.000Z",
    updatedAt: "2026-01-01T00:00:05.000Z",
    version: 1,
  };
  await mockArtifacts(page, [
    { artifact: log, versions: [artifactVersion(0, "text/plain")] },
    {
      artifact: laterPatch,
      versions: [{
        id: laterPatch.currentVersionId,
        artifactId: patchId,
        revision: 1,
        runStepId: implementStepId,
        authorId: "00000000-0000-4000-8000-000000000001",
        mediaType: "text/x-diff",
        sizeBytes: 32,
        sha256: digest("c"),
        subjectHeadSha: "a".repeat(40),
        subjectBaseSha: "b".repeat(40),
        metadata: {},
        createdAt: "2026-01-01T00:00:04.000Z",
        updatedAt: "2026-01-01T00:00:04.000Z",
        version: 1,
      }],
    },
  ], { pageSize: 1 });
  let requested!: () => void;
  const secondPageRequested = new Promise<void>((resolve) => {
    requested = resolve;
  });
  await page.route("**/v1/artifacts?*cursor=*", async (route) => {
    requested();
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await route.fallback();
  });
  await page.goto(`/tasks/${id}`);
  const pane = page.getByRole("complementary", {
    name: "Artifact",
    exact: true,
  });
  await secondPageRequested;
  await page.waitForTimeout(1000);
  // One immediate count: `toHaveCount` would retry until the page arrives.
  expect(
    await pane.getByText("This run has published no artifact yet.").count(),
  ).toBe(0);
  await expect(pane.getByRole("heading", { name: "Implement patch" }))
    .toBeVisible();
});

for (const locale of ["en", "en-XA", "ar-XB"]) {
  test(`session detail supports dark reduced-motion ${locale} at 320px`, async ({ page }) => {
    await page.addInitScript((value) => {
      localStorage.setItem("bakery.theme.v1", "dark");
      Object.defineProperty(navigator, "languages", {
        configurable: true,
        value: [value],
      });
    }, locale);
    // The server's answer wins over the browser, so it asks for the same.
    await mockUserPreferences(page, {
      theme: "dark",
      effectiveLocale: locale,
      direction: locale === "ar-XB" ? "rtl" : "ltr",
    });
    await page.setViewportSize({ width: 320, height: 800 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await mockArtifact(page, { mediaType: "application/json" });
    await firstRender(
      () => page.goto(`/tasks/${id}`),
      (timeout) =>
        expect(page.locator("html")).toHaveAttribute("data-theme", "dark", {
          timeout,
        }),
    );
    await expect(page.locator("html")).toHaveAttribute(
      "dir",
      locale === "ar-XB" ? "rtl" : "ltr",
    );
    await expect(page.locator('[data-ui-component="runTimeline"]'))
      .toBeVisible();
    const pane = page.locator('[data-ui-component="artifactPane"]');
    await expectAsideFacts(pane, briefDigest(1, "application/json"));
    // At 320 px the Fingerprint name, its info icon and the value never overlap,
    // whatever the locale's name is.
    const fingerprint = pane.getByTestId("artifact-fingerprint-row");
    const icon = (await fingerprint.locator(".ui-help-tip .ui-icon").first()
      .boundingBox())!;
    const value = (await fingerprint.locator('[data-ui-component="dataText"]')
      .first().boundingBox())!;
    expect(
      icon.x < value.x + value.width && value.x < icon.x + icon.width &&
        icon.y < value.y + value.height && value.y < icon.y + icon.height,
    ).toBe(false);
    await expect(pane.locator("pre")).toHaveAttribute("dir", "ltr");
    await expect(pane.locator("pre")).toHaveCSS("direction", "ltr");
    expect(
      await page.evaluate(() =>
        document.documentElement.scrollWidth <=
          document.documentElement.clientWidth
      ),
    ).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });
}

// The artifact Details, open, as a still: desktop and phone, light and dark, in a
// left-to-right and a right-to-left locale. Written only when stills are asked for.
for (
  const [locale, narrow] of [["en", null], ["ar-XB", null], [
    "ar-XB",
    320,
  ]] as const
) {
  test(`still: the artifact details open, ${locale}${narrow ? ` at ${narrow}` : ""}`, async ({ page }) => {
    if (narrow) await page.setViewportSize({ width: narrow, height: 800 });
    await page.addInitScript((value) => {
      Object.defineProperty(navigator, "languages", {
        configurable: true,
        value: [value],
      });
    }, locale);
    await mockUserPreferences(page, {
      effectiveLocale: locale,
      direction: locale === "ar-XB" ? "rtl" : "ltr",
    });
    await mockArtifact(page, { mediaType: "application/json" });
    await page.goto(`/tasks/${id}`);
    const pane = page.locator('[data-ui-component="artifactPane"]');
    await expectAsideFacts(pane, briefDigest(1, "application/json"));
    await still(
      page,
      `artifact-details-${locale}${narrow ? `-${narrow}` : ""}`,
      pane,
    );
  });
}
