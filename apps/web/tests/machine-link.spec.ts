import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, type Request, test } from "@playwright/test";
import {
  MOCK_ORGANIZATION_ID,
  MOCK_PRINCIPAL_ID,
  mockAuthenticatedSession,
} from "./helpers/mock-session.ts";

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

const REQUEST_ID = "00000000-0000-4000-8000-0000000000f1";
const ENROLLMENT_ID = "00000000-0000-4000-8000-0000000000e1";
const MACHINE_ID = "00000000-0000-4000-8000-0000000000a1";
const CODE = "K7QM-2XPD";
const inMinutes = (minutes: number) =>
  new Date(Date.now() + minutes * 60_000).toISOString();
const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});
const problem = (status: number, code: string, reason?: string) => ({
  status,
  contentType: "application/problem+json",
  body: JSON.stringify({
    type: "https://bakery.example/problems/test",
    title: code,
    detail: code,
    status,
    code,
    retryable: false,
    requestId: crypto.randomUUID(),
    traceId: crypto.randomUUID(),
    ...(reason === undefined ? {} : { reason }),
  }),
});

type LinkRequest = Record<string, unknown>;
const request = (over: LinkRequest = {}): LinkRequest => ({
  id: REQUEST_ID,
  userCode: CODE,
  hostname: "build-box-01",
  os: "linux",
  architecture: "arm64",
  supported: true,
  state: "pending",
  createdAt: new Date().toISOString(),
  expiresAt: inMinutes(8),
  decidedAt: null,
  decidedBy: null,
  enrollmentId: null,
  workerHostId: null,
  ...over,
});

type Fixture = {
  found: LinkRequest;
  lookupRefusal: ReturnType<typeof problem> | null;
  approveRefusal: ReturnType<typeof problem> | null;
  enrollment: { state: string; workerHostId: string | null };
  lookups: Request[];
  approvals: Request[];
  declines: Request[];
};

const fixture = (over: Partial<Fixture> = {}): Fixture => ({
  found: request(),
  lookupRefusal: null,
  approveRefusal: null,
  enrollment: { state: "pending", workerHostId: null },
  lookups: [],
  approvals: [],
  declines: [],
  ...over,
});

const worker = {
  id: MACHINE_ID,
  principalId: "00000000-0000-4000-8000-0000000000b0",
  name: "release-box",
  os: "linux",
  architecture: "arm64",
  capabilities: ["git", "shell", "web", "model", "codex"],
  toolchainVersions: {},
  slots: 2,
  status: "online",
  desiredMode: "accepting",
  connectivity: "online",
  readiness: "ready",
  readinessReason: null,
  failedCheckIds: [],
  lastHeartbeatAt: new Date().toISOString(),
  activeAttemptCount: 0,
  credentialGeneration: 1,
  archivedAt: null,
  cleanup: { state: "not_requested", requestedAt: null, confirmedAt: null },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  version: 1,
};

async function open(
  page: Page,
  f: Fixture,
  role: "admin" | "developer" = "admin",
) {
  await mockAuthenticatedSession(page);
  await page.route(
    `**/v1/organizations/${MOCK_ORGANIZATION_ID}/effective-access`,
    (route) =>
      route.fulfill(json({
        organizationId: MOCK_ORGANIZATION_ID,
        role,
        capabilities: [],
      })),
  );
  await page.route("**/v1/worker-link-requests/lookups", (route) => {
    f.lookups.push(route.request());
    return route.fulfill(f.lookupRefusal ?? json(f.found));
  });
  await page.route("**/v1/worker-link-requests/*/approvals", (route) => {
    f.approvals.push(route.request());
    return route.fulfill(
      f.approveRefusal ?? json(request({
        userCode: null,
        state: "approved",
        decidedAt: new Date().toISOString(),
        decidedBy: MOCK_PRINCIPAL_ID,
        enrollmentId: ENROLLMENT_ID,
      })),
    );
  });
  await page.route("**/v1/worker-link-requests/*/declines", (route) => {
    f.declines.push(route.request());
    return route.fulfill(json(request({
      userCode: null,
      state: "declined",
      decidedAt: new Date().toISOString(),
      decidedBy: MOCK_PRINCIPAL_ID,
    })));
  });
  await page.route(
    (url) => url.pathname === `/v1/worker-enrollments/${ENROLLMENT_ID}`,
    (route) =>
      route.fulfill(json({
        enrollmentId: ENROLLMENT_ID,
        organizationId: MOCK_ORGANIZATION_ID,
        state: f.enrollment.state,
        expiresAt: inMinutes(8),
        workerHostId: f.enrollment.workerHostId,
        worker: null,
        version: 1,
        snapshotCursor: null,
      })),
  );
  await page.route(
    (url) => url.pathname === `/v1/workers/${MACHINE_ID}`,
    (route) => route.fulfill(json(worker)),
  );
  await page.route("**/v1/principals**", (route) =>
    route.fulfill(json({
      items: [{
        id: MOCK_PRINCIPAL_ID,
        principalType: "human",
        createdByPrincipalId: null,
        displayName: "Ada Rivera",
        disabledAt: null,
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
        version: 1,
      }],
      nextCursor: null,
    })));
  await page.goto("/machines/link");
}

const panel = (page: Page) => page.getByTestId("machine-link");
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });

async function find(page: Page, code = "k7qm2xpd") {
  await page.getByLabel("Code from the terminal").fill(code);
  await button(page, "Find the machine").click();
}

async function accessible(page: Page) {
  const axe = await new AxeBuilder({ page }).include(
    '[data-testid="machine-link"]',
  ).analyze();
  expect(axe.violations.map((violation) => violation.id)).toEqual([]);
}

test.describe("approve a machine", () => {
  test("the code finds the computer, and approving follows it to ready", async ({ page }) => {
    const f = fixture();
    await open(page, f);
    await expect(
      page.getByRole("heading", { name: "Approve a machine", level: 1 }),
    ).toBeVisible();
    await accessible(page);
    await still(page, "link-code");
    await find(page);
    await expect(panel(page)).toContainText(
      "A computer is asking to join Fixture Org.",
    );
    await expect(page.locator("[data-ui-component=setupKey]")).toHaveText(CODE);
    await expect(page.getByTestId("machine-link-says")).toHaveText(
      "The computer says it is build-box-01, Linux arm64 · 8 minutes left",
    );
    expect(f.lookups[0]!.postDataJSON()).toEqual({ userCode: "k7qm2xpd" });
    await expect(page.getByLabel("Name")).toHaveValue("build-box-01");
    await expect(page.getByRole("radio", { checked: true })).toHaveCount(0);
    await accessible(page);
    await button(page, "Approve").click();
    await expect(page.getByText("Choose a coding agent to continue."))
      .toBeVisible();
    expect(f.approvals).toHaveLength(0);
    await page.getByLabel("Name").fill("release-box");
    await page.getByLabel("How many tasks at once").fill("2");
    await page.getByRole("radio", { name: /Codex/ }).check({ force: true });
    await still(page, "link-found");
    await button(page, "Approve").click();
    await expect(page.getByTestId("machine-add-status")).toHaveText(
      "Waiting for the machine · this page updates by itself",
    );
    await expect(button(page, "Approve")).toHaveCount(0);
    await expect(page.getByLabel("Name")).toHaveCount(0);
    expect(f.approvals[0]!.postDataJSON()).toEqual({
      name: "release-box",
      slots: 2,
      capabilities: ["git", "shell", "web", "model", "codex"],
    });
    expect(f.approvals[0]!.headers()["idempotency-key"]).toBeTruthy();
    await still(page, "link-waiting");
    f.enrollment = { state: "consumed", workerHostId: MACHINE_ID };
    await expect(
      page.getByText(
        "release-box is ready. One thing left: sign in to Codex.",
      ),
    ).toBeVisible({ timeout: 15_000 });
    await expect(button(page, "Sign in to Codex")).toBeVisible();
    await still(page, "link-ready");
  });

  test("an empty or unknown code, and too many tries, are said at the field", async ({ page }) => {
    const f = fixture({
      lookupRefusal: problem(404, "RESOURCE_NOT_FOUND", "not_found"),
    });
    await open(page, f);
    await button(page, "Find the machine").click();
    await expect(page.getByText("Enter the code from the terminal."))
      .toBeVisible();
    expect(f.lookups).toHaveLength(0);
    await find(page, "AAAA-AAAA");
    await expect(page.getByText(
      "No machine is waiting with that code. Check the terminal; codes work for 10 minutes.",
    )).toBeVisible();
    await still(page, "link-unknown");
    f.lookupRefusal = problem(429, "RATE_LIMITED");
    await page.getByLabel("Code from the terminal").press("Enter");
    await expect(
      page.getByText("Too many tries. Wait 10 minutes, then try again."),
    ).toBeVisible();
    await expect(page.getByLabel("Code from the terminal")).toBeVisible();
  });

  test("an expired code says so and keeps the field", async ({ page }) => {
    await open(
      page,
      fixture({
        found: request({ state: "expired", expiresAt: inMinutes(-1) }),
      }),
    );
    await find(page);
    await expect(panel(page)).toContainText(
      `The code ${CODE} expired. Codes work for 10 minutes. Nothing was installed.`,
    );
    await expect(page.getByLabel("Code from the terminal")).toBeVisible();
    await expect(button(page, "Approve")).toHaveCount(0);
    await still(page, "link-expired");
  });

  test("an unsupported computer can only be declined", async ({ page }) => {
    const f = fixture({
      found: request({ os: "macos", supported: false }),
    });
    await open(page, f);
    await find(page);
    await expect(panel(page)).toContainText(
      "Bakery does not support macOS arm64 yet, so this computer cannot be added. Declining tells its terminal to stop.",
    );
    await expect(button(page, "Approve")).toHaveCount(0);
    await expect(page.getByLabel("Name")).toHaveCount(0);
    await expect(button(page, "Back to machines")).toBeVisible();
    await accessible(page);
    await still(page, "link-unsupported");
    await button(page, "Decline").click();
    await expect(panel(page)).toContainText(
      "Declined. Nothing was installed on that computer.",
    );
    expect(f.declines).toHaveLength(1);
    await still(page, "link-declined");
  });

  test("a code someone already approved names them and opens the machine", async ({ page }) => {
    await open(
      page,
      fixture({
        found: request({
          state: "approved",
          decidedAt: inMinutes(-3),
          decidedBy: MOCK_PRINCIPAL_ID,
          enrollmentId: ENROLLMENT_ID,
          workerHostId: MACHINE_ID,
        }),
      }),
    );
    await find(page);
    await expect(panel(page)).toContainText(
      "Ada Rivera approved this code 3 minutes ago.",
    );
    await still(page, "link-approved-already");
    await button(page, "Open release-box").click();
    await expect(page).toHaveURL(new RegExp(`/machines/${MACHINE_ID}`));
  });

  test("a decision someone else just made is read again, not reported as a failure", async ({ page }) => {
    const f = fixture({
      approveRefusal: problem(409, "STATE_CONFLICT", "declined"),
    });
    await open(page, f);
    await find(page);
    await page.getByRole("radio", { name: /Codex/ }).check({ force: true });
    f.found = request({
      state: "declined",
      decidedAt: new Date().toISOString(),
      decidedBy: MOCK_PRINCIPAL_ID,
    });
    await button(page, "Approve").click();
    await expect(panel(page)).toContainText(
      "Declined. Nothing was installed on that computer.",
    );
    expect(f.lookups).toHaveLength(2);
  });

  test("someone who is not an administrator is told who to ask", async ({ page }) => {
    await open(page, fixture(), "developer");
    await expect(panel(page)).toContainText(
      "Only administrators can approve a machine",
    );
    await expect(panel(page)).toContainText(
      "Send an administrator this page.",
    );
    await expect(panel(page).getByText("Only administrators")).toHaveCount(1);
    await expect(panel(page)).not.toContainText("add machines");
    await expect(page.getByLabel("Code from the terminal")).toHaveCount(0);
    await expect(button(page, "Copy the address")).toBeVisible();
    await still(page, "link-not-admin");
  });
});
