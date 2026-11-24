import { shot } from "./helpers/real-api.ts";
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
import { still } from "./helpers/stills.ts";

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
  /** The version the saved workflow has in use now (the plan's own by default). */
  workflowActiveVersionId?: string;
  /** The saved workflow's name (a long one, to see it wrap). */
  workflowName?: string;
  /** Answer for the saved workflow's versions; 404 when unreadable. */
  versionsStatus?: number;
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
            name: state.workflowName ?? "Checkout fan-out",
            description: null,
            activeVersionId: state.workflowActiveVersionId ?? workflowVersionId,
            enabled: true,
            createdAt: stamp,
            updatedAt: stamp,
            version: 1,
            origin: {
              kind: "authored",
              catalogKey: null,
              catalogVersion: null,
              sourceWorkflowId: null,
              sourceVersionId: null,
              sourceDigest: null,
              conversationId: null,
              turnId: null,
            },
            visibility: "listed",
          },
        })
        : route.fulfill({
          status: state.workflowStatus,
          contentType: "application/problem+json",
          json: problem(state.workflowStatus ?? 404, "RESOURCE_NOT_FOUND"),
        }),
  );
  await page.route(
    `**/v1/workflows/${workflowId}/versions**`,
    (route) =>
      (state.versionsStatus ?? 200) === 200
        ? route.fulfill({
          json: {
            items: [{
              id: workflowVersionId,
              workflowId,
              revision: 3,
              sourceYaml: "steps: []\n",
              normalizedSpec: { steps: [] },
              digest: "c".repeat(64),
              status: "published",
              createdBy: "00000000-0000-4000-8000-000000000001",
              createdAt: stamp,
              updatedAt: stamp,
              version: 1,
              starts: [],
            }],
            nextCursor: null,
          },
        })
        : route.fulfill({
          status: state.versionsStatus,
          contentType: "application/problem+json",
          json: problem(state.versionsStatus ?? 404, "RESOURCE_NOT_FOUND"),
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

const scopesByConnection = (stream: Stream) => {
  const byConnection = new Map<number, string[]>();
  for (const subscribe of stream.subscribes) {
    const scopes = byConnection.get(subscribe.connection) ?? [];
    for (const scope of subscribe.scopes) {
      const named = `${scope.type}:${scope.id}`;
      expect(scopes).not.toContain(named);
      scopes.push(named);
    }
    byConnection.set(subscribe.connection, scopes);
  }
  return [...byConnection.values()].map((scopes) => scopes.sort());
};

const shellAndCoordinationScopes = () =>
  [
    `application:${applicationId}`,
    `inbox:${principalId}`,
    `task:${taskId}`,
  ].sort();

/** A scripted /v1/events server: hello, then a cursor for every subscribe. */
type Subscribe = {
  connection: number;
  scopes: { type: string; id: string }[];
};
type Stream = {
  connections: WebSocketRoute[];
  subscribes: Subscribe[];
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
      stream.subscribes.push({
        connection: stream.connections.length,
        scopes: frame.scopes as { type: string; id: string }[],
      });
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
  await expect(page.getByRole("heading", { name: "Split" }))
    .toBeVisible();
  await expect(root(page)).toContainText("Split, version 2");
  await expect(root(page)).toContainText("1 of 3 lanes completed");
  await expect(root(page)).toContainText(
    "Shared budget ceiling: $12.50",
  );
  await expect(
    page.getByRole(onPhone(page) ? "list" : "table", {
      name: "Lanes",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator("[data-lane-key]")).toHaveCount(3);
  await page.mouse.move(700, 700);
  await shot(page, "task-split-lanes");
  const api = laneRow(page, "api");
  await expect(api).toContainText("Change the API contract");
  await expect(api).toContainText("example/api-service");
  await expect(api).toContainText("Short name: api");
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
  await expect(api.getByRole("link", { name: "Open task" }))
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
  // O12: a lane that has not begun is "Not started"; the word "Planned"
  // belongs to the plan document alone.
  await expect(laneRow(page, "docs")).toContainText("Not started");
  await expect(laneRow(page, "docs")).not.toContainText("Planned");
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
  await page.getByRole("button", { name: "Cancel split", exact: true }).click();
  // The shared alert dialog: the question is its name, what stopping costs is
  // its body, "Keep the split" comes first and the danger action last
  // (design-ux, #396).
  const dialog = page.getByRole("alertdialog", { name: "Cancel this split?" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(
    "Unfinished lanes stop. Completed lanes keep their results.",
  );
  const actions = dialog.getByRole("button");
  await expect(actions.first()).toHaveText("Keep the split");
  await expect(actions.last()).toHaveText("Cancel the split");
  await expect(actions.last()).toHaveAttribute("data-variant", "destructive");
  await page.mouse.move(700, 700);
  await shot(page, "task-split-cancel-confirm");
  await page.getByRole("button", { name: "Keep the split" }).click();
  expect(state.cancels).toHaveLength(0);
  await page.getByRole("button", { name: "Cancel split", exact: true }).click();
  await page.getByRole("button", { name: "Cancel the split" }).click();
  await expect(root(page).locator("[data-plan-status]")).toHaveAttribute(
    "data-plan-status",
    "canceled",
  );
  expect(state.cancels).toHaveLength(1);
  expect(state.cancels[0].id).toBe(planId);
  expect(state.cancels[0].key).toMatch(/^[0-9a-f-]{36}$/);
  await expect(laneRow(page, "api")).toContainText("Completed");
  await expect(laneRow(page, "docs")).toContainText("Canceled");
  await expect(page.getByRole("button", { name: "Cancel split", exact: true }))
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
  await page.getByRole("button", { name: "Cancel split", exact: true }).click();
  await page.getByRole("button", { name: "Cancel the split" }).click();
  await expect(
    page.getByText("Bakery cannot tell whether the split was canceled"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Try again" }).click();
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
  await page.getByRole("button", { name: "Cancel split", exact: true }).click();
  await page.getByRole("button", { name: "Cancel the split" }).click();
  await expect(page.getByText("The split changed before it could be canceled"))
    .toBeVisible();
  await expect(root(page).locator("[data-plan-status]")).toHaveAttribute(
    "data-plan-status",
    "partially_delivered",
  );
});

test("no plan shows the empty state", async ({ page }) => {
  await open(page, world({ plans: [] }));
  await expect(page.getByText("This task is not split")).toBeVisible();
  await page.mouse.move(700, 700);
  await shot(page, "task-split-empty");
});

test("a failed read shows an error with retry", async ({ page }) => {
  const state = world({ plansStatus: 500 });
  await open(page, state);
  await expect(page.getByText("The split could not be loaded."))
    .toBeVisible();
  state.plansStatus = 200;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(laneRow(page, "api")).toBeVisible();
});

test("a forbidden read shows no plan data", async ({ page }) => {
  await open(page, world({ plansStatus: 403, taskStatus: 403 }));
  await expect(
    page.getByText("You do not have access to this split."),
  )
    .toBeVisible();
  await expect(page.locator("[data-lane-key]")).toHaveCount(0);
});

test("a stale refresh keeps the last plan and offers a refresh", async ({ page }) => {
  const state = world();
  const stream = await mockStream(page);
  await open(page, state);
  await expect(laneRow(page, "api")).toBeVisible();
  await expect.poll(() => stream.connections.length).toBe(1);
  await expect.poll(() => scopesByConnection(stream)).toEqual([
    shellAndCoordinationScopes(),
  ]);
  state.plansStatus = 500;
  stream.push();
  await expect(page.getByText("The split could not be refreshed"))
    .toBeVisible();
  await expect(laneRow(page, "api")).toBeVisible();
  state.plansStatus = 200;
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByText("The split could not be refreshed")).toHaveCount(
    0,
  );
});

test("an event refreshes lanes without a reload and a dropped stream reconnects", async ({ page }) => {
  const state = world();
  const stream = await mockStream(page);
  await open(page, state);
  await expect(laneRow(page, "docs")).toContainText("Running");
  await expect.poll(() => stream.connections.length).toBe(1);
  await expect.poll(() => scopesByConnection(stream)).toEqual([
    shellAndCoordinationScopes(),
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
  await expect.poll(() => stream.connections.length, { timeout: 15_000 })
    .toBe(2);
  await expect.poll(() => scopesByConnection(stream)).toEqual([
    shellAndCoordinationScopes(),
    shellAndCoordinationScopes(),
  ]);
  await expect(root(page)).toContainText("3 of 3 lanes completed");
  await expect(page.locator('[data-ui-region="live-lost"]')).toHaveCount(0);
});

test("offline shows a notice and keeps the plan", async ({ page, context }) => {
  await open(page);
  await expect(laneRow(page, "api")).toBeVisible();
  await context.setOffline(true);
  await expect(
    page.getByText("You are offline. What is shown may be out of date."),
  )
    .toBeVisible();
  await expect(laneRow(page, "api")).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel split", exact: true }))
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
  const link = page.getByRole("link", { name: "View the split" });
  await expect(link).toBeVisible();
  await page.mouse.move(700, 700);
  await shot(page, "task-conversation-split-link");
  await link.click();
  await expect(page).toHaveURL(`/tasks/${taskId}/coordination`);
  await expect(laneRow(page, "api")).toBeVisible();
});

test("keyboard reaches the cancel flow and the child links in order", async ({ page }) => {
  await open(page);
  const link = laneRow(page, "api").getByRole("link", {
    name: "Open task",
  });
  await link.focus();
  await expect(link).toBeFocused();
  await page.getByRole("button", { name: "Cancel split", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Cancel the split" }))
    .toBeVisible();
  await expect(page.getByRole("button", { name: "Keep the split" }))
    .toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("button", { name: "Cancel the split" }))
    .toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Cancel split", exact: true }))
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
      page.getByRole("button", { name: "Cancel split", exact: true }),
      laneRow(page, "api").getByRole("link", { name: "Open task" }),
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

test("the phone header carries the notifications bell", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await expect(
    root(page).getByRole("button", { name: /^Notifications/ }),
  ).toBeVisible();
  await page.mouse.move(200, 800);
  await still(page, "phone-header-bell-coordination");
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

test("an ad hoc plan shows its origin and revision, and the digest behind a fingerprint row", async ({ page }) => {
  await open(page);
  const provenance = page.locator('[data-ui-region="plan-provenance"]');
  await expect(provenance).toContainText("Made for this task");
  await expect(provenance).not.toContainText("Digest");
  await expect(provenance).not.toContainText("eeeeeeeeeeee");
  const fingerprint = page.getByTestId("fingerprint-row");
  await expect(fingerprint).toContainText("Fingerprint");
  await expect(fingerprint).toContainText("eeeeeeeeeeee");
  await expect(fingerprint).not.toContainText("eeeeeeeeeeeee");
  await expect(fingerprint).toContainText(
    "Identifies the selected requirements and versions.",
  );
  await expect(root(page)).toContainText("Split, version 2");
  await expect(page.locator('[data-ui-region="plan-ticket-claim"]'))
    .toHaveCount(0);
  // The row sits inside the page's column, lined up with the heading, and its
  // Copy button does not touch the window's edge. The inset is the list's own
  // padding, so measure where its content starts, not its box.
  const copy = (await fingerprint.getByRole("button", { name: "Copy" })
    .boundingBox())!;
  const heading = (await page.getByRole("heading", {
    name: "Split",
  }).boundingBox())!;
  const width = page.viewportSize()!.width;
  // The label is a bare text node beside the help button (and the help text
  // repeats the word), so read where that one text node starts.
  const labelX = await fingerprint.evaluate((row) => {
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.textContent?.trim() === "Fingerprint") {
        const range = document.createRange();
        range.selectNodeContents(node);
        return range.getBoundingClientRect().x;
      }
    }
    return null;
  });
  expect(labelX, "the Fingerprint label is on the page").not.toBeNull();
  expect(labelX!, "label starts inside the column").toBeGreaterThan(8);
  expect(copy.x + copy.width, "Copy keeps a margin").toBeLessThanOrEqual(
    width - 8,
  );
  if (width > 743) {
    expect(Math.abs(labelX! - heading.x), "lines up with the heading")
      .toBeLessThan(2);
  }
  await still(page, "plan-coordination");
});

test("a lane's child task link is the task's title, never an id", async ({ page }) => {
  await page.route(
    /\/v1\/tasks\/00000000-0000-4000-8000-0000000008\d0$/,
    (route) => {
      const id = route.request().url().split("/").at(-1)!;
      return route.fulfill({
        json: { ...task, id, title: `Update lane ${id.at(-2)}` },
      });
    },
  );
  await open(page);
  const link = laneRow(page, "api").getByRole("link", {
    name: /^Open Update lane/,
  });
  await expect(link).toBeVisible();
  await expect(link).toHaveText(/^Update lane \d$/);
  await expect(laneRow(page, "api")).not.toContainText("00000000");
  await still(page, "plan-coordination-child-links");
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
  const origin = page.locator("[data-plan-origin]");
  await expect(origin).toContainText("Workflow: Checkout fan-out, version 3");
  // The line leads to that version's page, and says nothing is older.
  await expect(origin.getByRole("link")).toHaveAttribute(
    "href",
    `/library/workflows/${workflowId}?version=${workflowVersionId}`,
  );
  await expect(origin).not.toContainText("Older version");
});

test("a saved workflow whose newer version is in use says this run's version is older", async ({ page }) => {
  await open(
    page,
    world({
      workflowActiveVersionId: "bbbbbbbb-0000-4000-8000-0000000000c3",
      plans: [withOrigin({
        kind: "saved_workflow",
        workflowId,
        workflowVersionId,
        nodeId: "fan-out",
      })],
    }),
  );
  const origin = page.locator("[data-plan-origin]");
  await expect(origin).toContainText("Workflow: Checkout fan-out, version 3");
  await expect(origin).toContainText("Older version");
  // The badge is a normal badge (not taller than a text badge) and its tip follows
  // it directly, the pair in one group that does not break across lines.
  const group = origin.locator('[data-ui-region="plan-older-version"]');
  await expect(group.locator('[data-ui-component="badge"]')).toHaveCount(1);
  await expect(group.getByRole("button", { name: "Older version" }))
    .toHaveCount(
      1,
    );
  await expect(
    origin.locator('[data-ui-component="badge"]').getByRole("button"),
  ).toHaveCount(0);
  const older = await group.locator('[data-ui-component="badge"]')
    .boundingBox();
  // A normal badge is about 20px tall; with the tip inside it was 2.4 times that.
  expect(older!.height).toBeLessThan(32);
  const after = await group.getByRole("button", { name: "Older version" })
    .boundingBox();
  expect(after!.x).toBeGreaterThanOrEqual(older!.x + older!.width - 1);
  expect(after!.x - (older!.x + older!.width)).toBeLessThanOrEqual(12);
  await shot(page, "task-origin-older");
  // In the wide header the workflow's link is line 2, under the title.
  if (test.info().project.name === "desktop") {
    // The header's two lines share one element, so measure the text itself.
    const line = (needle: string) =>
      page.evaluate((text) => {
        const walker = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_TEXT,
        );
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (node.textContent?.includes(text)) {
            const range = document.createRange();
            range.selectNodeContents(node);
            const box = range.getBoundingClientRect();
            return { x: box.x, y: box.y, height: box.height };
          }
        }
        return null;
      }, needle);
    const link = await origin.getByRole("link").boundingBox();
    const title = await line("Ship the contract change");
    const plan = await line("Split, version 2");
    expect(title, "the title's text").not.toBeNull();
    expect(plan, "the plan label's text").not.toBeNull();
    expect(link, "the workflow link").not.toBeNull();
    // Line 1: the title, then the plan's revision beside it.
    expect(Math.abs(plan!.y - title!.y)).toBeLessThanOrEqual(4);
    // Line 2: starts at the title's left edge, under it.
    expect(link!.y).toBeGreaterThan(title!.y + title!.height - 2);
    expect(Math.abs(link!.x - title!.x)).toBeLessThanOrEqual(2);
  }
  // On a phone the workflow line is line 2 of the header, under the revision and
  // above the status, not after the lanes.
  if (test.info().project.name === "mobile") {
    const status = await page.getByText("In progress").first().boundingBox();
    const link = await origin.getByRole("link").boundingBox();
    const lane = await page.getByText("example/api-service").first()
      .boundingBox();
    expect(link!.y).toBeLessThan(lane!.y);
    expect(link!.y).toBeLessThan(status!.y);
  }
  // On a phone the tip closes when the page scrolls, and this line is at the
  // end of the page: bring the button into view first so opening it does not.
  const tip = origin.getByRole("button", { name: "Older version" });
  await tip.scrollIntoViewIfNeeded();
  await tip.click();
  const panel = page.locator(
    '[data-ui-component="helpTip"] .ui-help-tip__panel',
  ).filter({
    has: page.getByText(
      "A newer version is in use for new tasks. This task keeps the one it started with.",
    ),
  });
  await expect(panel).toBeVisible();
  await shot(page, "task-origin-tip");
});

test("when the versions cannot be read the version shows its short identifier", async ({ page }) => {
  await open(
    page,
    world({
      versionsStatus: 404,
      plans: [withOrigin({
        kind: "saved_workflow",
        workflowId,
        workflowVersionId,
        nodeId: "fan-out",
      })],
    }),
  );
  await expect(page.locator("[data-plan-origin]")).toContainText(
    "Workflow: Checkout fan-out",
  );
  // The version's identifier is internal: never shown in place of its number.
  await expect(page.locator("[data-plan-origin]")).not.toContainText(
    "aaaaaaaa",
  );
  await expect(page.locator("[data-plan-origin]")).not.toContainText(
    ", version",
  );
});

test("a long unbroken workflow name wraps on its line and never widens the page", async ({ page }) => {
  await open(
    page,
    world({
      workflowActiveVersionId: "bbbbbbbb-0000-4000-8000-0000000000c3",
      workflowName: "n".repeat(200),
      plans: [withOrigin({
        kind: "saved_workflow",
        workflowId,
        workflowVersionId,
        nodeId: "fan-out",
      })],
    }),
  );
  await expect(page.locator("[data-plan-origin]")).toContainText("version 3");
  // Where the line wraps, the badge and its tip stay together on one line.
  const group = page.locator('[data-ui-region="plan-older-version"]');
  const badge = await group.locator('[data-ui-component="badge"]')
    .boundingBox();
  const tip = await group.getByRole("button", { name: "Older version" })
    .boundingBox();
  expect(tip!.y + tip!.height / 2).toBeGreaterThanOrEqual(badge!.y);
  expect(tip!.y + tip!.height / 2).toBeLessThanOrEqual(
    badge!.y + badge!.height,
  );
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test("an unreadable saved workflow falls back to its identifier", async ({ page }) => {
  await open(
    page,
    world({
      workflowStatus: 404,
      versionsStatus: 404,
      plans: [withOrigin({
        kind: "saved_workflow",
        workflowId,
        workflowVersionId,
        nodeId: "fan-out",
      })],
    }),
  );
  await expect(page.locator("[data-plan-origin]")).toContainText(
    "Workflow: 00000000",
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
    "An input it used was replaced after it finished. Rework it in a new version of the split.",
  );
  const notice = page.locator('[data-ui-region="stale-lanes"]');
  await expect(notice).toContainText("Some lanes are stale");
  await expect(notice).toContainText("new version of the split");
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
  await expect(laneRow(page, "api")).toBeVisible();
  await expect.poll(() => stream.connections.length).toBe(1);
  await expect.poll(() => scopesByConnection(stream)).toEqual([
    shellAndCoordinationScopes(),
  ]);
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
