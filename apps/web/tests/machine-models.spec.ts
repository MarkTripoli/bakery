import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, type Request, test } from "@playwright/test";
import {
  MOCK_ORGANIZATION_ID,
  MOCK_PRINCIPAL_ID,
  mockAuthenticatedSession,
} from "./helpers/mock-session.ts";

// #70 slice 4: the Models tab lists the models this machine may use, with one state each and, for an
// administrator, a switch; adding a model is a page with three sections. The server is stubbed at the
// API, so every request the page makes is recorded and checked.

// Evidence for the PR: with BAKERY_STILLS_DIR set, a test saves the screen it has just checked, the whole
// page, light and dark, at 1440 wide on a desktop or the phone's own 390.
async function still(page: Page, name: string) {
  const dir = process.env.BAKERY_STILLS_DIR;
  if (!dir) return;
  const phone = test.info().project.name === "mobile";
  if (!phone) await page.setViewportSize({ width: 1440, height: 900 });
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.evaluate(
      (value) => document.documentElement.setAttribute("data-theme", value),
      theme,
    );
    // The whole page from its top: the window is made as tall as the page, so the sidebar and the
    // top bar frame it instead of being cut part-way down.
    const width = page.viewportSize()!.width;
    const tall = await page.evaluate(() => {
      for (const element of document.querySelectorAll("*")) {
        if (element.scrollTop) element.scrollTop = 0;
      }
      globalThis.scrollTo(0, 0);
      return Math.max(
        document.documentElement.scrollHeight,
        ...Array.from(document.querySelectorAll("main, [data-shell-main]"))
          .map((element) => element.scrollHeight),
      );
    });
    await page.setViewportSize({
      width,
      height: Math.min(Math.max(tall, 900), 4000),
    });
    await page.evaluate(() => globalThis.scrollTo(0, 0));
    await page.waitForTimeout(500);
    await page.screenshot({
      path: `${dir}/${name}-${phone ? "phone" : "desktop"}-${theme}.png`,
    });
  }
}

const MACHINE_ID = "00000000-0000-4000-8000-0000000000a1";
const BINDING_ID = "00000000-0000-4000-8000-0000000000b1";
const OTHER_BINDING_ID = "00000000-0000-4000-8000-0000000000b2";

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

const problem = (status: number, code: string, extra: object = {}) => ({
  status,
  contentType: "application/problem+json",
  body: JSON.stringify({
    type: "https://bakery.example/problems/x",
    title: "x",
    status,
    code,
    retryable: false,
    detail: "Refused.",
    requestId: "00000000-0000-4000-8000-00000000f001",
    traceId: "00000000000000000000000000000001",
    ...extra,
  }),
});

type Route = {
  id: string;
  provider: string;
  model: string;
  harness: "pi" | "claude_code" | "codex";
  status: "active" | "disabled" | "revoked";
  health: "healthy" | "degraded" | "open" | "unverified";
  workerBindingId: string | null;
  inferenceVerifiedAt: string | null;
  version: number;
};

type World = {
  role: "admin" | "developer";
  bound: boolean;
  routes: Route[];
  health: Record<string, { reason: string; reasonSince: string }>;
  updates: { request: Request; id: string; body: Record<string, string> }[];
  creates: { request: Request; body: Record<string, string> }[];
  /** The next update is refused with this status. */
  refuseUpdate: number | null;
  /** The next create is refused with this problem. */
  refuseCreate: { status: number; code: string; extra?: object } | null;
  /** Holds the answer about this machine's sign-ins until it is opened. */
  gate: Promise<void> | null;
  /** How many times the list of every model was asked for. */
  listCalls: number;
  /** While true, the read of this machine's sign-ins fails. */
  failBindings: boolean;
};

let nextRoute = 1;
const route = (over: Partial<Route> = {}): Route => ({
  id: `00000000-0000-4000-8000-0000000001${
    String(nextRoute++).padStart(2, "0")
  }`,
  provider: "acme",
  model: "acme-large",
  harness: "claude_code",
  status: "active",
  health: "healthy",
  workerBindingId: BINDING_ID,
  inferenceVerifiedAt: null,
  version: 3,
  ...over,
});

const wire = (r: Route) => ({
  id: r.id,
  provider: r.provider,
  endpoint: "https://api.acme.example/v1",
  region: null,
  model: r.model,
  harness: r.harness,
  billingRoute: "subscription",
  credentialLocation: "harness_host",
  status: r.status,
  health: r.health,
  incidentGeneration: 0,
  providerAccountId: null,
  workerBindingId: r.workerBindingId,
  incidentId: null,
  lastProbeAt: null,
  nextProbeAt: null,
  inferenceVerifiedAt: r.inferenceVerifiedAt,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  version: r.version,
});

function world(over: Partial<World> = {}): World {
  return {
    role: "admin",
    bound: true,
    routes: [],
    health: {},
    updates: [],
    creates: [],
    refuseUpdate: null,
    refuseCreate: null,
    gate: null,
    listCalls: 0,
    failBindings: false,
    ...over,
  };
}

function machine() {
  return {
    id: MACHINE_ID,
    principalId: "00000000-0000-4000-8000-0000000000a2",
    name: "fixture-host",
    os: "linux",
    architecture: "x86_64",
    capabilities: ["git", "shell", "web", "model", "claude"],
    toolchainVersions: {},
    slots: 2,
    status: "online",
    desiredMode: "accepting",
    connectivity: "online",
    readiness: "ready",
    readinessReason: null,
    failedCheckIds: [],
    lastHeartbeatAt: new Date().toISOString(),
    credentialGeneration: 1,
    archivedAt: null,
    cleanup: { state: "not_requested", requestedAt: null, confirmedAt: null },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    version: 1,
  };
}

const bindingWire = {
  id: BINDING_ID,
  workerHostId: MACHINE_ID,
  componentKey: "harness.claude",
  provider: "anthropic",
  billingRoute: "subscription",
  paymentMethodSupported: true,
  enabled: true,
  authMode: "host_native",
  credentialLocation: "harness_host",
  modelProviderAccountId: null,
  authGeneration: 1,
  lastCheckedAt: "2026-11-21T10:00:00.000Z",
  safeProblem: null,
};

async function open(
  page: Page,
  w: World,
  path = `/machines/${MACHINE_ID}/models`,
) {
  await mockAuthenticatedSession(page);
  if (w.role !== "admin") {
    // A member is a member in the corner of the screen too, not "Fixture Admin".
    await page.route("**/v1/me", (r) =>
      r.fulfill(json({
        principalId: MOCK_PRINCIPAL_ID,
        principalType: "human",
        displayName: "Fixture Developer",
        locale: "en",
        timeZone: null,
        direction: "ltr",
        catalogVersion: "2",
        twoFactorEnabled: false,
        email: "fixture-developer@example.test",
        backupCodesRemaining: null,
      })));
  }
  await page.route(
    `**/v1/organizations/${MOCK_ORGANIZATION_ID}/effective-access`,
    (r) =>
      r.fulfill(json({
        organizationId: MOCK_ORGANIZATION_ID,
        role: w.role,
        capabilities: [],
      })),
  );
  await page.route(`**/v1/workers/${MACHINE_ID}/**`, async (r) => {
    const url = new URL(r.request().url());
    if (url.pathname.endsWith("/dispatch-blockers")) {
      return r.fulfill(json({
        workerHostId: MACHINE_ID,
        reason: null,
        connectivity: "online",
        allBlocked: false,
        blockedCapabilities: [],
        failedChecks: [],
        credentialGeneration: 1,
        inventoryRevision: 1,
      }));
    }
    if (url.pathname.endsWith("/components")) {
      return r.fulfill(json({
        items: w.bound
          ? [{
            id: "00000000-0000-4000-8000-0000000000c0",
            componentKey: "harness.claude",
            paymentMethods: ["subscription"],
            kind: "harness",
            actualVersion: "1.0.0",
            actualDigest: null,
            installOwner: "external",
            adapterVersion: "1",
            availableVersion: null,
            channel: null,
            observedAt: "2026-01-01T00:00:00.000Z",
            maintenanceSupport: null,
          }]
          : [],
        nextCursor: null,
      }));
    }
    if (url.pathname.endsWith("/provider-bindings")) {
      if (w.role !== "admin") return r.fulfill(problem(403, "AUTH_FORBIDDEN"));
      if (w.gate !== null) await w.gate;
      if (w.failBindings) return r.fulfill(problem(500, "INTERNAL"));
      return r.fulfill(
        json({ items: w.bound ? [bindingWire] : [], nextCursor: null }),
      );
    }
    return r.fulfill(json({ items: [], nextCursor: null }));
  });
  await page.route(
    (url) => url.pathname === `/v1/workers/${MACHINE_ID}`,
    (r) => r.fulfill(json(machine())),
  );
  await page.route(
    (url) => url.pathname === "/v1/provider-routes",
    (r) => {
      if (r.request().method() === "POST") {
        const body = r.request().postDataJSON() as Record<string, string>;
        w.creates.push({ request: r.request(), body });
        if (w.refuseCreate !== null) {
          const refusal = w.refuseCreate;
          w.refuseCreate = null;
          return r.fulfill(
            problem(refusal.status, refusal.code, refusal.extra),
          );
        }
        const made = route({
          provider: body.provider,
          model: body.model,
          harness: body.harness as Route["harness"],
          health: "unverified",
          workerBindingId: body.workerBindingId,
          version: 1,
        });
        w.routes.unshift(made);
        return r.fulfill(json(wire(made), 201));
      }
      w.listCalls += 1;
      return r.fulfill(json({ items: w.routes.map(wire), nextCursor: null }));
    },
  );
  await page.route(
    (url) => /^\/v1\/provider-routes\/[^/]+\/health$/.test(url.pathname),
    (r) => {
      const id = new URL(r.request().url()).pathname.split("/")[3];
      const h = w.health[id];
      return r.fulfill(json({
        routeId: id,
        health: "degraded",
        reason: h?.reason ?? null,
        reasonSince: h?.reasonSince ?? null,
        consecutiveFailures: 1,
        consecutiveInferenceTrials: 0,
        evidenceWatermark: null,
        lastFailureAt: null,
        lastSuccessAt: null,
        lastProbeAt: null,
        nextProbeAt: null,
        probeLeaseExpiresAt: null,
        corroboration: "none",
        incidentId: null,
        incidentGeneration: 0,
        inferenceVerifiedAt: null,
        updatedAt: "2026-01-01T00:00:00.000Z",
      }));
    },
  );
  await page.route(
    (url) => /^\/v1\/provider-routes\/[^/]+$/.test(url.pathname),
    (r) => {
      const id = new URL(r.request().url()).pathname.split("/")[3];
      const body = r.request().postDataJSON() as Record<string, string>;
      w.updates.push({ request: r.request(), id, body });
      if (w.refuseUpdate !== null) {
        const status = w.refuseUpdate;
        w.refuseUpdate = null;
        return r.fulfill(problem(status, "PRECONDITION_FAILED"));
      }
      const found = w.routes.find((entry) => entry.id === id)!;
      found.status = body.status as Route["status"];
      found.version += 1;
      return r.fulfill(json(wire(found)));
    },
  );
  await page.goto(path);
}

const models = (page: Page) => page.getByTestId("machine-models");
// A row is a table row on a desktop and a list row on a phone: both carry the model's id.
const row = (page: Page, model: string) =>
  models(page).locator("[data-model-id]", { hasText: model });
const onPhone = () => test.info().project.name === "mobile";

test.describe("machine page: Models tab", () => {
  test("a tab bar leads from the overview to the models this machine may use", async ({ page }) => {
    const w = world({ routes: [route()] });
    await open(page, w, `/machines/${MACHINE_ID}`);
    await expect(page.getByRole("tab", { name: "Overview" })).toBeVisible();
    await page.getByRole("tab", { name: "Models" }).click();
    await expect(page).toHaveURL(new RegExp(`/machines/${MACHINE_ID}/models$`));
    await expect(models(page)).toContainText(
      "Work on this machine is sent only to the models listed here. Bakery never picks a different model or a different way to pay by itself.",
    );
    await expect(row(page, "acme-large")).toContainText("Working");
    await expect(row(page, "acme-large")).toContainText("Claude Code");
    await expect(row(page, "acme-large")).toContainText("Subscription");
    await still(page, "models-tab");
  });

  test("only this machine's own models are listed", async ({ page }) => {
    const w = world({
      routes: [
        route({ model: "mine" }),
        route({ model: "someone-elses", workerBindingId: OTHER_BINDING_ID }),
        route({ model: "no-sign-in", workerBindingId: null }),
      ],
    });
    await open(page, w);
    await expect(row(page, "mine")).toBeVisible();
    await expect(models(page)).not.toContainText("someone-elses");
    await expect(models(page)).not.toContainText("no-sign-in");
    await still(page, "models-own-only");
  });

  test("each state has its own word, and a model in trouble says why and since when", async ({ page }) => {
    const trouble = route({ model: "wobbly", health: "degraded" });
    const w = world({
      routes: [
        route({
          model: "fine",
          health: "healthy",
          inferenceVerifiedAt: "2026-11-21T10:00:00.000Z",
        }),
        trouble,
        route({ model: "down", health: "open" }),
        route({ model: "fresh", health: "unverified" }),
        route({ model: "off", status: "disabled" }),
      ],
      health: {
        [trouble.id]: {
          reason: "rate_limited",
          reasonSince: "2026-11-21T09:00:00.000Z",
        },
      },
    });
    await open(page, w);
    await expect(row(page, "fine")).toContainText("Working");
    await expect(row(page, "fine")).toContainText("Answered");
    await expect(row(page, "wobbly")).toContainText("Having trouble");
    await expect(row(page, "wobbly")).toContainText(
      "The provider is limiting requests, since",
    );
    await expect(row(page, "down")).toContainText("Stopped by an outage");
    await expect(row(page, "fresh")).toContainText("Not tried yet");
    await expect(row(page, "off")).toContainText("Turned off");
    // A model never tried is not claimed to have answered.
    await expect(row(page, "fresh")).not.toContainText("Answered");
    // Provider, coding agent and how it is paid: in columns on a desktop, in one muted line on a phone.
    if (onPhone()) {
      await expect(row(page, "fine")).toContainText(
        "acme · Claude Code · Subscription",
      );
      // Every row's switch is in one place: at the right edge, under the badge.
      const edges = [];
      for (const name of ["fine", "wobbly", "down"]) {
        const found = await row(page, name).getByRole("switch").boundingBox();
        edges.push(Math.round(found!.x + found!.width));
      }
      expect(new Set(edges).size).toBe(1);
    } else {
      // The model column takes the spare width, so a note does not wrap to three lines.
      const cell = row(page, "wobbly").locator("td").first();
      expect((await cell.boundingBox())!.width).toBeGreaterThan(300);
      // A turned-off row is quiet.
      await expect(row(page, "off")).toHaveAttribute("data-muted", "true");
    }
    await still(page, "models-states");
  });

  test("an administrator turns a model off with the last version it read, and is told what that means", async ({ page }) => {
    const w = world({ routes: [route({ model: "acme-large", version: 7 })] });
    await open(page, w);
    await page.getByRole("switch", { name: "Use acme-large" }).click();
    await expect.poll(() => w.updates.length).toBe(1);
    expect(w.updates[0].body).toEqual({ status: "disabled" });
    expect(w.updates[0].request.headers()["if-match"]).toBe('"v7"');
    expect(w.updates[0].request.headers()["idempotency-key"]).toBeTruthy();
    await expect(row(page, "acme-large")).toContainText("Turned off");
    await expect(models(page)).toContainText(
      "Turned off. New work is not sent to acme-large.",
    );
    await still(page, "models-turned-off");
    // And back on.
    await page.getByRole("switch", { name: "Use acme-large" }).click();
    await expect.poll(() => w.updates.length).toBe(2);
    expect(w.updates[1].body).toEqual({ status: "active" });
    await expect(row(page, "acme-large")).toContainText("Working");
  });

  test("a model someone else changed says so and shows the latest state", async ({ page }) => {
    const w = world({ routes: [route()], refuseUpdate: 412 });
    await open(page, w);
    await page.getByRole("switch", { name: "Use acme-large" }).click();
    await expect(models(page)).toContainText(
      "Someone else changed this model. The latest state is shown.",
    );
    await expect(row(page, "acme-large")).toContainText("Working");
    await still(page, "models-changed-by-someone");
  });

  test("a model removed for good says so and has no switch", async ({ page }) => {
    await open(
      page,
      world({
        routes: [route({ status: "revoked" }), route({ model: "kept" })],
      }),
    );
    const removed = row(page, "acme-large");
    await expect(removed).toContainText("Turned off for good");
    await expect(removed).toContainText(
      "It cannot be turned on again. Add it as a new model to use it.",
    );
    // A switch that cannot be pressed is not shown; a model that is only turned on keeps its own.
    await expect(removed.getByRole("switch")).toHaveCount(0);
    await expect(row(page, "kept").getByRole("switch")).toBeVisible();
    if (!onPhone()) await expect(removed).toHaveAttribute("data-muted", "true");
    await still(page, "models-revoked");
  });

  test("a member sees one line and no table, and never the models of other machines", async ({ page }) => {
    const w = world({
      role: "developer",
      routes: [
        route({ model: "mine" }),
        route({ model: "someone-elses", workerBindingId: OTHER_BINDING_ID }),
        // The same coding agent on another machine: the old fallback listed this one.
        route({ model: "same-agent-elsewhere", workerBindingId: null }),
      ],
    });
    await open(page, w);
    await expect(models(page)).toHaveText(
      "Only administrators can see this machine's models.",
    );
    await expect(page.locator("[data-model-id]")).toHaveCount(0);
    await expect(page.getByRole("switch")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add a model" })).toHaveCount(
      0,
    );
    // The sentence cannot stand over no list, and the list of everything is never asked for.
    await expect(page.getByText("Work on this machine is sent only to"))
      .toHaveCount(0);
    expect(w.listCalls).toBe(0);
    await still(page, "models-not-admin");
  });

  test("while this machine's sign-ins are read, no list is drawn, never a guess", async ({ page }) => {
    let open_!: () => void;
    const gate = new Promise<void>((resolve) => (open_ = resolve));
    const w = world({
      gate,
      routes: [
        route({ model: "mine" }),
        route({ model: "someone-elses", workerBindingId: OTHER_BINDING_ID }),
      ],
    });
    await open(page, w);
    await expect(page.getByText("Loading").first()).toBeVisible();
    await expect(page.locator("[data-model-id]")).toHaveCount(0);
    await expect(page.getByText("someone-elses")).toHaveCount(0);
    open_();
    await expect(row(page, "mine")).toBeVisible();
    await expect(page.getByText("someone-elses")).toHaveCount(0);
  });

  test("the button to add a model ends the sentence's row on a desktop and sits under it on a phone", async ({ page }) => {
    await open(page, world({ routes: [route()] }));
    const sentence = await page.getByText(
      "Work on this machine is sent only to",
    )
      .boundingBox();
    const button = await page.getByRole("button", { name: "Add a model" })
      .boundingBox();
    if (onPhone()) {
      expect(button!.y).toBeGreaterThan(sentence!.y + sentence!.height);
    } else {
      expect(button!.y).toBeLessThan(sentence!.y + sentence!.height);
      expect(button!.x).toBeGreaterThan(sentence!.x + sentence!.width);
    }
  });

  test("with no models and a coding agent signed in, the tab offers to add one", async ({ page }) => {
    await open(page, world());
    await expect(models(page)).toContainText("No models yet");
    await expect(models(page)).toContainText(
      "Add the models this machine's coding agents may use.",
    );
    await still(page, "models-empty");
    await page.getByRole("button", { name: "Add a model" }).click();
    await expect(page).toHaveURL(
      new RegExp(`/machines/${MACHINE_ID}/models/new$`),
    );
  });

  test("with no coding agent signed in, the tab says there are no models and where to go", async ({ page }) => {
    await open(page, world({ bound: false }));
    await expect(models(page)).toContainText("No models yet");
    await expect(models(page)).toContainText(
      "A model is added for a coding agent that is signed in on this machine.",
    );
    // The banner above the tabs is the page's one statement that an agent is not signed in.
    await expect(models(page)).not.toContainText(
      "Sign in to a coding agent first.",
    );
    await expect(page.getByRole("button", { name: "Go to coding agents" }))
      .toBeVisible();
    await still(page, "models-sign-in-first");
  });

  test("more than ten models bring a search and a filter by coding agent", async ({ page }) => {
    const many = Array.from({ length: 11 }, (_, index) =>
      route({
        model: `model-${index}`,
        harness: index === 0 ? "pi" : "claude_code",
      }));
    await open(page, world({ routes: many }));
    await page.getByRole("searchbox", { name: "Search by model" }).fill(
      "model-1",
    );
    // "model-1" also matches "model-10", so the rows left are counted rather than named.
    await expect(models(page).locator("[data-model-id]")).toHaveCount(2);
    await expect(models(page)).not.toContainText("model-2");
    if (onPhone()) {
      // On a phone the search and the filter each have the whole column, like every other field.
      const column = (await models(page).getByTestId("machine-models-filters")
        .boundingBox())!.width;
      const search = (await page.getByRole("searchbox", {
        name: "Search by model",
      }).boundingBox())!.width;
      // The visible control is the filter's own box, not the select inside it.
      const filter = (await models(page).locator(".ui-combobox--filter")
        .boundingBox())!.width;
      expect(search).toBeGreaterThanOrEqual(column - 2);
      expect(filter).toBeGreaterThanOrEqual(column - 2);
    }
    await still(page, "models-search-and-filter");
    await page.getByRole("searchbox", { name: "Search by model" }).fill("");
    await page.getByLabel("Coding agent").selectOption("pi");
    await expect(models(page).locator("[data-model-id]")).toHaveCount(1);
  });

  test("has no accessibility violations", async ({ page }) => {
    await open(
      page,
      world({ routes: [route(), route({ model: "second", health: "open" })] }),
    );
    await expect(row(page, "second")).toBeVisible();
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
});

test.describe("machine page: Add a model", () => {
  const fill = async (page: Page, over: Record<string, string> = {}) => {
    await page.getByRole("radio", { name: /Claude Code/ }).check();
    await page.locator("#machine-model-provider").selectOption({
      label: "acme",
    });
    await page.getByLabel(/^Model\*?$/).fill(
      over.model ?? "acme-large",
    );
    await page.getByLabel("Provider address").fill(
      over.endpoint ?? "https://api.acme.example/v1",
    );
    if (over.region) {
      await page.getByLabel("Region (optional)").fill(over.region);
    }
  };

  test("saving sends the agent's own sign-in and lands on the tab with the new model marked Not tried yet", async ({ page }) => {
    const w = world({ routes: [route({ provider: "acme" })] });
    await open(page, w, `/machines/${MACHINE_ID}/models/new`);
    await expect(page.getByText(
      "Say which model a coding agent on this machine may use. Nothing is charged or switched by adding it.",
    )).toBeVisible();
    if (!onPhone()) {
      // One narrow column, and the short fields are 320 wide, not the whole column.
      const column = await page.getByTestId("machine-model-new-page")
        .boundingBox();
      expect(column!.width).toBeLessThanOrEqual(680);
      for (const id of ["#machine-model-name", "#machine-model-region"]) {
        expect((await page.locator(id).boundingBox())!.width)
          .toBeLessThanOrEqual(320);
      }
    }
    await expect(page.getByText("The model's exact name at the provider."))
      .toBeVisible();
    await expect(page.getByText(
      "Leave empty unless the provider has regional addresses.",
    )).toBeVisible();
    // With no coding agent chosen, section 3 says once that an API key is not available yet.
    await expect(page.getByText("Paying with an API key is not available yet."))
      .toHaveCount(1);
    if (onPhone()) {
      // On a phone every field has the column.
      const address = (await page.locator("#machine-model-endpoint")
        .boundingBox())!.width;
      for (const id of ["#machine-model-name", "#machine-model-region"]) {
        expect((await page.locator(id).boundingBox())!.width)
          .toBeGreaterThanOrEqual(address - 1);
      }
    }
    await expect(page.getByTestId("machine-model-new")).toContainText(
      "A model's details cannot be changed after it is added.",
    );
    await expect(page.getByTestId("machine-model-new")).toContainText(
      "Paying with an API key is not available yet.",
    );
    await fill(page, { model: "acme-small", region: "eu-west" });
    await still(page, "add-model-form");
    await page.getByRole("button", { name: "Add model" }).click();
    await expect.poll(() => w.creates.length).toBe(1);
    expect(w.creates[0].body).toEqual({
      provider: "acme",
      endpoint: "https://api.acme.example/v1",
      model: "acme-small",
      harness: "claude_code",
      billingRoute: "subscription",
      credentialLocation: "harness_host",
      region: "eu-west",
      workerBindingId: BINDING_ID,
    });
    expect(w.creates[0].request.headers()["idempotency-key"]).toBeTruthy();
    await expect(page).toHaveURL(
      new RegExp(`/machines/${MACHINE_ID}/models\\?added=true$`),
    );
    await expect(models(page)).toContainText("Added.");
    await expect(row(page, "acme-small")).toContainText("Not tried yet");
    // "Added." sits under the list with the other notices, not above it.
    const added = await models(page).getByText("Added.").boundingBox();
    const listed = await row(page, "acme-small").boundingBox();
    expect(added!.y).toBeGreaterThan(listed!.y);
    await still(page, "add-model-saved");
  });

  test("another provider is typed in, and an empty form says what is missing", async ({ page }) => {
    const w = world({ routes: [route({ provider: "acme" })] });
    await open(page, w, `/machines/${MACHINE_ID}/models/new`);
    await page.getByRole("button", { name: "Add model" }).click();
    await expect(page.getByTestId("machine-model-new")).toContainText(
      "Choose a coding agent that is signed in.",
    );
    expect(w.creates).toHaveLength(0);
    // Every error wears the error style, and Provider is marked required.
    await expect(page.locator(".ui-text--error", {
      hasText: "Choose a coding agent that is signed in.",
    })).toBeVisible();
    await expect(page.locator("#machine-model-provider")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await expect(page.locator(".ui-field__error").first()).toBeVisible();
    await expect(page.locator("label", { hasText: /^Provider\*/ }))
      .toBeVisible();
    await still(page, "add-model-empty-form-errors");
    await page.getByRole("radio", { name: /Claude Code/ }).check();
    await page.locator("#machine-model-provider").selectOption({
      label: "Another provider",
    });
    await page.getByLabel("Provider name").fill("newco");
    await page.getByLabel(/^Model\*?$/).fill("m1");
    await page.getByLabel("Provider address").fill("https://api.newco.example");
    await page.getByRole("button", { name: "Add model" }).click();
    await expect.poll(() => w.creates.length).toBe(1);
    expect(w.creates[0].body.provider).toBe("newco");
  });

  test("an address the server refuses is explained under the address", async ({ page }) => {
    const w = world({
      routes: [route({ provider: "acme" })],
      refuseCreate: {
        status: 422,
        code: "UNPROCESSABLE",
        extra: {
          issues: [{
            path: "/endpoint",
            code: "provider_endpoint_invalid",
            message: "Refused.",
          }],
        },
      },
    });
    await open(page, w, `/machines/${MACHINE_ID}/models/new`);
    await fill(page, { endpoint: "https://10.0.0.5/v1" });
    await page.getByRole("button", { name: "Add model" }).click();
    await expect(page.getByTestId("machine-model-new")).toContainText(
      "Use an https address on the public internet, with no password or query in it.",
    );
    await expect(page).toHaveURL(new RegExp(`/models/new$`));
    await still(page, "add-model-refused-address");
  });

  test("a plainly wrong address is caught before anything is sent", async ({ page }) => {
    const w = world({ routes: [route({ provider: "acme" })] });
    await open(page, w, `/machines/${MACHINE_ID}/models/new`);
    await fill(page, { endpoint: "http://api.acme.example" });
    await page.getByRole("button", { name: "Add model" }).click();
    await expect(page.getByTestId("machine-model-new")).toContainText(
      "Use an https address on the public internet, with no password or query in it.",
    );
    expect(w.creates).toHaveLength(0);
    await still(page, "add-model-wrong-address");
  });

  test("a coding agent that is not signed in cannot be chosen and offers its own sign-in", async ({ page }) => {
    await open(
      page,
      world({ bound: false }),
      `/machines/${MACHINE_ID}/models/new`,
    );
    await expect(page.getByRole("radio", { name: /Claude Code/ }))
      .toBeDisabled();
    await expect(page.getByRole("button", { name: "Sign in to Claude Code" }))
      .toBeVisible();
    if (!onPhone()) {
      // The button is its label's width, not the column's.
      const button = await page.getByRole("button", {
        name: "Sign in to Claude Code",
      }).boundingBox();
      expect(button!.width).toBeLessThan(400);
    }
    await still(page, "add-model-agent-not-signed-in");
    await page.getByRole("button", { name: "Sign in to Claude Code" }).click();
    // The machine page takes the agent from the address and then clears it, so a reload does not
    // start another sign-in: the person ends on the machine page with a clean address.
    await expect(page).toHaveURL(new RegExp(`/machines/${MACHINE_ID}$`));
  });

  test("while the sign-ins are read, no agent is shown as not signed in", async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await open(
      page,
      world({ gate, routes: [route({ provider: "acme" })] }),
      `/machines/${MACHINE_ID}/models/new`,
    );
    // The sign-ins are asked for only once the role and the machine are read: wait for that request, so the
    // assertions below run while the answer is held, not before the page has got that far.
    await page.waitForRequest((request) =>
      new URL(request.url()).pathname.endsWith("/provider-bindings")
    );
    await expect(page.getByText("Loading").first()).toBeVisible();
    await expect(page.getByText("Not signed in on this machine.")).toHaveCount(
      0,
    );
    await expect(page.getByRole("radio")).toHaveCount(0);
    await still(page, "add-model-loading");
    release();
    // Once they are read the signed-in agent can be chosen.
    await expect(page.getByRole("radio", { name: /Claude Code/ }))
      .toBeEnabled();
    await expect(page.getByText("Not signed in on this machine.")).toHaveCount(
      0,
    );
  });

  test("when the sign-ins cannot be read, the page says so and does not guess", async ({ page }) => {
    const w = world({
      failBindings: true,
      routes: [route({ provider: "acme" })],
    });
    await open(page, w, `/machines/${MACHINE_ID}/models/new`);
    await expect(page.getByText("This machine's details could not be loaded."))
      .toBeVisible();
    await expect(page.getByText("Not signed in on this machine.")).toHaveCount(
      0,
    );
    await expect(page.getByRole("radio")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add model" })).toHaveCount(
      0,
    );
    await still(page, "add-model-read-failed");
    // Try again reads them once more, and the form comes up.
    w.failBindings = false;
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("radio", { name: /Claude Code/ }))
      .toBeEnabled();
  });

  test("someone who is not an administrator is told they cannot add models", async ({ page }) => {
    await open(
      page,
      world({ role: "developer" }),
      `/machines/${MACHINE_ID}/models/new`,
    );
    await expect(page.getByText("Only administrators can add models."))
      .toBeVisible();
    await expect(page.getByRole("button", { name: "Add model" })).toHaveCount(
      0,
    );
    // The card has a way on.
    await still(page, "add-model-not-admin");
    await page.getByRole("button", { name: "Back to models" }).click();
    await expect(page).toHaveURL(new RegExp(`/machines/${MACHINE_ID}/models$`));
  });

  test("Cancel goes back to the tab without sending anything", async ({ page }) => {
    const w = world();
    await open(page, w, `/machines/${MACHINE_ID}/models/new`);
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page).toHaveURL(new RegExp(`/machines/${MACHINE_ID}/models$`));
    expect(w.creates).toHaveLength(0);
  });
});
