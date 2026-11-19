import { expect, type Page, test } from "@playwright/test";
import { mockAuthenticatedSession } from "./helpers/mock-session.ts";
import { still } from "./helpers/stills.ts";

// #240: a failed load, and a task that cannot be opened, say what happened and
// what to do, in the one pattern every page uses.

const taskId = "00000000-0000-4000-8000-000000000012";

const problem = (status: number, code: string) => ({
  type: "about:blank",
  title: code,
  status,
  code,
  detail: "The server refused the request.",
  requestId: "00000000-0000-4000-8000-000000000110",
  traceId: "00000000-0000-4000-8000-000000000111",
  retryable: status >= 500,
});

async function prepare(page: Page) {
  // Anything not stubbed below is an empty list.
  await page.route(
    "**/v1/**",
    (route) => route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await mockAuthenticatedSession(page);
}

test("a failed Work load is one error block with a content-width secondary button and no filters", async ({ page }) => {
  await prepare(page);
  await page.route(
    "**/v1/tasks?*",
    (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/problem+json",
        json: problem(500, "INTERNAL"),
      }),
  );
  await page.goto("/tasks");
  const error = page.locator('[data-ui-component="errorState"]');
  await expect(error).toBeVisible();
  await expect(error).toContainText("Work could not be loaded");
  await expect(error).toContainText("Check your connection, then try again.");
  const retry = error.getByRole("button", { name: "Try again", exact: true });
  await expect(retry).toBeVisible();
  // Secondary, and as wide as its label, never a bar across the block.
  await expect(retry).toHaveClass(/secondary/);
  const [button, block] = await Promise.all([
    retry.boundingBox(),
    error.boundingBox(),
  ]);
  expect(button!.width).toBeLessThan(block!.width / 2);
  // Nothing to filter, so no search or filter controls above the error.
  await expect(page.getByRole("searchbox", { name: "Search tasks" }))
    .toHaveCount(0);
  await expect(page.getByRole("button", { name: "All applications" }))
    .toHaveCount(0);
  // The tabs stay.
  await expect(page.getByRole("tab", { name: /^All/ }).first()).toBeVisible();
  await still(page, "work-error");
});

test("trying again after a failed Work load reads the list again", async ({ page }) => {
  await prepare(page);
  let failing = true;
  let reads = 0;
  await page.route("**/v1/tasks?*", (route) => {
    reads += 1;
    return failing
      ? route.fulfill({
        status: 500,
        contentType: "application/problem+json",
        json: problem(500, "INTERNAL"),
      })
      : route.fulfill({ json: { items: [], nextCursor: null } });
  });
  await page.goto("/tasks");
  const retry = page.getByRole("button", { name: "Try again", exact: true });
  await expect(retry).toBeVisible();
  const before = reads;
  failing = false;
  await retry.click();
  await expect.poll(() => reads).toBeGreaterThan(before);
  await expect(page.locator('[data-ui-component="errorState"]')).toHaveCount(0);
});

for (const status of [404, 403] as const) {
  test(
    `a task that answers ${status} says it is not available, and the button goes back to Work`,
    async ({ page }, testInfo) => {
      await prepare(page);
      await page.route(
        `**/v1/tasks/${taskId}`,
        (route) =>
          route.fulfill({
            status,
            contentType: "application/problem+json",
            json: problem(status, status === 404 ? "NOT_FOUND" : "FORBIDDEN"),
          }),
      );
      await page.goto(`/tasks/${taskId}`);
      const empty = page.locator('[data-ui-component="emptyState"]');
      await expect(empty).toContainText("This task is not available");
      await expect(empty).toContainText(
        "It may have been deleted, or you may not have access to it.",
      );
      // The page is "Task", and the trail reads Work / Task.
      await expect(page.getByRole("heading", { name: "Task detail" }))
        .toHaveCount(0);
      // A phone has no top-bar trail; a wide screen reads Work / Task.
      if (testInfo.project.name === "desktop") {
        const trail = page.getByRole("navigation", { name: /breadcrumb/i });
        await expect(trail).toContainText("Work");
        await expect(trail).toContainText("Task");
      }
      await still(page, `task-unavailable-${status}`);
      await empty.getByRole("button", { name: "Back to Work", exact: true })
        .click();
      await expect(page).toHaveURL(/\/tasks$/);
    },
  );
}

const stamp = "2026-01-01T00:00:00.000Z";
const listedTask = {
  id: taskId,
  applicationId: "00000000-0000-4000-8000-000000000004",
  repositoryId: "00000000-0000-4000-8000-000000000005",
  conversationId: "00000000-0000-4000-8000-000000000006",
  parentTaskId: null,
  title: "Add retries to uploads",
  description: "Persisted description",
  taskType: "feature",
  status: "active",
  priority: 50,
  createdBy: "00000000-0000-4000-8000-000000000001",
  currentRunId: null,
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

const inbox = (page: Page) => page.locator('[data-ui-component="taskInbox"]');

/** The search field: a toolbar field on a wide screen, behind a button on a phone. */
async function searchBox(page: Page) {
  if ((page.viewportSize()?.width ?? 1280) > 743) {
    return page.getByRole("searchbox", { name: "Search tasks" });
  }
  await page.getByRole("button", { name: /^Search(: .*)?$/ }).click();
  return page.getByLabel("Search titles and descriptions");
}

test("the Work list loads as five skeleton rows with no filters above them", async ({ page }) => {
  await prepare(page);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => release = resolve);
  await page.route("**/v1/tasks?*", async (route) => {
    await held;
    await route.fulfill({ json: { items: [], nextCursor: null } });
  });
  await page.goto("/tasks");
  await expect(inbox(page)).toHaveAttribute("data-state", "loading");
  const rows = page.getByLabel("Loading tasks…");
  await expect(rows).toBeVisible();
  await expect(rows.locator('[data-ui-component="skeleton"]')).toHaveCount(5);
  await expect(page.getByRole("searchbox", { name: "Search tasks" }))
    .toHaveCount(0);
  await still(page, "work-loading");
  release();
});

test("a Work list the person cannot read says so, with no button and no filters", async ({ page }) => {
  await prepare(page);
  await page.route(
    "**/v1/tasks?*",
    (route) =>
      route.fulfill({
        status: 403,
        contentType: "application/problem+json",
        json: problem(403, "FORBIDDEN"),
      }),
  );
  await page.goto("/tasks");
  const empty = page.locator('[data-ui-component="emptyState"]');
  await expect(empty).toContainText("You do not have access to Work");
  await expect(empty).toContainText(
    "Ask an organization administrator for access.",
  );
  await expect(empty.getByRole("button")).toHaveCount(0);
  await expect(page.getByRole("searchbox", { name: "Search tasks" }))
    .toHaveCount(0);
  await still(page, "work-forbidden");
});

test("no tasks at all offers one primary New task button", async ({ page }) => {
  await prepare(page);
  await page.goto("/tasks");
  const empty = page.locator('[data-ui-component="emptyState"]');
  await expect(empty).toContainText("No tasks yet");
  await expect(empty).toContainText(
    "Describe what you want done and Bakery starts on it.",
  );
  await still(page, "work-empty");
  await empty.getByRole("button", { name: "New task", exact: true }).click();
  await expect(page).toHaveURL(/\/tasks\/new$/);
});

test("no tasks match a search, and Clear filters brings the list back", async ({ page }) => {
  await prepare(page);
  await page.route("**/v1/tasks?*", (route) => {
    const searched = new URL(route.request().url()).search.includes("needle");
    return route.fulfill({
      json: { items: searched ? [] : [listedTask], nextCursor: null },
    });
  });
  await page.goto("/tasks");
  await expect(page.getByText("Add retries to uploads").first()).toBeVisible();
  await (await searchBox(page)).fill("needle");
  const empty = page.locator('[data-ui-component="emptyState"]');
  await expect(empty).toContainText("No tasks match");
  // On a phone the search sits in a popover; close it so the block is in view.
  if ((page.viewportSize()?.width ?? 1280) <= 743) {
    await page.keyboard.press("Escape");
    await expect(page.getByLabel("Search titles and descriptions")).toHaveCount(
      0,
    );
  }
  await expect(empty).toContainText("Change or clear the filters.");
  const sideways = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(sideways).toBeLessThanOrEqual(0);
  await still(page, "work-no-match");
  await empty.getByRole("button", { name: "Clear filters", exact: true })
    .click();
  await expect(page.getByText("Add retries to uploads").first()).toBeVisible();
  await expect(empty).toHaveCount(0);
});

test("offline with nothing loaded says so, and the list is not blank", async ({ page, context }) => {
  await prepare(page);
  await page.goto("/tasks");
  await expect(inbox(page)).toHaveAttribute("data-state", "empty");
  await context.setOffline(true);
  await expect(inbox(page)).toHaveAttribute("data-state", "offline");
  const empty = page.locator('[data-ui-component="emptyState"]');
  await expect(empty).toContainText("You are offline");
  await expect(empty).toContainText("Work appears when you are back online.");
  await still(page, "work-offline");
  await context.setOffline(false);
});

test("a task page that is loading shows skeleton rows, not a bare line", async ({ page }) => {
  await prepare(page);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => release = resolve);
  await page.route(`**/v1/tasks/${taskId}`, async (route) => {
    await held;
    await route.fulfill({ json: listedTask });
  });
  await page.goto(`/tasks/${taskId}`);
  const rows = page.getByLabel("Loading the task…");
  await expect(rows).toBeVisible();
  await expect(rows.locator('[data-ui-component="skeleton"]')).toHaveCount(3);
  await still(page, "task-loading");
  release();
});

test("a task that fails to load says so, with Try again and Back to Work", async ({ page }) => {
  await prepare(page);
  let failing = true;
  await page.route(`**/v1/tasks/${taskId}`, (route) =>
    failing
      ? route.fulfill({
        status: 500,
        contentType: "application/problem+json",
        json: problem(500, "INTERNAL"),
      })
      : route.fulfill({ json: listedTask }));
  await page.goto(`/tasks/${taskId}`);
  const error = page.locator('[data-ui-component="errorState"]');
  await expect(error).toContainText("This task could not be loaded");
  await expect(error).toContainText("Check your connection, then try again.");
  const retry = error.getByRole("button", { name: "Try again", exact: true });
  await expect(retry).toHaveClass(/secondary/);
  await expect(error.getByRole("button", { name: "Back to Work", exact: true }))
    .toBeVisible();
  await still(page, "task-failed");
  failing = false;
  await retry.click();
  await expect(error).toHaveCount(0);
});

test("a task page that is offline and not loaded says so and goes back to Work", async ({ page, context }) => {
  await prepare(page);
  await page.goto("/tasks");
  await context.setOffline(true);
  await page.evaluate((id) => {
    history.pushState({}, "", `/tasks/${id}`);
    dispatchEvent(new PopStateEvent("popstate"));
  }, taskId);
  const empty = page.locator('[data-ui-component="emptyState"]');
  await expect(empty).toContainText("You are offline");
  await expect(empty).toContainText(
    "This task appears when you are back online.",
  );
  await expect(empty.getByRole("button", { name: "Back to Work", exact: true }))
    .toBeVisible();
  await context.setOffline(false);
});
