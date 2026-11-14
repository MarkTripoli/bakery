import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import {
  mockAuthenticatedSession,
  mockUserPreferences,
} from "./helpers/mock-session.ts";

const applicationId = "00000000-0000-4000-8000-000000000101";
const repositoryId = "00000000-0000-4000-8000-000000000102";
const profileId = "00000000-0000-4000-8000-000000000103";
const digest = "a".repeat(64);
const application = {
  id: applicationId,
  slug: "bakery",
  name: "Bakery",
  description: "Repository delivery",
  archivedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  version: 1,
};
const repository = {
  id: repositoryId,
  applicationId,
  integrationConnectionId: "00000000-0000-4000-8000-000000000104",
  providerRepoId: "MarkTripoli/bakery",
  slug: "bakery",
  owner: "MarkTripoli",
  name: "bakery",
  defaultBranch: "main",
  activeProfileId: profileId,
  archivedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  version: 3,
};
const profile = {
  id: profileId,
  repositoryId,
  revision: 7,
  config: {
    schemaVersion: 1,
    workflow: { kind: "fixed" },
    branches: {
      base: "main",
      allowedPatterns: [
        "delivery/*",
        "fix/*",
        "release/issue-128-worst-case-*",
      ],
    },
    worktree: { root: ".agents/worktrees/bakery" },
  },
  digest,
  createdBy: "00000000-0000-4000-8000-000000000105",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  version: 1,
};

async function mockProjects(page: import("@playwright/test").Page) {
  await mockAuthenticatedSession(page);
  let taskFailure: "none" | "conflict" | "forbidden" = "none";
  const taskRequests: unknown[] = [];
  await page.route("**/v1/**", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === "/v1/applications" && request.method() === "GET") {
      return route.fulfill({
        json: { items: [application], nextCursor: null },
      });
    }
    if (path === `/v1/applications/${applicationId}`) {
      return route.fulfill({ json: application });
    }
    if (path === "/v1/repositories" && request.method() === "GET") {
      return route.fulfill({ json: { items: [repository], nextCursor: null } });
    }
    if (
      path === `/v1/repositories/${repositoryId}` && request.method() === "GET"
    ) {
      return route.fulfill({ json: repository });
    }
    if (path === `/v1/repositories/${repositoryId}/profiles`) {
      return route.fulfill({ json: { items: [profile], nextCursor: null } });
    }
    if (path === `/v1/applications/${applicationId}/roles`) {
      return route.fulfill({ json: { items: [], nextCursor: null } });
    }
    if (
      (path.startsWith("/v1/applications/") ||
        path.startsWith("/v1/repositories/")) && request.method() === "GET"
    ) {
      return route.fulfill({
        status: 404,
        contentType: "application/problem+json",
        json: {
          type: "https://bakery.example/problems/not-found",
          title: "Resource not found",
          status: 404,
          detail: "The requested resource was not found.",
          code: "RESOURCE_NOT_FOUND",
          requestId: "00000000-0000-4000-8000-000000000110",
          traceId: "00000000-0000-4000-8000-000000000111",
          retryable: false,
        },
      });
    }
    if (path === "/v1/tasks" && request.method() === "POST") {
      taskRequests.push(request.postDataJSON());
      if (taskFailure === "conflict") {
        return route.fulfill({
          status: 409,
          contentType: "application/problem+json",
          json: {
            type: "https://bakery.example/problems/state-conflict",
            title: "State conflict",
            status: 409,
            detail: "The current state conflicts with this request.",
            code: "STATE_CONFLICT",
            requestId: "00000000-0000-4000-8000-000000000106",
            traceId: "00000000-0000-4000-8000-000000000107",
            retryable: false,
          },
        });
      }
      if (taskFailure === "forbidden") {
        return route.fulfill({
          status: 403,
          contentType: "application/problem+json",
          json: {
            type: "https://bakery.example/problems/auth-forbidden",
            title: "Access forbidden",
            status: 403,
            detail: "You do not have permission to perform this action.",
            code: "AUTH_FORBIDDEN",
            requestId: "00000000-0000-4000-8000-000000000112",
            traceId: "00000000-0000-4000-8000-000000000113",
            retryable: false,
          },
        });
      }
      return route.fulfill({
        status: 201,
        json: {
          id: "00000000-0000-4000-8000-000000000108",
          applicationId,
          repositoryId,
          conversationId: "00000000-0000-4000-8000-000000000109",
          parentTaskId: null,
          title: "Repository profile task",
          description: "Draft survives conflicts",
          taskType: "feature",
          status: "draft",
          priority: 50,
          createdBy: "00000000-0000-4000-8000-000000000105",
          currentRunId: null,
          archivedAt: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          version: 1,
          repositoryProfileId: profileId,
          repositoryProfileRevision: 7,
          repositoryProfileDigest: digest,
          observationId: null,
          observationDigest: null,
          baseSha: null,
        },
      });
    }
    return route.fallback();
  });
  return {
    taskRequests,
    setTaskFailure(value: "none" | "conflict" | "forbidden") {
      taskFailure = value;
    },
  };
}

for (const ambiguous of ["network", "in-flight"]) {
  test(`composer retries ${ambiguous} with the same immutable intent`, async ({ page }) => {
    await mockProjects(page);
    const keys: string[] = [];
    const bodies: string[] = [];
    await page.route("**/v1/tasks", (route) => {
      keys.push(route.request().headers()["idempotency-key"]);
      bodies.push(route.request().postData()!);
      if (keys.length === 1) {
        if (ambiguous === "network") return route.abort("failed");
        return route.fulfill({
          status: 409,
          contentType: "application/problem+json",
          json: {
            type: "https://bakery.example/problems/idempotency-in-flight",
            title: "Command in flight",
            status: 409,
            detail: "Original command is pending.",
            code: "IDEMPOTENCY_IN_FLIGHT",
            requestId: applicationId,
            traceId: repositoryId,
            retryable: true,
          },
        });
      }
      return route.fallback();
    });
    await page.goto(deepLink);
    const scope = page.getByTestId("projects-onboarding-task-scope");
    await scope.getByLabel("Task title").fill("Repository profile task");
    await scope.getByRole("button", { name: "Create draft task" }).click();
    await expect(scope.getByRole("alert")).toBeVisible();
    await expect(scope.getByLabel("Task title")).toBeDisabled();
    await expect(scope.getByLabel("Task description")).toBeDisabled();
    await scope.getByRole("button", { name: "Create draft task" }).click();
    await expect(scope).toContainText(
      "Draft task created with authoritative profile pins",
    );
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
    expect(bodies[1]).toBe(bodies[0]);
    await expect(
      scope.getByRole("link", { name: "00000000-0000-4000-8000-000000000108" }),
    ).toHaveAttribute("href", "/tasks/00000000-0000-4000-8000-000000000108");
    await expect(scope.getByRole("button", { name: "Create draft task" }))
      .toBeDisabled();
    await scope.getByRole("button", { name: "Start another task" }).click();
    await expect(scope.getByLabel("Task title")).toHaveValue("");
    await scope.getByLabel("Task title").fill("Explicit next task");
    await scope.getByRole("button", { name: "Create draft task" }).click();
    await expect(scope).toContainText(
      "Draft task created with authoritative profile pins",
    );
    expect(keys).toHaveLength(3);
    expect(keys[2]).not.toBe(keys[0]);
  });
}

test("composer allows correcting a definitive validation rejection", async ({ page }) => {
  await mockProjects(page);
  await page.route(
    "**/v1/tasks",
    (route) =>
      route.fulfill({
        status: 422,
        contentType: "application/problem+json",
        json: {
          type: "https://bakery.example/problems/validation",
          title: "Invalid task",
          status: 422,
          detail: "Correct the task.",
          code: "VALIDATION_FAILED",
          requestId: applicationId,
          traceId: repositoryId,
          retryable: false,
        },
      }),
  );
  await page.goto(deepLink);
  const scope = page.getByTestId("projects-onboarding-task-scope");
  await scope.getByLabel("Task title").fill("Invalid task");
  await scope.getByRole("button", { name: "Create draft task" }).click();
  await expect(scope.getByRole("alert")).toBeVisible();
  await expect(scope.getByLabel("Task title")).toBeEnabled();
  await scope.getByLabel("Task title").fill("Corrected task");
});

const deepLink =
  `/projects/onboarding?application=${applicationId}&repository=${repositoryId}&profile=${profileId}`;

test("projects onboarding restores the repository profile boundary from a stable link", async ({ page }) => {
  await mockProjects(page);
  await page.goto(deepLink);

  const boundary = page.getByTestId("projects-onboarding-profile-boundary");
  await expect(boundary).toBeVisible();
  await expect(boundary).toContainText("MarkTripoli/bakery");
  await expect(boundary).toContainText("delivery/*");
  await expect(boundary).toContainText(".agents/worktrees/bakery");
  await expect(boundary).toContainText(digest);
  await expect(page).toHaveURL(deepLink);

  await page.reload();
  await expect(boundary).toBeVisible();
  await expect(page.getByTestId("projects-onboarding-task-scope"))
    .toBeVisible();
});

test("a selected repository links to the rules in force for it", async ({ page }) => {
  await mockProjects(page);
  await page.route(
    `**/v1/repositories/${repositoryId}/rules`,
    (route) =>
      route.fulfill({
        json: {
          repositoryId,
          profileId,
          profileRevision: 7,
          organizationRevision: 0,
          entries: [],
          supersededOverrides: [],
          digest,
          repositoryVersion: 3,
          checkers: { state: "not_required", unavailableRuleKeys: [] },
          providerProtection: { state: "unknown", reason: "not_checked" },
        },
      }),
  );
  await page.goto(deepLink);
  const link = page.getByRole("link", {
    name: "Rules for MarkTripoli/bakery",
  });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute(
    "href",
    `/projects/repositories/${repositoryId}/rules`,
  );
  await link.click();
  await expect(page).toHaveURL(`/projects/repositories/${repositoryId}/rules`);
  await expect(page.getByRole("heading", { name: "Rules", level: 1 }))
    .toBeVisible();
  await expect(page.getByText("No rules apply to this repository"))
    .toBeVisible();
});

test("projects onboarding preserves draft input and requires explicit profile reselection after conflict", async ({ page }) => {
  const mocked = await mockProjects(page);
  await page.goto(deepLink);
  const scope = page.getByTestId("projects-onboarding-task-scope");
  await scope.getByLabel("Task title").fill("Repository profile task");
  await scope.getByLabel("Task description").fill("Draft survives conflicts");
  mocked.setTaskFailure("conflict");
  await scope.getByRole("button", { name: "Create draft task" }).click();
  await expect(
    scope.locator('form[data-ui-component="taskComposer"]'),
  ).toHaveAttribute("data-state", "conflict");

  await expect(scope).toContainText("The active repository profile changed");
  await expect(scope.getByLabel("Task title")).toHaveValue(
    "Repository profile task",
  );
  await expect(scope.getByLabel("Task description")).toHaveValue(
    "Draft survives conflicts",
  );
  await expect(page).toHaveURL(
    `/projects/onboarding?application=${applicationId}&repository=${repositoryId}`,
  );
  await expect(scope.getByRole("button", { name: "Create draft task" }))
    .toBeDisabled();

  const review = page.getByRole("button", {
    name: "Review this active profile",
  });
  if (!(await review.isVisible())) {
    // Phones keep the repository inspector, with its profile list, in a
    // sheet that opens from the repository row; wide layouts show it in place.
    await page.getByRole("button", { name: /MarkTripoli\/bakery/ }).click();
  }
  await review.click();
  await expect(page).toHaveURL(deepLink);
  await expect(scope.getByLabel("Task title")).toHaveValue(
    "Repository profile task",
  );
  mocked.setTaskFailure("none");
  await scope.getByRole("button", { name: "Create draft task" }).click();
  await expect(
    scope.locator('form[data-ui-component="taskComposer"]'),
  ).toHaveAttribute("data-state", "success");
  await expect(scope).toContainText(
    "Draft task created with authoritative profile pins",
  );
  expect(mocked.taskRequests).toHaveLength(2);
  expect(mocked.taskRequests[1]).toMatchObject({
    applicationId,
    repositoryId,
    repositoryProfileId: profileId,
  });
});

test("composer conflict keeps the outcome visible and focused without losing the draft or pins", async ({ page }) => {
  const mocked = await mockProjects(page);
  await page.goto(deepLink);
  const scope = page.getByTestId("projects-onboarding-task-scope");
  const title = scope.getByLabel("Task title");
  await title.fill("Repository profile task");
  await scope.getByLabel("Task description").fill("Retain this draft");
  mocked.setTaskFailure("conflict");
  await scope.getByRole("button", { name: "Create draft task" }).click();
  await expect(
    scope.locator('form[data-ui-component="taskComposer"]'),
  ).toHaveAttribute("data-state", "conflict");

  await expect(page).toHaveURL(
    `/projects/onboarding?application=${applicationId}&repository=${repositoryId}`,
  );
  const notice = scope.getByRole("alert");
  await expect(notice).toContainText("The active repository profile changed");
  await expect(notice).toBeFocused();
  await expect(notice).toBeInViewport({ ratio: 1 });
  await expect(title).toHaveValue("Repository profile task");
  await expect(scope.getByLabel("Task description")).toHaveValue(
    "Retain this draft",
  );
  await expect(scope.getByRole("button", { name: "Create draft task" }))
    .toBeDisabled();
  expect(mocked.taskRequests).toHaveLength(1);
  expect(mocked.taskRequests[0]).toMatchObject({
    applicationId,
    repositoryId,
    repositoryProfileId: profileId,
  });
  await page.keyboard.press("Tab");
  await expect(title).toBeFocused();
});

test("composer conflict does not steal focus after the user moves elsewhere", async ({ page }) => {
  const mocked = await mockProjects(page);
  mocked.setTaskFailure("conflict");
  let release = () => {};
  const response = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/v1/tasks", async (route) => {
    if (route.request().method() === "POST") await response;
    await route.fallback();
  });
  try {
    await page.goto(deepLink);
    const scope = page.getByTestId("projects-onboarding-task-scope");
    await scope.getByLabel("Task title").fill("Draft while awaiting response");
    await scope.getByRole("button", { name: "Create draft task" }).click();
    await expect(scope.getByRole("button", { name: "Creating draft task" }))
      .toBeDisabled();
    // A persistent shell control outside the composer: the sidebar's first
    // link on desktop, the top bar's navigation button on phones.
    const elsewhere = page.locator(
      '[data-ui-component="sidebarNav"] a, [data-ui-component="topBar"] button',
    ).filter({ visible: true }).first();
    await elsewhere.focus();
    release();
    await expect(page).toHaveURL(
      `/projects/onboarding?application=${applicationId}&repository=${repositoryId}`,
    );
    await expect(scope.getByRole("alert")).toContainText(
      "The active repository profile changed",
    );
    await expect(elsewhere).toBeFocused();
  } finally {
    release();
  }
});

test("projects onboarding preserves denied and offline drafts without retrying", async ({ page, context }) => {
  const mocked = await mockProjects(page);
  await page.goto(deepLink);
  const scope = page.getByTestId("projects-onboarding-task-scope");
  await scope.getByLabel("Task title").fill("Denied draft");
  mocked.setTaskFailure("forbidden");
  await scope.getByRole("button", { name: "Create draft task" }).click();
  await expect(scope).toContainText("not authorized");
  await expect(
    scope.locator('form[data-ui-component="taskComposer"]'),
  ).toHaveAttribute("data-state", "forbidden");

  mocked.setTaskFailure("none");
  const attemptsBeforeReconnect = mocked.taskRequests.length;
  await context.setOffline(true);
  await expect(scope).toContainText("service is offline");
  await expect(
    scope.locator('form[data-ui-component="taskComposer"]'),
  ).toHaveAttribute("data-state", "offline");
  await expect(scope.getByLabel("Task title")).toHaveValue("Denied draft");
  await context.setOffline(false);
  await expect(scope).toContainText("Connection restored");
  expect(mocked.taskRequests).toHaveLength(attemptsBeforeReconnect);
});

test("projects onboarding profile boundary remains accessible at narrow zoomed RTL layout", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("bakery.theme.v1", "dark");
    Object.defineProperty(navigator, "languages", {
      configurable: true,
      value: ["ar-XB"],
    });
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 320, height: 800 });
  await mockProjects(page);
  // The server's answer wins over the browser, so it asks for the same.
  await mockUserPreferences(page, {
    theme: "dark",
    effectiveLocale: "ar-XB",
    direction: "rtl",
  });
  await page.goto(deepLink);

  await expect(page.getByTestId("projects-onboarding-profile-boundary"))
    .toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
  const create = page.getByRole("button", { name: /Create draft task/ });
  await expect(create).toBeVisible();
  expect(
    await create.evaluate((element) => element.getBoundingClientRect().height),
  )
    .toBeGreaterThanOrEqual(44);
  const overflow = await page.evaluate(() => {
    const viewport = document.documentElement.clientWidth;
    return [...document.querySelectorAll<HTMLElement>("body *")]
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          selector: `${element.tagName.toLowerCase()}${
            element.id ? `#${element.id}` : ""
          }.${[...element.classList].join(".")}`,
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
        };
      })
      .filter((rect, index) => {
        if (rect.left >= -1 && rect.right <= viewport + 1) return false;
        const element = document.querySelectorAll<HTMLElement>("body *")[index];
        for (
          let parent = element.parentElement;
          parent;
          parent = parent.parentElement
        ) {
          const overflowX = getComputedStyle(parent).overflowX;
          if (
            ["auto", "scroll", "hidden", "clip"].includes(overflowX) &&
            parent.scrollWidth > parent.clientWidth
          ) return false;
        }
        return true;
      })
      .slice(0, 20);
  });
  expect(overflow).toEqual([]);
});

test("projects onboarding clears unconfirmed foreign deep-link identity", async ({ page }) => {
  await mockProjects(page);
  const foreign = "00000000-0000-4000-8000-000000000999";
  await page.goto(
    `/projects/onboarding?application=${foreign}&repository=${foreign}&profile=${foreign}`,
  );
  // Without a repository of its own the page is the Projects list.
  await expect(page).toHaveURL("/projects");
  await expect(page.getByTestId("projects-onboarding-profile-boundary"))
    .toHaveCount(0);
});
