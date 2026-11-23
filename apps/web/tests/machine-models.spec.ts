import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, type Request, test } from "@playwright/test";
import {
  MOCK_ORGANIZATION_ID,
  mockAuthenticatedSession,
} from "./helpers/mock-session.ts";

// #70 slice 4: the Models tab lists the models this machine may use, with one state each and, for an
// administrator, a switch; adding a model is a page with three sections. The server is stubbed at the
// API, so every request the page makes is recorded and checked.

// Evidence for the PR: with BAKERY_STILLS_DIR set, the final screen of every passing test is saved, light and dark.
test.afterEach(async ({ page }, testInfo) => {
  const dir = process.env.BAKERY_STILLS_DIR;
  if (!dir || testInfo.status !== "passed") return;
  const slug = testInfo.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "").slice(0, 60);
  for (const theme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: theme });
    await page.evaluate(
      (value) => document.documentElement.setAttribute("data-theme", value),
      theme,
    );
    await page.waitForTimeout(300);
    await page.screenshot({
      path: `${dir}/${slug}-${testInfo.project.name}-${theme}.png`,
    });
  }
});

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
  await page.route(
    `**/v1/organizations/${MOCK_ORGANIZATION_ID}/effective-access`,
    (r) =>
      r.fulfill(json({
        organizationId: MOCK_ORGANIZATION_ID,
        role: w.role,
        capabilities: [],
      })),
  );
  await page.route(`**/v1/workers/${MACHINE_ID}/**`, (r) => {
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
const row = (page: Page, model: string) =>
  models(page).locator("tr", { hasText: model });

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
        route({ model: "new", health: "unverified" }),
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
    await expect(row(page, "new")).toContainText("Not tried yet");
    await expect(row(page, "off")).toContainText("Turned off");
    // A model never tried is not claimed to have answered.
    await expect(row(page, "new")).not.toContainText("Answered");
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
  });

  test("a revoked model has a switch that cannot be pressed", async ({ page }) => {
    await open(page, world({ routes: [route({ status: "revoked" })] }));
    await expect(page.getByRole("switch", { name: "Use acme-large" }))
      .toBeDisabled();
  });

  test("someone who is not an administrator sees the list but cannot change it", async ({ page }) => {
    await open(page, world({ role: "developer", routes: [route()] }));
    await expect(row(page, "acme-large")).toBeVisible();
    await expect(page.getByRole("switch")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add a model" })).toHaveCount(
      0,
    );
    await expect(models(page)).toContainText(
      "Only administrators can change models.",
    );
  });

  test("with no models and a coding agent signed in, the tab offers to add one", async ({ page }) => {
    await open(page, world());
    await expect(models(page)).toContainText("No models yet");
    await expect(models(page)).toContainText(
      "Add the models this machine's coding agents may use.",
    );
    await page.getByRole("button", { name: "Add a model" }).click();
    await expect(page).toHaveURL(
      new RegExp(`/machines/${MACHINE_ID}/models/new$`),
    );
  });

  test("with no coding agent signed in, the tab says to sign in first", async ({ page }) => {
    await open(page, world({ bound: false }));
    await expect(models(page)).toContainText(
      "Sign in to a coding agent first.",
    );
    await expect(page.getByRole("button", { name: "Go to coding agents" }))
      .toBeVisible();
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
    await expect(models(page).locator("tbody tr")).toHaveCount(2);
    await expect(models(page)).not.toContainText("model-2");
    await page.getByRole("searchbox", { name: "Search by model" }).fill("");
    await page.getByLabel("Coding agent").selectOption("pi");
    await expect(models(page).locator("tbody tr")).toHaveCount(1);
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
    await expect(page.getByTestId("machine-model-new")).toContainText(
      "A model's details cannot be changed after it is added.",
    );
    await expect(page.getByTestId("machine-model-new")).toContainText(
      "Paying with an API key is not available yet.",
    );
    await fill(page, { model: "acme-small", region: "eu-west" });
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
  });

  test("another provider is typed in, and an empty form says what is missing", async ({ page }) => {
    const w = world({ routes: [route({ provider: "acme" })] });
    await open(page, w, `/machines/${MACHINE_ID}/models/new`);
    await page.getByRole("button", { name: "Add model" }).click();
    await expect(page.getByTestId("machine-model-new")).toContainText(
      "Choose a coding agent that is signed in.",
    );
    expect(w.creates).toHaveLength(0);
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
  });

  test("a coding agent that is not signed in cannot be chosen and offers its own sign-in", async ({ page }) => {
    await open(
      page,
      world({ bound: false }),
      `/machines/${MACHINE_ID}/models/new`,
    );
    await expect(page.getByRole("radio", { name: /Claude Code/ }))
      .toBeDisabled();
    await page.getByRole("button", { name: "Sign in to Claude Code" }).click();
    // The machine page takes the agent from the address and then clears it, so a reload does not
    // start another sign-in: the person ends on the machine page with a clean address.
    await expect(page).toHaveURL(new RegExp(`/machines/${MACHINE_ID}$`));
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
  });

  test("Cancel goes back to the tab without sending anything", async ({ page }) => {
    const w = world();
    await open(page, w, `/machines/${MACHINE_ID}/models/new`);
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page).toHaveURL(new RegExp(`/machines/${MACHINE_ID}/models$`));
    expect(w.creates).toHaveLength(0);
  });
});
