import { expect, type Page, type Route, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockAuthenticatedSession } from "./helpers/mock-session.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { laneBudgetMs } from "./helpers/lane-budget.ts";

// #70 slice 2: a step whose model is not answering shows a card on the task
// run. Bakery never switches by itself, and this slice ships no way to choose
// another. The reads are mocked with the shapes of `routeContinuations.list`
// and `runs.get` (`waitingOnModel`).

registerPageHealth(test);

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const id = uuid(12);
const runId = uuid(20);
const stepId = uuid(21);
const incidentId = uuid(30);
const BASE = "a7254e7".padEnd(40, "c");

const run = {
  id: runId,
  taskId: id,
  workflowVersionId: uuid(22),
  repositoryProfileId: null,
  repositoryProfileRevision: null,
  repositoryProfileDigest: null,
  observationId: null,
  observationDigest: null,
  baseSha: BASE,
  workspaceBaseSha: null,
  requestedBy: uuid(1),
  inngestRunId: null,
  status: "running",
  budgetLimitUsd: "10.00",
  startedAt: "2026-01-01T00:00:01.000Z",
  finishedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:01:00.000Z",
  version: 4,
  budgetSummary: {
    installation: null,
    run: {
      scope: "run",
      runId,
      periodStart: null,
      periodEnd: null,
      limitUsd: "10",
      reservedUsd: "2",
      settledUsd: "1",
      availableUsd: "7",
      unknownCount: 0,
    },
  },
};
const step = {
  id: stepId,
  runId,
  stepKey: "implement",
  iteration: 1,
  status: "running",
  input: {},
  output: null,
  error: null,
  startedAt: "2026-01-01T00:00:02.000Z",
  finishedAt: null,
  createdAt: "2026-01-01T00:00:02.000Z",
  updatedAt: "2026-01-01T00:00:03.000Z",
  version: 1,
};
const task = {
  id,
  applicationId: uuid(4),
  repositoryId: uuid(5),
  conversationId: uuid(6),
  parentTaskId: null,
  title: "Add partial refunds",
  description: "Persisted description",
  taskType: "feature",
  status: "draft",
  priority: 50,
  createdBy: uuid(1),
  currentRunId: runId,
  archivedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  version: 1,
  repositoryProfileId: null,
  repositoryProfileRevision: null,
  repositoryProfileDigest: null,
  observationId: null,
  observationDigest: null,
  baseSha: BASE,
};

const page_ = <T>(items: T[]) => ({ items, nextCursor: null });
const problemBody = (status: number, code: string, reason?: string) => ({
  type: "about:blank",
  title: code,
  status,
  code,
  detail: code,
  requestId: uuid(110),
  traceId: uuid(111),
  retryable: false,
  ...(reason === undefined ? {} : { reason }),
});

type Target = {
  routeId: string;
  provider: string;
  model: string;
  harness: string;
  billingRoute: string;
  health: string;
  eligible: boolean;
  ineligibleReason: string | null;
};
type Offer = ReturnType<typeof offerRow>;

const target = (n: number, over: Partial<Target> = {}): Target => ({
  routeId: uuid(100 + n),
  provider: "anthropic",
  model: "claude-sonnet",
  harness: "claude_code",
  billingRoute: "subscription",
  health: "healthy",
  eligible: true,
  ineligibleReason: null,
  ...over,
});

/** One step waiting on a model; `since` is how many seconds ago it began. */
const offerRow = (
  over: { since?: number; targets?: Target[]; nextCheckAt?: string | null } =
    {},
) => ({
  runStepId: stepId,
  stepKey: "implement",
  incidentId,
  incidentGeneration: 2,
  sourceRouteId: uuid(40),
  source: {
    provider: "anthropic",
    model: "claude-opus",
    harness: "claude_code",
    billingRoute: "subscription",
    health: "open",
  },
  reason: "rate_limited",
  since: new Date(Date.now() - (over.since ?? 300) * 1000).toISOString(),
  nextCheckAt: over.nextCheckAt === undefined
    ? new Date(Date.now() + 3 * 60_000).toISOString()
    : over.nextCheckAt,
  runVersion: 4,
  estimatedIncrementalCost: null,
  targets: over.targets ?? [
    target(1, { model: "claude-sonnet" }),
    target(2, {
      provider: "openai",
      model: "gpt-5",
      harness: "claude_code",
      billingRoute: "api_metered",
      health: "degraded",
    }),
    target(3, { model: "claude-haiku", health: "unverified" }),
    target(4, {
      provider: "openai",
      model: "codex-large",
      harness: "codex",
      eligible: false,
      ineligibleReason: "different_harness",
    }),
    target(5, {
      model: "claude-old",
      eligible: false,
      ineligibleReason: "route_not_active",
    }),
  ],
});

type Waiting = {
  offers: Offer[];
  /** What `runs.get` says; false once the incident has closed. */
  waiting: boolean;
};

/** Serves the task and its run waiting on a model. */
async function openWaiting(page: Page, offers: Offer[]): Promise<Waiting> {
  const state: Waiting = { offers, waiting: offers.length > 0 };
  await mockAuthenticatedSession(page);
  await page.route(
    `**/v1/tasks/${id}`,
    (route) => route.fulfill({ json: task }),
  );
  await page.route(
    `**/v1/runs/${runId}`,
    (route) =>
      route.fulfill({ json: { ...run, waitingOnModel: state.waiting } }),
  );
  await page.route(
    `**/v1/runs/${runId}/steps*`,
    (route) => route.fulfill({ json: page_([step]) }),
  );
  await page.route(`**/v1/runs/${runId}/controls`, (route) =>
    route.fulfill({
      json: {
        runId,
        actions: ["pause", "resume", "cancel", "interrupt"].map((action) => ({
          action,
          canRequest: true,
          reason: "allowed",
        })),
      },
    }));
  const empty = (route: Route) => route.fulfill({ json: page_([]) });
  for (
    const pattern of [
      "**/v1/artifacts?*",
      "**/v1/conversations/*/messages*",
      "**/v1/conversations/*/turns*",
      "**/v1/conversations/*/participants*",
      "**/v1/plan-revisions*",
      "**/v1/questions*",
      "**/v1/coordination-plans*",
      "**/v1/approvals?*",
      "**/v1/pull-requests?*",
      "**/v1/merge-attempts?*",
      `**/v1/runs/${runId}/checks*`,
      `**/v1/runs/${runId}/reviews*`,
      `**/v1/runs/${runId}/delivery-decisions*`,
    ]
  ) await page.route(pattern, empty);
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
  await page.route(`**/v1/runs/${runId}/route-continuations`, async (route) => {
    const request = route.request();
    // This slice ships no way to choose, so the page only reads offers.
    if (request.method() === "GET") {
      return await route.fulfill({
        json: { runId, offers: state.offers },
      });
    }
    await route.fulfill({
      status: 405,
      json: problemBody(405, "METHOD_NOT_ALLOWED"),
    });
  });
  await page.goto(`/tasks/${id}`);
  return state;
}

const card = (page: Page) => page.getByTestId("route-waiting-card");

const SECOND_LINE =
  "Bakery has not moved this work anywhere else, and the step does not start again by itself.";

test("a step waiting on a model shows one card that says what, why and what Bakery has not done", async ({ page }) => {
  await openWaiting(page, [offerRow()]);
  await expect(card(page)).toHaveCount(1);
  await expect(card(page)).toContainText(
    "Waiting: Claude Code cannot reach its model",
  );
  await expect(card(page)).toContainText(
    'The step "Implement" runs on Claude Code with claude-opus, using the subscription on a machine. Anthropic has been limiting requests since',
  );
  await expect(card(page)).toContainText(SECOND_LINE);
  await expect(card(page)).toContainText("Bakery tries Anthropic again at");
  await expect(card(page)).not.toContainText("checks again");
  // No way to choose ships yet: no button, and no promise of one.
  await expect(card(page).getByRole("button")).toHaveCount(0);
  await expect(card(page)).not.toContainText("chooses");
  // The run says so too: the badge, and the step's own row.
  await expect(page.getByText("Waiting on a model", { exact: true }))
    .toBeVisible();
  await expect(page.getByText(
    "Waiting on Claude Code with claude-opus. It does not start again by itself.",
  )).toBeVisible();
  const results = await new AxeBuilder({ page })
    .include('[data-testid="route-waiting"]')
    .analyze();
  expect(results.violations).toEqual([]);
});

test("with no next check the card drops its last sentence", async ({ page }) => {
  await openWaiting(page, [offerRow({ nextCheckAt: null })]);
  await expect(card(page)).toContainText(SECOND_LINE);
  await expect(card(page)).not.toContainText("tries Anthropic again");
});

test("a wait of less than a minute shows no card and no badge", async ({ page }) => {
  await openWaiting(page, [offerRow({ since: 20 })]);
  await expect(page.getByRole("heading", { name: "Current run" }))
    .toBeVisible();
  await expect(card(page)).toHaveCount(0);
  await expect(page.getByText("Waiting on a model", { exact: true }))
    .toHaveCount(0);
});

test("with no other way to run the step the card reads the same and has no button", async ({ page }) => {
  await openWaiting(page, [
    offerRow({
      targets: [target(4, { eligible: false, ineligibleReason: "route_open" })],
    }),
  ]);
  await expect(card(page)).toContainText(SECOND_LINE);
  await expect(card(page).getByRole("button")).toHaveCount(0);
});

test("the card goes without a notice when the incident closes", async ({ page }) => {
  const state = await openWaiting(page, [offerRow()]);
  await expect(card(page)).toHaveCount(1);
  state.offers = [];
  state.waiting = false;
  await page.reload();
  await expect(page.getByRole("heading", { name: "Current run" }))
    .toBeVisible();
  await expect(card(page)).toHaveCount(0);
  await expect(page.getByTestId("route-waiting-notice")).toHaveCount(0);
});

test("several waiting steps show one card each, oldest first", async ({ page }) => {
  const second = {
    ...offerRow({ since: 120 }),
    runStepId: uuid(23),
    stepKey: "review",
  };
  await openWaiting(page, [second, offerRow({ since: 900 })]);
  await expect(card(page)).toHaveCount(2);
  await expect(card(page).first()).toHaveAttribute(
    "data-step-key",
    "implement",
  );
  await expect(card(page).last()).toHaveAttribute("data-step-key", "review");
});

// ---- stills for design-ux's and QA's review (only when BAKERY_STILLS_DIR is set).
const STILLS = process.env.BAKERY_EVIDENCE_DIR ?? process.env.BAKERY_STILLS_DIR;
const SIZES = [["desktop", 1440, 900], ["phone", 390, 844]] as const;
const SCHEMES = ["light", "dark"] as const;
const CASES = [
  ["waiting-card", () => [offerRow()]],
  ["waiting-card-no-check", () => [offerRow({ nextCheckAt: null })]],
] as const;

for (const scheme of SCHEMES) {
  for (const [size, width, height] of SIZES) {
    for (const [name, offers] of CASES) {
      test(`still: ${name}, ${size} ${scheme}`, async ({ page }) => {
        test.skip(STILLS === undefined, "BAKERY_STILLS_DIR is not set");
        test.setTimeout(laneBudgetMs(90_000));
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({ width, height });
        await openWaiting(page, [...offers()]);
        await expect(card(page)).toBeVisible();
        await expect(page.getByText(
          "Waiting on Claude Code with claude-opus. It does not start again by itself.",
        )).toBeVisible();
        // The whole page, so the card and the step's row in the timeline are
        // both in the still, uncropped.
        await page.screenshot({
          path: `${STILLS}/${name}-${size}-${scheme}.png`,
          animations: "disabled",
          fullPage: true,
        });
      });
    }
  }
}
