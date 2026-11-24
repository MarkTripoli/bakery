import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, type Request, test } from "@playwright/test";
import {
  MOCK_ORGANIZATION_ID,
  mockAuthenticatedSession,
} from "./helpers/mock-session.ts";

const ENROLLMENT_ID = "00000000-0000-4000-8000-0000000000e1";
const SECOND_ENROLLMENT_ID = "00000000-0000-4000-8000-0000000000e2";
const MACHINE_ID = "00000000-0000-4000-8000-0000000000a1";
const COMMAND =
  "npx -y http://127.0.0.1/v1/worker/link.tgz link --server http://127.0.0.1 --code ABCD-2345";
const NEW_COMMAND =
  "npx -y http://127.0.0.1/v1/worker/link.tgz link --server http://127.0.0.1 --code WXYZ-6789";
const inMinutes = (minutes: number) =>
  new Date(Date.now() + minutes * 60_000).toISOString();
const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

type Fixture = {
  state: "pending" | "consumed" | "canceled" | "expired";
  expiresAt: string;
  workerHostId: string | null;
  readiness: "ready" | "needs_attention" | "checking";
  creates: Request[];
  cancels: Request[];
  replacements: Request[];
  failures: number;
  list: unknown[];
};

function fixture(over: Partial<Fixture> = {}): Fixture {
  return {
    state: "pending",
    expiresAt: inMinutes(10),
    workerHostId: null,
    readiness: "ready",
    creates: [],
    cancels: [],
    replacements: [],
    failures: 0,
    list: [],
    ...over,
  };
}

const worker = (f: Fixture) => ({
  id: MACHINE_ID,
  principalId: "00000000-0000-4000-8000-0000000000b0",
  name: "build-box-01",
  os: "linux",
  architecture: "arm64",
  capabilities: ["git", "shell", "web", "model", "claude"],
  toolchainVersions: {},
  slots: 2,
  status: "online",
  desiredMode: "accepting",
  connectivity: "online",
  readiness: f.readiness,
  readinessReason: f.readiness === "needs_attention" ? "check_failed" : null,
  failedCheckIds: f.readiness === "needs_attention" ? ["c1"] : [],
  lastHeartbeatAt: new Date().toISOString(),
  credentialGeneration: 1,
  archivedAt: null,
  cleanup: { state: "not_requested", requestedAt: null, confirmedAt: null },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  version: 1,
});

async function open(
  page: Page,
  f: Fixture,
  options: { role?: "admin" | "developer"; path?: string } = {},
) {
  await mockAuthenticatedSession(page);
  await page.route(
    `**/v1/organizations/${MOCK_ORGANIZATION_ID}/effective-access`,
    (route) =>
      route.fulfill(json({
        organizationId: MOCK_ORGANIZATION_ID,
        role: options.role ?? "admin",
        capabilities: [],
      })),
  );
  await page.route(
    (url) => url.pathname === "/v1/worker-enrollments",
    (route) => {
      if (route.request().method() === "POST") {
        f.creates.push(route.request());
        if (f.failures > 0) {
          f.failures -= 1;
          return route.fulfill({
            status: 500,
            contentType: "application/problem+json",
            body: JSON.stringify({
              type: "about:blank",
              title: "x",
              status: 500,
              code: "INTERNAL_ERROR",
            }),
          });
        }
        return route.fulfill(json({
          enrollmentId: ENROLLMENT_ID,
          enrollmentToken: "fixture-setup-code-0001",
          expiresAt: f.expiresAt,
          linkCode: "ABCD-2345",
          command: COMMAND,
        }, 201));
      }
      return route.fulfill(json({ items: f.list, nextCursor: null }));
    },
  );
  await page.route(
    (url) => url.pathname.endsWith("/replacements"),
    (route) => {
      f.replacements.push(route.request());
      return route.fulfill(json({
        enrollmentId: SECOND_ENROLLMENT_ID,
        enrollmentToken: "fixture-setup-code-0002",
        expiresAt: inMinutes(10),
        linkCode: "WXYZ-6789",
        command: NEW_COMMAND,
      }, 201));
    },
  );
  await page.route(
    (url) => /^\/v1\/worker-enrollments\/[0-9a-f-]{36}$/.test(url.pathname),
    (route) => {
      const id = new URL(route.request().url()).pathname.split("/").pop();
      const second = id === SECOND_ENROLLMENT_ID;
      if (route.request().method() === "PATCH") {
        f.cancels.push(route.request());
        return route.fulfill(json({
          enrollmentId: id,
          organizationId: MOCK_ORGANIZATION_ID,
          state: "canceled",
          expiresAt: f.expiresAt,
          workerHostId: null,
          worker: null,
          version: 2,
          snapshotCursor: null,
        }));
      }
      return route.fulfill(json({
        enrollmentId: id,
        organizationId: MOCK_ORGANIZATION_ID,
        state: second ? "pending" : f.state,
        expiresAt: second ? inMinutes(10) : f.expiresAt,
        workerHostId: second ? null : f.workerHostId,
        worker: null,
        version: 1,
        snapshotCursor: null,
      }));
    },
  );
  await page.route(
    (url) => /^\/v1\/workers\/[0-9a-f-]{36}$/.test(url.pathname),
    (route) => route.fulfill(json(worker(f))),
  );
  await page.route(
    (url) => url.pathname === "/v1/workers",
    (route) => route.fulfill(json({ items: [], nextCursor: null })),
  );
  await page.goto(options.path ?? "/machines/new");
}

async function getTheCommand(page: Page) {
  await page.getByRole("radio", { name: /Claude Code/ }).check({ force: true });
  await page.getByRole("button", { name: "Get the command" }).click();
}

const status = (page: Page) => page.getByTestId("machine-add-status");

const steps = (page: Page) => page.locator("[data-ui-component=stepItem]");

test.describe("add a machine with one command", () => {
  test("the settings, then the command, then waiting", async ({ page }) => {
    const f = fixture();
    await open(page, f);
    await expect(
      page.getByRole("heading", { name: "Add a machine", level: 1 }),
    ).toBeVisible();
    await expect(steps(page).first()).toHaveAttribute("data-state", "running");
    await page.getByLabel("Name").fill("build-box-01");
    await page.getByLabel("How many tasks at once").fill("2");
    await getTheCommand(page);
    await expect(page.locator("[data-ui-component=codeBlock]")).toContainText(
      COMMAND,
    );
    await expect(steps(page).first()).toHaveAttribute("data-state", "done");
    expect(
      await page.locator("[data-ui-component=codeBlock] code").evaluate((
        code,
      ) => code.getClientRects().length),
    ).toBe(1);
    await expect(steps(page).nth(1).locator(".ui-step-item__detail"))
      .toHaveCount(1);
    expect(f.creates).toHaveLength(1);
    const sent = f.creates[0]!.postDataJSON();
    expect(sent.name).toBe("build-box-01");
    expect(sent.slots).toBe(2);
    expect(sent.os).toBeUndefined();
    expect(sent.architecture).toBeUndefined();
    expect(sent.capabilities).toEqual([
      "git",
      "shell",
      "web",
      "model",
      "claude",
    ]);
    await expect(page.getByText("build-box-01 · 2 tasks at once · Claude Code"))
      .toBeVisible();
    await expect(page.getByText("Works once, for 10 minutes", { exact: false }))
      .toContainText("Linux arm64");
    await expect(status(page)).toHaveText(
      "Waiting for the machine · this page updates by itself",
    );
    await expect(page.getByText("Set up by hand")).toBeVisible();
    const axe = await new AxeBuilder({ page }).include(
      '[data-testid="machine-add"]',
    ).analyze();
    expect(axe.violations.map((v) => v.id)).toEqual([]);
  });

  test("a coding agent is required, a name is not", async ({ page }) => {
    const f = fixture();
    await open(page, f);
    await page.getByRole("button", { name: "Get the command" }).click();
    await expect(page.getByText("Choose a coding agent to continue."))
      .toBeVisible();
    expect(f.creates).toHaveLength(0);
    await page.getByRole("radio", { name: /Codex/ }).check({ force: true });
    await page.getByRole("button", { name: "Get the command" }).click();
    await expect(page.locator("[data-ui-component=codeBlock]")).toBeVisible();
    expect(f.creates[0]!.postDataJSON().name).toBeUndefined();
  });

  test("still waiting after two minutes says what to do", async ({ page }) => {
    const f = fixture();
    await page.clock.install({ time: new Date() });
    await open(page, f);
    await getTheCommand(page);
    await expect(status(page)).toContainText("Waiting for the machine");
    await page.clock.fastForward(125_000);
    await expect(status(page)).toHaveText(
      "Still waiting. If the terminal shows an error, it says what to do.",
    );
  });

  test("connected, then ready: only the banner, with Sign in", async ({ page }) => {
    const f = fixture();
    await open(page, f);
    await getTheCommand(page);
    f.state = "consumed";
    f.workerHostId = MACHINE_ID;
    f.readiness = "checking";
    await expect(status(page)).toHaveText(
      "Connected. Checking that it can run work…",
      { timeout: 20_000 },
    );
    await expect(page.locator("[data-ui-component=codeBlock]")).toHaveCount(0);
    await expect(steps(page).nth(1).locator(".ui-step-item__detail"))
      .toHaveCount(0);
    f.readiness = "ready";
    await expect(
      page.getByRole("status").filter({
        hasText:
          "build-box-01 is ready. One thing left: sign in to Claude Code.",
      }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: "Sign in to Claude Code" }))
      .toBeVisible();
    await expect(page.getByRole("button", { name: "Add another machine" }))
      .toBeVisible();
    await expect(page.getByText("Set up by hand")).toHaveCount(0);
  });

  test("a failed check shows only a warning and Open", async ({ page }) => {
    const f = fixture();
    await open(page, f);
    await getTheCommand(page);
    f.state = "consumed";
    f.workerHostId = MACHINE_ID;
    f.readiness = "needs_attention";
    await expect(page.getByRole("button", { name: "Open build-box-01" }))
      .toBeVisible({ timeout: 20_000 });
    await expect(page.locator("[data-ui-component=codeBlock]")).toHaveCount(0);
    await expect(
      page.getByRole("status").filter({ hasText: "1 check failed." }),
    )
      .toBeVisible();
    await expect(page.getByText("needs attention before it can take work"))
      .toHaveCount(0);
  });

  test("a command that expired unused is not drawn; Get a new command makes another", async ({ page }) => {
    const f = fixture();
    await open(page, f);
    await getTheCommand(page);
    f.state = "expired";
    await expect(page.getByText("This command expired before it was used."))
      .toBeVisible({ timeout: 20_000 });
    await expect(page.locator("[data-ui-component=codeBlock]")).toHaveCount(0);
    await expect(page.getByText("Nothing connected.")).toHaveCount(0);
    await expect(steps(page).nth(1).locator(".ui-step-item__detail"))
      .toHaveCount(0);
    await page.getByRole("button", { name: "Get a new command" }).click();
    await expect(page.locator("[data-ui-component=codeBlock]")).toContainText(
      NEW_COMMAND,
    );
    expect(f.replacements).toHaveLength(1);
  });

  test("Change warns, cancels the old command, and asks again", async ({ page }) => {
    const f = fixture();
    await open(page, f);
    await getTheCommand(page);
    await expect(page.getByRole("button", { name: "Change" })).toHaveCount(1);
    await page.getByRole("button", { name: "Change" }).click();
    await expect(page.getByText(
      "Changing the settings makes a new command. The old one stops working.",
    )).toBeVisible();
    await expect(page.getByRole("button", { name: "Change" })).toHaveCount(1);
    await expect(
      page.getByTestId("machine-add-change").getByRole("button", {
        name: "Change",
      }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Keep" }).click();
    await expect(page.locator("[data-ui-component=codeBlock]")).toBeVisible();
    await page.getByRole("button", { name: "Change" }).click();
    await page.getByTestId("machine-add-change").getByRole("button", {
      name: "Change",
    }).click();
    await expect(page.getByRole("button", { name: "Get the command" }))
      .toBeVisible();
    expect(f.cancels).toHaveLength(1);
  });

  test("came back later: the command is shown once, and a new one can be made", async ({ page }) => {
    const f = fixture({
      list: [{
        enrollmentId: ENROLLMENT_ID,
        state: "pending",
        name: "build-box-01",
        os: null,
        architecture: null,
        capabilities: ["git", "shell", "web", "model", "claude"],
        slots: 2,
        expiresAt: inMinutes(5),
        consumedAt: null,
        canceledAt: null,
        workerHostId: null,
        replacementOfId: null,
        targetWorkerHostId: null,
        version: 1,
      }],
    });
    await open(page, f, { path: `/machines/new?finish=${ENROLLMENT_ID}` });
    await expect(page.getByText("The command is shown once.")).toBeVisible();
    await expect(page.getByText("build-box-01 · 2 tasks at once · Claude Code"))
      .toBeVisible();
    await expect(steps(page).nth(1).locator(".ui-step-item__detail"))
      .toHaveCount(0);
    await page.getByRole("button", { name: "Get a new command" }).click();
    await expect(page.locator("[data-ui-component=codeBlock]")).toContainText(
      NEW_COMMAND,
    );
  });

  test("a command that could not be made says so and can be tried again", async ({ page }) => {
    const f = fixture({ failures: 1 });
    await open(page, f);
    await getTheCommand(page);
    await expect(
      steps(page).first().getByText("Bakery could not make the command."),
    ).toBeVisible();
    await expect(steps(page).first()).toHaveAttribute("data-state", "running");
    await expect(page.getByRole("button", { name: "Get the command" }))
      .toHaveCount(0);
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.locator("[data-ui-component=codeBlock]")).toBeVisible();
    expect(f.creates).toHaveLength(2);
  });

  test("only an administrator can add a machine", async ({ page }) => {
    await open(page, fixture(), { role: "developer" });
    await expect(page.getByText("Only administrators can add machines"))
      .toBeVisible();
    await expect(page.getByRole("button", { name: "Get the command" }))
      .toHaveCount(0);
  });
});
