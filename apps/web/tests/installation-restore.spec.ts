import {
  expect as baseExpect,
  type Page,
  type Route,
  test,
} from "@playwright/test";
import { mockAuthenticatedSession } from "./helpers/mock-session.ts";
import { laneBudgetMs } from "./helpers/lane-budget.ts";
import { still } from "./helpers/stills.ts";

const expect = baseExpect.configure({ timeout: 15_000 });
test.describe.configure({ timeout: laneBudgetMs(60_000) });

// Desktop stills are taken at 1440x900, the size the evidence rule names.
test.beforeEach(async ({ page }, info) => {
  if (info.project.name === "desktop") {
    await page.setViewportSize({ width: 1440, height: 900 });
  }
});

// #64 E4 (design-ux E3): the Finish the restore page takes the three steps of
// the ordered re-enable of a restored installation, in order.

const BACKUP = "bakery-backup-2026-11-20T03-00-00Z-full-stack-9f3c1a7e";
const STEPS = ["intake", "dispatch", "workers"] as const;
type Step = typeof STEPS[number];

const ADA = {
  principalId: "00000000-0000-4000-8000-000000000001",
  displayName: "Ada Lee",
};

const record = (taken: number) => ({
  id: "00000000-0000-4000-8000-000000000901",
  backupName: BACKUP,
  cutoffAt: "2026-11-20T03:00:00.000Z",
  restoredAt: "2026-11-21T09:10:00.000Z",
  effectsHeld: 12,
  attemptsQuarantined: 2,
  jobsAwaitingReconciliation: 3,
  workersRevoked: 4,
  intakeEnabledAt: taken >= 1 ? "2026-11-21T09:22:00.000Z" : null,
  intakeEnabledBy: taken >= 1 ? ADA : null,
  dispatchEnabledAt: taken >= 2 ? "2026-11-21T09:40:00.000Z" : null,
  dispatchEnabledBy: taken >= 2 ? ADA : null,
  workersEnabledAt: taken >= 3 ? "2026-11-21T10:05:00.000Z" : null,
  workersEnabledBy: taken >= 3 ? ADA : null,
  releasedAt: taken >= 3 ? "2026-11-21T10:05:00.000Z" : null,
  nextStep: STEPS[taken] ?? null,
});

const problem = (status: number, code: string) => ({
  type: "about:blank",
  title: code,
  status,
  code,
  detail: "The server refused the request.",
  requestId: "00000000-0000-4000-8000-000000000110",
  traceId: "00000000-0000-4000-8000-000000000111",
  retryable: false,
});

type World = {
  /** Steps taken so far; null = no restore holds the installation. */
  taken: number | null;
  /** The read answers this status instead of the record. */
  readStatus: number;
  /** The step answers this instead of taking the step. */
  stepReply?: (route: Route) => Promise<void> | void;
  steps: {
    key: string | undefined;
    body: { step: Step; confirmation: string };
  }[];
};

async function restoreWorld(
  page: Page,
  overrides: Partial<World> = {},
): Promise<World> {
  const state: World = { taken: 0, readStatus: 200, steps: [], ...overrides };
  await mockAuthenticatedSession(page);
  // The public status says whether an unfinished restore holds Bakery.
  await page.route("**/v1/installation/status", (route) =>
    route.fulfill({
      json: {
        bootstrapped: true,
        restoreHeld: state.taken !== null && state.taken < 3,
      },
    }));
  await page.route("**/v1/installation/restore", (route) => {
    if (state.readStatus !== 200 || state.taken === null) {
      const status = state.taken === null && state.readStatus === 200
        ? 409
        : state.readStatus;
      return route.fulfill({
        status,
        contentType: "application/problem+json",
        json: problem(
          status,
          status === 409
            ? "RESTORE_NOT_HELD"
            : status === 403
            ? "AUTH_FORBIDDEN"
            : "INTERNAL_ERROR",
        ),
      });
    }
    return route.fulfill({ json: record(state.taken) });
  });
  await page.route("**/v1/installation/restore/steps", (route) => {
    const request = route.request();
    const body = request.postDataJSON() as World["steps"][number]["body"];
    state.steps.push({ key: request.headers()["idempotency-key"], body });
    if (state.stepReply) return state.stepReply(route);
    if (body.confirmation !== BACKUP) {
      return route.fulfill({
        status: 422,
        contentType: "application/problem+json",
        json: problem(422, "RESTORE_CONFIRMATION_MISMATCH"),
      });
    }
    state.taken = (state.taken ?? 0) + 1;
    return route.fulfill({ json: record(state.taken) });
  });
  return state;
}

const open = (page: Page) =>
  page.goto("/installation/restore", { waitUntil: "domcontentloaded" });
const stepCard = (page: Page, step: Step) =>
  page.locator(`[data-restore-step="${step}"]`);
const confirmField = (page: Page, step: Step) =>
  page.locator(`#restore-confirm-${step}`);

test("held: the record says what the restore did and only the first step can be taken", async ({ page }) => {
  await restoreWorld(page);
  await open(page);
  await expect(page.getByRole("heading", { name: "Finish the restore" }))
    .toBeVisible();
  const record = page.getByTestId("restore-record");
  await expect(record.getByText(BACKUP)).toBeVisible();
  await expect(record.getByText("12 outside actions are held")).toBeVisible();
  await expect(record.getByText("3 jobs were stopped mid-run")).toBeVisible();
  await expect(record.getByText("4 machines were disconnected")).toBeVisible();
  await expect(stepCard(page, "intake")).toHaveAttribute(
    "data-restore-state",
    "next",
  );
  await expect(stepCard(page, "dispatch")).toContainText(
    "Waits for step 1.",
  );
  // A step waits for the one before it.
  await expect(stepCard(page, "workers")).toContainText("Waits for step 2.");
  // Only the next step has controls.
  await expect(confirmField(page, "dispatch")).toHaveCount(0);
  await expect(confirmField(page, "workers")).toHaveCount(0);
  await page.mouse.move(700, 100);
  await still(page, "restore-held");
});

test("the button turns on only when the typed name matches, and a step sends the name and a key", async ({ page }) => {
  const state = await restoreWorld(page);
  await open(page);
  const button = page.getByRole("button", { name: "Turn on new work" });
  await expect(button).toBeDisabled();
  await confirmField(page, "intake").fill("not the name");
  await expect(button).toBeDisabled();
  await confirmField(page, "intake").fill(BACKUP);
  await expect(button).toBeEnabled();
  await button.click();
  await expect.poll(() => state.steps.length).toBe(1);
  expect(state.steps[0].body).toEqual({ step: "intake", confirmation: BACKUP });
  expect(state.steps[0].key).toMatch(/^[0-9a-f-]{36}$/);
  // The page moves on: step 1 is On with its time, step 2 is next.
  await expect(stepCard(page, "intake")).toContainText("Turned on");
  // The server says who took it.
  await expect(stepCard(page, "intake")).toContainText("by Ada Lee.");
  await expect(stepCard(page, "intake")).toHaveAttribute(
    "data-restore-state",
    "done",
  );
  await expect(stepCard(page, "dispatch")).toHaveAttribute(
    "data-restore-state",
    "next",
  );
});

test("steps 2 and 3 say what to run on the server first, and the name waits for the tick", async ({ page }) => {
  await restoreWorld(page, { taken: 1 });
  await open(page);
  const card = stepCard(page, "dispatch");
  await expect(
    card.getByText(
      "Bakery can't see the server, so it can't check this for you.",
    ),
  )
    .toBeVisible();
  // Each command is its own block, so it can be read and copied on its own.
  await expect(card.locator('[data-ui-component="codeBlock"]')).toHaveText([
    "runtime.sh background <sha>",
    "docker compose up -d inngest",
  ]);
  await expect(card.getByRole("link", { name: "Open the runbook" }))
    .toHaveAttribute("href", /runbooks\/backups\.md#after-a-restore$/);
  const field = confirmField(page, "dispatch");
  await expect(field).toBeDisabled();
  await card.getByRole("checkbox", { name: "I have done this on the server." })
    .check();
  await expect(field).toBeEnabled();
  await page.mouse.move(700, 100);
  await still(page, "restore-step2");
  await field.fill(BACKUP);
  await expect(page.getByRole("button", { name: "Start background work" }))
    .toBeEnabled();
});

test("a name the server refuses says so under the field and changes nothing", async ({ page }) => {
  const state = await restoreWorld(page);
  state.stepReply = (route) =>
    route.fulfill({
      status: 422,
      contentType: "application/problem+json",
      json: problem(422, "RESTORE_CONFIRMATION_MISMATCH"),
    });
  await open(page);
  await confirmField(page, "intake").fill(BACKUP);
  await page.getByRole("button", { name: "Turn on new work" }).click();
  await expect(
    page.getByText(
      "That is not the backup's name. Copy it from above. Nothing was changed.",
    ),
  ).toBeVisible();
  await expect(stepCard(page, "intake")).toHaveAttribute(
    "data-restore-state",
    "next",
  );
  await page.mouse.move(700, 100);
  await still(page, "restore-mismatch");
});

test("a step someone else already took says so and the page is up to date", async ({ page }) => {
  const state = await restoreWorld(page);
  state.stepReply = (route) => {
    // Someone took step 1 first: the read now shows it done.
    state.taken = 1;
    return route.fulfill({
      status: 409,
      contentType: "application/problem+json",
      json: problem(409, "RESTORE_STEP_ALREADY_TAKEN"),
    });
  };
  await open(page);
  await confirmField(page, "intake").fill(BACKUP);
  await page.getByRole("button", { name: "Turn on new work" }).click();
  await expect(
    page.getByText(
      "Someone already did this step. The page is up to date now.",
    ),
  ).toBeVisible();
  await expect(stepCard(page, "intake")).toHaveAttribute(
    "data-restore-state",
    "done",
  );
});

test("a failed step says nothing changed and can be tried again with the same key", async ({ page }) => {
  const state = await restoreWorld(page);
  let attempt = 0;
  state.stepReply = (route) => {
    attempt += 1;
    if (attempt === 1) {
      return route.fulfill({
        status: 500,
        contentType: "application/problem+json",
        json: problem(500, "INTERNAL_ERROR"),
      });
    }
    state.taken = 1;
    return route.fulfill({ json: record(1) });
  };
  await open(page);
  await confirmField(page, "intake").fill(BACKUP);
  const button = page.getByRole("button", { name: "Turn on new work" });
  await button.click();
  await expect(
    page.getByText("The step was not taken. Nothing changed. Try again."),
  ).toBeVisible();
  await button.click();
  await expect(stepCard(page, "intake")).toContainText("Turned on");
  expect(state.steps).toHaveLength(2);
  // The same step with the same name is the same request.
  expect(state.steps[1].key).toBe(state.steps[0].key);
});

test("after the last step the hold has ended and the page says what to do next", async ({ page }) => {
  await restoreWorld(page, { taken: 3 });
  await open(page);
  await expect(page.getByText("Restore finished")).toBeVisible();
  await expect(
    page.getByText(
      "The hold has ended. Bakery is taking and running work again.",
    ),
  ).toBeVisible();
  await expect(stepCard(page, "workers")).toHaveAttribute(
    "data-restore-state",
    "done",
  );
  // What to do next names the held actions and offers both places to look.
  await expect(page.getByText("What to do next")).toBeVisible();
  await expect(page.getByText(/then look at the 12 held outside actions\./))
    .toBeVisible();
  // The two places to look are the buttons that end the page.
  await expect(page.getByRole("button", { name: "Open Machines" }))
    .toBeEnabled();
  await expect(page.getByRole("button", { name: "Open Audit" })).toBeEnabled();
  await page.mouse.move(700, 100);
  await still(page, "restore-finished");
});

test("one confirmation covers one step: each next step starts unticked, empty and off", async ({ page }) => {
  const state = await restoreWorld(page);
  await open(page);
  // Step 1: type the name and take it.
  await confirmField(page, "intake").fill(BACKUP);
  await page.getByRole("button", { name: "Turn on new work" }).click();
  await expect(stepCard(page, "dispatch")).toHaveAttribute(
    "data-restore-state",
    "next",
  );
  // Step 2 begins blank: nothing carried over from step 1.
  const tick2 = stepCard(page, "dispatch").getByRole("checkbox", {
    name: "I have done this on the server.",
  });
  await expect(tick2).not.toBeChecked();
  await expect(confirmField(page, "dispatch")).toHaveValue("");
  await expect(confirmField(page, "dispatch")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Start background work" }))
    .toBeDisabled();
  // Tick and type, then take it.
  await tick2.check();
  await expect(confirmField(page, "dispatch")).toHaveValue("");
  await expect(page.getByRole("button", { name: "Start background work" }))
    .toBeDisabled();
  await confirmField(page, "dispatch").fill(BACKUP);
  await page.getByRole("button", { name: "Start background work" }).click();
  await expect(stepCard(page, "workers")).toHaveAttribute(
    "data-restore-state",
    "next",
  );
  // Step 3 begins blank too: the tick and the name of step 2 do not carry on.
  const tick3 = stepCard(page, "workers").getByRole("checkbox", {
    name: "I have done this on the server.",
  });
  await expect(tick3).not.toBeChecked();
  await expect(confirmField(page, "workers")).toHaveValue("");
  await expect(confirmField(page, "workers")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Let machines take work" }))
    .toBeDisabled();
  // Each step was sent once, with its own name.
  expect(state.steps.map((step) => step.body.step)).toEqual([
    "intake",
    "dispatch",
  ]);
});

test("opened when nothing is held: no restore is waiting, with a way to the audit trail", async ({ page }) => {
  await restoreWorld(page, { taken: null });
  await open(page);
  await expect(page.getByText("No restore is waiting")).toBeVisible();
  await page.mouse.move(700, 100);
  await still(page, "restore-not-held");
  await page.getByRole("button", { name: "Open Audit" }).click();
  await expect(page).toHaveURL(/\/installation\/audit$/);
});

test("only an installation administrator can finish a restore", async ({ page }) => {
  await restoreWorld(page, { readStatus: 403 });
  await open(page);
  await expect(
    page.getByText("Only an installation administrator can finish a restore"),
  ).toBeVisible();
  await expect(page.getByText("You can still read everything.")).toBeVisible();
  await page.mouse.move(700, 100);
  await still(page, "restore-forbidden");
});

test("a read that failed says so and can be tried again", async ({ page }) => {
  const state = await restoreWorld(page, { readStatus: 500 });
  await open(page);
  await expect(page.getByText("The restore could not be loaded."))
    .toBeVisible();
  state.readStatus = 200;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByTestId("restore-record")).toBeVisible();
});

test("the Installation navigation shows Restore while a restore holds Bakery and after it, and not when none ever did", async ({ page }) => {
  // On a phone the navigation is a menu, closed until it is opened.
  test.skip(
    (page.viewportSize()?.width ?? 1440) < 744,
    "the sidebar form only",
  );
  const state = await restoreWorld(page);
  await open(page);
  const nav = page.getByRole("navigation", { name: "Installation" });
  const item = nav.getByRole("link", { name: /Restore/ });
  await expect(item).toBeVisible();
  await expect(item.getByText("Held")).toBeVisible();
  // After the last step the record stays, so the item stays, without the mark.
  state.taken = 3;
  await page.goto("/installation/settings", { waitUntil: "domcontentloaded" });
  await expect(nav.getByRole("link", { name: /Restore/ })).toBeVisible();
  await expect(nav.getByRole("link", { name: /Restore/ }).getByText("Held"))
    .toHaveCount(0);
  // No restore ever: no item.
  state.taken = null;
  await page.goto("/installation/usage", { waitUntil: "domcontentloaded" });
  await expect(nav.getByRole("link", { name: "Usage" })).toBeVisible();
  await expect(nav.getByRole("link", { name: /Restore/ })).toHaveCount(0);
});

const banner = (page: Page) => page.locator('[data-ui-region="restore-held"]');

test("every page carries the held banner, with the way to finish the restore for an administrator", async ({ page }) => {
  await restoreWorld(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(banner(page).getByText("Bakery is held after a restore."))
    .toBeVisible();
  await expect(
    banner(page).getByText(
      "Nobody can start or change work until you finish the restore.",
    ),
  ).toBeVisible();
  await page.mouse.move(700, 100);
  await still(page, "restore-banner-admin");
  // The way out is a link to the page, not a button that happens to navigate.
  const finish = banner(page).getByRole("link", { name: "Finish the restore" });
  await expect(finish).toHaveAttribute("href", "/installation/restore");
  await expect(banner(page).getByRole("button")).toHaveCount(0);
  await finish.click();
  await expect(page).toHaveURL(/\/installation\/restore$/);
  // The page that finishes the restore says it in full: no second banner.
  await expect(banner(page)).toHaveCount(0);
});

test("everyone else sees the banner without a button, and who can finish the restore", async ({ page }) => {
  await restoreWorld(page, { readStatus: 403 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(
    banner(page).getByText(
      "You can read everything, but nobody can start or change work yet. An installation administrator has to finish the restore.",
    ),
  ).toBeVisible();
  await expect(banner(page).getByRole("button")).toHaveCount(0);
  await expect(banner(page).getByRole("link")).toHaveCount(0);
  await page.mouse.move(700, 100);
  await still(page, "restore-banner-member");
});

test("no banner when no restore holds Bakery, or once the last step is taken", async ({ page }) => {
  const state = await restoreWorld(page, { taken: null });
  // The status has been answered, and the page has had two frames to draw it.
  const settled = async () => {
    await page.waitForResponse("**/v1/installation/status");
    await page.evaluate(() =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      )
    );
  };
  const answered = settled();
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await answered;
  await expect(banner(page)).toHaveCount(0);
  state.taken = 3;
  const again = settled();
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await again;
  await expect(banner(page)).toHaveCount(0);
});

test(
  "the record sits beside the steps from 1280, and nothing clips at 1280 or 1440",
  async ({ page }, info) => {
    test.skip(
      info.project.name !== "desktop",
      "the two columns are a desktop layout",
    );
    await restoreWorld(page, { taken: 1 });
    for (const width of [1280, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await open(page);
      const steps = page.getByTestId("restore-steps");
      const record = page.getByTestId("restore-record");
      await expect(record.getByText(BACKUP)).toBeVisible();
      const left = await steps.boundingBox();
      const right = await record.boundingBox();
      if (left === null || right === null) throw new Error("no boxes");
      // Beside, not below: the record starts to the right of the steps and near their top.
      expect(right.x).toBeGreaterThanOrEqual(left.x + left.width - 1);
      expect(Math.abs(right.y - left.y)).toBeLessThan(120);
      // Nothing runs past the window: the page does not scroll sideways and the
      // record's column and the long backup name stay inside it.
      const overflow = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }));
      expect(overflow.scroll).toBeLessThanOrEqual(overflow.client);
      expect(right.x + right.width).toBeLessThanOrEqual(width);
      const name = await record.getByText(BACKUP).boundingBox();
      if (name === null) throw new Error("no name box");
      expect(name.x + name.width).toBeLessThanOrEqual(
        right.x + right.width + 1,
      );
    }
  },
);
