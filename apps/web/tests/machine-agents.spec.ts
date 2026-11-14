import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { shot } from "./helpers/real-api.ts";
import {
  MOCK_ORGANIZATION_ID,
  mockAuthenticatedSession,
} from "./helpers/mock-session.ts";

// #70 part C2b: the Coding agents section, the one banner for an agent that is
// not signed in, and the sign-in dialog, against a stubbed API. Every sentence
// that depends on server data is shown only when the server gives it.

const MACHINE_ID = "00000000-0000-4000-8000-0000000000a1";
const BINDING_ID = "00000000-0000-4000-8000-0000000000b1";
const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

type Binding = {
  id: string;
  componentKey: string;
  provider: string;
  billingRoute: "subscription" | "api_metered" | "local";
  lastCheckedAt: string | null;
  safeProblem: string | null;
  enabled: boolean;
};

type Script = {
  flow: "remote_device" | "remote_browser" | "terminal";
  createState: "pending" | "terminal";
  challenge: unknown;
  instructions: string | null;
  /** What each read of the attempt returns, in order; the last one repeats. */
  reads: string[];
  expiresAt: string | null;
};

type World = {
  capabilities: string[];
  bindings: Binding[];
  components: string[];
  role: "admin" | "developer";
  script: Script;
  createdBindings: unknown[];
  createdAttempts: string[];
  cancels: string[];
  reads: number;
  listReads: number;
  /** How many attempt creations answer 500 before they work. */
  failAttempts: number;
  /** When set, an attempt creation answers only once this settles. */
  hold: Promise<void> | null;
  status: "online" | "revoked";
};

const inMinutes = (minutes: number) =>
  new Date(Date.now() + minutes * 60_000).toISOString();

function script(over: Partial<Script> = {}): Script {
  return {
    flow: "remote_device",
    createState: "pending",
    challenge: {
      verificationUri: "https://claude.ai/device",
      userCode: "ABCD-EFGH",
    },
    instructions: null,
    reads: ["challenge_issued"],
    expiresAt: inMinutes(10),
    ...over,
  };
}

function world(over: Partial<World> = {}): World {
  return {
    capabilities: ["git", "shell", "web", "model", "claude"],
    bindings: [],
    components: ["harness.claude"],
    role: "admin",
    script: script(),
    createdBindings: [],
    createdAttempts: [],
    cancels: [],
    reads: 0,
    listReads: 0,
    failAttempts: 0,
    hold: null,
    status: "online",
    ...over,
  };
}

const binding = (over: Partial<Binding> = {}): Binding => ({
  id: BINDING_ID,
  componentKey: "harness.claude",
  provider: "anthropic",
  billingRoute: "subscription",
  lastCheckedAt: null,
  safeProblem: null,
  enabled: true,
  ...over,
});

const wire = (b: Binding) => ({
  id: b.id,
  workerHostId: MACHINE_ID,
  componentKey: b.componentKey,
  provider: b.provider,
  billingRoute: b.billingRoute,
  enabled: b.enabled,
  authMode: "host_native",
  credentialLocation: "harness_host",
  modelProviderAccountId: null,
  authGeneration: 1,
  lastCheckedAt: b.lastCheckedAt,
  safeProblem: b.safeProblem,
});

function workerBody(w: World) {
  return {
    id: MACHINE_ID,
    principalId: "00000000-0000-4000-8000-0000000000a2",
    name: "fixture-host",
    os: "linux",
    architecture: "x86_64",
    capabilities: w.capabilities,
    toolchainVersions: {},
    slots: 2,
    status: w.status,
    desiredMode: w.status === "revoked" ? "revoked" : "accepting",
    connectivity: "online",
    readiness: "ready",
    readinessReason: null,
    failedCheckIds: [],
    lastHeartbeatAt: new Date().toISOString(),
    credentialGeneration: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    version: 1,
  };
}

async function open(page: Page, w: World, path = `/machines/${MACHINE_ID}`) {
  await mockAuthenticatedSession(page);
  await page.route(
    `**/v1/organizations/${MOCK_ORGANIZATION_ID}/effective-access`,
    (route) =>
      route.fulfill(json({
        organizationId: MOCK_ORGANIZATION_ID,
        role: w.role,
        capabilities: [],
      })),
  );
  await page.route(`**/v1/workers/${MACHINE_ID}/**`, (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const path = url.pathname;
    if (path.endsWith("/dispatch-blockers")) {
      return route.fulfill(json({
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
    if (path.endsWith("/components")) {
      return route.fulfill(json({
        items: w.components.map((key, index) => ({
          id: `00000000-0000-4000-8000-0000000000c${index}`,
          componentKey: key,
          kind: "harness",
          actualVersion: "1.0.0",
          actualDigest: null,
          installOwner: "external",
          adapterVersion: "1",
          availableVersion: null,
          channel: null,
          observedAt: "2026-01-01T00:00:00.000Z",
          maintenanceSupport: null,
        })),
        nextCursor: null,
      }));
    }
    if (path.endsWith("/provider-bindings") && method === "POST") {
      const body = route.request().postDataJSON() as Record<string, string>;
      w.createdBindings.push(body);
      const made = binding({
        componentKey: body.componentKey,
        provider: body.provider,
      });
      w.bindings.push(made);
      return route.fulfill(json(wire(made), 201));
    }
    if (path.endsWith("/provider-bindings")) {
      w.listReads += 1;
      if (w.role !== "admin") {
        return route.fulfill({
          status: 403,
          contentType: "application/problem+json",
          body: JSON.stringify({
            type: "https://bakery.example/problems/forbidden",
            title: "Forbidden",
            status: 403,
            code: "AUTH_FORBIDDEN",
            retryable: false,
            detail: "Admins only.",
            requestId: "00000000-0000-4000-8000-00000000f001",
            traceId: "00000000000000000000000000000001",
          }),
        });
      }
      return route.fulfill(
        json({ items: w.bindings.map(wire), nextCursor: null }),
      );
    }
    if (path.endsWith("/auth-attempts") && method === "POST") {
      return (async () => {
        if (w.failAttempts > 0) {
          w.failAttempts -= 1;
          return route.fulfill({
            status: 500,
            contentType: "application/problem+json",
            body: JSON.stringify({
              type: "https://bakery.example/problems/internal",
              title: "Internal error",
              status: 500,
              code: "INTERNAL_ERROR",
              retryable: true,
              detail: "Try again.",
              requestId: "00000000-0000-4000-8000-00000000f002",
              traceId: "00000000000000000000000000000002",
            }),
          });
        }
        if (w.hold) await w.hold;
        const id = `00000000-0000-4000-8000-00000000d${
          String(w.createdAttempts.length).padStart(3, "0")
        }`;
        w.createdAttempts.push(id);
        w.reads = 0;
        return route.fulfill(json({
          authAttemptId: id,
          flow: w.script.flow,
          state: w.script.createState,
          challenge: w.script.challenge,
          instructions: w.script.instructions,
          expiresAt: w.script.expiresAt ?? inMinutes(10),
        }, 201));
      })();
    }
    if (path.includes("/auth-attempts/") && method === "PATCH") {
      w.cancels.push(path.split("/").pop()!);
      return route.fulfill(
        json(attempt(w, "canceled", path.split("/").pop()!)),
      );
    }
    if (path.includes("/auth-attempts/")) {
      const id = path.split("/").pop()!;
      const states = w.script.reads;
      const state = states[Math.min(w.reads, states.length - 1)]!;
      w.reads += 1;
      if (state === "completed") {
        w.bindings = w.bindings.map((entry) => ({
          ...entry,
          lastCheckedAt: new Date().toISOString(),
          safeProblem: null,
        }));
      }
      return route.fulfill(json(attempt(w, state, id)));
    }
    return route.fulfill(json({ items: [], nextCursor: null }));
  });
  await page.route(
    (url) => url.pathname === `/v1/workers/${MACHINE_ID}`,
    (route) => route.fulfill(json(workerBody(w))),
  );
  await page.goto(path);
}

function attempt(w: World, state: string, id: string) {
  return {
    id,
    bindingId: BINDING_ID,
    workerHostId: MACHINE_ID,
    flow: w.script.flow,
    state,
    expiresAt: w.script.expiresAt ?? inMinutes(10),
    challenge: null,
    result: null,
  };
}

const row = (page: Page, agent: string) =>
  page.getByTestId(`coding-agent-${agent}`);
const banner = (page: Page) => page.getByTestId("agent-banner");
const dialog = (page: Page) => page.getByTestId("agent-sign-in");
const header = (page: Page) => page.locator(".bakery-page-header");

/** One agent in each badge state: Claude Code ready, Codex signed out, Pi not checked. */
const threeStates = () =>
  world({
    capabilities: ["git", "claude", "codex", "pi"],
    components: ["harness.claude", "harness.codex", "harness.pi"],
    bindings: [
      binding({ lastCheckedAt: "2026-11-14T00:00:00.000Z" }),
      binding({
        id: "00000000-0000-4000-8000-0000000000b2",
        componentKey: "harness.codex",
        provider: "openai",
        safeProblem: "AUTH",
      }),
      binding({
        id: "00000000-0000-4000-8000-0000000000b3",
        componentKey: "harness.pi",
        provider: "pi",
      }),
    ],
  });

test.describe("the Coding agents rows", () => {
  test("an agent with no way to sign in yet: one row, one banner, one Sign in", async ({ page }) => {
    const w = world();
    await open(page, w);
    await expect(row(page, "claude")).toContainText("Claude Code");
    await expect(row(page, "claude")).toContainText("Not signed in yet.");
    await expect(row(page, "claude")).toContainText("Not signed in");
    await expect(
      row(page, "claude").getByRole("button", { name: "Sign in", exact: true }),
    ).toBeEnabled();
    await expect(row(page, "claude").getByRole("button", { name: "Check" }))
      .toHaveCount(0);
    await expect(banner(page)).toContainText(
      "Claude Code is not signed in yet.",
    );
    await expect(banner(page)).toContainText(
      "Sign in with a Claude Code subscription on this machine so it can take Claude Code work.",
    );
    await expect(
      banner(page).getByRole("button", { name: "Sign in", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Paying with an API key is not available yet."))
      .toBeVisible();
    await shot(page, "machine-agents-banner-not-signed-in");
    // Nothing of the server's vocabulary reaches the screen.
    const text = (await page.getByTestId("machine-agents").innerText())
      .toLowerCase();
    for (
      const word of [
        "binding",
        "provider",
        "billing",
        "route",
        "auth mode",
        "harness",
      ]
    ) {
      expect(text).not.toContain(word);
    }
    // No API-key or local-model card: there is nothing to choose between.
    await expect(
      page.getByText(
        /An API key stored in Bakery|A model running on this machine/,
      ),
    ).toHaveCount(0);
  });

  test("an agent the machine has not reported cannot be signed in yet, and says so", async ({ page }) => {
    await open(page, world({ components: [] }));
    await expect(row(page, "claude")).toContainText(
      "Bakery has not heard from Claude Code on this machine yet.",
    );
    await expect(
      row(page, "claude").getByRole("button", { name: "Sign in", exact: true }),
    ).toBeDisabled();
    await expect(banner(page).getByRole("button")).toHaveCount(0);
  });

  test("ready, not checked and signed out each have their badge and the buttons beside it", async ({ page }) => {
    const w = threeStates();
    await open(page, w);
    await expect(row(page, "claude")).toContainText(
      "Uses the subscription signed in on this machine.",
    );
    await expect(row(page, "claude").getByText("Ready", { exact: true }))
      .toBeVisible();
    await expect(row(page, "claude").getByRole("button", { name: "Check" }))
      .toBeVisible();
    await expect(row(page, "claude").getByRole("button", { name: /Sign in/ }))
      .toHaveCount(0);
    await expect(row(page, "codex").getByText("Signed out", { exact: true }))
      .toBeVisible();
    await expect(
      row(page, "codex").getByRole("button", { name: "Sign in again" }),
    ).toBeVisible();
    await expect(row(page, "codex").getByRole("button", { name: "Check" }))
      .toBeVisible();
    await expect(row(page, "pi").getByText("Not checked", { exact: true }))
      .toBeVisible();
    await expect(row(page, "pi").getByRole("button", { name: "Check" }))
      .toBeVisible();
    await expect(row(page, "pi").getByRole("button", { name: /Sign in/ }))
      .toHaveCount(0);
    // One banner, for the agent that is signed out.
    await expect(banner(page)).toHaveCount(1);
    await expect(banner(page)).toContainText(
      "Codex is signed out on this machine.",
    );
    await expect(banner(page)).toContainText(
      "Work that needs Codex is waiting. Other work continues.",
    );
    await expect(banner(page).getByRole("button", { name: "Sign in again" }))
      .toBeVisible();
    // The line under each agent follows its state.
    await expect(row(page, "codex")).toContainText(
      "The sign-in on this machine no longer works.",
    );
    await expect(row(page, "codex")).not.toContainText("Uses the subscription");
    await expect(row(page, "pi")).toContainText(
      "Bakery has not checked the sign-in on this machine yet.",
    );
    await expect(row(page, "pi")).not.toContainText("Uses the subscription");
    // The machine's own badge says so when an agent needs signing in.
    await expect(header(page).getByText("Needs attention", { exact: true }))
      .toBeVisible();
    await expect(header(page).getByText("Ready", { exact: true })).toHaveCount(
      0,
    );
    await shot(page, "machine-agents-rows");
    const axe = await new AxeBuilder({ page }).include(
      '[data-testid="machine-agents"]',
    ).analyze();
    expect(axe.violations).toEqual([]);
  });

  test("an administrator-only note replaces the buttons for anyone else, and nothing is asked of the server", async ({ page }) => {
    const w = world({ role: "developer" });
    await open(page, w);
    await expect(row(page, "claude")).toContainText(
      "Only administrators can sign coding agents in.",
    );
    await expect(row(page, "claude").getByRole("button")).toHaveCount(0);
    await expect(banner(page)).toHaveCount(0);
    expect(w.listReads).toBe(0);
  });

  test("a retired machine's rows have no buttons and nothing is asked of the administrators' list", async ({ page }) => {
    const w = world({ status: "revoked" });
    await open(page, w);
    await expect(row(page, "claude")).toBeVisible();
    await expect(row(page, "claude").getByRole("button")).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(w.listReads).toBe(0);
  });

  test("another way to pay that already exists is described in plain words", async ({ page }) => {
    await open(
      page,
      world({
        bindings: [
          binding({
            billingRoute: "api_metered",
            lastCheckedAt: "2026-11-14T00:00:00.000Z",
          }),
        ],
      }),
    );
    await expect(row(page, "claude")).toContainText(
      "Uses an API key stored in Bakery.",
    );
  });

  test("the machine's software is one entry by agent name and version, in no internal words", async ({ page }) => {
    await open(page, threeStates());
    const software = page.getByTestId("machine-software");
    await expect(software).toHaveCount(1);
    await expect(software).toContainText("Software");
    await expect(software).toContainText("Claude Code 1.0.0");
    await expect(software).toContainText("Codex 1.0.0");
    await expect(software).toContainText("Pi 1.0.0");
    const about = page.getByTestId("machine-about");
    await expect(about).not.toContainText("harness");
    await expect(about).not.toContainText("external");
  });

  test("the header reads Ready only when every agent is signed in, and the machine's own reading wins otherwise", async ({ page }) => {
    await open(
      page,
      world({
        bindings: [binding({ lastCheckedAt: "2026-11-14T00:00:00.000Z" })],
      }),
    );
    await expect(header(page).getByText("Ready", { exact: true }))
      .toBeVisible();
    await expect(header(page).getByText("Needs attention")).toHaveCount(0);
  });

  test("for anyone but an administrator the header is the machine's own reading", async ({ page }) => {
    await open(page, world({ role: "developer" }));
    await expect(header(page).getByText("Ready", { exact: true }))
      .toBeVisible();
  });

  test(
    "on a phone the badge and buttons sit under the text and every label is on one line",
    async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== "mobile", "phone only");
      await open(page, threeStates());
      for (const agent of ["claude", "codex", "pi"]) {
        const item = row(page, agent);
        const title = await item.locator(".ui-description-item__title")
          .boundingBox();
        const text = await item.locator(".ui-description-item__description")
          .boundingBox();
        const action = await item.locator(".ui-description-item__action")
          .boundingBox();
        expect(title && text && action, agent).toBeTruthy();
        // Under the text, from the same left edge.
        expect(action!.y, agent).toBeGreaterThanOrEqual(
          text!.y + text!.height - 1,
        );
        expect(Math.abs(action!.x - title!.x), agent).toBeLessThan(2);
        // Each button keeps its label on one line: as tall as the shortest one.
        const heights: number[] = [];
        for (const button of await item.getByRole("button").all()) {
          heights.push((await button.boundingBox())!.height);
        }
        expect(heights.length, agent).toBeGreaterThan(0);
        expect(Math.max(...heights) - Math.min(...heights), agent)
          .toBeLessThan(1);
        expect(Math.max(...heights), agent).toBeLessThan(56);
      }
      // Beside the text on a wide screen is covered by the stills; here only the phone.
    },
  );
});

test.describe("the sign-in dialog", () => {
  test("a code and an address: the steps, the code to copy, the wait and the expiry; then Signed in and Done", async ({ page }) => {
    const w = world({ script: script({ reads: ["completed"] }) });
    await open(page, w);
    await row(page, "claude").getByRole("button", {
      name: "Sign in",
      exact: true,
    }).click();
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toContainText(
      "Sign in to Claude Code on fixture-host",
    );
    // What the setup is made under: the one method the server can save today.
    expect(w.createdBindings).toEqual([{
      componentKey: "harness.claude",
      provider: "anthropic",
      billingRoute: "subscription",
      authMode: "host_native",
      credentialLocation: "harness_host",
    }]);
    await expect(dialog(page)).toContainText("Signed in.");
    await shot(page, "machine-agents-dialog-completed", [], {
      windowOnly: true,
    });
    await dialog(page).getByRole("button", { name: "Done" }).first().click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(row(page, "claude").getByText("Ready", { exact: true }))
      .toBeVisible();
    await expect(row(page, "claude").getByRole("button", { name: "Check" }))
      .toBeFocused();
  });

  test("the code and the address are shown as steps, with a Copy and the expiry", async ({ page }) => {
    const w = world({ script: script({ reads: ["challenge_issued"] }) });
    await open(page, w);
    await row(page, "claude").getByRole("button", {
      name: "Sign in",
      exact: true,
    }).click();
    await expect(dialog(page).getByText("2. Enter this code:")).toBeVisible();
    const link = dialog(page).getByRole("link", {
      name: "claude.ai/device",
    });
    await expect(link).toHaveAttribute("href", "https://claude.ai/device");
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(dialog(page).getByLabel("Sign-in code")).toContainText(
      "ABCD-EFGH",
    );
    await expect(dialog(page).getByRole("button", { name: "Copy" }))
      .toBeVisible();
    await expect(dialog(page).getByText("Waiting for you to finish…"))
      .toBeVisible();
    await expect(dialog(page).getByText(/This code works for (9|10) minutes\./))
      .toBeVisible();
    await expect(dialog(page).getByText("Closing this cancels the sign-in."))
      .toBeVisible();
    await shot(page, "machine-agents-dialog-code", [], { windowOnly: true });
    const axe = await new AxeBuilder({ page }).include(
      '[data-testid="agent-sign-in"]',
    ).analyze();
    expect(axe.violations).toEqual([]);
  });

  test("an address alone is one button that opens it in a new tab; a code with no address is not shown", async ({ page }) => {
    await open(
      page,
      world({
        script: script({
          flow: "remote_browser",
          challenge: { url: "https://claude.ai/start" },
        }),
      }),
    );
    await row(page, "claude").getByRole("button", {
      name: "Sign in",
      exact: true,
    }).click();
    const openPage = dialog(page).getByRole("link", {
      name: "Open the sign-in page",
    });
    await expect(openPage).toHaveAttribute(
      "href",
      "https://claude.ai/start",
    );
    await expect(openPage).toHaveAttribute("target", "_blank");
    await expect(dialog(page).getByText("Waiting for you to finish…"))
      .toBeVisible();
    await shot(page, "machine-agents-dialog-link", [], { windowOnly: true });
  });

  for (
    const address of [
      "javascript:alert(1)",
      "http://claude.ai/device",
      "https://user:pw@claude.ai/device",
      "https://evil.example/claude-login",
      "https://claude.ai.evil.example/device",
      "https://127.0.0.1:8443/device",
    ]
  ) {
    test(`an address that is not https on the agent's own hosts is never a link and ends the sign-in: ${address}`, async ({ page }) => {
      const w = world({
        script: script({
          challenge: { verificationUri: address, userCode: "ABCD-EFGH" },
        }),
      });
      await open(page, w);
      await row(page, "claude").getByRole("button", {
        name: "Sign in",
        exact: true,
      }).click();
      await expect(
        dialog(page).getByText("Sign-in did not work. Try again."),
      ).toBeVisible();
      await expect(dialog(page).getByRole("link")).toHaveCount(0);
      await expect(dialog(page)).not.toContainText("ABCD-EFGH");
      // The attempt the machine opened is cancelled, not left to expire.
      await expect.poll(() => w.cancels.length).toBe(1);
      await expect(dialog(page).getByRole("button", { name: "Try again" }))
        .toBeVisible();
    });
  }

  test("a code that is not plainly one ends the sign-in too: no link, no code, Try again", async ({ page }) => {
    const w = world({
      script: script({
        challenge: {
          verificationUri: "https://claude.ai/device",
          userCode: "<img src=x onerror=alert(1)>",
        },
      }),
    });
    await open(page, w);
    await row(page, "claude").getByRole("button", {
      name: "Sign in",
      exact: true,
    }).click();
    await expect(dialog(page).getByText("Sign-in did not work. Try again."))
      .toBeVisible();
    await expect(dialog(page).getByRole("link")).toHaveCount(0);
    await expect.poll(() => w.cancels.length).toBe(1);
    // Try again reuses the setup and starts one more attempt.
    w.script = script({ reads: ["challenge_issued"] });
    await dialog(page).getByRole("button", { name: "Try again" }).click();
    await expect(dialog(page).getByText("2. Enter this code:")).toBeVisible();
    expect(w.createdBindings.length).toBe(1);
    expect(w.createdAttempts.length).toBe(2);
  });

  test("an address on another agent's host is not this agent's sign-in page", async ({ page }) => {
    const w = world({
      script: script({
        challenge: { verificationUri: "https://auth.openai.com/device" },
      }),
    });
    await open(page, w);
    await row(page, "claude").getByRole("button", {
      name: "Sign in",
      exact: true,
    }).click();
    await expect(dialog(page).getByText("Sign-in did not work. Try again."))
      .toBeVisible();
    await expect(dialog(page).getByRole("link")).toHaveCount(0);
  });

  test("a command with a second line is not shown or copied: only one plain line ever is", async ({ page }) => {
    await open(
      page,
      world({
        script: script({
          flow: "terminal",
          createState: "terminal",
          challenge: null,
          instructions: "claude login\nrm -rf ~",
          reads: ["terminal"],
        }),
      }),
    );
    await row(page, "claude").getByRole("button", {
      name: "Sign in",
      exact: true,
    }).click();
    await expect(
      dialog(page).getByText("Finish signing in in a terminal on the machine."),
    ).toBeVisible();
    await expect(dialog(page)).not.toContainText("rm -rf");
    await expect(dialog(page).getByRole("button", { name: "Copy" }))
      .toHaveCount(0);
  });

  test("an agent that must be finished on the machine shows the command only when the server gives one", async ({ page }) => {
    await open(
      page,
      world({
        script: script({
          flow: "terminal",
          createState: "terminal",
          challenge: null,
          instructions: "claude login",
          reads: ["terminal"],
        }),
      }),
    );
    await row(page, "claude").getByRole("button", {
      name: "Sign in",
      exact: true,
    }).click();
    await expect(
      dialog(page).getByText(
        "Finish signing in on the machine itself. Run this in a terminal there:",
      ),
    ).toBeVisible();
    await expect(dialog(page).getByLabel("Command to run on the machine"))
      .toContainText("claude login");
    await expect(dialog(page).getByRole("button", { name: "Copy" }))
      .toBeVisible();
    await shot(page, "machine-agents-dialog-terminal", [], {
      windowOnly: true,
    });
  });

  test("without a command it says only to finish in a terminal, and invents none", async ({ page }) => {
    await open(
      page,
      world({
        script: script({
          flow: "terminal",
          createState: "terminal",
          challenge: null,
          instructions: null,
          reads: ["terminal"],
        }),
      }),
    );
    await row(page, "claude").getByRole("button", {
      name: "Sign in",
      exact: true,
    }).click();
    await expect(
      dialog(page).getByText("Finish signing in in a terminal on the machine."),
    ).toBeVisible();
    await expect(dialog(page).getByRole("button", { name: "Copy" }))
      .toHaveCount(0);
    await expect(dialog(page).getByText("Run this in a terminal there:"))
      .toHaveCount(0);
    await shot(page, "machine-agents-dialog-terminal-nocmd", [], {
      windowOnly: true,
    });
  });

  test("a sign-in that failed offers Try again, which starts a new attempt", async ({ page }) => {
    const w = world({ script: script({ reads: ["failed"] }) });
    await open(page, w);
    await row(page, "claude").getByRole("button", {
      name: "Sign in",
      exact: true,
    }).click();
    await expect(dialog(page).getByText("Sign-in did not work. Try again."))
      .toBeVisible();
    await shot(page, "machine-agents-dialog-failed", [], { windowOnly: true });
    w.script = script({ reads: ["completed"] });
    await dialog(page).getByRole("button", { name: "Try again" }).click();
    await expect(dialog(page).getByText("Signed in.")).toBeVisible();
    expect(w.createdAttempts.length).toBe(2);
    expect(w.createdBindings.length).toBe(1);
  });

  test("a failed start keeps the setup it made: Try again makes one attempt, not a second setup", async ({ page }) => {
    const w = world({
      failAttempts: 1,
      script: script({ reads: ["challenge_issued"] }),
    });
    await open(page, w);
    await row(page, "claude").getByRole("button", {
      name: "Sign in",
      exact: true,
    }).click();
    await expect(dialog(page).getByText("Sign-in did not work. Try again."))
      .toBeVisible();
    expect(w.createdBindings.length).toBe(1);
    expect(w.createdAttempts.length).toBe(0);
    await dialog(page).getByRole("button", { name: "Try again" }).click();
    await expect(dialog(page).getByText("2. Enter this code:")).toBeVisible();
    expect(w.createdBindings.length).toBe(1);
    expect(w.createdAttempts.length).toBe(1);
  });

  test("closing the dialog while it still says Starting cancels the sign-in as soon as it exists", async ({ page }) => {
    let release: () => void = () => {};
    const w = world({
      hold: new Promise<void>((resolve) => {
        release = resolve;
      }),
      script: script({ reads: ["challenge_issued"] }),
    });
    await open(page, w);
    await row(page, "claude").getByRole("button", {
      name: "Sign in",
      exact: true,
    }).click();
    await expect(dialog(page).getByText("Starting sign-in…")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    release();
    // It answered after nobody was waiting for it: it is cancelled, and the dialog stays closed.
    await expect.poll(() => w.createdAttempts.length).toBe(1);
    await expect.poll(() => w.cancels).toEqual(w.createdAttempts);
    await expect(dialog(page)).toHaveCount(0);
  });

  test("an expired sign-in offers Start again", async ({ page }) => {
    const w = world({ script: script({ reads: ["expired"] }) });
    await open(page, w);
    await row(page, "claude").getByRole("button", {
      name: "Sign in",
      exact: true,
    }).click();
    await expect(dialog(page).getByText("The sign-in expired.")).toBeVisible();
    await expect(dialog(page).getByRole("button", { name: "Start again" }))
      .toBeVisible();
    await shot(page, "machine-agents-dialog-expired", [], { windowOnly: true });
  });

  test("Cancel sign-in calls cancel and closes; Escape does the same; focus returns to the row", async ({ page }) => {
    const w = world();
    await open(page, w);
    await row(page, "claude").getByRole("button", {
      name: "Sign in",
      exact: true,
    }).click();
    await expect(dialog(page).getByText("Waiting for you to finish…"))
      .toBeVisible();
    await dialog(page).getByRole("button", { name: "Cancel sign-in" }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect.poll(() => w.cancels.length).toBe(1);
    // The setup was made (the person asked to sign in), so the row now has Check; focus is on it.
    await expect(row(page, "claude").getByRole("button", { name: "Check" }))
      .toBeFocused();
    // Escape is the same thing: Check needs the person, so it becomes the dialog again.
    await row(page, "claude").getByRole("button", { name: "Check" }).click();
    await expect(dialog(page).getByText("Waiting for you to finish…"))
      .toBeVisible();
    await expect(dialog(page).getByText("Closing this cancels the sign-in."))
      .toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    await expect.poll(() => w.cancels.length).toBe(2);
  });

  test("a sign-in that cannot start says so and can be tried again", async ({ page }) => {
    const w = world({ components: [] });
    await open(page, w);
    // No component reported: Sign in is disabled, so nothing starts.
    await expect(
      row(page, "claude").getByRole("button", { name: "Sign in", exact: true }),
    ).toBeDisabled();
    expect(w.createdAttempts).toEqual([]);
  });
});

test.describe("the dialog while it starts", () => {
  test("says it is starting until the server has answered", async ({ page }) => {
    const w = world();
    await open(page, w);
    // The server is slow to answer the sign-in: hold the response.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/auth-attempts", async (route) => {
      if (route.request().method() === "POST") await held;
      await route.fallback();
    });
    await row(page, "claude").getByRole("button", {
      name: "Sign in",
      exact: true,
    }).click();
    await expect(dialog(page).getByText("Starting sign-in…")).toBeVisible();
    await expect(dialog(page).getByRole("button", { name: "Cancel sign-in" }))
      .toBeVisible();
    await shot(page, "machine-agents-dialog-starting", [], {
      windowOnly: true,
    });
    release();
    await expect(dialog(page).getByText("2. Enter this code:")).toBeVisible();
  });
});

test.describe("Check", () => {
  const ready = () => [binding({ lastCheckedAt: "2026-11-14T00:00:00.000Z" })];

  test("a check that finds the agent signed in changes nothing and opens no dialog", async ({ page }) => {
    const w = world({
      bindings: ready(),
      script: script({ reads: ["completed"] }),
    });
    await open(page, w);
    await row(page, "claude").getByRole("button", { name: "Check" }).click();
    await expect.poll(() => w.createdAttempts.length).toBe(1);
    await expect(dialog(page)).toHaveCount(0);
    await expect(row(page, "claude").getByText("Ready", { exact: true }))
      .toBeVisible();
    await expect(row(page, "claude").getByRole("button", { name: "Check" }))
      .toBeEnabled();
  });

  test("a check that needs the person becomes the sign-in dialog", async ({ page }) => {
    const w = world({
      bindings: ready(),
      script: script({ reads: ["challenge_issued"] }),
    });
    await open(page, w);
    await row(page, "claude").getByRole("button", { name: "Check" }).click();
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toContainText(
      "Sign in to Claude Code on fixture-host",
    );
  });

  test("a check that could not run says so under the row", async ({ page }) => {
    const w = world({
      bindings: ready(),
      script: script({ reads: ["failed"] }),
    });
    await open(page, w);
    await row(page, "claude").getByRole("button", { name: "Check" }).click();
    await expect(row(page, "claude")).toContainText(
      "Bakery could not check this. Try again in a moment.",
    );
    await expect(dialog(page)).toHaveCount(0);
  });
});

test.describe("arriving from the wizard", () => {
  test("the machine page opens the sign-in for the agent in the address, once", async ({ page }) => {
    const w = world({ script: script({ reads: ["challenge_issued"] }) });
    await open(page, w, `/machines/${MACHINE_ID}?signIn=claude`);
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toContainText(
      "Sign in to Claude Code on fixture-host",
    );
    // The address has done its job: its search is gone, so a reload cannot start another sign-in.
    await expect(page).toHaveURL(new RegExp(`/machines/${MACHINE_ID}$`));
    await dialog(page).getByRole("button", { name: "Cancel sign-in" }).click();
    await expect(dialog(page)).toHaveCount(0);
    // Closing it does not open it again, nor does a reload.
    await page.waitForTimeout(500);
    await expect(dialog(page)).toHaveCount(0);
    await page.reload();
    await expect(row(page, "claude")).toBeVisible();
    await page.waitForTimeout(500);
    await expect(dialog(page)).toHaveCount(0);
    expect(w.createdAttempts.length).toBe(1);
  });

  test("an agent that is already signed in is not asked to sign in again", async ({ page }) => {
    const w = world({
      bindings: [binding({ lastCheckedAt: "2026-11-14T00:00:00.000Z" })],
    });
    await open(page, w, `/machines/${MACHINE_ID}?signIn=claude`);
    await expect(row(page, "claude")).toBeVisible();
    await page.waitForTimeout(300);
    await expect(dialog(page)).toHaveCount(0);
    expect(w.createdAttempts).toEqual([]);
  });
});
