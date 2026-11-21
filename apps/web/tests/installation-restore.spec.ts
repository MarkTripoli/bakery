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

// #64 E4 (design-ux E3): the Finish the restore page takes the three steps of
// the ordered re-enable of a restored installation, in order.

const BACKUP = "bakery-backup-2026-11-20T03-00-00Z-full-stack-9f3c1a7e";
const STEPS = ["intake", "dispatch", "workers"] as const;
type Step = typeof STEPS[number];

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
  dispatchEnabledAt: taken >= 2 ? "2026-11-21T09:40:00.000Z" : null,
  workersEnabledAt: taken >= 3 ? "2026-11-21T10:05:00.000Z" : null,
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
  await expect(stepCard(page, "workers")).toContainText("Waits for step 1.");
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
  await page.mouse.move(700, 100);
  await still(page, "restore-finished");
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

test("the Installation navigation shows Restore while a restore holds Bakery, and not when none exists", async ({ page }) => {
  await restoreWorld(page);
  await open(page);
  const nav = page.getByRole("navigation", { name: "Installation" });
  const item = nav.getByRole("link", { name: /Restore/ });
  await expect(item).toBeVisible();
  await expect(item.getByText("Held")).toBeVisible();
  // Nothing held and nothing ever restored: no item.
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await restoreWorld(page, { taken: null });
  await page.goto("/installation/settings", { waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("navigation", { name: "Installation" })
      .getByRole("link", { name: "Settings" }),
  ).toBeVisible();
  await expect(nav.getByRole("link", { name: /Restore/ })).toHaveCount(0);
});
