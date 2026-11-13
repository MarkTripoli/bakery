import {
  expect,
  type Locator,
  type Page,
  type Route,
  test,
  type WebSocketRoute,
} from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {
  mockAuthenticatedSession,
  mockUserPreferences,
} from "./helpers/mock-session.ts";

const applicationId = "00000000-0000-4000-8000-000000000004";
const apiRepositoryId = "00000000-0000-4000-8000-000000000005";
const webRepositoryId = "00000000-0000-4000-8000-000000000015";
const docsRepositoryId = "00000000-0000-4000-8000-000000000025";
const conversationId = "00000000-0000-4000-8000-000000000008";
const taskId = "00000000-0000-4000-8000-000000000012";
const planId = "00000000-0000-4000-8000-000000000701";
const principalId = "00000000-0000-4000-8000-000000000001";
const child = (n: number) => `00000000-0000-4000-8000-0000000008${n}0`;

const stamp = "2026-01-01T10:00:00.000Z";
const task = {
  id: taskId,
  applicationId,
  repositoryId: null,
  conversationId,
  parentTaskId: null,
  title: "Ship the contract change",
  description: "Change the API contract and update every consumer.",
  taskType: "epic",
  status: "active",
  priority: 50,
  createdBy: principalId,
  currentRunId: null,
  archivedAt: null,
  createdAt: stamp,
  updatedAt: stamp,
  version: 3,
  repositoryProfileId: null,
  repositoryProfileRevision: null,
  repositoryProfileDigest: null,
  observationId: null,
  observationDigest: null,
  baseSha: null,
  approvalPolicy: null,
  planningOnly: false,
};

const specLane = (
  key: string,
  alias: string,
  title: string,
  extra: Record<string, unknown> = {},
) => ({
  key,
  repositoryAlias: alias,
  title,
  instructions: "Do the work.",
  prerequisites: [],
  outputs: [],
  inputs: [],
  ...extra,
});
const spec = {
  lanes: [
    specLane("api", "api", "Change the API contract", {
      outputs: [{ key: "contract", kind: "artifact", artifactType: "design" }],
    }),
    specLane("web", "web", "Update the web client", {
      prerequisites: ["api"],
      inputs: [{ fromLane: "api", outputKey: "contract" }],
    }),
    specLane("docs", "docs", "Document the change"),
  ],
  maxConcurrency: 2,
  join: "all-required",
  failurePolicy: "stop-dependent",
};

type LaneStatus =
  | "planned"
  | "ready"
  | "waiting"
  | "running"
  | "completed"
  | "stale"
  | "failed"
  | "stopped"
  | "canceled";
const lane = (
  key: string,
  repositoryId: string,
  n: number,
  status: LaneStatus,
  extra: Record<string, unknown> = {},
) => ({
  laneKey: key,
  repositoryId,
  childTaskId: child(n),
  reusedFromLaneId: null,
  prerequisites: [],
  declaredOutputs: [],
  laneDigest: "d".repeat(64),
  status,
  ...extra,
});
const plan = (
  status: string,
  lanes: ReturnType<typeof lane>[],
  extra: Record<string, unknown> = {},
) => ({
  id: planId,
  applicationId,
  parentTaskId: taskId,
  revision: 2,
  spec,
  digest: "e".repeat(64),
  origin: { kind: "ad_hoc" } as Record<string, unknown>,
  budgetLimitUsd: "12.500000",
  status,
  createdBy: principalId,
  lanes,
  createdAt: stamp,
  updatedAt: stamp,
  version: 4,
  ...extra,
});
const output = { key: "contract", kind: "artifact", artifactType: "design" };
const running = () =>
  plan("materialized", [
    lane("api", apiRepositoryId, 1, "completed", { declaredOutputs: [output] }),
    lane("web", webRepositoryId, 2, "waiting", { prerequisites: ["api"] }),
    lane("docs", docsRepositoryId, 3, "running"),
  ]);
const partial = () =>
  plan("partially_delivered", [
    lane("api", apiRepositoryId, 1, "completed", { declaredOutputs: [output] }),
    lane("web", webRepositoryId, 2, "stopped", { prerequisites: ["api"] }),
    lane("docs", docsRepositoryId, 3, "failed"),
  ]);

const workflowId = "00000000-0000-4000-8000-0000000000c1";
const workflowVersionId = "aaaaaaaa-0000-4000-8000-0000000000c2";
const stale = () =>
  plan("materialized", [
    lane("api", apiRepositoryId, 1, "completed", { declaredOutputs: [output] }),
    lane("web", webRepositoryId, 2, "stale", { prerequisites: ["api"] }),
    lane("docs", docsRepositoryId, 3, "completed"),
  ]);

const repository = (id: string, name: string) => ({
  id,
  applicationId,
  slug: name,
  integrationConnectionId: "00000000-0000-4000-8000-000000000007",
  providerRepoId: name,
  owner: "example",
  name,
  defaultBranch: "main",
  activeProfileId: null,
  archivedAt: null,
  createdAt: stamp,
  updatedAt: stamp,
  version: 1,
});
const role = (alias: string, repositoryId: string) => ({
  id: `00000000-0000-4000-8000-00000000090${alias.length}`,
  applicationId,
  alias,
  role: alias,
  repositoryId,
  createdAt: stamp,
  updatedAt: stamp,
  version: 1,
});
const committedArtifact = {
  id: "00000000-0000-4000-8000-000000000a01",
  taskId: child(1),
  artifactType: "design",
  name: "contract",
  currentVersionId: "00000000-0000-4000-8000-000000000a02",
  createdAt: stamp,
  updatedAt: stamp,
  version: 1,
  pinnedAt: null,
  pinnedBy: null,
};

const patchArtifact = {
  ...committedArtifact,
  taskId: child(5),
  artifactType: "patch",
};

const problem = (status: number, code: string) => ({
  type: "about:blank",
  title: code,
  status,
  code,
  detail: "The server refused the request.",
  requestId: "00000000-0000-4000-8000-000000000110",
  traceId: "00000000-0000-4000-8000-000000000111",
  retryable: false,
});
const page_ = <T>(items: T[]) => ({ items, nextCursor: null });

type World = {
  plans: ReturnType<typeof plan>[];
  plansStatus: number;
  taskStatus: number;
  cancels: { id: string; key: string | undefined }[];
  cancelReply?: (route: Route) => Promise<void> | void;
  /** Child number with an older published and a newer unpublished artifact. */
  unpublishedChild?: number;
  /** Child number whose only matching artifact has no published version. */
  onlyUnpublishedChild?: number;
  /** Answer for the saved workflow definition; 404 when unreadable. */
  workflowStatus?: number;
};
const world = (overrides: Partial<World> = {}): World => ({
  plans: [running()],
  plansStatus: 200,
  taskStatus: 200,
  cancels: [],
  ...overrides,
});

async function mockWorld(page: Page, state: World) {
  await page.route(
    `**/v1/tasks/${taskId}`,
    (route) =>
      state.taskStatus === 200 ? route.fulfill({ json: task }) : route.fulfill({
        status: state.taskStatus,
        contentType: "application/problem+json",
        json: problem(state.taskStatus, "AUTH_FORBIDDEN"),
      }),
  );
  await page.route("**/v1/coordination-plans**", (route) => {
    const url = new URL(route.request().url());
    const cancel = url.pathname.match(/coordination-plans\/([^/]+)\/cancel$/);
    if (cancel) {
      state.cancels.push({
        id: cancel[1],
        key: route.request().headers()["idempotency-key"],
      });
      if (state.cancelReply) return state.cancelReply(route);
      state.plans = state.plans.map((item) => ({
        ...item,
        status: "canceled",
        lanes: item.lanes.map((entry) =>
          entry.status === "completed"
            ? entry
            : { ...entry, status: "canceled" as const }
        ),
        version: item.version + 1,
      }));
      return route.fulfill({ json: state.plans[0] });
    }
    if (state.plansStatus !== 200) {
      return route.fulfill({
        status: state.plansStatus,
        contentType: "application/problem+json",
        json: problem(
          state.plansStatus,
          state.plansStatus === 403 ? "AUTH_FORBIDDEN" : "INTERNAL",
        ),
      });
    }
    return route.fulfill({ json: page_(state.plans) });
  });
  await page.route(
    `**/v1/applications/${applicationId}/repository-roles*`,
    (route) =>
      route.fulfill({
        json: page_([
          role("api", apiRepositoryId),
          role("web", webRepositoryId),
          role("docs", docsRepositoryId),
        ]),
      }),
  );
  await page.route(
    "**/v1/repositories?*",
    (route) =>
      route.fulfill({
        json: page_([
          repository(apiRepositoryId, "api-service"),
          repository(webRepositoryId, "web-client"),
          repository(docsRepositoryId, "docs-site"),
        ]),
      }),
  );
  await page.route("**/v1/artifacts?*", (route) => {
    const forTask = new URL(route.request().url()).searchParams.get("taskId");
    return route.fulfill({
      json: page_(
        forTask === child(1)
          ? state.onlyUnpublishedChild === 1
            ? [{ ...committedArtifact, currentVersionId: null }]
            : state.unpublishedChild === 1
            ? [committedArtifact, {
              ...committedArtifact,
              id: "00000000-0000-4000-8000-000000000a09",
              currentVersionId: null,
              createdAt: "2026-10-15T12:00:00.000Z",
            }]
            : [committedArtifact]
          : forTask === child(5)
          ? [patchArtifact]
          : [],
      ),
    });
  });
  await page.route(
    `**/v1/workflows/${workflowId}`,
    (route) =>
      (state.workflowStatus ?? 200) === 200
        ? route.fulfill({
          json: {
            id: workflowId,
            slug: "checkout-fan-out",
            name: "Checkout fan-out",
            description: null,
            activeVersionId: workflowVersionId,
            enabled: true,
            createdAt: stamp,
            updatedAt: stamp,
            version: 1,
          },
        })
        : route.fulfill({
          status: state.workflowStatus,
          contentType: "application/problem+json",
          json: problem(state.workflowStatus ?? 404, "RESOURCE_NOT_FOUND"),
        }),
  );
  await page.route("**/v1/sync*", (route) =>
    route.fulfill({
      json: {
        resourceState: {},
        highwater: "0",
        events: [],
        nextCursor: null,
        resetRequired: false,
      },
    }));
}

/** A scripted /v1/events server: hello, then a cursor for every subscribe. */
type Stream = {
  connections: WebSocketRoute[];
  subscribes: Record<string, unknown>[];
  push: () => void;
  drop: () => void;
};
async function mockStream(page: Page): Promise<Stream> {
  const stream: Stream = {
    connections: [],
    subscribes: [],
    push: () => {},
    drop: () => {},
  };
  const requests = new Map<WebSocketRoute, string>();
  let sequence = 1;
  const cursor = (socket: WebSocketRoute) => {
    sequence += 1;
    socket.send(JSON.stringify({
      type: "cursor",
      requestId: requests.get(socket),
      cursor: `cursor-${sequence}`,
      highwater: String(sequence),
    }));
  };
  await page.routeWebSocket(/\/v1\/events/, (socket) => {
    stream.connections.push(socket);
    socket.send(JSON.stringify({
      type: "hello",
      protocolVersion: 1,
      connectionId: crypto.randomUUID(),
      highwater: "1",
      retainedFrom: "0",
    }));
    socket.onMessage((message) => {
      const frame = JSON.parse(String(message)) as Record<string, unknown>;
      if (frame.type !== "subscribe") return;
      stream.subscribes.push(frame);
      requests.set(socket, String(frame.requestId));
      cursor(socket);
    });
  });
  stream.push = () => {
    const socket = stream.connections.at(-1);
    if (socket) cursor(socket);
  };
  stream.drop = () => stream.connections.at(-1)?.close();
  return stream;
}

const root = (page: Page) =>
  page.locator('[data-ui-region="task-coordination"]');
/** Phones list lanes as stacked rows and show only committed outputs (2JQJ-0). */
const onPhone = (page: Page) => (page.viewportSize()?.width ?? 1280) < 744;
const output_ =
  (page: Page, name: "Declared" | "Committed") => (api: Locator) =>
    onPhone(page)
      ? name === "Committed"
        ? api.getByText(/committed/)
        : api.getByText(/declared/i)
      : api.getByText(name, { exact: true });

const laneRow = (page: Page, key: string) =>
  page.locator(`[data-lane-key="${key}"]`);

async function open(page: Page, state: World = world()) {
  await mockWorld(page, state);
  await page.goto(`/tasks/${taskId}/coordination`);
  return state;
}

test.beforeEach(async ({ page }) => {
  await mockAuthenticatedSession(page);
});

test("shows the current revision with lanes as rows", async ({ page }) => {
  await open(page);
  await expect(page.getByRole("heading", { name: "Coordination plan" }))
    .toBeVisible();
  await expect(root(page)).toContainText("Plan, version 2");
  await expect(root(page)).toContainText("1 of 3 lanes completed");
  await expect(root(page)).toContainText(
    "Shared budget ceiling: $12.50",
  );
  await expect(
    page.getByRole(onPhone(page) ? "list" : "table", { name: "Plan lanes" }),
  ).toBeVisible();
  await expect(page.locator("[data-lane-key]")).toHaveCount(3);
  const api = laneRow(page, "api");
  await expect(api).toContainText("Change the API contract");
  await expect(api).toContainText("example/api-service");
  await expect(api).toContainText("alias api");
  await expect(api).toContainText("Completed");
  // A phone row that lists a committed output drops this line (2JQJ-0).
  if (!onPhone(page)) await expect(api).toContainText("No prerequisites");
  const web = laneRow(page, "web");
  await expect(web).toContainText("example/web-client");
  await expect(web).toContainText("Waiting");
  await expect(web).toContainText("Waits for: Change the API contract");
  await expect(web).toContainText("from Change the API contract · contract");
  await expect(laneRow(page, "docs")).toContainText("Running");
  // Declared output is committed only when the child task holds the artifact.
  await expect(output_(page, "Committed")(api)).toBeVisible();
  await expect(api.getByRole("link", { name: "Open child task" }))
    .toHaveAttribute(
      "href",
      `/tasks/${child(1)}`,
    );
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("a declared output without an artifact stays declared", async ({ page }) => {
  const state = world({
    plans: [plan("materialized", [
      lane("api", apiRepositoryId, 4, "running", { declaredOutputs: [output] }),
      lane("web", webRepositoryId, 2, "waiting", { prerequisites: ["api"] }),
      lane("docs", docsRepositoryId, 3, "planned"),
    ])],
  });
  await open(page, state);
  const api = laneRow(page, "api");
  if (onPhone(page)) {
    await expect(api).not.toContainText(/committed/);
  } else {
    await expect(api.getByText("Declared", { exact: true })).toBeVisible();
  }
  await expect(output_(page, "Committed")(api)).toHaveCount(0);
});

test("an older published artifact keeps the output committed past a newer unpublished one", async ({ page }) => {
  const state = world({
    plans: [plan("materialized", [
      lane("api", apiRepositoryId, 1, "running", { declaredOutputs: [output] }),
      lane("web", webRepositoryId, 2, "waiting", { prerequisites: ["api"] }),
      lane("docs", docsRepositoryId, 3, "planned"),
    ])],
    unpublishedChild: 1,
  });
  await open(page, state);
  const api = laneRow(page, "api");
  await expect(output_(page, "Committed")(api)).toBeVisible();
  // Phone rows never print a "declared" label, so the match is the whole row text.
  await expect(output_(page, "Declared")(api)).toHaveCount(0);
  if (onPhone(page)) await expect(api).not.toContainText(/declared/i);
});

test("an artifact without a published version is not a committed handoff", async ({ page }) => {
  const state = world({
    plans: [plan("materialized", [
      lane("api", apiRepositoryId, 1, "running", { declaredOutputs: [output] }),
      lane("web", webRepositoryId, 2, "waiting", { prerequisites: ["api"] }),
      lane("docs", docsRepositoryId, 3, "planned"),
    ])],
    onlyUnpublishedChild: 1,
  });
  await open(page, state);
  const api = laneRow(page, "api");
  if (onPhone(page)) {
    await expect(api).not.toContainText(/committed/);
  } else {
    await expect(api.getByText("Declared", { exact: true })).toBeVisible();
  }
  await expect(output_(page, "Committed")(api)).toHaveCount(0);
});

test("an output without an artifact type defaults to patch and commits", async ({ page }) => {
  const state = world({
    plans: [plan("materialized", [
      lane("api", apiRepositoryId, 5, "completed", {
        declaredOutputs: [{ key: "contract", kind: "artifact" }],
      }),
      lane("web", webRepositoryId, 2, "waiting", { prerequisites: ["api"] }),
      lane("docs", docsRepositoryId, 3, "planned"),
    ])],
  });
  await open(page, state);
  const api = laneRow(page, "api");
  await expect(output_(page, "Committed")(api)).toBeVisible();
});

test("partial delivery is explained and stopped lanes say why", async ({ page }) => {
  await open(page, world({ plans: [partial()] }));
  await expect(root(page).locator("[data-plan-status]")).toHaveAttribute(
    "data-plan-status",
    "partially_delivered",
  );
  await expect(page.locator('[data-ui-region="partial-delivery"]'))
    .toContainText("1 lanes completed, 2 stopped or failed");
  await expect(laneRow(page, "web")).toContainText("Stopped");
  await expect(laneRow(page, "web")).toContainText(
    "Stopped because a prerequisite lane failed, stopped or was canceled",
  );
  await expect(laneRow(page, "docs")).toContainText("Failed");
});

test("cancel needs confirmation and sends one idempotent request", async ({ page }) => {
  const state = await open(page);
  await page.getByRole("button", { name: "Cancel plan", exact: true }).click();
  await expect(page.getByText("Cancel this plan?")).toBeVisible();
  await page.getByRole("button", { name: "Keep the plan" }).click();
  expect(state.cancels).toHaveLength(0);
  await page.getByRole("button", { name: "Cancel plan", exact: true }).click();
  await page.getByRole("button", { name: "Cancel the plan" }).click();
  await expect(root(page).locator("[data-plan-status]")).toHaveAttribute(
    "data-plan-status",
    "canceled",
  );
  expect(state.cancels).toHaveLength(1);
  expect(state.cancels[0].id).toBe(planId);
  expect(state.cancels[0].key).toMatch(/^[0-9a-f-]{36}$/);
  await expect(laneRow(page, "api")).toContainText("Completed");
  await expect(laneRow(page, "docs")).toContainText("Canceled");
  await expect(page.getByRole("button", { name: "Cancel plan", exact: true }))
    .toHaveCount(0);
});

test("an unknown cancel outcome retries with the same key", async ({ page }) => {
  const state = world();
  state.cancelReply = (route) => {
    if (state.cancels.length === 1) {
      return route.fulfill({
        status: 503,
        contentType: "application/problem+json",
        json: { ...problem(503, "UNAVAILABLE"), retryable: true },
      });
    }
    state.plans = [{ ...state.plans[0], status: "canceled" }];
    return route.fulfill({ json: state.plans[0] });
  };
  await open(page, state);
  await page.getByRole("button", { name: "Cancel plan", exact: true }).click();
  await page.getByRole("button", { name: "Cancel the plan" }).click();
  await expect(page.getByText("The cancel outcome is unknown")).toBeVisible();
  await page.getByRole("button", { name: "Retry cancel" }).click();
  await expect(root(page).locator("[data-plan-status]")).toHaveAttribute(
    "data-plan-status",
    "canceled",
  );
  expect(state.cancels).toHaveLength(2);
  expect(state.cancels[1].key).toBe(state.cancels[0].key);
});

test("a canceled plan changed elsewhere shows the conflict and the current state", async ({ page }) => {
  const state = world();
  state.cancelReply = (route) => {
    state.plans = [partial()];
    return route.fulfill({
      status: 409,
      contentType: "application/problem+json",
      json: problem(409, "STATE_CONFLICT"),
    });
  };
  await open(page, state);
  await page.getByRole("button", { name: "Cancel plan", exact: true }).click();
  await page.getByRole("button", { name: "Cancel the plan" }).click();
  await expect(page.getByText("The plan changed before it could be canceled"))
    .toBeVisible();
  await expect(root(page).locator("[data-plan-status]")).toHaveAttribute(
    "data-plan-status",
    "partially_delivered",
  );
});

test("no plan shows the empty state", async ({ page }) => {
  await open(page, world({ plans: [] }));
  await expect(page.getByText("No coordination plan yet")).toBeVisible();
});

test("a failed read shows an error with retry", async ({ page }) => {
  const state = world({ plansStatus: 500 });
  await open(page, state);
  await expect(page.getByText("The coordination plan could not be loaded."))
    .toBeVisible();
  state.plansStatus = 200;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(laneRow(page, "api")).toBeVisible();
});

test("a forbidden read shows no plan data", async ({ page }) => {
  await open(page, world({ plansStatus: 403, taskStatus: 403 }));
  await expect(
    page.getByText("You do not have access to this coordination plan."),
  )
    .toBeVisible();
  await expect(page.locator("[data-lane-key]")).toHaveCount(0);
});

test("a stale refresh keeps the last plan and offers a refresh", async ({ page }) => {
  const state = world();
  const stream = await mockStream(page);
  await open(page, state);
  await expect(laneRow(page, "api")).toBeVisible();
  await expect.poll(() => stream.subscribes.length).toBe(1);
  state.plansStatus = 500;
  stream.push();
  await expect(page.getByText("The plan could not be refreshed")).toBeVisible();
  await expect(laneRow(page, "api")).toBeVisible();
  state.plansStatus = 200;
  await page.getByRole("button", { name: "Refresh plan" }).click();
  await expect(page.getByText("The plan could not be refreshed")).toHaveCount(
    0,
  );
});

test("an event refreshes lanes without a reload and a dropped stream reconnects", async ({ page }) => {
  const state = world();
  const stream = await mockStream(page);
  await open(page, state);
  await expect(laneRow(page, "docs")).toContainText("Running");
  await expect.poll(() => stream.subscribes.length).toBe(1);
  expect(stream.subscribes[0].scopes).toEqual([
    { type: "task", id: taskId },
    { type: "application", id: applicationId },
  ]);
  state.plans = [partial()];
  stream.push();
  await expect(laneRow(page, "docs")).toContainText("Failed");
  await expect(page.locator('[data-ui-region="partial-delivery"]'))
    .toBeVisible();
  // The stream drops: the page says so, then re-reads everything on return.
  state.plans = [plan("completed", [
    lane("api", apiRepositoryId, 1, "completed", { declaredOutputs: [output] }),
    lane("web", webRepositoryId, 2, "completed", { prerequisites: ["api"] }),
    lane("docs", docsRepositoryId, 3, "completed"),
  ])];
  stream.drop();
  await expect(page.locator('[data-ui-region="live-lost"]')).toBeVisible();
  await expect.poll(() => stream.subscribes.length, { timeout: 15_000 })
    .toBe(2);
  await expect(root(page)).toContainText("3 of 3 lanes completed");
  await expect(page.locator('[data-ui-region="live-lost"]')).toHaveCount(0);
});

test("offline shows a notice and keeps the plan", async ({ page, context }) => {
  await open(page);
  await expect(laneRow(page, "api")).toBeVisible();
  await context.setOffline(true);
  await expect(
    page.getByText("You are offline. The plan shown may be out of date."),
  )
    .toBeVisible();
  await expect(laneRow(page, "api")).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel plan", exact: true }))
    .toBeDisabled();
  await context.setOffline(false);
});

test("the task detail links to the plan only when one exists", async ({ page }) => {
  await mockWorld(page, world());
  await page.route(
    `**/v1/conversations/${conversationId}/**`,
    (route) => route.fulfill({ json: page_([]) }),
  );
  for (const path of ["plan-revisions", "approvals", "questions"]) {
    await page.route(
      `**/v1/${path}*`,
      (route) => route.fulfill({ json: page_([]) }),
    );
  }
  await page.route(
    "**/v1/workflow-presets*",
    (route) => route.fulfill({ json: page_([]) }),
  );
  await page.goto(`/tasks/${taskId}`);
  if (onPhone(page)) {
    // On a phone the link sits in the plan sheet (2J3V-0 has no top-bar link).
    await page.locator('[data-ui-component="planSummaryCard"]').first().click();
  }
  const link = page.getByRole("link", { name: "View the coordination plan" });
  await expect(link).toBeVisible();
  await link.click();
  await expect(page).toHaveURL(`/tasks/${taskId}/coordination`);
  await expect(laneRow(page, "api")).toBeVisible();
});

test("keyboard reaches the cancel flow and the child links in order", async ({ page }) => {
  await open(page);
  const link = laneRow(page, "api").getByRole("link", {
    name: "Open child task",
  });
  await link.focus();
  await expect(link).toBeFocused();
  await page.getByRole("button", { name: "Cancel plan", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Cancel the plan" }))
    .toBeVisible();
  await expect(page.getByRole("button", { name: "Keep the plan" }))
    .toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("button", { name: "Cancel the plan" }))
    .toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Cancel plan", exact: true }))
    .toBeVisible();
});

test(
  "coordination controls are at least 44px with a coarse pointer",
  async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name !== "mobile",
      "44px applies to coarse pointers; the fine-pointer lane keeps token sizes",
    );
    await open(page);
    const targets = [
      page.getByRole("button", { name: "Cancel plan", exact: true }),
      laneRow(page, "api").getByRole("link", { name: "Open child task" }),
    ];
    for (const control of targets) {
      await control.scrollIntoViewIfNeeded();
      const box = await control.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
  },
);

for (const locale of ["en-XA", "ar-XB"]) {
  test(`the plan reflows at 320px in ${locale}`, async ({ page }) => {
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
    await page.setViewportSize({ width: 320, height: 800 });
    await open(page, world({ plans: [partial()] }));
    await expect(page.locator("html")).toHaveAttribute(
      "dir",
      locale === "ar-XB" ? "rtl" : "ltr",
    );
    await expect(root(page)).toBeVisible();
    await expect(page.locator("[data-lane-key]")).toHaveCount(3);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(
      await page.evaluate(() =>
        document.documentElement.scrollWidth <=
          document.documentElement.clientWidth
      ),
    ).toBe(true);
  });
}

test("long titles and a dark scheme stay contained", async ({ page }) => {
  const long = "Rework the cross-repository onboarding contract ".repeat(8);
  const state = world();
  state.plans = [{
    ...state.plans[0],
    spec: {
      ...spec,
      lanes: spec.lanes.map((entry, index) =>
        index === 0 ? { ...entry, title: long } : entry
      ),
    },
  }];
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, state);
  await expect(laneRow(page, "api")).toContainText(
    "Rework the cross-repository",
  );
  expect(
    await page.evaluate(() =>
      document.documentElement.scrollWidth <=
        document.documentElement.clientWidth
    ),
  ).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

const withOrigin = (origin: Record<string, unknown>) => ({
  ...running(),
  origin,
});
const ticketOrigin = {
  kind: "ticket",
  provider: "github",
  reference: "example/shop#214",
  url: "https://github.com/example/shop/issues/214",
};

test("an ad hoc plan shows its origin, revision and short digest", async ({ page }) => {
  await open(page);
  const provenance = page.locator('[data-ui-region="plan-provenance"]');
  await expect(provenance).toContainText("Ad hoc");
  await expect(provenance).toContainText("Digest eeeeeeeeeeee");
  await expect(provenance).not.toContainText("eeeeeeeeeeeee");
  await expect(provenance).toContainText(
    "Identifies the selected requirements and versions.",
  );
  await expect(root(page)).toContainText("Plan, version 2");
  await expect(page.locator('[data-ui-region="plan-ticket-claim"]'))
    .toHaveCount(0);
});

test("a saved workflow origin names the workflow and version", async ({ page }) => {
  await open(
    page,
    world({
      plans: [withOrigin({
        kind: "saved_workflow",
        workflowId,
        workflowVersionId,
        nodeId: "fan-out",
      })],
    }),
  );
  await expect(page.locator("[data-plan-origin]")).toContainText(
    "Saved workflow Checkout fan-out, version id aaaaaaaa",
  );
});

test("an unreadable saved workflow falls back to its identifier", async ({ page }) => {
  await open(
    page,
    world({
      workflowStatus: 404,
      plans: [withOrigin({
        kind: "saved_workflow",
        workflowId,
        workflowVersionId,
        nodeId: "fan-out",
      })],
    }),
  );
  await expect(page.locator("[data-plan-origin]")).toContainText(
    "Saved workflow 00000000, version id aaaaaaaa",
  );
  await expect(laneRow(page, "api")).toBeVisible();
});

test("a ticket origin is labelled unverified and links only over https", async ({ page }) => {
  await open(page, world({ plans: [withOrigin(ticketOrigin)] }));
  const provenance = page.locator('[data-ui-region="plan-provenance"]');
  await expect(provenance).toContainText(
    "github ticket example/shop#214",
  );
  const claim = page.locator('[data-ui-region="plan-ticket-claim"]');
  await expect(claim).toContainText(
    "Reported by the requester, not verified.",
  );
  const link = claim.getByRole("link", { name: /Open the ticket/ });
  await expect(link).toHaveAttribute(
    "href",
    "https://github.com/example/shop/issues/214",
  );
  await expect(link).toHaveAttribute("rel", /noreferrer/);
  // Keyboard: the link is a normal tab stop and shows focus.
  await link.focus();
  await expect(link).toBeFocused();
});

test("a ticket link that is not https is never rendered", async ({ page }) => {
  await open(
    page,
    world({
      plans: [withOrigin({
        ...ticketOrigin,
        url: "javascript:alert(1)",
      })],
    }),
  );
  const claim = page.locator('[data-ui-region="plan-ticket-claim"]');
  await expect(claim).toContainText("Reported by the requester");
  await expect(claim.getByRole("link")).toHaveCount(0);
  await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
});

test("handoffs show the source lane and output with committed or waiting", async ({ page }) => {
  const state = world();
  await open(page, state);
  const web = laneRow(page, "web");
  const handoff = web.locator("[data-handoff-state]");
  await expect(handoff).toHaveCount(1);
  await expect(handoff).toContainText(
    "from Change the API contract · contract",
  );
  await expect(handoff).toHaveAttribute("data-handoff-state", "committed");
  await expect(handoff).toContainText("Committed");
  // Lanes without inputs list none.
  await expect(laneRow(page, "docs").locator("[data-handoff-state]"))
    .toHaveCount(0);
});

test("a handoff whose output has no published version is waiting", async ({ page }) => {
  await open(page, world({ onlyUnpublishedChild: 1 }));
  const handoff = laneRow(page, "web").locator("[data-handoff-state]");
  await expect(handoff).toHaveAttribute("data-handoff-state", "waiting");
  await expect(handoff).toContainText("Waiting for output");
});

test("a stale lane has its own label, hint and a plan notice", async ({ page }) => {
  await open(page, world({ plans: [stale()] }));
  const web = laneRow(page, "web");
  await expect(web).toHaveAttribute("data-lane-status", "stale");
  await expect(web).toContainText("Stale");
  await expect(web).toContainText(
    "An input it used was replaced after it finished. Rework it in a new version of the plan.",
  );
  const notice = page.locator('[data-ui-region="stale-lanes"]');
  await expect(notice).toContainText("Some lanes are stale");
  await expect(notice).toContainText("new plan revision");
  await expect(root(page)).toContainText("In progress");
});

test("no stale notice without a stale lane", async ({ page }) => {
  await open(page);
  await expect(laneRow(page, "api")).toBeVisible();
  await expect(page.locator('[data-ui-region="stale-lanes"]')).toHaveCount(0);
});

test("a stale lane arriving by event shows the notice without a reload", async ({ page }) => {
  const state = world();
  const stream = await mockStream(page);
  await open(page, state);
  await expect.poll(() => stream.subscribes.length).toBe(1);
  state.plans = [stale()];
  stream.push();
  await expect(laneRow(page, "web")).toContainText("Stale");
  await expect(page.locator('[data-ui-region="stale-lanes"]')).toBeVisible();
});

for (const locale of ["en-XA", "ar-XB"]) {
  test(`origin, digest, handoffs and stale reflow at 320px in ${locale}`, async ({ page }) => {
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
    await page.setViewportSize({ width: 320, height: 800 });
    await open(
      page,
      world({ plans: [{ ...stale(), origin: ticketOrigin }] }),
    );
    await expect(page.locator('[data-ui-region="plan-provenance"]'))
      .toBeVisible();
    await expect(page.locator('[data-ui-region="stale-lanes"]')).toBeVisible();
    await expect(page.locator("[data-handoff-state]")).toHaveCount(1);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(
      await page.evaluate(() =>
        document.documentElement.scrollWidth <=
          document.documentElement.clientWidth
      ),
    ).toBe(true);
  });
}

test("origin, handoffs and stale lanes pass axe in the dark scheme", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await open(
    page,
    world({ plans: [{ ...stale(), origin: ticketOrigin }] }),
  );
  await expect(page.locator('[data-ui-region="stale-lanes"]')).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(
    await page.evaluate(() =>
      document.documentElement.scrollWidth <=
        document.documentElement.clientWidth
    ),
  ).toBe(true);
});
