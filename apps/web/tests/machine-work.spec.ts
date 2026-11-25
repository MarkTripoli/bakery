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

const NOW_ROWS = [
  attempt({
    taskId: TASK,
    taskTitle: "Write the refund policy",
    runStepId: STEP,
    stepKey: "draft",
    codingAgent: "claude_code",
    model: "claude-sonnet-5-5",
  }),
  attempt({
    jobAction: "repository.inspect",
    status: "canceling",
    startedAt: null,
    leaseState: "unknown",
  }),
];
const ATTENTION_ROWS = [
  attempt({
    taskId: TASK,
    taskTitle: "Plan the onboarding checks",
    status: "lost",
    leaseState: "expired",
    codingAgent: "codex",
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
    failedCheckIds: [],
    unsettledAttemptCount: 0,
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
        if (cursor === "second") {
          return options.secondPageStatus === undefined
            ? route.fulfill(json({
              items: options.nowSecond ?? [],
              nextCursor: null,
            }))
            : route.fulfill(problem(options.secondPageStatus));
        }
        return route.fulfill(json({
          items: options.now ?? NOW_ROWS,
          nextCursor: options.nowSecond === undefined ? null : "second",
        }));
      }
      return route.fulfill(json({
        items: state === "needs_attention" ? ATTENTION_ROWS : FINISHED_ROWS,
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
      }));
    }
    return route.fulfill(json({ items: [], nextCursor: null }));
  });
  await page.route(
    `**/v1/workers/${MACHINE}`,
    (route) => route.fulfill(json(worker)),
  );
  await page.route(
    (url) => url.pathname === "/v1/workers",
    (route) => route.fulfill(json({ items: [worker], nextCursor: null })),
  );
  return { asked };
}

const phoneNow = (page: Page) => (page.viewportSize()?.width ?? 1440) < 600;
const rowsOf = (page: Page) => page.locator("[data-attempt]");

test.describe("machine page: Work", () => {
  test("shows the slots and the work the server says is current, row by row", async ({ page }) => {
    const { asked } = await fixture(page);
    await page.goto(WORK);
    await expect(page.getByRole("tab", { name: "Work" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const slots = page.getByTestId("machine-slots");
    await expect(slots).toContainText("Slots");
    await expect(page.getByTestId("machine-slot-line")).toHaveText(
      "3 in total, 2 occupied, 1 unoccupied.",
    );
    await expect(slots).toContainText(
      "A slot is held by one attempt: work being run, being cancelled, or a check with no task. It is not one task.",
    );
    await expect(rowsOf(page)).toHaveCount(2);
    expect(
      asked.every((entry) => entry.state === "now" && entry.cursor === null),
    ).toBe(true);
    const first = rowsOf(page).nth(0);
    await expect(first.getByRole("link", { name: "Write the refund policy" }))
      .toHaveAttribute("href", `/tasks/${TASK}`);
    await expect(first.getByRole("link", { name: "Step draft" }))
      .toHaveAttribute("href", `/tasks/${TASK}?at=step:${STEP}`);
    await expect(first).toContainText("Claude Code · claude-sonnet-5-5");
    await expect(first).toContainText("Running");
    await expect(first).toContainText("Slot held");
    const second = rowsOf(page).nth(1);
    await expect(second).toContainText("No task:");
    await expect(second).toContainText("repository.inspect");
    await expect(second.getByRole("link")).toHaveCount(0);
    await expect(second).toContainText("Being cancelled");
    await expect(second).toContainText("Not started");
    await expect(second).toContainText("Not reported");
    await page.mouse.move(700, 700);
    await still(page, "machine-work-now");
  });

  test("the unoccupied slots never go below zero, and do not come from the rows", async ({ page }) => {
    await fixture(page, { slots: 1, occupied: 3 });
    await page.goto(WORK);
    await expect(page.getByTestId("machine-slot-line")).toHaveText(
      "1 in total, 3 occupied, 0 unoccupied.",
    );
    await expect(rowsOf(page)).toHaveCount(2);
  });

  test("Needs attention and Finished ask the server for their own state and show its rows as they come", async ({ page }) => {
    const { asked } = await fixture(page);
    await page.goto(WORK);
    await expect(rowsOf(page)).toHaveCount(2);
    await page.getByRole("radio", { name: "Needs attention" }).click();
    await expect(rowsOf(page)).toHaveCount(1);
    await expect(rowsOf(page).first()).toContainText(
      "Plan the onboarding checks",
    );
    await expect(rowsOf(page).first()).toContainText("Lost contact");
    await expect(rowsOf(page).first()).toContainText("Slot hold ran out");
    await page.getByRole("radio", { name: "Finished" }).click();
    await expect(rowsOf(page)).toHaveCount(2);
    const canceled = rowsOf(page).filter({
      hasText: "Release notes for November",
    });
    await expect(canceled).toContainText("Cancelled");
    await expect(canceled).not.toContainText("Completed");
    expect(
      asked.map((entry) => entry.state).filter((state, index, all) =>
        state !== all[index - 1]
      ),
    ).toEqual(["now", "needs_attention", "finished"]);
    await page.mouse.move(700, 700);
    await still(page, "machine-work-finished");
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
    expect(asked.slice(-1)[0]).toEqual({ state: "now", cursor: "second" });
    await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(
      0,
    );
  });

  test("a page that fails to load says so, keeps the rows and offers Try again", async ({ page }) => {
    await fixture(page, {
      nowSecond: [attempt({ taskId: TASK, taskTitle: "Never seen" })],
      secondPageStatus: 500,
    });
    await page.goto(WORK);
    await expect(rowsOf(page)).toHaveCount(2);
    await page.getByRole("button", { name: "Load more" }).click();
    await expect(page.getByText("More work could not be loaded."))
      .toBeVisible();
    await expect(rowsOf(page)).toHaveCount(2);
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  });

  test("each state says plainly when it has nothing", async ({ page }) => {
    await fixture(page, { now: [] });
    await page.goto(WORK);
    await expect(page.getByText("Nothing is running on this machine"))
      .toBeVisible();
    await page.getByRole("radio", { name: "Finished" }).click();
    await expect(rowsOf(page)).toHaveCount(2);
    await page.mouse.move(700, 700);
    await still(page, "machine-work-empty");
  });

  test("a work read that fails shows a retry, not 'no work'", async ({ page }) => {
    await fixture(page, { attempts: 500 });
    await page.goto(WORK);
    await expect(page.getByText("The work on this machine did not load."))
      .toBeVisible();
    await expect(page.getByText("Nothing is running on this machine"))
      .toHaveCount(0);
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  });

  test("someone who may not read it sees no rows, and a missing machine says so", async ({ page }) => {
    await fixture(page, { attempts: 403 });
    await page.goto(WORK);
    await expect(page.getByText("You cannot see this machine's work"))
      .toBeVisible();
    await expect(rowsOf(page)).toHaveCount(0);
  });

  test("a machine that is not answering says its counts are as of its last report", async ({ page }) => {
    await fixture(page, { connectivity: "stale" });
    await page.goto(WORK);
    await expect(
      page.getByText(
        /This machine is not answering, so these counts are as of/,
      ),
    ).toBeVisible();
    await page.mouse.move(700, 700);
    await still(page, "machine-work-stale");
  });

  test("a retired machine keeps its history", async ({ page }) => {
    await fixture(page, { status: "revoked", occupied: 0 });
    await page.goto(WORK);
    await page.getByRole("radio", { name: "Finished" }).click();
    await expect(rowsOf(page)).toHaveCount(2);
    await expect(page.getByRole("button", { name: /Retire/ })).toHaveCount(0);
  });

  test("a row opens its task from the keyboard on a wide screen, and the phone lists the same facts", async ({ page }) => {
    await fixture(page);
    await page.goto(WORK);
    const link = page.getByRole("link", { name: "Write the refund policy" });
    await link.focus();
    await expect(link).toBeFocused();
    if (phoneNow(page)) {
      await expect(rowsOf(page).first()).toContainText("Running");
      await expect(rowsOf(page).first()).toContainText("Slot held");
    }
  });
});
