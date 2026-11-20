import {
  expect,
  type Locator,
  type Page,
  type Route,
  test,
} from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockAuthenticatedSession } from "./helpers/mock-session.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { laneBudgetMs } from "./helpers/lane-budget.ts";

// #70 slice 2: a step whose model is not answering shows a card on the task
// run, and a dialog chooses another way to run it. Bakery never switches by
// itself. The reads are mocked with the shapes of `routeContinuations.list`,
// `routeContinuations.admit`, and `runs.get` (`waitingOnModel`).

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
  admits: { key: string | undefined; body: Record<string, unknown> }[];
  /** Answers a choice instead of the default (admitting it). */
  reply?: (route: Route, state: Waiting) => Promise<void>;
};

/** Serves the task, its run waiting on a model, and the choice. */
async function openWaiting(
  page: Page,
  offers: Offer[],
  reply?: Waiting["reply"],
): Promise<Waiting> {
  const state: Waiting = {
    offers,
    waiting: offers.length > 0,
    admits: [],
    reply,
  };
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
    if (request.method() === "GET") {
      return await route.fulfill({
        json: { runId, offers: state.offers },
      });
    }
    state.admits.push({
      key: request.headers()["idempotency-key"],
      body: request.postDataJSON() as Record<string, unknown>,
    });
    if (state.reply) return await state.reply(route, state);
    const chosen = state.offers[0].targets.find((one) =>
      one.routeId === (request.postDataJSON() as { targetRouteId: string })
        .targetRouteId
    )!;
    // The server moves the step: the incident no longer offers a choice.
    state.offers = [];
    state.waiting = false;
    await route.fulfill({
      json: {
        id: uuid(60),
        runId,
        runStepId: stepId,
        jobId: uuid(61),
        incidentId,
        incidentGeneration: 2,
        sourceRouteId: uuid(40),
        targetRouteId: chosen.routeId,
        previousPin: {
          provider: "anthropic",
          model: "claude-opus",
          billingRoute: "subscription",
          billingAccountId: "acct-1",
        },
        newPin: {
          provider: chosen.provider,
          model: chosen.model,
          billingRoute: chosen.billingRoute === "api_metered"
            ? "api"
            : "subscription",
          billingAccountId: "acct-2",
        },
        admittedAt: new Date().toISOString(),
      },
    });
  });
  await page.goto(`/tasks/${id}`);
  return state;
}

const card = (page: Page) => page.getByTestId("route-waiting-card");
const dialog = (page: Page) => page.getByTestId("route-waiting-dialog");
const button = (scope: Locator, name: string | RegExp) =>
  scope.getByRole("button", { name });

const SECOND_LINE =
  "Bakery has not moved this work anywhere else, and the step does not start again by itself. It stays waiting until someone chooses another way to run it.";

test("a step waiting on a model shows one card that says what, why and what Bakery has not done", async ({ page }) => {
  await openWaiting(page, [offerRow()]);
  await expect(card(page)).toHaveCount(1);
  await expect(card(page)).toContainText(
    "Waiting: Claude Code cannot reach its model",
  );
  await expect(card(page)).toContainText(
    'The step "implement" runs on Claude Code with claude-opus, paid by the subscription on a machine. Anthropic has been limiting requests since',
  );
  await expect(card(page)).toContainText(SECOND_LINE);
  await expect(card(page)).toContainText("Bakery tries Anthropic again at");
  await expect(card(page)).not.toContainText("checks again");
  await expect(button(card(page), "Choose another way to run it"))
    .toBeVisible();
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

test("with no other way to run the step there is no button and the card says so", async ({ page }) => {
  await openWaiting(page, [
    offerRow({
      targets: [target(4, { eligible: false, ineligibleReason: "route_open" })],
    }),
  ]);
  await expect(card(page)).toContainText(
    "There is no other way to run this step right now.",
  );
  await expect(card(page)).not.toContainText("until someone chooses");
  await expect(button(card(page), /Choose another way/)).toHaveCount(0);
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

test("the dialog opens with nothing chosen and Continue waits for a choice", async ({ page }) => {
  await openWaiting(page, [offerRow()]);
  await button(card(page), "Choose another way to run it").click();
  const open = dialog(page);
  await expect(open).toBeVisible();
  await expect(open.getByRole("heading", {
    name: 'Choose another way to run "implement"',
  })).toBeVisible();
  const radios = open.getByRole("radio");
  await expect(radios).toHaveCount(3);
  for (let n = 0; n < 3; n += 1) await expect(radios.nth(n)).not.toBeChecked();
  await expect(open.getByText("Having trouble too")).toBeVisible();
  await expect(open.getByText("Not tried yet")).toBeVisible();
  await expect(button(open, "Continue")).toBeDisabled();
  await expect(open.getByTestId("route-waiting-payment")).toHaveCount(0);
  await expect(open.getByText("2 others cannot be used")).toBeVisible();
  await expect(open).toContainText(
    "What the rest will cost this way: Unknown.",
  );
  const results = await new AxeBuilder({ page }).include("dialog[open]")
    .analyze();
  expect(results.violations).toEqual([]);
  // Keep waiting closes it and changes nothing.
  await button(open, "Keep waiting").click();
  await expect(open).toHaveCount(0);
});

test("a choice paid the same way says nothing about payment", async ({ page }) => {
  const state = await openWaiting(page, [offerRow()]);
  await button(card(page), "Choose another way to run it").click();
  await dialog(page).getByRole("radio", { name: /claude-sonnet/ }).check();
  await expect(dialog(page).getByTestId("route-waiting-payment"))
    .toHaveCount(0);
  await expect(button(dialog(page), /^Continue with claude-sonnet/))
    .toBeEnabled();
  expect(state.admits).toEqual([]);
});

test("a choice paid differently says so, names itself on the button and is sent once with the offer it saw", async ({ page }) => {
  const state = await openWaiting(page, [offerRow()]);
  await button(card(page), "Choose another way to run it").click();
  await dialog(page).getByRole("radio", { name: /gpt-5/ }).check();
  await expect(dialog(page).getByTestId("route-waiting-payment"))
    .toContainText(
      "This changes how the work is paid for: from the subscription on a machine to an API key, charged per use.",
    );
  await button(dialog(page), "Continue with gpt-5, an API key, charged per use")
    .click();
  await expect(page.getByTestId("route-waiting-notice")).toContainText(
    "Continuing with Claude Code with gpt-5. The step starts again.",
  );
  await expect(dialog(page)).toHaveCount(0);
  await expect(card(page)).toHaveCount(0);
  expect(state.admits).toHaveLength(1);
  expect(state.admits[0].key).toMatch(/^[0-9a-f-]{36}$/);
  expect(state.admits[0].body).toEqual({
    runStepId: stepId,
    incidentId,
    incidentGeneration: 2,
    targetRouteId: uuid(102),
    runVersion: 4,
  });
});

test("a target refused in the dialog keeps it open with the reason, and an answer that never arrived keeps the key", async ({ page }) => {
  let calls = 0;
  const state = await openWaiting(page, [offerRow()], async (route) => {
    calls += 1;
    if (calls === 1) {
      return await route.fulfill({
        status: 409,
        contentType: "application/problem+json",
        json: problemBody(409, "STATE_CONFLICT", "target_pricing_unavailable"),
      });
    }
    return await route.fulfill({
      status: 503,
      contentType: "application/problem+json",
      json: { ...problemBody(503, "UNAVAILABLE"), retryable: true },
    });
  });
  await button(card(page), "Choose another way to run it").click();
  await dialog(page).getByRole("radio", { name: /claude-haiku/ }).check();
  await button(dialog(page), /^Continue with claude-haiku/).click();
  await expect(dialog(page).getByTestId("route-waiting-problem")).toContainText(
    "Bakery has no price for that one, so it cannot hold a budget for it. Pick another.",
  );
  await expect(dialog(page)).toBeVisible();
  await button(dialog(page), /^Continue with claude-haiku/).click();
  await expect(dialog(page).getByTestId("route-waiting-problem")).toContainText(
    "Nothing was switched. Try again.",
  );
  await button(dialog(page), /^Continue with claude-haiku/).click();
  await expect.poll(() => state.admits.length).toBe(3);
  // A definite refusal ends its key; a lost answer keeps it for the retry.
  expect(state.admits[1].key).not.toBe(state.admits[0].key);
  expect(state.admits[2].key).toBe(state.admits[1].key);
});

test("a choice made on a stale offer closes the dialog and says nothing was switched", async ({ page }) => {
  await openWaiting(page, [offerRow()], async (route) => {
    await route.fulfill({
      status: 412,
      contentType: "application/problem+json",
      json: problemBody(412, "PRECONDITION_FAILED"),
    });
  });
  await button(card(page), "Choose another way to run it").click();
  await dialog(page).getByRole("radio", { name: /claude-sonnet/ }).check();
  await button(dialog(page), /^Continue with claude-sonnet/).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByTestId("route-waiting-notice")).toContainText(
    "This changed while you were choosing. Nothing was switched; the latest is shown.",
  );
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

for (const scheme of SCHEMES) {
  for (const [size, width, height] of SIZES) {
    test(`still: waiting card, ${size} ${scheme}`, async ({ page }) => {
      test.skip(STILLS === undefined, "BAKERY_STILLS_DIR is not set");
      test.setTimeout(laneBudgetMs(90_000));
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height });
      await openWaiting(page, [offerRow()]);
      await expect(card(page)).toBeVisible();
      await page.screenshot({
        path: `${STILLS}/waiting-card-${size}-${scheme}.png`,
        animations: "disabled",
      });
    });

    test(`still: dialog with nothing chosen, ${size} ${scheme}`, async ({ page }) => {
      test.skip(STILLS === undefined, "BAKERY_STILLS_DIR is not set");
      test.setTimeout(laneBudgetMs(90_000));
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height });
      await openWaiting(page, [offerRow()]);
      await button(card(page), "Choose another way to run it").click();
      await expect(dialog(page)).toBeVisible();
      await page.screenshot({
        path: `${STILLS}/dialog-none-${size}-${scheme}.png`,
        animations: "disabled",
      });
    });

    test(`still: dialog with one chosen and the payment notice, ${size} ${scheme}`, async ({ page }) => {
      test.skip(STILLS === undefined, "BAKERY_STILLS_DIR is not set");
      test.setTimeout(laneBudgetMs(90_000));
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height });
      await openWaiting(page, [offerRow()]);
      await button(card(page), "Choose another way to run it").click();
      await dialog(page).getByRole("radio", { name: /gpt-5/ }).check();
      await expect(dialog(page).getByTestId("route-waiting-payment"))
        .toBeVisible();
      await page.screenshot({
        path: `${STILLS}/dialog-chosen-${size}-${scheme}.png`,
        animations: "disabled",
      });
    });

    test(`still: a refusal in the dialog, ${size} ${scheme}`, async ({ page }) => {
      test.skip(STILLS === undefined, "BAKERY_STILLS_DIR is not set");
      test.setTimeout(laneBudgetMs(90_000));
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height });
      await openWaiting(page, [offerRow()], async (route) => {
        await route.fulfill({
          status: 409,
          contentType: "application/problem+json",
          json: problemBody(
            409,
            "STATE_CONFLICT",
            "target_pricing_unavailable",
          ),
        });
      });
      await button(card(page), "Choose another way to run it").click();
      await dialog(page).getByRole("radio", { name: /gpt-5/ }).check();
      await button(dialog(page), /^Continue with gpt-5/).click();
      await expect(dialog(page).getByTestId("route-waiting-problem"))
        .toBeVisible();
      await page.screenshot({
        path: `${STILLS}/dialog-refused-${size}-${scheme}.png`,
        animations: "disabled",
      });
    });
  }
}
