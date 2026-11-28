import { expect, type Page, test } from "@playwright/test";
import {
  MOCK_ORGANIZATION_ID,
  mockAuthenticatedSession,
} from "./helpers/mock-session.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { still } from "./helpers/stills.ts";

registerPageHealth(test);

const MACHINE = "00000000-0000-4000-8000-0000000000d1";
const TASK = "00000000-0000-4000-8000-0000000000d2";
const STEP = "00000000-0000-4000-8000-0000000000d3";
const WORK = `/machines/${MACHINE}/work`;

const json = (body: unknown) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify(body),
});
const problem = (status: number) => ({
  status,
  contentType: "application/problem+json",
  body: JSON.stringify({
    type: "about:blank",
    title: "Problem",
    status,
    code: status === 403 ? "AUTH_FORBIDDEN" : "RESOURCE_NOT_FOUND",
    detail: "Refused.",
  }),
});

type Attempt = {
  id: string;
  jobId: string;
  taskId: string | null;
  taskTitle: string | null;
  runStepId: string | null;
  stepKey: string | null;
  jobAction: string;
  codingAgent: "pi" | "claude_code" | "codex" | "mastra" | null;
  model: string | null;
  status:
    | "leased"
    | "running"
    | "canceling"
    | "completed"
    | "failed"
    | "canceled"
    | "lost"
    | "quarantined";
  leaseState: "active" | "expired" | "lost" | "closed" | "unknown";
  startedAt: string | null;
  createdAt: string;
};

let counter = 0;
const attempt = (overrides: Partial<Attempt>): Attempt => {
  counter += 1;
  return {
    id: `00000000-0000-4000-8000-0000000001${String(counter).padStart(2, "0")}`,
    jobId: `00000000-0000-4000-8000-0000000002${
      String(counter).padStart(2, "0")
    }`,
    taskId: null,
    taskTitle: null,
    runStepId: null,
    stepKey: null,
    jobAction: "repository.inspect",
    codingAgent: null,
    model: null,
    status: "running",
    leaseState: "active",
    startedAt: "2026-11-20T10:00:00.000Z",
    createdAt: "2026-11-20T09:59:00.000Z",
    ...overrides,
  };
};

const LONG_TITLE =
  "Make the refund window configurable for every region and say so in the help text, the emails and the admin settings page";

const NOW_ROWS = [
  attempt({
    taskId: TASK,
    taskTitle: "Write the refund policy",
    runStepId: STEP,
    stepKey: "draft",
    codingAgent: "claude_code",
    model: "claude-sonnet-5-5",
  }),
  attempt({ jobAction: "repository.inspect", startedAt: null }),
];
const ATTENTION_ROWS = [
  attempt({
    taskId: TASK,
    taskTitle: "Check the nightly export",
    status: "running",
    leaseState: "expired",
    codingAgent: "mastra",
  }),
  attempt({
    taskId: TASK,
    taskTitle: "Backfill the invoice totals",
    status: "quarantined",
    leaseState: "unknown",
    codingAgent: "claude_code",
  }),
];
const FINISHED_ROWS = [
  attempt({
    taskId: TASK,
    taskTitle: "Release notes for November",
    status: "canceled",
    leaseState: "closed",
    codingAgent: "pi",
    model: "pi-large",
  }),
  attempt({ status: "completed", leaseState: "closed", jobAction: "plan" }),
];

type Options = {
  readonly slots?: number;
  readonly occupied?: number;
  readonly connectivity?: "online" | "stale" | "offline";
  readonly status?: "online" | "revoked";
  readonly now?: readonly Attempt[];
  readonly nowSecond?: readonly Attempt[];
  readonly attempts?: number;
  readonly secondPageStatus?: number;
  readonly finished?: readonly Attempt[];
  readonly needsAttention?: readonly Attempt[];
  readonly workerStatus?: number;
  readonly failedChecks?: readonly string[];
};

async function fixture(page: Page, options: Options = {}) {
  await mockAuthenticatedSession(page);
  const worker = {
    id: MACHINE,
    principalId: "00000000-0000-4000-8000-0000000000d4",
    name: "build-host-01",
    os: "linux",
    architecture: "x86_64",
    capabilities: ["claude"],
    toolchainVersions: {},
    slots: options.slots ?? 3,
    status: options.status ?? "online",
    desiredMode: options.status === "revoked" ? "revoked" : "accepting",
    connectivity: options.connectivity ?? "online",
    readiness: "ready",
    readinessReason: null,
    failedCheckIds: options.failedChecks ?? [],
    unsettledAttemptCount: options.occupied ?? 2,
    activeAttemptCount: options.occupied ?? 2,
    lastHeartbeatAt: "2026-11-20T10:00:00.000Z",
    credentialGeneration: 1,
    archivedAt: null,
    cleanup: { state: "not_requested", requestedAt: null, confirmedAt: null },
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-20T10:00:00.000Z",
    version: 1,
  };
  await page.route(
    `**/v1/organizations/${MOCK_ORGANIZATION_ID}/effective-access`,
    (route) =>
      route.fulfill(json({
        organizationId: MOCK_ORGANIZATION_ID,
        role: "developer",
        capabilities: [],
      })),
  );
  const asked: { state: string | null; cursor: string | null }[] = [];
  const server = {
    now: options.now ?? NOW_ROWS,
    failNow: false,
  };
  await page.route(`**/v1/workers/${MACHINE}/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/attempts")) {
      const state = url.searchParams.get("state");
      const cursor = url.searchParams.get("cursor");
      asked.push({ state, cursor });
      if (options.attempts !== undefined && options.attempts !== 200) {
        return route.fulfill(problem(options.attempts));
      }
      if (state === "now") {
        if (server.failNow) return route.fulfill(problem(500));
        if (cursor === "second") {
          return options.secondPageStatus === undefined
            ? route.fulfill(json({
              items: options.nowSecond ?? [],
              nextCursor: null,
            }))
            : route.fulfill(problem(options.secondPageStatus));
        }
        return route.fulfill(json({
          items: server.now,
          nextCursor: options.nowSecond === undefined ? null : "second",
        }));
      }
      return route.fulfill(json({
        items: state === "needs_attention"
          ? options.needsAttention ?? ATTENTION_ROWS
          : options.finished ?? FINISHED_ROWS,
        nextCursor: null,
      }));
    }
    if (url.pathname.endsWith("/dispatch-blockers")) {
      return route.fulfill(json({
        workerHostId: MACHINE,
        reason: null,
        connectivity: worker.connectivity,
        allBlocked: false,
        blockedCapabilities: [],
        failedChecks: [],
        credentialGeneration: 1,
        inventoryRevision: 1,
        meteredModelReady: false,
      }));
    }
    return route.fulfill(json({ items: [], nextCursor: null }));
  });
  await page.route(
    `**/v1/workers/${MACHINE}`,
    (route) =>
      route.fulfill(
        options.workerStatus === undefined
          ? json(worker)
          : problem(options.workerStatus),
      ),
  );
  await page.route(
    (url) => url.pathname === "/v1/workers",
    (route) => route.fulfill(json({ items: [worker], nextCursor: null })),
  );
  return { asked, server };
}

const rowsOf = (page: Page) => page.locator("[data-attempt]");

test.describe("machine page: Work", () => {
  test("shows the three numbers and the work the server says is current", async ({ page }) => {
    const { asked } = await fixture(page);
    await page.goto(WORK);
    await expect(page.getByRole("tab", { name: /^Work/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.getByTestId("machine-slots")).toHaveText(
      /Tasks at once\s*3\s*Running now\s*2\s*Free\s*1/,
    );
    await expect(rowsOf(page)).toHaveCount(2);
    expect(
      asked.filter((entry) => entry.state === "now").every((entry) =>
        entry.cursor === null
      ),
    ).toBe(true);
    const first = rowsOf(page).nth(0);
    await expect(first.getByRole("link", { name: "Write the refund policy" }))
      .toHaveAttribute("href", `/tasks/${TASK}`);
    await expect(first.getByRole("link", { name: /draft/ }))
      .toHaveAttribute("href", `/tasks/${TASK}?at=step:${STEP}`);
    await expect(first).toContainText("Claude Code · claude-sonnet-5-5");
    await expect(first).toContainText("Running");
    const second = rowsOf(page).nth(1);
    await expect(second).toContainText("Repository check");
    await expect(second.getByRole("link")).toHaveCount(0);
    await expect(second).toContainText("Not started");
    await expect(second).toContainText("Not reported");
    await expect(page.getByTestId("machine-work")).not.toContainText(
      /Slot|attempt|unoccupied|repository\.inspect/,
    );
    await page.mouse.move(700, 700);
    await still(page, "machine-work-now");
  });

  test("Free never goes below zero, and does not come from the rows", async ({ page }) => {
    await fixture(page, { slots: 1, occupied: 3 });
    await page.goto(WORK);
    await expect(page.getByTestId("machine-slots")).toHaveText(
      /Tasks at once\s*1\s*Running now\s*3\s*Free\s*0/,
    );
    await expect(rowsOf(page)).toHaveCount(2);
  });

  test("the tab counts the work that needs a look, and each such row says what happened", async ({ page }) => {
    await fixture(page, { connectivity: "stale" });
    await page.goto(WORK);
    await expect(page.getByRole("tab", { name: /^Work/ })).toContainText(
      "2 need a look",
    );
    await page.getByRole("radio", { name: "Needs a look" }).click();
    await expect(rowsOf(page)).toHaveCount(2);
    const lost = rowsOf(page).filter({ hasText: "Check the nightly export" });
    await expect(lost).toContainText("Lost contact");
    await expect(lost).not.toContainText("Running");
    await expect(lost).toContainText(
      /Bakery stopped hearing from this machine at .+\. The work was not finished here\. Open the task to carry on\./,
    );
    const unknown = rowsOf(page).filter({
      hasText: "Backfill the invoice totals",
    });
    await expect(unknown).toContainText("Unknown");
    await expect(unknown).toContainText(
      "Bakery cannot tell whether this finished. It is waiting for the machine to report. Nothing is run again until it is known.",
    );
    await expect(page.getByText(/these counts are as of/)).toHaveCount(0);
    await page.mouse.move(700, 700);
    await still(page, "machine-work-needs-a-look");
  });

  test("the tabs follow the design's order, with failed checks counted", async ({ page }) => {
    await fixture(page, { failedChecks: ["disk_threshold"] });
    await page.goto(WORK);
    await expect(page.getByRole("tab")).toHaveText([
      "Overview",
      "Models",
      /^Work/,
      /^Checks and software\s*1 failed$/,
    ]);
  });

  test("work being stopped says who is finishing up, and no count shows when nothing needs a look", async ({ page }) => {
    await fixture(page, {
      needsAttention: [],
      now: [
        attempt({
          taskId: TASK,
          taskTitle: "Fix webhook retries",
          status: "canceling",
        }),
        attempt({ status: "canceling" }),
      ],
    });
    await page.goto(WORK);
    await expect(rowsOf(page).first()).toContainText("Stopping");
    await expect(rowsOf(page).first()).toContainText(
      "Someone stopped this task. The machine is finishing up.",
    );
    await expect(rowsOf(page).nth(1)).toContainText(
      "Someone stopped this work. The machine is finishing up.",
    );
    await expect(page.getByRole("tab", { name: /^Work/ })).toHaveText("Work");
    await page.mouse.move(700, 700);
    await still(page, "machine-work-stopping");
  });

  test("Finished shows cancelled work as cancelled, not as success", async ({ page }) => {
    const { asked } = await fixture(page);
    await page.goto(WORK);
    await page.getByRole("radio", { name: "Finished" }).click();
    await expect(rowsOf(page)).toHaveCount(2);
    const canceled = rowsOf(page).filter({
      hasText: "Release notes for November",
    });
    await expect(canceled).toContainText("Cancelled");
    await expect(canceled).not.toContainText("Completed");
    expect(asked.some((entry) => entry.state === "finished")).toBe(true);
    await page.mouse.move(700, 700);
    await still(page, "machine-work-finished");
  });

  test("rows refresh by themselves, so finished work leaves Now", async ({ page }) => {
    await page.clock.install();
    const { server } = await fixture(page);
    await page.goto(WORK);
    await expect(rowsOf(page)).toHaveCount(2);
    server.now = [NOW_ROWS[1]!];
    await page.clock.runFor(16_000);
    await expect(rowsOf(page)).toHaveCount(1);
  });

  test("a failed refresh says so, keeps the rows, and Try again reads again", async ({ page }) => {
    await page.clock.install();
    const { asked, server } = await fixture(page);
    await page.goto(WORK);
    await expect(rowsOf(page)).toHaveCount(2);
    server.failNow = true;
    await page.clock.runFor(30_000);
    await expect(page.getByText("This list could not be refreshed."))
      .toBeVisible();
    await expect(page.getByText("More work could not be loaded."))
      .toHaveCount(0);
    await expect(rowsOf(page)).toHaveCount(2);
    await page.mouse.move(700, 700);
    await still(page, "machine-work-refresh-failed");
    server.failNow = false;
    const before = asked.length;
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByText("This list could not be refreshed."))
      .toHaveCount(0);
    expect(asked.length).toBeGreaterThan(before);
  });

  test("Load more asks for the next page of the same state and keeps the rows it has", async ({ page }) => {
    const { asked } = await fixture(page, {
      nowSecond: [
        attempt({ taskId: TASK, taskTitle: "A later one", status: "leased" }),
      ],
    });
    await page.goto(WORK);
    await expect(rowsOf(page)).toHaveCount(2);
    await page.getByRole("button", { name: "Load more" }).click();
    await expect(rowsOf(page)).toHaveCount(3);
    await expect(rowsOf(page).last()).toContainText("A later one");
    expect(
      asked.some((entry) => entry.state === "now" && entry.cursor === "second"),
    ).toBe(true);
    await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(
      0,
    );
  });

  test("a next page that fails says so, and Try again asks for that page again", async ({ page }) => {
    const { asked } = await fixture(page, {
      nowSecond: [attempt({ taskId: TASK, taskTitle: "Never seen" })],
      secondPageStatus: 500,
    });
    await page.goto(WORK);
    await expect(rowsOf(page)).toHaveCount(2);
    await page.getByRole("button", { name: "Load more" }).click();
    await expect(page.getByText("More work could not be loaded."))
      .toBeVisible();
    await expect(rowsOf(page)).toHaveCount(2);
    const asks = () =>
      asked.filter((entry) => entry.cursor === "second").length;
    const before = asks();
    await page.getByRole("button", { name: "Try again" }).click();
    await expect.poll(asks).toBeGreaterThan(before);
  });

  test("each state says plainly when it has nothing", async ({ page }) => {
    await fixture(page, { now: [], finished: [], needsAttention: [] });
    await page.goto(WORK);
    await expect(page.getByText("Nothing is running on this machine."))
      .toBeVisible();
    await page.mouse.move(700, 700);
    await still(page, "machine-work-empty");
    await page.getByRole("radio", { name: "Needs a look" }).click();
    await expect(page.getByText("Nothing needs a look")).toBeVisible();
    await page.getByRole("radio", { name: "Finished" }).click();
    await expect(page.getByText("No finished work yet")).toBeVisible();
    await expect(rowsOf(page)).toHaveCount(0);
  });

  test("a work read that fails shows a retry, not 'no work'", async ({ page }) => {
    await fixture(page, { attempts: 500 });
    await page.goto(WORK);
    await expect(page.getByText("The work on this machine did not load."))
      .toBeVisible();
    await expect(page.getByText("Nothing is running on this machine."))
      .toHaveCount(0);
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  });

  test("someone who may not read the work sees no rows", async ({ page }) => {
    await fixture(page, { attempts: 403 });
    await page.goto(WORK);
    await expect(page.getByText("You cannot see this machine's work"))
      .toBeVisible();
    await expect(rowsOf(page)).toHaveCount(0);
  });

  test("a machine that does not exist says it was not found and leads back", async ({ page }) => {
    await fixture(page, { workerStatus: 404, attempts: 404 });
    await page.goto(WORK);
    await expect(page.getByText("This machine was not found")).toBeVisible();
    await expect(page.getByText(/Check your connection/)).toHaveCount(0);
    await expect(page.getByText(MACHINE)).toHaveCount(0);
    await page.mouse.move(700, 700);
    await still(page, "machine-work-not-found");
    await page.getByRole("button", { name: "Back to machines" }).click();
    await expect(page).toHaveURL("/machines");
  });

  test("a retired machine keeps its history", async ({ page }) => {
    await fixture(page, { status: "revoked", occupied: 0 });
    await page.goto(WORK);
    await page.getByRole("radio", { name: "Finished" }).click();
    await expect(rowsOf(page)).toHaveCount(2);
    await expect(page.getByRole("button", { name: /Retire/ })).toHaveCount(0);
  });

  test("a row opens its task from the keyboard", async ({ page }) => {
    await fixture(page);
    await page.goto(WORK);
    const link = page.getByRole("link", { name: "Write the refund policy" });
    await link.focus();
    await expect(link).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(`/tasks/${TASK}`);
  });

  test("a long task title never runs into its step link", async ({ page }) => {
    await fixture(page, {
      now: [
        attempt({
          taskId: TASK,
          taskTitle: LONG_TITLE,
          runStepId: STEP,
          stepKey: "implement-the-regional-refund-window",
          codingAgent: "claude_code",
          model: "claude-opus-5-5",
          status: "leased",
          startedAt: null,
        }),
      ],
    });
    await page.goto(WORK);
    const title = await page.getByRole("link", { name: LONG_TITLE })
      .boundingBox();
    const step = await page.getByRole("link", { name: /implement-the/ })
      .boundingBox();
    const apart = title!.x + title!.width <= step!.x ||
      step!.x + step!.width <= title!.x ||
      title!.y + title!.height <= step!.y ||
      step!.y + step!.height <= title!.y;
    expect(apart).toBe(true);
    await page.mouse.move(700, 700);
    await still(page, "machine-work-long-title");
  });
});
