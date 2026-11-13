import { expect, type Page, type Route, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {
  mockAuthenticatedSession,
  mockUserPreferences,
} from "./helpers/mock-session.ts";

const organizationId = "00000000-0000-4000-8000-000000000003";
const principalId = "00000000-0000-4000-8000-000000000001";
const intentKey = `bakery.taskComposer.intent:${organizationId}:${principalId}`;
const applicationId = "00000000-0000-4000-8000-000000000004";
const repositoryId = "00000000-0000-4000-8000-000000000005";
const profileId = "00000000-0000-4000-8000-000000000006";
const taskId = "00000000-0000-4000-8000-000000000012";
const runId = "00000000-0000-4000-8000-000000000020";
const versionId = "00000000-0000-4000-8000-000000000022";

const repository = {
  id: repositoryId,
  applicationId,
  slug: "web",
  integrationConnectionId: "00000000-0000-4000-8000-000000000007",
  providerRepoId: "1",
  owner: "example",
  name: "web",
  defaultBranch: "main",
  activeProfileId: profileId,
  archivedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  version: 1,
};
type ComposerAvailability = {
  status: "ready" | "setup_required";
  reasons: string[];
  minimumBudgetLimitUsd?: string | null;
};
const preset = (
  availability: ComposerAvailability = {
    status: "ready",
    reasons: [],
  },
) => ({
  id: "fixed-coding",
  revision: 1,
  digest: "a".repeat(64),
  nameKey: "workflowPresets.fixedCoding.name",
  steps: [{ id: "brief", uses: "task.brief" }, {
    id: "implement",
    uses: "harness.implement",
  }],
  defaultBudgetLimitUsd: "5.00",
  availability: { minimumBudgetLimitUsd: null, ...availability },
});
const task = {
  id: taskId,
  applicationId,
  repositoryId,
  conversationId: "00000000-0000-4000-8000-000000000008",
  parentTaskId: null,
  title: "Add repository onboarding",
  description: "Choose a repository and check the worker toolchain.",
  taskType: "feature",
  status: "draft",
  priority: 50,
  createdBy: principalId,
  currentRunId: null,
  archivedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  version: 1,
  repositoryProfileId: profileId,
  repositoryProfileRevision: 1,
  repositoryProfileDigest: "b".repeat(64),
  observationId: null,
  observationDigest: null,
  baseSha: null,
};
const run = {
  id: runId,
  taskId,
  workflowVersionId: versionId,
  repositoryProfileId: profileId,
  repositoryProfileRevision: 1,
  repositoryProfileDigest: "b".repeat(64),
  observationId: null,
  observationDigest: null,
  baseSha: null,
  workspaceBaseSha: null,
  requestedBy: principalId,
  inngestRunId: null,
  status: "queued",
  budgetLimitUsd: "5.00",
  startedAt: null,
  finishedAt: null,
  createdAt: "2026-01-01T00:00:01.000Z",
  updatedAt: "2026-01-01T00:00:01.000Z",
  version: 1,
  budgetSummary: {
    installation: null,
    run: {
      scope: "run",
      runId,
      periodStart: null,
      periodEnd: null,
      limitUsd: "5",
      reservedUsd: "0",
      settledUsd: "0",
      availableUsd: "5",
      unknownCount: 0,
    },
  },
};
const problem = (status: number, code: string, retryable = false) => ({
  type: "about:blank",
  title: code,
  status,
  code,
  detail: "The server refused the request.",
  requestId: "00000000-0000-4000-8000-000000000110",
  traceId: "00000000-0000-4000-8000-000000000111",
  retryable,
});

/** Every availability reason, with the copy the composer owes it. */
const REASON_COPY: Record<string, string> = {
  repository_archived:
    "This repository is archived. Restore it in Projects to start tasks here.",
  application_archived:
    "The application this repository belongs to is archived. Restore it in Projects to start tasks here.",
  no_active_profile:
    "This repository is not set up for Bakery yet. Finish its setup in Projects.",
  coding_agent_unbound:
    "No coding agent is chosen for this repository. An organization administrator can choose one in the repository's setup.",
  coding_agent_disabled:
    "The coding agent chosen for this repository is turned off or no longer available. An organization administrator can turn it on or choose another.",
  coding_agent_unbilled:
    "The coding agent has no way to pay for its model. Add a billing source on the machine it runs on, or publish a new version of the agent with an API key and choose it for this repository.",
  coding_agent_capability_denied:
    "The coding agent chosen for this repository is not allowed to change code. An organization administrator can choose a different agent.",
  coding_agent_unpriced:
    "Bakery has no price for the model this coding agent uses, so it cannot work out a budget. Ask whoever runs your Bakery server to add the price.",
  review_agent_unavailable:
    "This workflow includes a review, and no agent is available to do it. An organization administrator can choose a reviewing agent that is turned on and has a way to pay for its model.",
  repair_agent_unavailable:
    "This workflow fixes problems it finds, and no agent is available to do that. An organization administrator can choose an agent for fixes that is turned on and has a way to pay for its model.",
  profile_effect_denied:
    "This repository's setup does not allow something this workflow needs to do. Choose a different workflow, or ask an organization administrator to change the repository's setup.",
  budget_below_reservation:
    "The budget for this task is lower than the amount Bakery must set aside to start. Raise the budget.",
  budget_policy_unavailable:
    "Bakery could not read your organization's budget settings, so it cannot set money aside for this task. Try again in a moment; if it continues, ask whoever runs your Bakery server.",
  required_check_missing:
    "Your organization requires a check that this workflow does not run. Choose a workflow that runs checks, or ask an organization administrator to change the rule in Repository rules.",
};

type Seen = {
  tasks: { key: string | undefined; body: unknown }[];
  runs: { key: string | undefined; body: unknown; taskId: string }[];
};

/**
 * Mock the composer's reads and writes. `presets` answers
 * `workflowPresets.list`; `runReply` answers `runs.create` per attempt.
 */
async function mockComposer(
  page: Page,
  options: {
    availability?: ComposerAvailability;
    taskReply?: (route: Route, attempt: number) => Promise<void> | void;
    runReply?: (route: Route, attempt: number) => Promise<void> | void;
    taskAfterRun?: () => unknown;
  } = {},
): Promise<Seen> {
  const seen: Seen = { tasks: [], runs: [] };
  let created = false;
  await page.route(
    "**/v1/repositories?*",
    (route) =>
      route.fulfill({ json: { items: [repository], nextCursor: null } }),
  );
  await page.route("**/v1/workflow-presets*", (route) =>
    route.fulfill({
      json: {
        items: [preset(options.availability)],
        nextCursor: null,
      },
    }));
  await page.route("**/v1/tasks?*", (route) =>
    route.fulfill({
      json: {
        items: created ? [task] : [],
        nextCursor: null,
      },
    }));
  await page.route("**/v1/tasks", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const headers = route.request().headers();
    expect(headers["bakery-organization-id"]).toBe(organizationId);
    seen.tasks.push({
      key: headers["idempotency-key"],
      body: route.request().postDataJSON(),
    });
    if (options.taskReply) {
      return options.taskReply(route, seen.tasks.length);
    }
    created = true;
    return route.fulfill({ status: 201, json: task });
  });
  await page.route(`**/v1/tasks/${taskId}/runs`, (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const headers = route.request().headers();
    seen.runs.push({
      key: headers["idempotency-key"],
      body: route.request().postDataJSON(),
      taskId,
    });
    if (options.runReply) return options.runReply(route, seen.runs.length);
    return route.fulfill({ status: 201, json: run });
  });
  await page.route(`**/v1/tasks/${taskId}`, (route) =>
    route.fulfill({
      json: seen.runs.length > 0 && !options.taskAfterRun
        ? { ...task, status: "queued", currentRunId: runId }
        : options.taskAfterRun?.() ?? task,
    }));
  await page.route(
    `**/v1/runs/${runId}`,
    (route) => route.fulfill({ json: run }),
  );
  await page.route(
    `**/v1/runs/${runId}/steps*`,
    (route) => route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.route(`**/v1/runs/${runId}/controls`, (route) =>
    route.fulfill({
      json: {
        runId,
        actions: ["pause", "resume", "cancel", "interrupt"].map((action) => ({
          action,
          canRequest: action === "cancel",
          reason: action === "cancel" ? "allowed" : "no_active_attempt",
        })),
      },
    }));
  await page.route(
    "**/v1/artifacts?*",
    (route) => route.fulfill({ json: { items: [], nextCursor: null } }),
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
  return seen;
}

const form = (page: Page) => page.getByRole("form", { name: "New task" });
const field = {
  repository: (page: Page) =>
    page.getByRole("combobox", { name: /^Repository/ }),
  title: (page: Page) => page.getByRole("textbox", { name: /^Title/ }),
  type: (page: Page) => page.getByRole("combobox", { name: /^Task type/ }),
  description: (page: Page) =>
    page.getByRole("textbox", { name: /^Description/ }),
  budget: (page: Page) =>
    page.getByRole("textbox", { name: /^Budget limit \(USD\)/ }),
  preset: (page: Page) => page.getByRole("radio", { name: /Fixed coding/ }),
  start: (page: Page) =>
    page.getByRole("button", { name: "Start task", exact: true }),
  retry: (page: Page) =>
    page.getByRole("button", { name: "Retry submission", exact: true }),
  discard: (page: Page) =>
    page.getByRole("button", { name: "Discard draft", exact: true }),
};

async function fill(page: Page) {
  await field.repository(page).selectOption(repositoryId);
  await expect(field.preset(page)).toBeChecked();
  await field.title(page).fill(task.title);
  await field.description(page).fill(task.description);
}

test.beforeEach(async ({ page }) => {
  await mockAuthenticatedSession(page);
});

test(
  "New task opens the composer: inspector on desktop, full page on phone",
  async ({ page }, testInfo) => {
    await mockComposer(page);
    await page.goto("/tasks");
    await page.getByRole("link", { name: "New task", exact: true }).click();
    await expect(page).toHaveURL(/\/tasks\/new$/);
    await expect(form(page)).toBeVisible();
    if (testInfo.project.name === "mobile") {
      // Phones get the composer as the page: its heading is the only h1.
      await expect(page.getByRole("heading", { level: 1, name: "New task" }))
        .toBeVisible();
      await expect(page.getByRole("complementary")).toHaveCount(0);
    } else {
      // Desktop keeps the queue and puts the form in the inspector region.
      await expect(page.getByRole("heading", { level: 1, name: "Work" }))
        .toBeVisible();
      await expect(
        page.getByRole("complementary", { name: "New task" }).getByRole(
          "form",
          {
            name: "New task",
          },
        ),
      ).toBeVisible();
    }
    await expect(field.repository(page)).toBeVisible();
    await expect(field.type(page)).toBeVisible();
    await expect(field.budget(page)).toBeVisible();
    await expect(field.start(page)).toBeDisabled();
    await fill(page);
    await expect(field.budget(page)).toHaveValue("5.00");
    await expect(field.start(page)).toBeEnabled();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  },
);

test(
  "a failed repositories load keeps one page heading on phone and the region heading on desktop",
  async ({ page }, testInfo) => {
    await mockComposer(page);
    await page.route(
      "**/v1/repositories?*",
      (route) =>
        route.fulfill({
          status: 500,
          contentType: "application/problem+json",
          json: problem(500, "INTERNAL"),
        }),
    );
    await page.goto("/tasks/new");
    const error = "Tasks could not be loaded. Retry this page.";
    await expect(page.getByText(error)).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry", exact: true }))
      .toBeVisible();
    if (testInfo.project.name === "mobile") {
      // The sheet is the page, so its error state must own the only h1.
      await expect(page.locator("main h1")).toHaveCount(1);
      await expect(page.getByRole("heading", { level: 1, name: error }))
        .toBeVisible();
    } else {
      // The rail keeps the queue's h1 and shows the error as a region h2.
      await expect(page.getByRole("heading", { level: 1, name: "Work" }))
        .toBeVisible();
      await expect(
        page.getByRole("complementary", { name: "New task" }).getByRole(
          "heading",
          { level: 2, name: error },
        ),
      ).toBeVisible();
    }
  },
);

test("a setup-required preset names every missing requirement and blocks submit", async ({ page }) => {
  await mockComposer(page, {
    availability: {
      status: "setup_required",
      reasons: Object.keys(REASON_COPY),
      // The default budget (5.00) is below this, so the server reason stands.
      minimumBudgetLimitUsd: "6",
    },
  });
  await page.goto("/tasks/new");
  await field.repository(page).selectOption(repositoryId);
  await field.title(page).fill("Needs setup");
  const list = form(page).getByRole("listitem");
  await expect(list).toHaveCount(Object.keys(REASON_COPY).length);
  for (const [reason, copy] of Object.entries(REASON_COPY)) {
    // The budget reason also names the smallest budget that works ($6.00).
    const text = reason === "budget_below_reservation"
      ? `${copy} The smallest budget that works is $6.00.`
      : copy;
    await expect(form(page).getByText(text, { exact: true })).toBeVisible();
  }
  await expect(field.start(page)).toBeDisabled();
  await expect(field.start(page)).toHaveAccessibleDescription(
    /This workflow cannot start here yet/,
  );
});

test("Start is disabled for a budget below the reservation", async ({ page }) => {
  const seen = await mockComposer(page, {
    availability: {
      status: "ready",
      reasons: [],
      minimumBudgetLimitUsd: "1.5",
    },
  });
  await page.goto("/tasks/new");
  await fill(page);
  await expect(field.start(page)).toBeEnabled();
  await field.budget(page).fill("0.5");
  await expect(field.start(page)).toBeDisabled();
  await expect(form(page)).toHaveAttribute(
    "data-reasons",
    /budget_below_reservation/,
  );
  await expect(
    form(page).getByText(
      `${REASON_COPY.budget_below_reservation} The smallest budget that works is $1.50.`,
      { exact: true },
    ),
  ).toBeVisible();
  await field.budget(page).fill("2");
  await expect(field.start(page)).toBeEnabled();
  await field.budget(page).fill("1.5");
  await expect(field.start(page)).toBeEnabled();
  expect(seen.tasks).toHaveLength(0);
  expect(seen.runs).toHaveLength(0);
});

test("the default-budget server reason clears when the user raises the budget", async ({ page }) => {
  await mockComposer(page, {
    availability: {
      status: "setup_required",
      reasons: ["budget_below_reservation"],
      minimumBudgetLimitUsd: "6",
    },
  });
  await page.goto("/tasks/new");
  await fill(page);
  await expect(field.start(page)).toBeDisabled();
  await field.budget(page).fill("6");
  await expect(field.start(page)).toBeEnabled();
});

test("submit sends one task then one preset run on one scoped intent and opens the task", async ({ page }) => {
  const seen = await mockComposer(page);
  await page.goto("/tasks/new");
  await fill(page);
  await field.start(page).click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${taskId}$`));
  await expect(page.getByRole("status", { name: "Run updates" })).toHaveText(
    "Current run: Queued",
  );
  expect(seen.tasks).toHaveLength(1);
  expect(seen.runs).toHaveLength(1);
  const intent = seen.tasks[0].key!.replace(/:task$/, "");
  expect(intent).toMatch(/^[0-9a-f-]{36}$/);
  expect(seen.tasks[0].key).toBe(`${intent}:task`);
  expect(seen.runs[0].key).toBe(`${intent}:run`);
  expect(seen.tasks[0].body).toEqual({
    applicationId,
    repositoryId,
    repositoryProfileId: profileId,
    taskType: "feature",
    title: task.title,
    description: task.description,
  });
  expect(seen.runs[0].body).toEqual({
    presetId: "fixed-coding",
    repositoryProfileId: profileId,
    executionMode: "repository",
    budgetLimitUsd: "5.00",
  });
  // The definitive outcome ends the intent.
  expect(await page.evaluate((key) => sessionStorage.getItem(key), intentKey))
    .toBeNull();
});

test("an unknown outcome locks the form; Retry replays identical keys and bodies", async ({ page }) => {
  const seen = await mockComposer(page, {
    runReply: (route, attempt) =>
      attempt === 1
        ? route.abort("failed")
        : route.fulfill({ status: 201, json: run }),
  });
  await page.goto("/tasks/new");
  await fill(page);
  await field.start(page).click();
  const notice = form(page).getByRole("status");
  await expect(notice).toContainText(
    "The server did not confirm the submission.",
  );
  await expect(field.start(page)).toHaveCount(0);
  await expect(field.title(page)).toHaveAttribute("readonly", "");
  await expect(field.description(page)).toHaveAttribute("readonly", "");
  await expect(field.budget(page)).toHaveAttribute("readonly", "");
  await expect(field.repository(page)).toBeDisabled();
  await expect(field.retry(page)).toBeVisible();
  await expect(field.discard(page)).toBeVisible();
  expect(seen.tasks).toHaveLength(1);
  expect(seen.runs).toHaveLength(1);
  await field.retry(page).click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${taskId}$`));
  expect(seen.tasks).toHaveLength(2);
  expect(seen.runs).toHaveLength(2);
  expect(seen.tasks[1]).toEqual(seen.tasks[0]);
  expect(seen.runs[1]).toEqual(seen.runs[0]);
  expect(seen.runs[0].key).toBe(seen.tasks[0].key!.replace(/:task$/, ":run"));
});

test("a reload during an unknown outcome restores the frozen draft and its intent", async ({ page }) => {
  const seen = await mockComposer(page, {
    runReply: (route, attempt) =>
      attempt === 1
        ? route.abort("failed")
        : route.fulfill({ status: 201, json: run }),
  });
  await page.goto("/tasks/new");
  await fill(page);
  await field.start(page).click();
  await expect(field.retry(page)).toBeVisible();
  const stored = await page.evaluate(
    (key) => sessionStorage.getItem(key),
    intentKey,
  );
  expect(stored).not.toBeNull();
  await page.reload();
  await expect(field.retry(page)).toBeVisible();
  await expect(field.title(page)).toHaveValue(task.title);
  await expect(field.title(page)).toHaveAttribute("readonly", "");
  await field.retry(page).click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${taskId}$`));
  expect(seen.tasks[1]).toEqual(seen.tasks[0]);
  expect(seen.runs[1]).toEqual(seen.runs[0]);
});

test("Discard drops the draft and the stored intent", async ({ page }) => {
  await mockComposer(page, {
    runReply: (route) => route.abort("failed"),
  });
  await page.goto("/tasks/new");
  await fill(page);
  await field.start(page).click();
  await field.discard(page).click();
  await expect(page).toHaveURL(/\/tasks$/);
  expect(await page.evaluate((key) => sessionStorage.getItem(key), intentKey))
    .toBeNull();
});

test("a refused task shows the definitive copy and keeps no stale intent", async ({ page }) => {
  let status = 409;
  await mockComposer(page, {
    taskReply: (route) =>
      route.fulfill({
        status,
        contentType: "application/problem+json",
        json: status === 403
          ? problem(403, "AUTH_FORBIDDEN")
          : problem(409, "STATE_CONFLICT"),
      }),
  });
  await page.goto("/tasks/new");
  await fill(page);
  await field.start(page).click();
  await expect(form(page).getByRole("status")).toContainText(
    "This draft conflicts with a task that already exists.",
  );
  await expect(field.retry(page)).toHaveCount(0);
  await expect(field.discard(page)).toBeVisible();
  expect(await page.evaluate((key) => sessionStorage.getItem(key), intentKey))
    .toBeNull();
  await field.discard(page).click();
  await expect(page).toHaveURL(/\/tasks$/);

  status = 403;
  await page.goto("/tasks/new");
  await fill(page);
  await field.start(page).click();
  await expect(form(page).getByRole("status")).toContainText(
    "You are not allowed to start tasks in this repository.",
  );
  await expect(field.retry(page)).toHaveCount(0);
  await expect(field.start(page)).toBeDisabled();
  await expect(field.start(page)).toHaveAccessibleDescription(
    "You are not allowed to start tasks in this repository.",
  );
  await expect(field.discard(page)).toBeVisible();
  await field.discard(page).click();
  await expect(page).toHaveURL(/\/tasks$/);
  expect(await page.evaluate((key) => sessionStorage.getItem(key), intentKey))
    .toBeNull();
});

test("a run refused with STATE_CONFLICT leaves a draft that shows the same setup copy", async ({ page }) => {
  let refused = false;
  const seen = await mockComposer(page, {
    availability: { status: "ready", reasons: [] },
    runReply: (route) => {
      refused = true;
      return route.fulfill({
        status: 409,
        contentType: "application/problem+json",
        json: problem(409, "STATE_CONFLICT"),
      });
    },
    taskAfterRun: () => task,
  });
  // The server's availability reads setup_required once the refusal happened.
  await page.route("**/v1/workflow-presets*", (route) =>
    route.fulfill({
      json: {
        items: [
          preset(
            refused
              ? {
                status: "setup_required",
                reasons: ["coding_agent_unbound"],
              }
              : { status: "ready", reasons: [] },
          ),
        ],
        nextCursor: null,
      },
    }));
  await page.goto("/tasks/new");
  await fill(page);
  await field.start(page).click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${taskId}$`));
  expect(seen.runs).toHaveLength(1);
  const start = page.getByText("Start a run", { exact: true });
  await expect(start).toBeVisible();
  await expect(page.getByText(REASON_COPY.coding_agent_unbound)).toBeVisible();
  await expect(page.getByRole("button", { name: "Start run", exact: true }))
    .toBeDisabled();
  // Nothing was duplicated: the task exists once, as a draft.
  expect(seen.tasks).toHaveLength(1);
});

test("a refused run keeps its problem notice on the draft detail across reload", async ({ page }) => {
  await mockComposer(page, {
    runReply: (route) =>
      route.fulfill({
        status: 409,
        contentType: "application/problem+json",
        json: {
          ...problem(409, "STATE_CONFLICT"),
          title: "Workflow is disabled.",
        },
      }),
    taskAfterRun: () => task,
  });
  await page.goto("/tasks/new");
  await fill(page);
  await field.start(page).click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${taskId}$`));
  const detail = page.locator('[data-ui-region="start-run"]');
  await expect(detail.getByRole("status")).toContainText(
    "Workflow is disabled.",
  );
  await expect(detail.getByRole("status")).toContainText(
    "The server did not admit the run.",
  );
  await page.reload();
  await expect(detail.getByRole("status")).toContainText(
    "Workflow is disabled.",
  );
});

test("Start run on a draft task uses its own scoped intent and replays it after an unknown outcome", async ({ page }) => {
  const seen = await mockComposer(page, {
    runReply: (route, attempt) =>
      attempt === 1
        ? route.abort("failed")
        : route.fulfill({ status: 201, json: run }),
    taskAfterRun: undefined,
  });
  await page.goto(`/tasks/${taskId}`);
  await expect(page.getByText("Start a run", { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      "This task has no run yet. Start a run to see its timeline.",
    ),
  ).toBeVisible();
  const startRun = page.getByRole("button", { name: "Start run", exact: true });
  await expect(startRun).toBeEnabled();
  await startRun.click();
  await expect(page.getByText("The server did not confirm the run."))
    .toBeVisible();
  const retry = page.getByRole("button", { name: "Retry run", exact: true });
  await expect(retry).toBeVisible();
  const stored = await page.evaluate(
    () =>
      Object.keys(sessionStorage).filter((key) =>
        key.startsWith("bakery.taskStartRun.intent:")
      ),
  );
  expect(stored).toEqual([
    `bakery.taskStartRun.intent:${organizationId}:${principalId}:${taskId}`,
  ]);
  await retry.click();
  await expect(page.getByRole("status", { name: "Run updates" })).toHaveText(
    "Current run: Queued",
  );
  expect(seen.runs).toHaveLength(2);
  expect(seen.runs[1]).toEqual(seen.runs[0]);
  expect(seen.runs[0].key).toMatch(/^[0-9a-f-]{36}:run$/);
  expect(seen.runs[0].body).toEqual({
    presetId: "fixed-coding",
    repositoryProfileId: profileId,
    executionMode: "repository",
    budgetLimitUsd: "5.00",
  });
  expect(seen.tasks).toHaveLength(0);
});

test("offline blocks submit and says nothing is sent; back online restores the form", async ({ page, context }) => {
  const seen = await mockComposer(page);
  await page.goto("/tasks/new");
  await fill(page);
  await expect(field.start(page)).toBeEnabled();
  await context.setOffline(true);
  await expect(form(page).getByRole("status")).toContainText(
    "Offline. Nothing is sent until the connection returns.",
  );
  await expect(field.start(page)).toBeDisabled();
  await context.setOffline(false);
  await expect(form(page).getByRole("status")).not.toContainText("Offline.");
  await expect(field.start(page)).toBeEnabled();
  expect(seen.tasks).toHaveLength(0);
});

for (const scheme of ["light", "dark", "system-dark"] as const) {
  test(`composer is accessible in the ${scheme} theme`, async ({ page }) => {
    await mockComposer(page);
    await page.addInitScript((value) => {
      localStorage.setItem(
        "bakery.theme.v1",
        value === "system-dark" ? "system" : value,
      );
    }, scheme);
    // System follows the emulated scheme; light and dark are stored choices.
    await page.emulateMedia({
      colorScheme: scheme === "system-dark" ? "dark" : "light",
    });
    // The server's answer wins over the stored choice, so it asks for the same.
    await mockUserPreferences(page, {
      theme: scheme === "system-dark" ? "system" : scheme,
    });
    await page.goto("/tasks/new");
    await expect(form(page)).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      scheme === "light" ? "light" : "dark",
    );
    await fill(page);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });
}

for (const locale of ["en-XA", "ar-XB"]) {
  test(`composer reflows at 320px in ${locale} with the right direction`, async ({ page }) => {
    await mockComposer(page, {
      availability: {
        status: "setup_required",
        reasons: ["coding_agent_unbound", "coding_agent_unpriced"],
      },
    });
    await page.addInitScript((value) => {
      Object.defineProperty(navigator, "languages", {
        configurable: true,
        value: [value],
      });
    }, locale);
    // The server's answer wins over the browser, so it asks for the same.
    await mockUserPreferences(page, {
      effectiveLocale: locale,
      direction: locale === "ar-XB" ? "rtl" : "ltr",
    });
    // 320 CSS px is a 1280px window at 400% zoom; it also bounds 200% on a phone.
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto("/tasks/new");
    await expect(page.locator("html")).toHaveAttribute(
      "dir",
      locale === "ar-XB" ? "rtl" : "ltr",
    );
    await expect(page.getByRole("form")).toBeVisible();
    await page.getByRole("combobox").first().selectOption(repositoryId);
    await expect(page.getByRole("listitem")).toHaveCount(2);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(
      await page.evaluate(() =>
        document.documentElement.scrollWidth <=
          document.documentElement.clientWidth
      ),
    ).toBe(true);
  });
}

test("keyboard order follows the form", async ({ page }) => {
  await mockComposer(page);
  await page.goto("/tasks/new");
  await fill(page);
  await field.repository(page).focus();
  const order: string[] = [];
  const label = () =>
    page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      const named = el?.getAttribute("aria-label") ??
        (el?.id
          ? document.querySelector(`label[for="${el.id}"]`)?.textContent
          : null) ??
        el?.textContent ?? el?.tagName;
      return `${el?.tagName.toLowerCase()}:${
        (named ?? "").trim().slice(0, 40)
      }`;
    });
  order.push(await label());
  for (let step = 0; step < 6; step++) {
    await page.keyboard.press("Tab");
    order.push(await label());
  }
  expect(order.map((entry) => entry.split(":")[0])).toEqual([
    "select",
    "input", // the checked preset radio
    "input", // title
    "select", // task type
    "textarea",
    "input", // budget
    "button",
  ]);
  expect(order[6]).toContain("Start task");
});

// Coarse-pointer floor: 44px. The iPhone project is the coarse pointer.
test(
  "every composer control is at least 44px with a coarse pointer",
  async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name !== "mobile",
      "44px applies to coarse pointers; the fine-pointer lane keeps token sizes",
    );
    await mockComposer(page);
    await page.goto("/tasks/new");
    await fill(page);
    const targets = [
      field.repository(page),
      // The radio's hit area is its whole card, not the 16px glyph.
      page.locator('[data-ui-component="presetOption"]'),
      field.title(page),
      field.type(page),
      field.budget(page),
      field.start(page),
    ];
    for (const control of targets) {
      const box = await control.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.width).toBeGreaterThanOrEqual(44);
    }
  },
);

for (const width of [390, 1024]) {
  test(
    `active New task action retains its button frame at ${width}px coarse`,
    async ({ page }, testInfo) => {
      test.skip(
        testInfo.project.name !== "mobile",
        "Coarse pointer project only",
      );
      await page.setViewportSize({ width, height: 844 });
      await mockComposer(page);
      await page.goto("/tasks/new");
      await expect(form(page)).toBeVisible();
      expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches))
        .toBe(true);
      const action = page.getByRole("link", { name: "New task", exact: true });
      await expect(action).toHaveAttribute("aria-current", "page");
      await expect(action).toHaveClass(/ui-link--primary(?:Button|Icon)/);
      const box = await action.boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
    },
  );
}

test("reduced motion removes composer transitions", async ({ page }) => {
  await mockComposer(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/tasks/new");
  await fill(page);
  const durations = await field.start(page).evaluate((button) => {
    const style = getComputedStyle(button);
    return [style.transitionDuration, style.animationDuration];
  });
  for (const duration of durations.flatMap((value) => value.split(", "))) {
    // The design system collapses motion to 1ms, not 0, so it still ends.
    expect(parseFloat(duration)).toBeLessThanOrEqual(0.001);
  }
});
