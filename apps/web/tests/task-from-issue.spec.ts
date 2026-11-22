import { expect, type Page, test } from "@playwright/test";
import { ticket, uuid } from "./helpers/issues-fixture.ts";
import { mockAuthenticatedSession } from "./helpers/mock-session.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { still } from "./helpers/stills.ts";

registerPageHealth(test);

/**
 * #69 web (design-ux): "From issue" on a task, and "Mentions" for the issues it
 * only mentions. Shown only from the server's links.
 */

const taskId = "00000000-0000-4000-8000-000000000012";
const runId = "00000000-0000-4000-8000-000000000020";
const conversationId = "00000000-0000-4000-8000-000000000013";
const stamp = "2026-01-01T00:00:00.000Z";

const task = {
  id: taskId,
  applicationId: uuid(904),
  repositoryId: null,
  conversationId,
  parentTaskId: null,
  title: "Fix the login redirect",
  description: "",
  taskType: "task",
  status: "completed",
  priority: 50,
  createdBy: uuid(1),
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
  approvalPolicy: null,
  planningOnly: false,
};
const run = {
  id: runId,
  taskId,
  workflowVersionId: "00000000-0000-4000-8000-000000000022",
  repositoryProfileId: null,
  repositoryProfileRevision: null,
  repositoryProfileDigest: null,
  observationId: null,
  observationDigest: null,
  baseSha: null,
  workspaceBaseSha: null,
  requestedBy: uuid(1),
  inngestRunId: null,
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

const link = (id: number, issue: number, role: "primary" | "reference") => ({
  id: uuid(id),
  organizationId: "00000000-0000-4000-8000-000000000003",
  externalTicketId: uuid(issue),
  taskId,
  role,
  statusCommentExternalId: null,
  lastSyncedRunRevision: null,
  syncHealth: "healthy",
  lastProblemCode: null,
  createdAt: stamp,
  updatedAt: stamp,
  version: 1,
});

const ISSUES = [
  { number: 201, title: "Add invoice export" },
  { number: 150, title: "Tidy the auth module" },
];

/** The task page's reads, the task's links, and the issues they name. */
async function world(page: Page, links: ReturnType<typeof link>[]) {
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
    `**/v1/runs/${runId}/controls`,
    (route) => route.fulfill({ json: { runId, actions: [] } }),
  );
  for (
    const empty of [
      `**/v1/runs/${runId}/checks*`,
      `**/v1/runs/${runId}/reviews*`,
      `**/v1/runs/${runId}/delivery-decisions*`,
      "**/v1/artifacts?*",
      "**/v1/questions?*",
      "**/v1/pull-requests?*",
      `**/v1/conversations/${conversationId}/messages*`,
      `**/v1/conversations/${conversationId}/participants*`,
      `**/v1/conversations/${conversationId}/turns*`,
      "**/v1/coordination-plans*",
      "**/v1/plan-revisions*",
      "**/v1/approvals*",
    ]
  ) {
    await page.route(
      empty,
      (route) => route.fulfill({ json: { items: [], nextCursor: null } }),
    );
  }
  // No output streams: the output read answers with its byte count as well.
  await page.route(
    "**/v1/output-streams?*",
    (route) =>
      route.fulfill({
        json: { items: [], nextCursor: null, encodedBytes: 32 },
      }),
  );
  // The page opens its event stream; nothing is said on it here.
  await page.routeWebSocket("**/v1/events?*", (socket) => {
    socket.onMessage(() => {});
  });
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
  const step = (id: string, stepKey: string, status: string) => ({
    id,
    runId,
    stepKey,
    iteration: 1,
    status,
    input: {},
    output: null,
    error: null,
    startedAt: stamp,
    finishedAt: stamp,
    createdAt: stamp,
    updatedAt: stamp,
    version: 1,
    handoffManifest: null,
  });
  await page.route(`**/v1/runs/${runId}/steps*`, (route) =>
    route.fulfill({
      json: {
        items: [
          step("00000000-0000-4000-8000-000000000021", "publish", "completed"),
          step("00000000-0000-4000-8000-000000000031", "verify", "completed"),
        ],
        nextCursor: null,
      },
    }));
  await page.route(`**/v1/applications/${uuid(904)}`, (route) =>
    route.fulfill({
      json: {
        id: uuid(904),
        slug: "storefront",
        name: "Storefront",
        description: "",
        archivedAt: null,
        createdAt: stamp,
        updatedAt: stamp,
        version: 1,
      },
    }));
  await page.route(
    (url) => url.pathname === "/v1/ticket-task-links",
    (route) => route.fulfill({ json: { items: links, nextCursor: null } }),
  );
  await page.route(
    (url) => /^\/v1\/external-tickets\/[^/]+$/.test(url.pathname),
    (route) => {
      const id = new URL(route.request().url()).pathname.split("/")[3]!;
      const issue = ISSUES.find((entry) => uuid(entry.number) === id);
      return route.fulfill(
        issue
          ? { json: ticket({ ...issue, verdict: null }) }
          : { status: 404, json: { status: 404, code: "RESOURCE_NOT_FOUND" } },
      );
    },
  );
}

for (
  const viewport of [
    { name: "desktop", width: 1280, height: 800 },
    { name: "phone", width: 390, height: 844 },
  ]
) {
  test.describe(`${viewport.name}: a task and its issue`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });
    const section = (page: Page) => page.getByTestId("task-from-issue");

    test("a task from an issue names it, links to its page and to GitHub", async ({ page }) => {
      await world(page, [link(8000, 201, "primary")]);
      await page.goto(`/tasks/${taskId}`);
      await expect(section(page).getByText("From issue", { exact: true }))
        .toBeVisible();
      await expect(
        section(page).getByRole("link", {
          name: "acme/web#201 Add invoice export",
        }),
      ).toHaveAttribute("href", `/issues/${uuid(201)}`);
      await expect(
        section(page).getByRole("link", {
          name: "View acme/web#201 on GitHub",
        }),
      ).toHaveAttribute("href", "https://github.com/acme/web/issues/201");
      await page.mouse.move(700, 700);
      await still(page, "task-from-issue");
    });

    test("an issue a task only mentions is listed under Mentions", async ({ page }) => {
      await world(page, [
        link(8000, 201, "primary"),
        link(8001, 150, "reference"),
      ]);
      await page.goto(`/tasks/${taskId}`);
      await expect(section(page).getByText("Mentions", { exact: true }))
        .toBeVisible();
      await expect(
        section(page).getByRole("link", {
          name: "acme/web#150 Tidy the auth module",
        }),
      ).toBeVisible();
      await expect(section(page).getByText("From issue", { exact: true }))
        .toBeVisible();
    });

    test("a task with no links shows nothing about issues", async ({ page }) => {
      await world(page, []);
      const asked = page.waitForResponse((response) =>
        new URL(response.url()).pathname === "/v1/ticket-task-links"
      );
      await page.goto(`/tasks/${taskId}`);
      await asked;
      await expect(
        page.getByRole("heading", { name: "Fix the login redirect", level: 1 }),
      ).toBeVisible();
      await expect(section(page)).toHaveCount(0);
    });

    test("an issue that cannot be read is not shown", async ({ page }) => {
      await world(page, [link(8000, 999, "primary")]);
      const read = page.waitForResponse((response) =>
        new URL(response.url()).pathname ===
          `/v1/external-tickets/${uuid(999)}`
      );
      await page.goto(`/tasks/${taskId}`);
      await read;
      await expect(
        page.getByRole("heading", { name: "Fix the login redirect", level: 1 }),
      ).toBeVisible();
      await expect(page.getByText("From issue", { exact: true })).toHaveCount(
        0,
      );
    });
  });
}
