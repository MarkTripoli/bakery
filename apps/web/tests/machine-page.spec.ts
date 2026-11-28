import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, type Request, test } from "@playwright/test";
import { shot } from "./helpers/real-api.ts";
import {
  MOCK_ORGANIZATION_ID,
  mockAuthenticatedSession,
} from "./helpers/mock-session.ts";

// #70 part C1: the machine page says what is wrong in one banner with its one
// fix, offers the mode control and Retire to administrators, and groups the
// failed checks with a sentence for each.

const MACHINE_ID = "00000000-0000-4000-8000-0000000000a1";
const REPAIR_ID = "00000000-0000-4000-8000-0000000000e7";
const REPAIR_CODE = "fixture-repair-code-0001";

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

type Facts = {
  status: "online" | "offline" | "draining" | "revoked";
  desiredMode: "accepting" | "paused" | "draining" | "revoked";
  connectivity: "online" | "stale" | "offline";
  readiness: "ready" | "checking" | "needs_attention";
  readinessReason: string | null;
  failedCheckIds: string[];
  version: number;
  unsettledAttemptCount?: number;
};

type Fixture = {
  facts: Facts;
  allBlocked: boolean;
  blockedCapabilities: string[];
  failedChecks: { checkId: string; reason: string | null }[];
  patches: Request[];
  revokes: Request[];
  repairs: Request[];
  /** What a read of the re-pair setup says. */
  repairState: "pending" | "consumed" | "expired";
  pendingRepair: boolean;
  cancels: number;
  /** The next update is refused with this status. */
  refuseWith: number | null;
  /** The machine's system and processor. */
  system: { os: string; architecture: string };
  components?: Record<string, unknown>[];
  checks?: Record<string, unknown>[];
  retirement?: Record<string, unknown> | null;
};

function fixture(
  facts: Partial<Facts> = {},
  more: Partial<Fixture> = {},
): Fixture {
  return {
    facts: {
      status: "online",
      desiredMode: "accepting",
      connectivity: "online",
      readiness: "ready",
      readinessReason: null,
      failedCheckIds: [],
      version: 1,
      ...facts,
    },
    allBlocked: false,
    blockedCapabilities: [],
    failedChecks: [],
    patches: [],
    revokes: [],
    repairs: [],
    repairState: "pending",
    pendingRepair: false,
    cancels: 0,
    refuseWith: null,
    // The server stores x86_64 as x64: that is what a real machine carries.
    system: { os: "linux", architecture: "x64" },
    ...more,
  };
}

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
  const reason = () => {
    const { desiredMode, status, connectivity, readiness } = f.facts;
    if (status === "revoked" || desiredMode === "revoked") return "revoked";
    if (connectivity === "offline") return "offline";
    if (connectivity === "stale") return "stale";
    if (readiness === "needs_attention") return "check_failed";
    if (desiredMode === "paused") return "paused";
    if (desiredMode === "draining") return "draining";
    return null;
  };
  await page.route(`**/v1/workers/${MACHINE_ID}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/dispatch-blockers")) {
      return route.fulfill(json({
        workerHostId: MACHINE_ID,
        reason: reason(),
        connectivity: f.facts.connectivity,
        allBlocked: f.allBlocked,
        blockedCapabilities: f.blockedCapabilities,
        failedChecks: f.failedChecks,
        credentialGeneration: 1,
        inventoryRevision: 1,
        meteredModelReady: false,
      }));
    }
    if (path.endsWith("/components")) {
      return route.fulfill(
        json({ items: f.components ?? [], nextCursor: null }),
      );
    }
    return route.fulfill(json({ items: [], nextCursor: null }));
  });
  await page.route(
    (url) => url.pathname === `/v1/workers/${MACHINE_ID}/enrollments`,
    (route) => {
      f.repairs.push(route.request());
      if (f.pendingRepair) {
        return route.fulfill({
          status: 409,
          contentType: "application/problem+json",
          body: JSON.stringify({
            type: "https://bakery.example/problems/x",
            title: "x",
            status: 409,
            code: "STATE_CONFLICT",
            retryable: false,
            detail: "A repair code is already pending.",
            requestId: "00000000-0000-4000-8000-00000000f002",
            traceId: "00000000000000000000000000000002",
          }),
        });
      }
      return route.fulfill(json({
        enrollmentId: REPAIR_ID,
        enrollmentToken: REPAIR_CODE,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        linkCode: "REPA-IR01",
        command:
          "npx -y http://127.0.0.1/v1/worker/link.tgz link --server http://127.0.0.1 --code REPA-IR01",
      }, 201));
    },
  );
  await page.route(
    (url) => url.pathname === "/v1/worker-enrollments",
    (route) =>
      route.fulfill(json({
        items: f.pendingRepair
          ? [{
            enrollmentId: REPAIR_ID,
            state: "pending",
            name: "fixture-host",
            os: "linux",
            architecture: "x64",
            capabilities: ["git", "claude"],
            slots: 2,
            expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
            consumedAt: null,
            canceledAt: null,
            workerHostId: null,
            replacementOfId: null,
            targetWorkerHostId: MACHINE_ID,
            version: 1,
          }]
          : [],
        nextCursor: null,
      })),
  );
  await page.route(
    (url) => url.pathname === `/v1/worker-enrollments/${REPAIR_ID}`,
    (route) => {
      if (route.request().method() === "PATCH") {
        f.pendingRepair = false;
        f.cancels += 1;
        return route.fulfill(json({
          enrollmentId: REPAIR_ID,
          organizationId: MOCK_ORGANIZATION_ID,
          state: "canceled",
          expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
          workerHostId: null,
          worker: null,
          version: 2,
          snapshotCursor: null,
        }));
      }
      return route.fulfill(json({
        enrollmentId: REPAIR_ID,
        organizationId: MOCK_ORGANIZATION_ID,
        state: f.repairState,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        workerHostId: f.repairState === "consumed" ? MACHINE_ID : null,
        worker: null,
        version: 1,
        snapshotCursor: null,
      }));
    },
  );
  await page.route(
    (url) => url.pathname === `/v1/workers/${MACHINE_ID}/revocations`,
    (route) => {
      f.revokes.push(route.request());
      f.facts = {
        ...f.facts,
        status: "revoked",
        desiredMode: "revoked",
        version: f.facts.version + 1,
      };
      return route.fulfill(json(worker(f)));
    },
  );
  await page.route(
    (url) => url.pathname === `/v1/workers/${MACHINE_ID}`,
    (route) => {
      if (route.request().method() === "PATCH") {
        f.patches.push(route.request());
        if (f.refuseWith !== null) {
          const status = f.refuseWith;
          f.refuseWith = null;
          return route.fulfill({
            status,
            contentType: "application/problem+json",
            body: JSON.stringify({
              type: "https://bakery.example/problems/x",
              title: "x",
              status,
              code: status === 412 ? "PRECONDITION_FAILED" : "STATE_CONFLICT",
              retryable: false,
              detail: "The machine changed.",
              requestId: "00000000-0000-4000-8000-00000000f001",
              traceId: "00000000000000000000000000000001",
            }),
          });
        }
        const wanted =
          (route.request().postDataJSON() as { status: Facts["status"] })
            .status;
        f.facts = {
          ...f.facts,
          status: wanted,
          desiredMode: wanted === "online"
            ? "accepting"
            : wanted === "offline"
            ? "paused"
            : "draining",
          version: f.facts.version + 1,
        };
      }
      return route.fulfill(json(worker(f)));
    },
  );
  await page.goto(`/machines/${MACHINE_ID}`);
}

function worker(f: Fixture) {
  return {
    ...(f.checks ? { checks: f.checks } : {}),
    ...(f.retirement === undefined ? {} : { retirement: f.retirement }),
    id: MACHINE_ID,
    principalId: "00000000-0000-4000-8000-0000000000a2",
    name: "fixture-host",
    os: f.system.os,
    architecture: f.system.architecture,
    capabilities: ["git", "shell", "web", "model", "claude"],
    toolchainVersions: {},
    slots: 2,
    status: f.facts.status,
    desiredMode: f.facts.desiredMode,
    connectivity: f.facts.connectivity,
    readiness: f.facts.readiness,
    readinessReason: f.facts.readinessReason,
    failedCheckIds: f.facts.failedCheckIds,
    ...(f.facts.unsettledAttemptCount === undefined
      ? {}
      : { unsettledAttemptCount: f.facts.unsettledAttemptCount }),
    lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
    activeAttemptCount: 0,
    credentialGeneration: 1,
    archivedAt: null,
    cleanup: { state: "not_requested", requestedAt: null, confirmedAt: null },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    version: f.facts.version,
  };
}

const banner = (page: Page) => page.getByTestId("machine-problem-banner");
const openChecks = async (page: Page) => {
  await page.getByRole("tab", { name: "Checks and software" }).click();
  await expect(page).toHaveURL(/\/machines\/[^/]+\/checks/);
};

test.describe("machine page: states", () => {
  test("offline keeps the last data, says when it was read and disables changes", async ({ page, context }) => {
    await open(page, fixture());
    await expect(page.getByTestId("machine-about")).toBeVisible();
    await context.setOffline(true);
    await expect(page.getByText(/You are offline\. Last updated /))
      .toBeVisible();
    for (const mode of ["Taking work", "Paused", "Finish and stop"]) {
      await expect(page.getByRole("radio", { name: mode })).toBeDisabled();
    }
    await expect(
      page.getByRole("button", { name: "Retire this machine" }).first(),
    ).toBeDisabled();
    await expect(page.getByTestId("machine-about")).toBeVisible();
    await shot(page, "machine-page-offline-last-updated");
  });

  test("a retire dialog left open cannot act offline", async ({ page, context }) => {
    await open(page, fixture());
    await page.getByRole("button", { name: "Retire this machine" }).first()
      .click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByRole("button", { name: "Retire now" }))
      .toBeEnabled();
    await expect(dialog).not.toContainText("You are offline.");
    await context.setOffline(true);
    await expect(dialog).toContainText("You are offline.");
    for (const name of ["Retire now", "Finish and stop instead"]) {
      await expect(dialog.getByRole("button", { name })).toBeDisabled();
    }
    await expect(dialog.getByRole("button", { name: "Cancel" }))
      .toBeEnabled();
    await shot(page, "machine-page-retire-offline", [], { windowOnly: true });
  });

  test("offline still opens the checks", async ({ page, context }) => {
    await open(
      page,
      fixture(
        {
          readiness: "needs_attention",
          readinessReason: "check_failed",
          failedCheckIds: ["capability:git"],
        },
        {
          blockedCapabilities: ["git"],
          failedChecks: [{ checkId: "capability:git", reason: "git missing" }],
        },
      ),
    );
    await expect(banner(page)).toContainText("1 check failed.");
    await context.setOffline(true);
    await expect(page.getByText(/You are offline\. Last updated /))
      .toBeVisible();
    await expect(banner(page).getByRole("button", { name: "See the checks" }))
      .toBeEnabled();
  });

  test("loading shows placeholder rows, not a banner", async ({ page }) => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await open(page, fixture());
    await expect(page.getByTestId("machine-about")).toBeVisible();
    await page.route(
      (url) => url.pathname === `/v1/workers/${MACHINE_ID}`,
      async (route) => {
        await held;
        await route.fallback();
      },
    );
    await page.reload();
    const loading = page.getByRole("status", { name: "Loading machine data…" });
    await expect(loading).toBeVisible();
    await expect(loading.locator("[data-ui-component=skeleton]"))
      .toHaveCount(3);
    await expect(page.getByTestId("machine-detail-page"))
      .not.toContainText(MACHINE_ID);
    await shot(page, "machine-page-loading");
    release();
    await expect(loading).toHaveCount(0);
  });

  test("a long check reason is clamped and can be shown whole", async ({ page }) => {
    const reason = Array.from(
      { length: 40 },
      (_, line) => `line ${line + 1}: git exited with a long explanation`,
    ).join("\n");
    await open(
      page,
      fixture(
        {
          readiness: "needs_attention",
          readinessReason: "check_failed",
          failedCheckIds: ["capability:git"],
        },
        {
          blockedCapabilities: ["git"],
          failedChecks: [{ checkId: "capability:git", reason }],
        },
      ),
    );
    await openChecks(page);
    const more = page.getByRole("button", { name: "Show more" });
    await expect(more).toBeVisible();
    await shot(page, "machine-page-check-reason-clamped");
    await more.click();
    await expect(page.getByRole("button", { name: "Show less" }))
      .toBeVisible();
    await expect(page.getByTestId("machine-checks")).toContainText("line 40:");
  });
});

test.describe("machine page: the one banner", () => {
  const cases: readonly {
    name: string;
    facts: Partial<Facts>;
    title: string;
    body: string | null;
    fix: string | null;
    tone: "information" | "warning" | "error";
  }[] = [
    {
      name: "offline",
      facts: { connectivity: "offline" },
      title: "Bakery cannot reach it.",
      body: "Check that the machine is on and the Bakery worker is running.",
      fix: null,
      tone: "warning",
    },
    {
      name: "not responding",
      facts: { connectivity: "stale" },
      title: "It has stopped answering Bakery.",
      body: "Work is not sent to it until it answers again.",
      fix: null,
      tone: "warning",
    },
    {
      // Someone chose it: nothing is wrong, so it is information, not amber.
      name: "paused",
      facts: { status: "offline", desiredMode: "paused" },
      title: "It takes no new work until someone resumes it.",
      body: "It keeps the work it has.",
      fix: "Take work again",
      tone: "information",
    },
    {
      name: "finishing up",
      facts: { status: "draining", desiredMode: "draining" },
      title: "It takes no new work and stops once its current work is done.",
      body: null,
      fix: "Take work again",
      tone: "information",
    },
    {
      name: "retired",
      facts: { status: "revoked", desiredMode: "revoked" },
      title: "It no longer takes work.",
      body: "Set it up again to use it.",
      fix: "Set up again",
      tone: "information",
    },
  ];
  for (const item of cases) {
    test(`${item.name}: what is wrong, and the one fix that exists`, async ({ page }) => {
      await open(page, fixture(item.facts));
      const detail = page.getByTestId("machine-detail-page");
      await expect(detail).toBeVisible();
      await expect(banner(page)).toContainText(item.title);
      if (item.body) await expect(banner(page)).toContainText(item.body);
      // The time it was last seen is in the header line, not in the banner.
      await expect(banner(page)).not.toContainText("Last seen");
      await expect(banner(page)).toHaveAttribute("data-variant", item.tone);
      // The status is the banner (the badge only when there is no banner): not again in the line under the name.
      await expect(detail.getByText(/· (Online|Offline|Not responding) ·/))
        .toHaveCount(0);
      if (item.fix) {
        await expect(banner(page).getByRole("button")).toHaveText(item.fix);
      } else {
        await expect(banner(page).getByRole("button")).toHaveCount(0);
      }
      // The old gate wording is gone.
      await expect(
        detail.getByText(/Dispatch blocked|Credential revoked|Heartbeat stale/),
      )
        .toHaveCount(0);
      await shot(page, `machine-page-${item.name.replaceAll(" ", "-")}`);
    });
  }

  test("a machine with nothing wrong has no banner and says so about its checks", async ({ page }) => {
    await open(page, fixture());
    const detail = page.getByTestId("machine-detail-page");
    await openChecks(page);
    await expect(detail.getByText("No failed checks reported.")).toBeVisible();
    await expect(banner(page)).toHaveCount(0);
    await page.getByRole("tab", { name: "Overview" }).click();
    // One section about the machine, one line each: no section per fact.
    const about = page.getByTestId("machine-about");
    await expect(about.getByRole("heading", { name: "About this machine" }))
      .toBeVisible();
    await expect(about).toContainText("System");
    await expect(about).toContainText("Linux");
    await expect(about).toContainText("Processor");
    await expect(about).toContainText("x86_64");
    await expect(about).toContainText("Tasks at once");
    // Nothing reported, nothing drawn: no Software row and no "none" line.
    await expect(about).not.toContainText("Software");
    await expect(about).not.toContainText("No software has been reported.");
    // With no problem banner the state is the header badge.
    await expect(detail.locator('[data-ui-component="badge"]').first())
      .toBeVisible();
    await expect(detail.getByRole("heading", { name: "Capacity" })).toHaveCount(
      0,
    );
    // The line under the name is where it is and when it was last seen, not its status.
    await expect(detail.getByText(/^Linux · x86_64 · Last seen /))
      .toBeVisible();
    // The coding agents are rows with no internal words: this machine reports
    // Claude Code and nothing has signed it in yet.
    await expect(detail.getByRole("heading", { name: "Coding agents" }))
      .toBeVisible();
    // The agent banner says why it cannot be signed in yet; the row keeps its badge.
    await expect(detail.getByTestId("agent-banner")).toContainText(
      "Bakery has not heard from Claude Code on this machine yet.",
    );
    await expect(detail.getByTestId("coding-agent-claude")).toContainText(
      "Not signed in",
    );
    await expect(detail.getByTestId("coding-agent-claude")).not.toContainText(
      "has not heard",
    );
    await expect(detail.getByText(/Provider bindings|provider bindings/))
      .toHaveCount(0);
    await shot(page, "machine-page-ready");
    const axe = await new AxeBuilder({ page }).analyze();
    expect(axe.violations.map((v) => v.id)).toEqual([]);
  });

  test("Checks and software lists what is installed and whether an update is available", async ({ page }) => {
    const component = (
      componentKey: string,
      kind: string,
      actualVersion: string,
      installOwner: string,
      availableVersion: string | null = null,
    ) => ({
      id: crypto.randomUUID(),
      componentKey,
      paymentMethods: ["subscription"],
      kind,
      actualVersion,
      actualDigest: null,
      installOwner,
      adapterVersion: "1",
      availableVersion,
      channel: null,
      observedAt: "2026-01-01T00:00:00.000Z",
      maintenanceSupport: null,
    });
    await open(
      page,
      fixture({}, {
        components: [
          component("harness.claude", "harness", "1.2.0", "external", "1.3.0"),
          component("worker-supervisor", "worker", "3.0.0", "bakery", "3.0.0"),
          component("git", "toolchain", "2.40.0", "external"),
        ],
      }),
    );
    await openChecks(page);
    const software = page.getByTestId("machine-software");
    await expect(software.getByRole("heading", { name: "Software" }))
      .toBeVisible();
    await expect(software).toContainText(
      "This page does not install updates.",
    );
    const phone = (page.viewportSize()?.width ?? 1440) < 600;
    const table = software.getByRole("table");
    if (phone) {
      await expect(table).toHaveCount(0);
      const clipped = await software.getByRole("listitem").evaluateAll((
        items,
      ) => items.filter((item) => item.scrollWidth > item.clientWidth).length);
      expect(clipped).toBe(0);
    } else {
      await expect(table.getByRole("columnheader")).toHaveText([
        "Software",
        "Kind",
        "Version",
        "Installed by",
        "Update",
      ]);
    }
    const rowOf = (text: string) =>
      phone
        ? software.getByRole("listitem").filter({ hasText: text })
        : table.getByRole("row").filter({ hasText: text });
    const claude = rowOf("Claude Code");
    await expect(claude).toContainText("Coding agent");
    await expect(claude).toContainText("Already on the machine");
    await expect(claude).toContainText("1.3.0 is available");
    await expect(rowOf("worker-supervisor")).toContainText("Up to date");
    await expect(rowOf("git")).toContainText("Not reported");
    await expect(software.getByRole("button")).toHaveCount(0);
    await expect(page.getByTestId("machine-about")).toHaveCount(0);
    await shot(page, "machine-page-software");
  });

  test("failed checks: what stops the machine, what stops only some work, and the machine's own reason", async ({ page }) => {
    await open(
      page,
      fixture(
        {
          readiness: "needs_attention",
          readinessReason: "check_failed",
          failedCheckIds: [
            "disk_threshold",
            "capability:model",
            "mystery_check",
          ],
        },
        {
          allBlocked: true,
          blockedCapabilities: ["model"],
          failedChecks: [
            { checkId: "capability:model", reason: "claude: not signed in" },
            { checkId: "disk_threshold", reason: "free space 2% (limit 10%)" },
            { checkId: "mystery_check", reason: null },
          ],
        },
      ),
    );
    await expect(banner(page)).toContainText("3 checks failed.");
    await expect(banner(page)).toContainText(
      "This machine cannot take any work until this is fixed.",
    );
    await expect(banner(page).getByRole("button")).toHaveText("See the checks");
    await expect(banner(page)).not.toContainText("See the checks below.");
    await banner(page).getByRole("button").click();
    await expect(page).toHaveURL(/\/machines\/[^/]+\/checks/);
    const checks = page.getByTestId("machine-checks");
    await expect(
      checks.getByRole("heading", { name: "Checks", exact: true }),
    ).toBeFocused();
    // Each failed check is marked on its own row.
    await expect(checks.getByText("Failed", { exact: true })).toHaveCount(3);
    await expect(checks.getByRole("heading", { name: "This machine" }))
      .toBeVisible();
    await expect(checks.getByRole("heading", { name: "What it can do" }))
      .toBeVisible();
    await expect(checks.getByRole("heading", { name: "Other checks" }))
      .toBeVisible();
    // Named, explained, and the machine's own reason as it gave it.
    await expect(checks).toContainText("Free disk space");
    await expect(checks).toContainText(
      "The machine is low on disk space. Free some space, then check again.",
    );
    await expect(checks).toContainText("free space 2% (limit 10%)");
    await expect(checks).toContainText("Model access");
    await expect(checks).toContainText(
      "The coding agent cannot reach its model with its current sign-in. Sign in again.",
    );
    await expect(checks).toContainText("claude: not signed in");
    // An id nobody named is shown as it is, with no advice made up.
    await expect(checks).toContainText("mystery_check");
    await expect(checks).toContainText("No reason supplied.");
    await shot(page, "machine-page-checks");
  });

  test("a failed capability check stops only the work that needs it", async ({ page }) => {
    await open(
      page,
      fixture(
        {
          readiness: "needs_attention",
          readinessReason: "check_failed",
          failedCheckIds: ["capability:git"],
        },
        {
          allBlocked: false,
          blockedCapabilities: ["git"],
          failedChecks: [{
            checkId: "capability:git",
            reason: "git not found",
          }],
        },
      ),
    );
    await expect(banner(page)).toContainText("1 check failed.");
    await expect(banner(page)).toContainText(
      "Only work that needs git is affected. Other work continues.",
    );
    await openChecks(page);
    await expect(page.getByTestId("machine-checks")).toContainText(
      "The coding agent cannot make a working copy of a repository.",
    );
  });
});

test.describe("machine page: every check and who retired it", () => {
  const observed = "2026-11-27T15:30:00.000Z";
  const check = (
    checkId: string,
    result: "pass" | "fail" | "unknown" | "not_applicable",
    reason: string | null = null,
    componentKey: string | null = null,
  ) => ({ checkId, componentKey, result, reason, observedAt: observed });

  test("each check has its result, when it ran and what to do", async ({ page }) => {
    await open(
      page,
      fixture({
        readiness: "needs_attention",
        readinessReason: "check_failed",
        failedCheckIds: ["disk_threshold"],
      }, {
        allBlocked: true,
        failedChecks: [{ checkId: "disk_threshold", reason: "2% free" }],
        checks: [
          check("disk_threshold", "fail", "2% free"),
          check("supervisor_health", "pass"),
          check("capability:git", "unknown"),
          check("capability:model", "pass", null, "harness.claude"),
          check("capability:reviewer", "not_applicable"),
        ],
      }),
    );
    await openChecks(page);
    const checks = page.getByTestId("machine-checks");
    for (
      const word of [
        "Passed",
        "Failed",
        "Could not be checked",
        "Does not apply",
        "Model access (Claude Code)",
        "Bakery could not run this check. Check again in a moment.",
        "The machine is low on disk space.",
        "2% free",
      ]
    ) await expect(checks).toContainText(word);
    await expect(checks).toContainText("Nov 27, 2026");
    await expect(checks).not.toContainText("No failed checks reported.");
    await expect(checks).not.toContainText(
      "The worker is not running properly.",
    );
    if (test.info().project.name === "desktop") {
      for (const column of ["Check", "Result", "Checked", "What to do"]) {
        await expect(
          checks.getByRole("columnheader", { name: column, exact: true })
            .first(),
        ).toBeVisible();
      }
    }
    await shot(page, "machine-page-checks-table");
  });

  test("checks that all pass say there are no failures", async ({ page }) => {
    await open(
      page,
      fixture({}, { checks: [check("disk_threshold", "pass")] }),
    );
    await openChecks(page);
    const checks = page.getByTestId("machine-checks");
    await expect(checks).toContainText("No failed checks reported.");
    await expect(checks).toContainText("Free disk space");
    await expect(checks).toContainText("Passed");
  });

  test("an offline machine's old results are out of date, not unrunnable", async ({ page }) => {
    await open(
      page,
      fixture({ connectivity: "offline" }, {
        checks: [
          check("disk_threshold", "unknown"),
          check("capability:git", "unknown"),
        ],
      }),
    );
    await openChecks(page);
    const checks = page.getByTestId("machine-checks");
    await expect(checks.getByText("Out of date", { exact: true }))
      .toHaveCount(2);
    await expect(checks).toContainText(
      "This result is out of date. It is checked again when the machine is back.",
    );
    await expect(checks).not.toContainText("Bakery could not run this check");
    await expect(checks).not.toContainText("No failed checks reported.");
    await shot(page, "machine-page-checks-out-of-date");
  });

  test("the banner and the tab count failed checks apart from ones that did not run", async ({ page }) => {
    await open(
      page,
      fixture({
        readiness: "needs_attention",
        readinessReason: "check_failed",
        failedCheckIds: ["disk_threshold", "supervisor_health"],
      }, {
        allBlocked: true,
        failedChecks: [
          { checkId: "disk_threshold", reason: "2% free" },
          { checkId: "supervisor_health", reason: null },
        ],
        checks: [
          check("disk_threshold", "fail", "2% free"),
          check("supervisor_health", "unknown"),
        ],
      }),
    );
    await expect(banner(page)).toContainText(
      "1 check failed and 1 could not be run.",
    );
    await expect(page.getByRole("tab", { name: /Checks and software/ }))
      .toContainText("1 failed");
    await openChecks(page);
    const checks = page.getByTestId("machine-checks");
    await expect(checks.getByText("Failed", { exact: true })).toHaveCount(1);
    await expect(checks.getByText("Could not be checked", { exact: true }))
      .toHaveCount(1);
    await shot(page, "machine-page-checks-mixed-count");
  });

  for (
    const [name, line] of [
      ["Riley Chen", "Retired by Riley Chen on Nov 27, 2026"],
      [null, "Retired on Nov 27, 2026"],
    ] as const
  ) {
    test(`a retired machine says ${line.slice(0, 10)}${name ? " who" : " when only"}`, async ({ page }) => {
      await open(
        page,
        fixture({ status: "revoked", desiredMode: "revoked" }, {
          retirement: { principalId: null, name, at: observed },
        }),
      );
      await expect(page.getByTestId("machine-detail-page")).toContainText(line);
      if (name) await shot(page, "machine-page-retired-by");
    });
  }
});

test.describe("machine page: mode and Retire", () => {
  test("an administrator changes the mode, and Take work again resumes it", async ({ page }) => {
    const f = fixture();
    await open(page, f);
    const mode = page.getByTestId("machine-mode");
    await expect(mode.getByRole("radio", { name: "Taking work" }))
      .toBeChecked();
    // The control shows the server's state, so it changes when the update returns.
    await mode.getByRole("radio", { name: "Paused" }).click({ force: true });
    await expect(banner(page)).toContainText("It keeps the work it has.");
    await expect(mode.getByRole("status")).toHaveCount(0);
    expect(f.patches).toHaveLength(1);
    expect(f.patches[0]!.postDataJSON()).toEqual({ status: "offline" });
    expect(f.patches[0]!.headers()["if-match"]).toBe('"v1"');
    expect(f.patches[0]!.headers()["idempotency-key"]).toBeTruthy();
    await expect(banner(page)).toContainText(
      "It takes no new work until someone resumes it.",
    );
    await shot(page, "machine-page-mode");
    await banner(page).getByRole("button", { name: "Take work again" }).click();
    await expect(banner(page)).toHaveCount(0);
    expect(f.patches).toHaveLength(2);
    expect(f.patches[1]!.postDataJSON()).toEqual({ status: "online" });
    await expect(mode.getByText("Taking work again.")).toBeVisible();
    await expect(mode.getByRole("radio", { name: "Taking work" }))
      .toBeChecked();
  });

  test("someone else changed it first: the page says so and shows the latest state", async ({ page }) => {
    const f = fixture();
    f.refuseWith = 412;
    await open(page, f);
    const mode = page.getByTestId("machine-mode");
    await mode.getByRole("radio", { name: "Finish and stop" }).click({
      force: true,
    });
    await expect(
      mode.getByText(
        "Someone else changed this machine. The latest state is shown.",
      ),
    ).toBeVisible();
    await expect(mode.getByRole("radio", { name: "Taking work" }))
      .toBeChecked();
  });

  test("Retire asks first, then retires; a retired machine has no mode control", async ({ page }) => {
    const f = fixture();
    await open(page, f);
    await page.getByRole("button", { name: "Retire this machine" }).first()
      .click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText("Retire fixture-host?");
    await expect(dialog).toContainText(
      "It stops taking new work now and its sign-in to Bakery ends.",
    );
    await expect(dialog).toContainText(
      "The machine can be set up again later.",
    );
    // The one thing a person fears: what happens to what is running on it.
    await expect(dialog).toContainText(
      'If it is running tasks, retiring now cuts them off. Bakery marks each one "Lost contact" when its time runs out.',
    );
    await expect(dialog).toContainText(
      "To let them finish first, choose Finish and stop.",
    );
    await expect(dialog.getByRole("button")).toHaveText([
      "Cancel",
      "Finish and stop instead",
      "Retire now",
    ]);
    await shot(page, "machine-page-retire", [], { windowOnly: true });
    // Cancelling retires nothing.
    await dialog.getByRole("button", { name: "Cancel" }).click();
    expect(f.revokes).toHaveLength(0);
    await page.getByRole("button", { name: "Retire this machine" }).first()
      .click();
    await page.getByRole("alertdialog").getByRole("button", {
      name: "Retire now",
    }).click();
    await expect(banner(page)).toContainText(
      "It no longer takes work.",
    );
    expect(f.revokes).toHaveLength(1);
    expect(f.revokes[0]!.headers()["idempotency-key"]).toBeTruthy();
    await expect(page.getByTestId("machine-mode")).toHaveCount(0);
    await expect(page.getByTestId("machine-retire")).toHaveCount(0);
  });

  test("Finish and stop instead sets the mode, closes the dialog and retires nothing", async ({ page }) => {
    const f = fixture();
    await open(page, f);
    await page.getByRole("button", { name: "Retire this machine" }).first()
      .click();
    await page.getByRole("alertdialog").getByRole("button", {
      name: "Finish and stop instead",
    }).click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(banner(page)).toContainText(
      "It takes no new work and stops once its current work is done.",
    );
    await expect(banner(page)).toBeInViewport();
    await expect(banner(page)).toBeFocused();
    await expect(page.getByTestId("machine-mode").getByRole("status"))
      .toHaveCount(0);
    expect(f.patches).toHaveLength(1);
    expect(f.patches[0]!.postDataJSON()).toEqual({ status: "draining" });
    expect(f.revokes).toHaveLength(0);
    await shot(page, "machine-page-finish-instead", [], { windowOnly: true });
  });

  test("a retired machine has one action, Set up again, which re-pairs the same machine in the wizard's words", async ({ page }) => {
    const f = fixture({ status: "revoked", desiredMode: "revoked" });
    await page.clock.install();
    await open(page, f);
    // One action: the banner's. No second button in the header, no word "enrollment".
    await expect(page.getByRole("button", { name: /Repair|enrollment/i }))
      .toHaveCount(0);
    await banner(page).getByRole("button", { name: "Set up again" }).click();
    expect(f.repairs).toHaveLength(1);
    expect(f.repairs[0]!.headers()["idempotency-key"]).toBeTruthy();
    const setup = page.getByTestId("machine-repair");
    await expect(
      setup.getByRole("heading", { name: "Set up fixture-host again" }),
    )
      .toBeVisible();
    await expect(setup.locator("[data-ui-component=codeBlock]")).toContainText(
      "link --server http://127.0.0.1 --code REPA-IR01",
    );
    await expect(setup).toContainText("Paste it in a terminal on the machine.");
    await expect(setup).toContainText("Works once, for 10 minutes");
    await expect(setup.getByTestId("machine-add-status")).toHaveText(
      "Waiting for the machine · this page updates by itself",
    );
    await expect(setup.getByText(REPAIR_CODE)).toHaveCount(0);
    await expect(banner(page).getByRole("button", { name: "Set up again" }))
      .toHaveCount(0);
    await expect(page.getByText(/setup key|worker host|Run the worker/i))
      .toHaveCount(0);
    const bannerBox = await banner(page).boundingBox();
    const setupBox = await setup.boundingBox();
    expect(bannerBox!.y).toBeLessThan(setupBox!.y);
    await shot(page, "machine-page-set-up-again");
    await page.clock.fastForward(2 * 60_000 + 1_000);
    await expect(setup.getByTestId("machine-add-status")).toHaveText(
      "Still waiting. If the terminal shows an error, it says what to do.",
    );
    await setup.getByRole("button", { name: "Set up by hand instead" }).click();
    await expect(setup.getByText(REPAIR_CODE)).toBeVisible();
    await expect(setup.locator("[data-ui-component=codeBlock]").first())
      .not.toContainText("link --server");
    await expect(setup).toContainText("BAKERY_WORKER_NAME=fixture-host");
    await expect(setup).toContainText("BAKERY_CLAUDE_HARNESS=1");
    await expect(setup.getByText("Waiting for the machine to connect…"))
      .toHaveCount(0);
    await expect(setup.getByText("is not a supported system yet"))
      .toHaveCount(0);
    expect(f.repairs).toHaveLength(1);
    await shot(page, "machine-page-set-up-by-hand");
    f.repairState = "consumed";
    await expect(async () => {
      await page.clock.fastForward(30_000);
      await expect(page.getByTestId("machine-repair")).toHaveCount(0, {
        timeout: 2_000,
      });
    }).toPass();
  });

  test("Set up again with a code still pending replaces it with a new command", async ({ page }) => {
    const f = fixture({ status: "revoked", desiredMode: "revoked" }, {
      pendingRepair: true,
    });
    await open(page, f);
    await banner(page).getByRole("button", { name: "Set up again" }).click();
    await expect(
      page.getByTestId("machine-repair").locator(
        "[data-ui-component=codeBlock]",
      ),
    ).toBeVisible();
    expect(f.cancels).toBe(1);
    expect(f.repairs).toHaveLength(2);
    await expect(page.getByText("Bakery could not start the setup."))
      .toHaveCount(0);
  });

  test("a command that expired unused is taken away and offers a new one", async ({ page, context }) => {
    const f = fixture({ status: "revoked", desiredMode: "revoked" });
    await page.clock.install();
    await open(page, f);
    await banner(page).getByRole("button", { name: "Set up again" }).click();
    const setup = page.getByTestId("machine-repair");
    await expect(setup.locator("[data-ui-component=codeBlock]")).toBeVisible();
    f.repairState = "expired";
    await expect(async () => {
      await page.clock.fastForward(30_000);
      await expect(setup).toContainText(
        "This command expired before it was used.",
        { timeout: 2_000 },
      );
    }).toPass();
    await expect(setup.locator("[data-ui-component=codeBlock]")).toHaveCount(0);
    await shot(page, "machine-page-set-up-expired");
    f.repairState = "pending";
    await context.setOffline(true);
    await expect(setup.getByRole("button", { name: "Get a new command" }))
      .toBeDisabled();
    await context.setOffline(false);
    await setup.getByRole("button", { name: "Get a new command" }).click();
    await expect.poll(() => f.repairs.length).toBe(2);
  });

  test("a machine with a banner keeps its status word in the header", async ({ page }) => {
    await open(page, fixture({ status: "offline", connectivity: "offline" }));
    await expect(banner(page)).toBeVisible();
    const badge = page.getByTestId("machine-detail-page").locator(
      '[data-ui-component="badge"]',
    );
    await expect(badge.filter({ hasText: /^Offline$/ })).toHaveCount(1);
  });

  for (
    const [name, facts, words] of [
      [
        "finishing with work",
        {
          desiredMode: "draining",
          status: "draining",
          unsettledAttemptCount: 2,
        },
        "It finishes 2 tasks, then takes nothing new.",
      ],
      [
        "finished",
        {
          desiredMode: "draining",
          status: "draining",
          unsettledAttemptCount: 0,
        },
        "It has no work left. You can retire it.",
      ],
      [
        "paused with work",
        { desiredMode: "paused", status: "offline", unsettledAttemptCount: 1 },
        "1 task continues.",
      ],
    ] as const
  ) {
    test(`a machine ${name} counts its tasks in the banner`, async ({ page }) => {
      await open(page, fixture(facts));
      await expect(banner(page)).toContainText(words);
      await shot(page, `machine-page-${name.replaceAll(" ", "-")}`);
    });
  }

  for (const unsettled of [0, 2]) {
    test(`retiring a finishing machine with ${unsettled} tasks does not offer to finish`, async ({ page }) => {
      await open(
        page,
        fixture({
          desiredMode: "draining",
          status: "draining",
          unsettledAttemptCount: unsettled,
        }),
      );
      await page.getByRole("button", { name: "Retire this machine" }).first()
        .click();
      const dialog = page.getByRole("alertdialog");
      await expect(dialog).toContainText("Retire fixture-host?");
      await expect(dialog).not.toContainText("choose Finish and stop");
      await expect(dialog.getByRole("button")).toHaveText([
        "Cancel",
        "Retire now",
      ]);
      await shot(page, `machine-page-retire-finishing-${unsettled}`, [], {
        windowOnly: true,
      });
    });
  }

  test("retiring a machine with unfinished tasks says they are cut off", async ({ page }) => {
    await open(page, fixture({ unsettledAttemptCount: 2 }));
    await page.getByRole("button", { name: "Retire this machine" }).first()
      .click();
    await expect(page.getByRole("alertdialog")).toContainText(
      'It is running 2 tasks. Retiring now cuts them off, and Bakery marks each one "Lost contact" when its time runs out.',
    );
    await shot(page, "machine-page-retire-running", [], { windowOnly: true });
  });

  test("a retired machine shows its header, one banner and About, with no empty Checks or Coding agents", async ({ page }) => {
    const f = fixture({ status: "revoked", desiredMode: "revoked" }, {
      system: { os: "macos", architecture: "arm64" },
    });
    await open(page, f);
    const detail = page.getByTestId("machine-detail-page");
    await expect(banner(page)).toContainText(
      "It no longer takes work.",
    );
    await expect(
      detail.locator('[data-ui-component="badge"]').filter({
        hasText: /^Retired$/,
      }),
    ).toHaveCount(1);
    await expect(page.getByTestId("machine-about")).toBeVisible();
    await expect(page.getByTestId("machine-checks")).toHaveCount(0);
    await expect(page.getByTestId("machine-agents")).toHaveCount(0);
    await expect(detail.getByText("No failed checks reported.")).toHaveCount(0);
    await expect(detail.getByText("No software has been reported."))
      .toHaveCount(0);
  });

  test("a retired Linux machine on an unlisted processor has one banner, with the warning as a plain line under the heading", async ({ page }) => {
    const f = fixture({ status: "revoked", desiredMode: "revoked" }, {
      system: { os: "linux", architecture: "riscv64" },
    });
    await page.clock.install();
    await open(page, f);
    await banner(page).getByRole("button", { name: "Set up again" }).click();
    const setup = page.getByTestId("machine-repair");
    const warning = setup.getByText(
      "Linux riscv64 is not a supported system yet. These are the same steps this machine was set up with.",
    );
    await expect(warning).toBeVisible();
    // A line of text, not a second banner.
    await expect(
      setup.locator('[data-ui-component="alertBanner"]').filter({
        hasText: "is not a supported system yet",
      }),
    ).toHaveCount(0);
  });

  test("a retired machine on a supported system sets up again with no warning", async ({ page }) => {
    const f = fixture({ status: "revoked", desiredMode: "revoked" }, {
      system: { os: "linux", architecture: "arm64" },
    });
    await page.clock.install();
    await open(page, f);
    await banner(page).getByRole("button", { name: "Set up again" }).click();
    const setup = page.getByTestId("machine-repair");
    await expect(setup.locator("[data-ui-component=codeBlock]")).toContainText(
      "link --server",
    );
    await expect(setup.getByText("is not a supported system yet"))
      .toHaveCount(0);
  });

  test("a retired Linux machine on any processor keeps its steps, with a warning", async ({ page }) => {
    const f = fixture({ status: "revoked", desiredMode: "revoked" }, {
      system: { os: "linux", architecture: "riscv64" },
    });
    await page.clock.install();
    await open(page, f);
    await banner(page).getByRole("button", { name: "Set up again" }).click();
    const setup = page.getByTestId("machine-repair");
    await expect(setup.getByText(REPAIR_CODE)).toBeVisible();
    await expect(setup).toContainText("BAKERY_WORKER_NAME=fixture-host");
    await expect(
      setup.getByText(
        "Linux riscv64 is not a supported system yet. These are the same steps this machine was set up with.",
      ),
    ).toBeVisible();
  });

  test("a retired Mac is told it cannot be set up again, with no button and no setup made", async ({ page }) => {
    const f = fixture({ status: "revoked", desiredMode: "revoked" }, {
      system: { os: "macos", architecture: "arm64" },
    });
    await open(page, f);
    await expect(banner(page)).toContainText(
      "Bakery has no installer for this system yet, so this machine cannot be set up again.",
    );
    await expect(banner(page).getByRole("button")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Set up again" }))
      .toHaveCount(0);
    await expect(page.getByTestId("machine-repair")).toHaveCount(0);
    expect(f.repairs).toHaveLength(0);
    await shot(page, "machine-page-retired-mac");
  });

  test("Retire on a Mac says it cannot be set up again", async ({ page }) => {
    const f = fixture({}, { system: { os: "macos", architecture: "arm64" } });
    await open(page, f);
    await page.getByRole("button", { name: "Retire this machine" }).first()
      .click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText(
      "Bakery has no installer for this system yet, so it cannot be set up again.",
    );
    await expect(dialog.getByText("The machine can be set up again later."))
      .toHaveCount(0);
    // The viewport, not the page: the dialog is an overlay on the window.
    await shot(page, "machine-page-retire-mac", [], { windowOnly: true });
  });

  test("anyone but an administrator sees the page without the controls", async ({ page }) => {
    await open(
      page,
      fixture({ status: "offline", desiredMode: "paused" }),
      "developer",
    );
    await expect(banner(page)).toContainText(
      "It takes no new work until someone resumes it.",
    );
    // The fix changes the machine, so it is for administrators.
    await expect(banner(page).getByRole("button")).toHaveCount(0);
    await expect(page.getByTestId("machine-mode")).toHaveCount(0);
    await expect(page.getByTestId("machine-retire")).toHaveCount(0);
  });
});
