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
// run, and the card's chooser (UX revision 3) picks another way to run it.
// Bakery never switches by itself. The reads and the admit are mocked with the
// shapes of `routeContinuations.list`, `routeContinuations.admit` and
// `runs.get` (`waitingOnModel`).

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
  providerName: string;
  modelName: string;
  health: string;
  priced: boolean;
  estimatedIncrementalCost: string | null;
};
type Unavailable = {
  reason: string;
  count: number;
  harnesses?: { harness: string; count: number }[];
  routes?: {
    provider: string;
    model: string;
    providerName: string;
    modelName: string;
  }[];
};
type Offer = ReturnType<typeof offerRow>;

const target = (n: number, over: Partial<Target> = {}): Target => ({
  routeId: uuid(100 + n),
  provider: "anthropic",
  model: "claude-sonnet",
  harness: "claude_code",
  billingRoute: "subscription",
  providerName: "Anthropic",
  modelName: "claude-sonnet",
  health: "healthy",
  priced: true,
  estimatedIncrementalCost: null,
  ...over,
});

/** One step waiting on a model; `since` is how many seconds ago it began. */
const offerRow = (
  over: {
    since?: number;
    targets?: Target[];
    unavailable?: Unavailable[];
    nextCheckAt?: string | null;
  } = {},
) => ({
  runStepId: stepId,
  stepKey: "implement",
  incidentId,
  incidentGeneration: 2,
  sourceRouteId: uuid(40),
  source: {
    provider: "anthropic",
    model: "claude-opus",
    providerName: "Anthropic",
    modelName: "claude-opus",
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
  targets: over.targets ?? [
    target(1, { model: "claude-sonnet" }),
    target(2, {
      provider: "openai",
      model: "gpt-5",
      providerName: "OpenAI",
      modelName: "gpt-5",
      harness: "claude_code",
      billingRoute: "api_metered",
      health: "degraded",
    }),
    target(3, {
      model: "claude-haiku",
      modelName: "claude-haiku",
      health: "unverified",
    }),
  ],
  unavailable: over.unavailable ?? [
    {
      reason: "route_not_active",
      count: 1,
    },
    {
      reason: "different_harness",
      count: 1,
      harnesses: [{ harness: "codex", count: 1 }],
    },
  ],
});

type Admit = { key: string | undefined; body: Record<string, unknown> };
type Waiting = {
  offers: Offer[];
  /** What `runs.get` says; false once the incident has closed. */
  waiting: boolean;
  /** Every admit the page sent, in order. */
  admits: Admit[];
  /** Answers an admit instead of the default success. */
  reply?: (route: Route) => Promise<void>;
  /** The offers read answers 500 while this is true. */
  failRead?: boolean;
};

/** Serves the task and its run waiting on a model. */
async function openWaiting(
  page: Page,
  offers: Offer[],
  options: { failRead?: boolean } = {},
): Promise<Waiting> {
  const state: Waiting = {
    offers,
    waiting: offers.length > 0,
    admits: [],
    failRead: options.failRead,
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
      if (state.failRead) {
        return await problemReply(route, problemBody(500, "INTERNAL_ERROR"));
      }
      return await route.fulfill({
        json: { runId, offers: state.offers },
      });
    }
    const body = request.postDataJSON() as Record<string, unknown>;
    state.admits.push({ key: request.headers()["idempotency-key"], body });
    if (state.reply) return await state.reply(route);
    const chosen = state.offers[0].targets.find((one) =>
      one.routeId === body.targetRouteId
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

/** The in-page chooser is for desktop and tablet; the phone sheet has its own test. */
const inPageOnly = () =>
  test.skip(
    test.info().project.name === "mobile",
    "the phone gets the two-step sheet, proven by its own test",
  );

/** A problem answer as the server sends it (`application/problem+json`). */
const problemReply = (route: Route, body: ReturnType<typeof problemBody>) =>
  route.fulfill({
    status: body.status,
    contentType: "application/problem+json",
    body: JSON.stringify(body),
  });

const card = (page: Page) => page.getByTestId("route-waiting-card");
const chooser = (page: Page) => page.getByTestId("route-waiting-chooser");
const chooseButton = (page: Page) => page.getByTestId("route-waiting-choose");
const providerRow = (scope: Locator, key: string) =>
  scope.locator(`[data-provider="${key}"] button`);
const modelRadio = (scope: Locator, name: string) =>
  scope.getByRole("radio", { name, exact: true });

const SECOND_LINE =
  "Bakery has not moved this work anywhere else. It tries the step again with the same model, and the waiting ends when a try works.";

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
  await expect(card(page)).toContainText("Bakery also checks Anthropic at");
  await expect(card(page)).not.toContainText("checks again");
  await expect(chooseButton(page)).toHaveText("Choose another way to run it");
  // The run says so too: the badge, and the step's own row.
  await expect(page.getByText("Waiting on a model", { exact: true }))
    .toBeVisible();
  await expect(page.getByText(
    "Waiting on Claude Code with claude-opus. Bakery tries it again with the same model.",
  )).toBeVisible();
  const results = await new AxeBuilder({ page })
    .include('[data-testid="route-waiting"]')
    .analyze();
  expect(results.violations).toEqual([]);
});

test("with no next check the card drops its last sentence", async ({ page }) => {
  await openWaiting(page, [offerRow({ nextCheckAt: null })]);
  await expect(card(page)).toContainText(SECOND_LINE);
  await expect(card(page)).not.toContainText("also checks Anthropic");
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
      targets: [],
      unavailable: [{
        reason: "route_open",
        count: 1,
        routes: [{
          provider: "anthropic",
          model: "claude-sonnet",
          providerName: "Anthropic",
          modelName: "claude-sonnet",
        }],
      }],
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

test("the chooser opens under the card, closes with Escape or its button, and focus returns", async ({ page }) => {
  inPageOnly();
  await openWaiting(page, [offerRow()]);
  await chooseButton(page).click();
  await expect(chooser(page)).toBeVisible();
  await expect(chooseButton(page)).toHaveText("Close the choices");
  await expect(chooseButton(page)).toHaveAttribute("aria-expanded", "true");
  await expect(chooser(page)).toContainText(
    "This step stays on Claude Code. Choose a provider, then a model. Now: Anthropic, claude-opus, the subscription on a machine.",
  );
  // It opens on Suggested with nothing chosen and Continue disabled.
  await expect(providerRow(chooser(page), "@suggested")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByTestId("route-waiting-summary")).toHaveText(
    "Nothing chosen yet.",
  );
  await expect(page.getByTestId("route-waiting-continue")).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(chooser(page)).toHaveCount(0);
  await expect(chooseButton(page)).toBeFocused();
  await chooseButton(page).click();
  await expect(chooser(page)).toBeVisible();
  await chooseButton(page).click();
  await expect(chooser(page)).toHaveCount(0);
  await expect(chooseButton(page)).toHaveText("Choose another way to run it");
  await chooseButton(page).click();
  await chooser(page).getByRole("button", { name: "Keep waiting" }).click();
  await expect(chooser(page)).toHaveCount(0);
  await expect(chooseButton(page)).toBeFocused();
});

test("choosing a provider, then a model, names it and says the payment changes", async ({ page }) => {
  inPageOnly();
  await openWaiting(page, [offerRow()]);
  await chooseButton(page).click();
  // Suggested holds only the Working route paid the same way.
  await expect(modelRadio(chooser(page), "claude-sonnet")).toBeVisible();
  await expect(modelRadio(chooser(page), "gpt-5")).toHaveCount(0);
  await providerRow(chooser(page), "openai").click();
  await modelRadio(chooser(page), "gpt-5").check();
  await expect(page.getByTestId("route-waiting-summary")).toHaveText(
    "OpenAI · gpt-5 · Charged per use to an API key",
  );
  await expect(page.getByTestId("route-waiting-payment")).toHaveText(
    "This changes how the work is paid for: from the subscription on a machine to an API key charged per use.",
  );
  await expect(page.getByTestId("route-waiting-continue")).toHaveText(
    "Continue with gpt-5",
  );
  // Anthropic: Working first, then Not tried yet; same payment, no notice.
  await providerRow(chooser(page), "anthropic").click();
  const rows = chooser(page).locator("[data-route-id]");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("claude-sonnet");
  await expect(rows.last()).toContainText("Not tried yet");
  await modelRadio(chooser(page), "claude-haiku").check();
  await expect(page.getByTestId("route-waiting-payment")).toHaveCount(0);
  const results = await new AxeBuilder({ page })
    .include('[data-testid="route-waiting"]')
    .analyze();
  expect(results.violations).toEqual([]);
});

test("search finds models across providers, says how many, and can be cleared", async ({ page }) => {
  inPageOnly();
  await openWaiting(page, [offerRow()]);
  await chooseButton(page).click();
  await page.keyboard.press("/");
  await expect(page.getByTestId("route-waiting-search")).toBeFocused();
  await page.keyboard.type("claude");
  await expect(chooser(page)).toContainText(
    '2 models match "claude" across 1 provider.',
  );
  await expect(
    chooser(page).getByRole("columnheader", {
      name: "Provider",
      exact: true,
    }),
  ).toHaveCount(1);
  await expect(chooser(page).locator("[data-route-id]")).toHaveCount(2);
  await page.getByTestId("route-waiting-search").fill("llama");
  await expect(page.getByTestId("route-waiting-search-none")).toContainText(
    'No models match "llama".',
  );
  await chooser(page).getByRole("button", { name: "Clear search" }).click();
  await expect(page.getByTestId("route-waiting-search")).toHaveValue("");
  await expect(modelRadio(chooser(page), "claude-sonnet")).toBeVisible();
});

test("routes that cannot be used are counts, one line per reason", async ({ page }) => {
  inPageOnly();
  await openWaiting(page, [offerRow({
    unavailable: [
      {
        reason: "route_not_active",
        count: 2,
        routes: [{
          provider: "openai",
          model: "gpt-4.1",
          providerName: "OpenAI",
          modelName: "gpt-4.1",
        }, {
          provider: "mistral",
          model: "codestral",
          providerName: "Mistral",
          modelName: "codestral",
        }],
      },
      {
        reason: "different_harness",
        count: 3,
        harnesses: [{ harness: "codex", count: 2 }, {
          harness: "pi",
          count: 1,
        }],
      },
      {
        reason: "route_open",
        count: 1,
        routes: [{
          provider: "google",
          model: "gemini-pro",
          providerName: "Google",
          modelName: "gemini-pro",
        }],
      },
    ],
  })]);
  await chooseButton(page).click();
  const unavailable = page.getByTestId("route-waiting-unavailable");
  await expect(unavailable).toContainText("6 routes cannot be used");
  await unavailable.getByText("6 routes cannot be used").click();
  await expect(unavailable).toContainText(
    "Turned off in Settings, Providers.",
  );
  await expect(unavailable).not.toContainText("Turned off (");
  // The names wait behind "Show the 2".
  const turnedOff = page.getByTestId("route-waiting-turned-off");
  await expect(turnedOff.getByText("OpenAI gpt-4.1, Mistral codestral"))
    .toBeHidden();
  await turnedOff.getByText("Show the 2", { exact: true }).click();
  await expect(turnedOff.getByText("OpenAI gpt-4.1, Mistral codestral"))
    .toBeVisible();
  await expect(unavailable).toContainText(
    "A different coding agent (3): Codex 2, Pi 1",
  );
  await expect(unavailable).toContainText(
    "Not working right now (1): Google gemini-pro",
  );
});

test("Continue sends the choice once, with the offer it saw, and the card goes", async ({ page }) => {
  inPageOnly();
  const state = await openWaiting(page, [offerRow()]);
  await chooseButton(page).click();
  await modelRadio(chooser(page), "claude-sonnet").check();
  await page.getByTestId("route-waiting-continue").click();
  await expect(page.getByTestId("route-waiting-notice")).toContainText(
    "Continuing with Claude Code with claude-sonnet. The step starts again.",
  );
  expect(state.admits).toHaveLength(1);
  expect(state.admits[0].key).toBeTruthy();
  expect(state.admits[0].body).toMatchObject({
    runStepId: stepId,
    incidentId,
    incidentGeneration: 2,
    targetRouteId: uuid(101),
    runVersion: 4,
  });
  await expect(card(page)).toHaveCount(0);
});

test("a refused choice says why in the chooser; a lost answer retries with the same key", async ({ page }) => {
  inPageOnly();
  const state = await openWaiting(page, [offerRow()]);
  state.reply = (route) =>
    problemReply(
      route,
      problemBody(409, "STATE_CONFLICT", "target_pricing_unavailable"),
    );
  await chooseButton(page).click();
  await modelRadio(chooser(page), "claude-sonnet").check();
  await page.getByTestId("route-waiting-continue").click();
  await expect(page.getByTestId("route-waiting-problem")).toHaveText(
    "Bakery has no price for that one, so it cannot hold a budget for it. Pick another.",
  );
  await expect(chooser(page)).toBeVisible();
  state.reply = (route) =>
    problemReply(route, {
      ...problemBody(503, "DEPENDENCY_UNAVAILABLE"),
      retryable: true,
    });
  await page.getByTestId("route-waiting-continue").click();
  await expect(page.getByTestId("route-waiting-problem")).toHaveText(
    "Nothing was switched. Try again.",
  );
  await page.getByTestId("route-waiting-continue").click();
  await expect.poll(() => state.admits.length).toBe(3);
  expect(state.admits[0].key).not.toBe(state.admits[1].key);
  expect(state.admits[2].key).toBe(state.admits[1].key);
});

test("Enter on a model chooses it, as Space does", async ({ page }) => {
  inPageOnly();
  await openWaiting(page, [offerRow()]);
  await chooseButton(page).click();
  await providerRow(chooser(page), "openai").click();
  await modelRadio(chooser(page), "gpt-5").focus();
  await page.keyboard.press("Enter");
  await expect(modelRadio(chooser(page), "gpt-5")).toBeChecked();
  await expect(page.getByTestId("route-waiting-summary")).toHaveText(
    "OpenAI · gpt-5 · Charged per use to an API key",
  );
  // Enter chooses; it does not send the choice.
  await expect(chooser(page)).toBeVisible();
});

test("a failed read of the choices keeps the card and the badge, and Try again reads them", async ({ page }) => {
  const state = await openWaiting(page, [offerRow()], { failRead: true });
  await expect(card(page)).toHaveCount(1);
  await expect(card(page).getByRole("heading")).toHaveText(
    "Waiting: a step cannot reach its model",
  );
  await expect(page.getByTestId("route-waiting-load-failed")).toHaveText(
    "The details and the choices could not be loaded.",
  );
  await expect(page.getByText("Waiting on a model", { exact: true }).first())
    .toBeVisible();
  await expect(chooseButton(page)).toHaveCount(0);
  state.failRead = false;
  await card(page).getByRole("button", { name: "Try again" }).click();
  await expect(page.getByTestId("route-waiting-load-failed")).toHaveCount(0);
  await expect(chooseButton(page)).toBeVisible();
});

test("on a phone a failed read puts Try again on its own row under the text", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWaiting(page, [offerRow()], { failRead: true });
  const failed = page.getByTestId("route-waiting-load-failed");
  const retry = card(page).getByRole("button", { name: "Try again" });
  await expect(retry).toBeVisible();
  const text = (await failed.boundingBox())!;
  const button = (await retry.boundingBox())!;
  // Under the message, not beside it squeezing the text into a column.
  expect(button.y).toBeGreaterThanOrEqual(text.y + text.height);
  expect(text.width).toBeGreaterThan(button.width);
});

test("on a phone the chooser is a sheet in two steps: providers, then models", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWaiting(page, [offerRow()]);
  await chooseButton(page).click();
  await expect(chooser(page)).toBeVisible();
  await expect(providerRow(chooser(page), "openai")).toBeVisible();
  await expect(chooser(page).locator("[data-route-id]")).toHaveCount(0);
  await providerRow(chooser(page), "openai").click();
  await expect(modelRadio(chooser(page), "gpt-5")).toBeVisible();
  // The buttons stack full width, Continue first.
  await modelRadio(chooser(page), "gpt-5").check();
  const go = await page.getByTestId("route-waiting-continue").boundingBox();
  const keep = await chooser(page).getByRole("button", {
    name: "Keep waiting",
  }).boundingBox();
  expect(go!.y).toBeLessThan(keep!.y);
  expect(Math.abs(go!.width - keep!.width)).toBeLessThan(1);
  expect(Math.abs(go!.x - keep!.x)).toBeLessThan(1);
  await chooser(page).getByRole("button", { name: "‹ Providers" }).click();
  await expect(providerRow(chooser(page), "anthropic")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(chooser(page)).toHaveCount(0);
});

// ---- stills for design-ux's and QA's review (only when BAKERY_STILLS_DIR is set).
const STILLS = process.env.BAKERY_EVIDENCE_DIR ?? process.env.BAKERY_STILLS_DIR;
const SIZES = [["desktop", 1440, 900], ["phone", 390, 844]] as const;
const SCHEMES = ["light", "dark"] as const;
// Tall enough that the composer pinned to the bottom of the page covers neither
// the card nor the step's row in the timeline.
const TALL = { desktop: 1800, phone: 2400 } as const;
const CASES = [
  ["waiting-card", () => [offerRow()]],
  ["waiting-card-no-check", () => [offerRow({ nextCheckAt: null })]],
] as const;

/** A wider organization for the chooser stills: four providers, a dozen models. */
const wideOffer = () =>
  offerRow({
    targets: [
      target(1, { model: "claude-sonnet", modelName: "claude-sonnet" }),
      target(2, { model: "claude-haiku", modelName: "claude-haiku" }),
      target(3, {
        model: "claude-sonnet-long-context-preview-2026-10",
        modelName: "claude-sonnet-long-context-preview-2026-10",
        health: "unverified",
      }),
      ...["gpt-5", "gpt-5-mini", "gpt-5-nano"].map((model, index) =>
        target(10 + index, {
          provider: "openai",
          providerName: "OpenAI",
          model,
          modelName: model,
          billingRoute: index === 0 ? "subscription" : "api_metered",
          health: index === 2 ? "degraded" : "healthy",
        })
      ),
      ...["deepseek-r2", "llama-4-maverick", "qwen-3-coder"].map((
        model,
        index,
      ) =>
        target(20 + index, {
          provider: "openrouter",
          providerName: "OpenRouter",
          model,
          modelName: model,
          billingRoute: "api_metered",
          priced: index !== 1,
        })
      ),
      target(30, {
        provider: "local",
        providerName: "Local",
        model: "qwen-3-32b",
        modelName: "qwen-3-32b",
        billingRoute: "local",
      }),
    ],
    unavailable: [
      {
        reason: "route_not_active",
        count: 4,
        routes: [
          ["openai", "OpenAI", "gpt-4.1"],
          ["openai", "OpenAI", "o3"],
          ["mistral", "Mistral", "codestral"],
          ["xai", "xAI", "grok-4"],
        ].map(([provider, providerName, model]) => ({
          provider,
          model,
          providerName,
          modelName: model,
        })),
      },
      {
        reason: "different_harness",
        count: 7,
        harnesses: [{ harness: "codex", count: 5 }, {
          harness: "pi",
          count: 2,
        }],
      },
      {
        reason: "route_open",
        count: 1,
        routes: [{
          provider: "google",
          model: "gemini-pro",
          providerName: "Google",
          modelName: "gemini-pro",
        }],
      },
    ],
  });

/** Chooser stills: each opens the chooser and gets it into one state. */
const CHOOSER_CASES: readonly [
  string,
  "desktop" | "phone" | "both",
  (page: Page) => Promise<void>,
][] = [
  ["chooser-suggested", "desktop", async () => {}],
  ["chooser-chosen", "desktop", async (page) => {
    await providerRow(chooser(page), "openai").click();
    await modelRadio(chooser(page), "gpt-5-mini").check();
    await expect(page.getByTestId("route-waiting-payment")).toBeVisible();
  }],
  ["chooser-search", "both", async (page) => {
    await page.getByTestId("route-waiting-search").fill("qwen");
    await expect(chooser(page).locator("[data-route-id]")).toHaveCount(2);
  }],
  ["chooser-cannot", "desktop", async (page) => {
    await page.getByTestId("route-waiting-unavailable")
      .getByText("12 routes cannot be used").click();
    await expect(page.getByTestId("route-waiting-unavailable"))
      .toContainText("Codex 5");
    await page.getByTestId("route-waiting-turned-off")
      .getByText("Show the 4", { exact: true }).click();
    await expect(page.getByTestId("route-waiting-turned-off"))
      .toContainText("xAI grok-4");
  }],
  ["chooser-providers", "phone", async () => {}],
  ["chooser-models", "phone", async (page) => {
    await providerRow(chooser(page), "openai").click();
    await modelRadio(chooser(page), "gpt-5-mini").check();
    await expect(page.getByTestId("route-waiting-payment")).toBeVisible();
  }],
];

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
        await page.setViewportSize({ width, height: TALL[size] });
        await expect(page.getByText(
          "Waiting on Claude Code with claude-opus. Bakery tries it again with the same model.",
        )).toBeVisible();
        await page.screenshot({
          path: `${STILLS}/${name}-${size}-${scheme}.png`,
          animations: "disabled",
        });
      });
    }
  }
}

for (const scheme of SCHEMES) {
  for (const [size, width, height] of SIZES) {
    test(`still: choices-failed, ${size} ${scheme}`, async ({ page }) => {
      test.skip(STILLS === undefined, "BAKERY_STILLS_DIR is not set");
      test.setTimeout(laneBudgetMs(90_000));
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height });
      await openWaiting(page, [offerRow()], { failRead: true });
      await expect(page.getByTestId("route-waiting-load-failed"))
        .toBeVisible();
      await page.setViewportSize({ width, height: TALL[size] });
      await page.screenshot({
        path: `${STILLS}/choices-failed-${size}-${scheme}.png`,
        animations: "disabled",
      });
    });
  }
}

test("the OpenAI mark is drawn at twice the art size and overflows its slot without moving the name", async ({ page }) => {
  await openWaiting(page, [wideOffer()]);
  await chooseButton(page).click();
  await expect(chooser(page)).toBeVisible();
  const measure = (provider: string) =>
    chooser(page).locator(`.ui-provider-mark[data-provider="${provider}"]`)
      .evaluate((slot) => {
        const art = slot.querySelector("img");
        if (art === null) throw new Error("no art");
        const s = slot.getBoundingClientRect();
        const a = art.getBoundingClientRect();
        const clipped: string[] = [];
        for (
          let node: Element | null = slot.parentElement;
          node !== null &&
          node.getAttribute("data-testid") !== "route-waiting-chooser";
          node = node.parentElement
        ) {
          const box = node.getBoundingClientRect();
          // A scroll area that still holds the whole art does not clip it.
          const holdsArt = box.left <= a.left && box.right >= a.right &&
            box.top <= a.top && box.bottom >= a.bottom;
          if (getComputedStyle(node).overflow !== "visible" && !holdsArt) {
            clipped.push(node.tagName);
          }
        }
        return {
          slot: [s.width, s.height],
          art: [a.width, a.height],
          offset: [
            a.left + a.width / 2 - (s.left + s.width / 2),
            a.top + a.height / 2 - (s.top + s.height / 2),
          ],
          pointer: getComputedStyle(slot).pointerEvents,
          clipped,
        };
      });
  const openai = await measure("openai");
  expect(openai.slot).toEqual([24, 24]);
  expect(openai.art).toEqual([40, 40]);
  expect(Math.abs(openai.offset[0])).toBeLessThan(1);
  expect(Math.abs(openai.offset[1])).toBeLessThan(1);
  expect(openai.pointer).toBe("none");
  expect(openai.clipped).toEqual([]);
  const openrouter = await measure("openrouter");
  expect(openrouter.slot).toEqual([24, 24]);
  expect(openrouter.art).toEqual([20, 20]);
});

for (const scheme of SCHEMES) {
  for (const [size, width, height] of SIZES) {
    for (const [name, where, act] of CHOOSER_CASES) {
      if (where !== "both" && where !== size) continue;
      test(`still: ${name}, ${size} ${scheme}`, async ({ page }) => {
        test.skip(STILLS === undefined, "BAKERY_STILLS_DIR is not set");
        test.setTimeout(laneBudgetMs(90_000));
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({ width, height });
        await openWaiting(page, [wideOffer()]);
        await chooseButton(page).click();
        await expect(chooser(page)).toBeVisible();
        await act(page);
        if (size === "desktop") {
          await page.setViewportSize({ width, height: TALL[size] });
        }
        // The card at the top, the chooser under it.
        await card(page).evaluate((element) =>
          element.scrollIntoView({ block: "start" })
        );
        await page.screenshot({
          path: `${STILLS}/${name}-${size}-${scheme}.png`,
          animations: "disabled",
        });
      });
    }
  }
}
