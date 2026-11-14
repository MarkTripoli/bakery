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
  /** The next update is refused with this status. */
  refuseWith: number | null;
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
    refuseWith: null,
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
      }));
    }
    return route.fulfill(json({ items: [], nextCursor: null }));
  });
  await page.route(
    (url) => url.pathname === `/v1/workers/${MACHINE_ID}/enrollments`,
    (route) => {
      f.repairs.push(route.request());
      return route.fulfill(json({
        enrollmentId: REPAIR_ID,
        enrollmentToken: REPAIR_CODE,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      }, 201));
    },
  );
  await page.route(
    (url) => url.pathname === `/v1/worker-enrollments/${REPAIR_ID}`,
    (route) =>
      route.fulfill(json({
        enrollmentId: REPAIR_ID,
        organizationId: MOCK_ORGANIZATION_ID,
        state: f.repairState,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        workerHostId: f.repairState === "consumed" ? MACHINE_ID : null,
        worker: null,
        version: 1,
        snapshotCursor: null,
      })),
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
    id: MACHINE_ID,
    principalId: "00000000-0000-4000-8000-0000000000a2",
    name: "fixture-host",
    os: "linux",
    architecture: "x86_64",
    capabilities: ["claude"],
    toolchainVersions: {},
    slots: 2,
    status: f.facts.status,
    desiredMode: f.facts.desiredMode,
    connectivity: f.facts.connectivity,
    readiness: f.facts.readiness,
    readinessReason: f.facts.readinessReason,
    failedCheckIds: f.facts.failedCheckIds,
    lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
    credentialGeneration: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    version: f.facts.version,
  };
}

const banner = (page: Page) => page.getByTestId("machine-problem-banner");

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
      title: "Offline. Bakery cannot reach it.",
      body: "Check that the machine is on and the Bakery worker is running.",
      fix: null,
      tone: "warning",
    },
    {
      name: "not responding",
      facts: { connectivity: "stale" },
      title: "Not responding. It has stopped answering Bakery.",
      body: "Work is not sent to it until it answers again.",
      fix: null,
      tone: "warning",
    },
    {
      // Someone chose it: nothing is wrong, so it is information, not amber.
      name: "paused",
      facts: { status: "offline", desiredMode: "paused" },
      title: "Paused. It takes no new work until someone resumes it.",
      body: "It keeps the work it has.",
      fix: "Take work again",
      tone: "information",
    },
    {
      name: "finishing up",
      facts: { status: "draining", desiredMode: "draining" },
      title: "Finishing its current work. It takes no new work.",
      body: null,
      fix: "Take work again",
      tone: "information",
    },
    {
      name: "retired",
      facts: { status: "revoked", desiredMode: "revoked" },
      title: "Retired. It no longer takes work.",
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
      await expect(banner(page)).toHaveAttribute("data-variant", item.tone);
      // The status is the badge and the banner: not a third time in the line under the name.
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
    await expect(detail.getByText("No failed checks reported.")).toBeVisible();
    await expect(banner(page)).toHaveCount(0);
    // One section about the machine, one line each: no section per fact.
    const about = page.getByTestId("machine-about");
    await expect(about.getByRole("heading", { name: "About this machine" }))
      .toBeVisible();
    await expect(about).toContainText("System");
    await expect(about).toContainText("Linux");
    await expect(about).toContainText("Processor");
    await expect(about).toContainText("x86_64");
    await expect(about).toContainText("Tasks at once");
    await expect(about).toContainText("Software");
    await expect(about).toContainText("No software has been reported.");
    await expect(detail.getByRole("heading", { name: "Capacity" })).toHaveCount(
      0,
    );
    // The line under the name is where it is and when it was last seen, not its status.
    await expect(detail.getByText(/^Linux · x86_64 · Last seen /))
      .toBeVisible();
    // Until the coding-agent rows exist the old section has no internal words.
    await expect(detail.getByRole("heading", { name: "Coding agents" }))
      .toBeVisible();
    await expect(detail.getByText("No coding agent is set up yet."))
      .toBeVisible();
    await expect(detail.getByText(/Provider bindings|provider bindings/))
      .toHaveCount(0);
    await shot(page, "machine-page-ready");
    const axe = await new AxeBuilder({ page }).analyze();
    expect(axe.violations.map((v) => v.id)).toEqual([]);
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
    // The button says it: the banner does not also say "see the checks".
    await expect(banner(page)).not.toContainText("See the checks below.");
    const checks = page.getByTestId("machine-checks");
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
    await expect(page.getByTestId("machine-checks")).toContainText(
      "The coding agent cannot make a working copy of a repository.",
    );
  });
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
    await expect(mode.getByText("Paused. It keeps the work it has."))
      .toBeVisible();
    expect(f.patches).toHaveLength(1);
    expect(f.patches[0]!.postDataJSON()).toEqual({ status: "offline" });
    expect(f.patches[0]!.headers()["if-match"]).toBe('"v1"');
    expect(f.patches[0]!.headers()["idempotency-key"]).toBeTruthy();
    await expect(banner(page)).toContainText("Paused.");
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
      "It stops taking new work now and its sign-in to Bakery ends. The machine can be added again later.",
    );
    // The one thing a person fears: what happens to what is running on it.
    await expect(dialog).toContainText(
      "Tasks running on it are not stopped or moved. Its sign-in ends, so it can no longer report on them.",
    );
    await shot(page, "machine-page-retire");
    // Cancelling retires nothing.
    await dialog.getByRole("button", { name: "Cancel" }).click();
    expect(f.revokes).toHaveLength(0);
    await page.getByRole("button", { name: "Retire this machine" }).first()
      .click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Retire" })
      .click();
    await expect(banner(page)).toContainText(
      "Retired. It no longer takes work.",
    );
    expect(f.revokes).toHaveLength(1);
    expect(f.revokes[0]!.headers()["idempotency-key"]).toBeTruthy();
    await expect(page.getByTestId("machine-mode")).toHaveCount(0);
    await expect(page.getByTestId("machine-retire")).toHaveCount(0);
  });

  test("a retired machine has one action, Set up again, which re-pairs the same machine in the wizard's words", async ({ page }) => {
    const f = fixture({ status: "revoked", desiredMode: "revoked" });
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
    await expect(setup.getByText(REPAIR_CODE)).toBeVisible();
    await expect(
      setup.getByText(
        "The Bakery worker is the program that runs agents on this machine.",
      ),
    ).toBeVisible();
    await expect(setup).toContainText("BAKERY_WORKER_NAME=fixture-host");
    await expect(setup).toContainText("BAKERY_CLAUDE_HARNESS=1");
    await expect(
      setup.getByRole("status").filter({
        hasText: "Waiting for the machine to connect…",
      }),
    ).toBeVisible();
    // The old panel's words are gone.
    await expect(page.getByText(/setup key|worker host|Run the worker/i))
      .toHaveCount(0);
    await shot(page, "machine-page-set-up-again");
    // It connects: the page says so.
    f.repairState = "consumed";
    await expect(page.getByText("fixture-host is connected.")).toBeVisible({
      timeout: 30_000,
    });
  });

  test("anyone but an administrator sees the page without the controls", async ({ page }) => {
    await open(
      page,
      fixture({ status: "offline", desiredMode: "paused" }),
      "developer",
    );
    await expect(banner(page)).toContainText("Paused.");
    // The fix changes the machine, so it is for administrators.
    await expect(banner(page).getByRole("button")).toHaveCount(0);
    await expect(page.getByTestId("machine-mode")).toHaveCount(0);
    await expect(page.getByTestId("machine-retire")).toHaveCount(0);
  });
});
