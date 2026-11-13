import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { submitUntilAccepted } from "./helpers/api-retry.ts";

/**
 * Real-API proof of the gate and run-control side of the FS26 task loop
 * against the scripted-coordinator stack described in
 * `task-conversation-real-api.spec.ts` and per-worktree stack (scripts/dev/compose-up.sh). It adds, on the real server and database:
 *
 * - a requested change on the current plan revision keeps the gated run from
 *   starting (no run is created and the gate copy stays on screen);
 * - cancel on a really admitted run with no worker attempt;
 * - a message sent during an active run is kept in the transcript across a
 *   reload and the missing live steering is stated (`steering-unsupported`);
 * - pause, resume and cancel admission for a worker that advertises `steer`
 *   (admission only; no claim that a stage is held).
 *
 * The stack runs no enrolled worker. The two attempt cases therefore graft a
 * live attempt and worker host onto the run the server admitted
 * (`tests/helpers/web-run-attempt-seed.ts`, database owner) so the real
 * capability read and control admission run. Nothing executes the attempt:
 * admitted control commands stay queued, so the spec proves admission and the
 * absence of any new stage, not a worker pausing or resuming real work.
 * Runs in `desktop-real-api` and never skips there.
 */
const realApi = process.env.BAKERY_REAL_API === "1";
const email = process.env.BAKERY_REAL_EMAIL ?? "fs26-admin@example.test";
const password = process.env.BAKERY_REAL_PASSWORD ?? "Fs26-Admin-Passw0rd-1";
const scriptDirectory = fileURLToPath(
  new URL("../../../tests/fixtures/scripted-coordinator/", import.meta.url),
);
const shotDirectory = process.env.BAKERY_FS26_SHOTS ?? "";
const helper = (name: string) =>
  fileURLToPath(new URL(`../../../tests/helpers/${name}.ts`, import.meta.url));

const placed: string[] = [];
/** Place a committed template as the scripted outcome for one conversation. */
function script(conversationId: string, template: string) {
  const target = `${scriptDirectory}${conversationId}.json`;
  copyFileSync(`${scriptDirectory}templates/${template}.json`, target);
  if (!placed.includes(target)) placed.push(target);
}

function deno(file: string, args: string[], env: Record<string, string> = {}) {
  return execFileSync("deno", [
    "run",
    "--allow-env",
    "--allow-read",
    "--allow-net",
    helper(file),
    ...args,
  ], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function shot(page: Page, name: string) {
  if (!shotDirectory) return;
  mkdirSync(shotDirectory, { recursive: true });
  await page.screenshot({
    path: `${shotDirectory}/${name}.png`,
    fullPage: true,
  });
}

const message = (page: Page) =>
  page.getByRole("textbox", { name: "Message this task" });
const approve = (page: Page, n: number) =>
  page.getByRole("button", { name: `Approve plan, version ${n}`, exact: true });

async function say(page: Page, intent: "Discuss" | "Ask agent", body: string) {
  await page.getByLabel(intent, { exact: true }).check({ force: true });
  await message(page).fill(body);
  await page.getByRole("button", { name: "Send", exact: true }).click();
}

let organizationId = "";

async function api<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(path, {
    headers: { "Bakery-Organization-Id": organizationId },
  });
  expect(response.ok(), `${path}: ${response.status()}`).toBe(true);
  return await response.json() as T;
}

type Task = { id: string; conversationId: string; currentRunId: string | null };

/** Seed, sign in, and create a plan-first task with revision 1 on screen. */
async function planned(browser: Browser) {
  deno("web-auth-seed", [email], { WEB_AUTH_SEED_PASSWORD: password });
  const seeded = JSON.parse(
    deno("web-conversation-seed", [email]).trim().split("\n").at(-1) ?? "null",
  ) as { organizationId: string; repositoryId: string; applicationId: string };
  organizationId = seeded.organizationId;
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  await page.goto("/sign-in");
  await submitUntilAccepted(page, "/api/auth/sign-in/email", async () => {
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  });
  await expect(page).toHaveURL("/");
  const created = await page.request.post("/v1/tasks", {
    headers: {
      "Bakery-Organization-Id": organizationId,
      "Idempotency-Key": crypto.randomUUID(),
      Origin: new URL(page.url()).origin,
    },
    data: {
      applicationId: seeded.applicationId,
      repositoryId: seeded.repositoryId,
      taskType: "feature",
      title: `Gate ${crypto.randomUUID().slice(0, 8)}`,
      description: "A plan whose decision gates the run.",
      approvalPolicy: { plan: "human_approval" },
    },
  });
  expect(created.status()).toBe(201);
  const task = await created.json() as Task;
  script(task.conversationId, "fs26-plan");
  await page.goto(`/tasks/${task.id}`);
  await say(page, "Ask agent", "Plan this one.");
  await expect(approve(page, 1)).toBeEnabled({ timeout: 60_000 });
  return { context, page, task };
}

/** Approve plan, version 1 and start the run; returns the admitted run id. */
async function started(page: Page, task: Task): Promise<string> {
  await approve(page, 1).click();
  await expect(page.getByText("You approved revision 1")).toBeVisible();
  // The start form reads the approval id from its own query; its hint goes
  // away once that read has caught up with the decision.
  await expect(page.getByText(
    "This task waits for an approved plan. The run starts from the plan you approve.",
  )).toHaveCount(0);
  await page.getByRole("button", { name: "Start run" }).click();
  await expect.poll(
    async () => (await api<Task>(page, `/v1/tasks/${task.id}`)).currentRunId,
    { timeout: 60_000 },
  ).not.toBeNull();
  const runId = (await api<Task>(page, `/v1/tasks/${task.id}`)).currentRunId!;
  await page.reload();
  await expect(page.getByText("A run is in progress.")).toBeVisible();
  return runId;
}

const controls = (page: Page, runId: string) =>
  api<{ actions: { action: string; canRequest: boolean; reason: string }[] }>(
    page,
    `/v1/runs/${runId}/controls`,
  );
const reasonOf = async (page: Page, runId: string, action: string) =>
  (await controls(page, runId)).actions.find((item) => item.action === action);
const controlButton = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const receipt = (page: Page) =>
  page.getByRole("status", { name: "Request sent" });

test.afterAll(() => {
  for (const file of placed) rmSync(file, { force: true });
});

test.beforeEach(() => {
  test.skip(!realApi, "set BAKERY_REAL_API=1 against the owned scripted stack");
  expect(process.env.BAKERY_ENV, "needs the isolated test environment").toBe(
    "test",
  );
});

test.describe.configure({ timeout: 240_000 });

test("a requested change on the current revision keeps the gated run from starting", async ({ browser }) => {
  const { context, page, task } = await planned(browser);
  // The change request starts a turn; the script answers without a revision,
  // so revision 1 stays the current, undecided-for-run plan.
  script(task.conversationId, "fs26-reply");
  await page.getByRole("button", { name: "Request changes", exact: true })
    .click();
  await page.getByRole("textbox", { name: "What should change?" }).fill(
    "Please explain the retry step first.",
  );
  await page.getByRole("button", { name: "Send change request" }).click();
  await expect(page.getByText("You requested changes to revision 1"))
    .toBeVisible();
  await expect(page.getByText("I read the task.")).toBeVisible({
    timeout: 60_000,
  });
  await expect(approve(page, 1)).toHaveCount(0);

  await expect(page.getByText(
    "This task waits for an approved plan. The run starts from the plan you approve.",
  )).toBeVisible();
  await page.getByRole("button", { name: "Start run" }).click();
  await expect(page.getByText("The server did not admit the run."))
    .toBeVisible({ timeout: 30_000 });
  await shot(page, "gate-request-changes-no-run");
  // The refusal is tied to the decision: the request_changes approval itself
  // never admits a run, and the server names why.
  const decided = (await api<{
    items: { id: string; decision: string | null }[];
  }>(page, `/v1/approvals?taskId=${task.id}`)).items.filter((item) =>
    item.decision === "request_changes"
  );
  expect(decided).toHaveLength(1);
  const profile = await api<
    { repositoryProfileId: string; repositoryId: string }
  >(
    page,
    `/v1/tasks/${task.id}`,
  );
  const presets = await api<
    { items: { id: string; defaultBudgetLimitUsd: string }[] }
  >(
    page,
    `/v1/workflow-presets?repositoryId=${profile.repositoryId}`,
  );
  const direct = await page.request.post(`/v1/tasks/${task.id}/runs`, {
    headers: {
      "Bakery-Organization-Id": organizationId,
      "Idempotency-Key": crypto.randomUUID(),
      Origin: new URL(page.url()).origin,
    },
    data: {
      presetId: presets.items[0].id,
      repositoryProfileId: profile.repositoryProfileId,
      executionMode: "repository",
      budgetLimitUsd: presets.items[0].defaultBudgetLimitUsd,
      approvalId: decided[0].id,
    },
  });
  expect(direct.status()).toBe(409);
  expect(await direct.json()).toMatchObject({
    code: "STATE_CONFLICT",
    reason: "approval_unavailable",
  });
  expect(
    (await api<{ items: unknown[] }>(page, `/v1/tasks/${task.id}/runs`)).items,
  ).toHaveLength(0);
  expect((await api<Task>(page, `/v1/tasks/${task.id}`)).currentRunId)
    .toBeNull();
  // The gate survives a reload: still no run and the same copy.
  await page.reload();
  await expect(page.getByText(
    "This task waits for an approved plan. The run starts from the plan you approve.",
  )).toBeVisible();
  expect(
    (await api<{ items: unknown[] }>(page, `/v1/tasks/${task.id}/runs`)).items,
  ).toHaveLength(0);
  await context.close();
});

test("cancel ends an admitted run that no worker has claimed", async ({ browser }) => {
  const { context, page, task } = await planned(browser);
  const runId = await started(page, task);
  // Pause needs a worker attempt; with none, the control is off and says why.
  expect(await reasonOf(page, runId, "pause")).toMatchObject({
    canRequest: false,
    reason: "no_active_attempt",
  });
  await expect(controlButton(page, "Request pause")).toBeDisabled();
  await expect(
    page.getByText("Nothing is running that this can be sent to.")
      .first(),
  ).toBeVisible();
  await shot(page, "cancel-before");
  expect(await reasonOf(page, runId, "cancel")).toMatchObject({
    canRequest: true,
    reason: "allowed",
  });
  await controlButton(page, "Request cancellation").click();
  await expect(receipt(page)).toContainText("Request admitted");
  await expect.poll(
    async () =>
      (await api<{ status: string }>(page, `/v1/runs/${runId}`)).status,
    { timeout: 60_000 },
  ).toBe("canceled");
  await page.reload();
  expect(await reasonOf(page, runId, "cancel")).toMatchObject({
    canRequest: false,
    reason: "already_terminal",
  });
  await shot(page, "cancel-after");
  await context.close();
});

test("a message during a run is kept and live steering is stated unsupported", async ({ browser }) => {
  const { context, page, task } = await planned(browser);
  const runId = await started(page, task);
  deno("web-run-attempt-seed", [runId, JSON.stringify(["follow_up"])]);
  await page.reload();
  const region = page.locator('[data-ui-region="steering-unsupported"]');
  await expect(region).toContainText("Live steering is not supported");
  expect(await reasonOf(page, runId, "pause")).toMatchObject({
    canRequest: false,
    reason: "unsupported",
  });
  await expect(controlButton(page, "Request pause")).toBeDisabled();
  await expect(
    page.getByText(
      "This worker's adapter does not support this control.",
    ).first(),
  ).toBeVisible();

  const body = "Mid-run: please keep the retry step small.";
  script(task.conversationId, "fs26-reply");
  await say(page, "Ask agent", body);
  const log = page.getByRole("log");
  await expect(log.getByText(body)).toBeVisible();
  await expect(page.getByText("I read the task.")).toBeVisible({
    timeout: 60_000,
  });
  await shot(page, "steering-unsupported-sent");
  const stored = async () =>
    (await api<{ items: { body: string }[] }>(
      page,
      `/v1/conversations/${task.conversationId}/messages`,
    )).items.map((item) => item.body);
  expect(await stored()).toContain(body);
  await page.reload();
  await expect(page.getByRole("log").getByText(body)).toBeVisible();
  await expect(page.locator('[data-ui-region="steering-unsupported"]'))
    .toContainText("Live steering is not supported");
  expect(await stored()).toContain(body);
  // The run is untouched by the message: same run, still running.
  expect((await api<Task>(page, `/v1/tasks/${task.id}`)).currentRunId).toBe(
    runId,
  );
  expect(["completed", "failed", "canceled"]).not.toContain(
    (await api<{ status: string }>(page, `/v1/runs/${runId}`)).status,
  );
  await context.close();
});

test("pause, resume and cancel are admitted for a worker that advertises steer (admission only)", async ({ browser }) => {
  const { context, page, task } = await planned(browser);
  const runId = await started(page, task);
  deno("web-run-attempt-seed", [
    runId,
    JSON.stringify(["steer", "follow_up", "interrupt"]),
  ]);
  await page.reload();
  await expect(page.locator('[data-ui-region="steering-unsupported"]'))
    .toHaveCount(0);
  const stepsBefore = (await api<{ items: { id: string; status: string }[] }>(
    page,
    `/v1/runs/${runId}/steps`,
  )).items;
  expect(stepsBefore.length).toBeGreaterThan(0);
  for (const action of ["pause", "resume", "cancel"]) {
    expect(await reasonOf(page, runId, action)).toMatchObject({
      canRequest: true,
      reason: "allowed",
    });
  }
  const runVersion = async () =>
    (await api<{ version: number }>(page, `/v1/runs/${runId}`)).version;
  let seen = await runVersion();
  const request = async (label: string) => {
    await controlButton(page, label).click();
    await expect(receipt(page)).toContainText("Request admitted");
    // Each admitted request is its own run revision.
    await expect.poll(runVersion).toBeGreaterThan(seen);
    seen = await runVersion();
    await shot(page, `control-${label.replaceAll(" ", "-").toLowerCase()}`);
    await controlButton(page, "Start a new control request").click();
  };
  const stepsNow = async () =>
    (await api<{ items: { id: string; status: string }[] }>(
      page,
      `/v1/runs/${runId}/steps`,
    )).items;
  const statusNow = async () =>
    (await api<{ status: string }>(page, `/v1/runs/${runId}`)).status;
  await request("Request pause");
  await request("Request resume");
  // Admission only. No worker consumes the queued commands, so this does not
  // show a pause holding anything back: it shows the server admitted each
  // request and the run did not move. Whether a paused run keeps its next
  // gated stage from starting is untested here.
  expect(["canceled", "completed", "failed"]).not.toContain(await statusNow());
  expect(await stepsNow()).toEqual(stepsBefore);
  await request("Request cancellation");
  // Cancel is admitted too. Whatever state the server settles on, no extra
  // step or run row exists.
  expect((await stepsNow()).map((step) => step.id)).toEqual(
    stepsBefore.map((step) => step.id),
  );
  expect(
    (await api<{ items: unknown[] }>(page, `/v1/tasks/${task.id}/runs`)).items,
  ).toHaveLength(1);
  await context.close();
});
