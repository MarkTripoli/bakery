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
    body: string;
    fix: string | null;
  }[] = [
    {
      name: "offline",
      facts: { connectivity: "offline" },
      title: "Offline. Bakery cannot reach it.",
      body: "Check that the machine is on and the Bakery worker is running.",
      fix: null,
    },
    {
      name: "not responding",
      facts: { connectivity: "stale" },
      title: "Not responding. It has stopped answering Bakery.",
      body: "Work is not sent to it until it answers again.",
      fix: null,
    },
    {
      name: "paused",
      facts: { status: "offline", desiredMode: "paused" },
      title: "Paused. It takes no new work until someone resumes it.",
      body: "It keeps the work it has and takes nothing new.",
      fix: "Take work again",
    },
    {
      name: "finishing up",
      facts: { status: "draining", desiredMode: "draining" },
      title: "Finishing its current work. It takes no new work.",
      body: "It finishes its current work, then takes nothing new.",
      fix: "Take work again",
    },
    {
      name: "retired",
      facts: { status: "revoked", desiredMode: "revoked" },
      title: "Retired. It no longer takes work.",
      body: "Retired machines take no work. Add it again to use it.",
      fix: "Add machine",
    },
  ];
  for (const item of cases) {
    test(`${item.name}: what is wrong, and the one fix that exists`, async ({ page }) => {
      await open(page, fixture(item.facts));
      const detail = page.getByTestId("machine-detail-page");
      await expect(detail).toBeVisible();
      await expect(banner(page)).toContainText(item.title);
      await expect(banner(page)).toContainText(item.body);
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
    await expect(detail.getByText("2 tasks at once")).toBeVisible();
    await expect(detail.getByText("Linux x86_64 · Online · last seen"))
      .toBeVisible();
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
    const checks = page.getByTestId("machine-checks");
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

  test("the fix for a retired machine is Add machine", async ({ page }) => {
    await open(page, fixture({ status: "revoked", desiredMode: "revoked" }));
    await banner(page).getByRole("button", { name: "Add machine" }).click();
    await expect(page).toHaveURL(/\/machines\/new$/);
  });

  test("anyone but an administrator sees the page without the controls", async ({ page }) => {
    await open(
      page,
      fixture({ status: "offline", desiredMode: "paused" }),
      "developer",
    );
    await expect(banner(page)).toContainText("Paused.");
    await expect(page.getByTestId("machine-mode")).toHaveCount(0);
    await expect(page.getByTestId("machine-retire")).toHaveCount(0);
  });
});
