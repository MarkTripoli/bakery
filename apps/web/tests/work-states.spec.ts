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
