import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  expect,
  type Locator,
  type Page,
  type Route,
  test,
} from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { submitUntilAccepted } from "./helpers/api-retry.ts";

/**
 * Real-API proof of the FS26 task conversation loop against a
 * compose stack started with `BAKERY_ENV=test` and the scripted coordinator
 * directory `tests/fixtures/scripted-coordinator`:
 *
 *   BAKERY_ENV=test \
 *   BAKERY_PUBLIC_BASE_URL=http://127.0.0.1:$BAKERY_WEB_PORT \
 *   BETTER_AUTH_SECRET=<32+ random chars> \
 *   BAKERY_INNGEST_EVENT_KEY=<event-key> \
 *   BAKERY_SCRIPTED_COORDINATOR_DIR=/workspace/tests/fixtures/scripted-coordinator \
 *   BAKERY_BUDGET_INSTALLATION_MONTHLY_LIMIT_USD=100 \
 *   BAKERY_BUDGET_RESERVATION_TTL_SECONDS=3600 \
 *   BAKERY_BUDGET_MAX_RUN_DURATION_SECONDS=86400 \
 *   scripts/dev/compose-up.sh bakery-e06-fs26-<hash> \
 *     postgres redis inngest migrate server
 *
 * Also set `BAKERY_PUBLIC_BASE_URL` to the web origin (for example
 * `http://127.0.0.1:$BAKERY_WEB_PORT`, else sign-in fails with
 * `AUTH_PROVIDER_ERROR`) and `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY`
 * (else host seeding fails with `AUTH_CONFIGURATION_INVALID`); they must equal the
 * stack's Inngest keys, which default to `local-event-key` and the compose
 * `BAKERY_INNGEST_SIGNING_KEY` default. Also pin `BETTER_AUTH_SECRET`. Run the outbox
 * dispatcher beside the stack:
 * `docker compose -p <project> -f infra/compose.yaml run -d --no-deps
 * -e INNGEST_EVENT_KEY=$INNGEST_EVENT_KEY server sh -eu -c 'export
 * BAKERY_APP_DATABASE_URL="postgres://bakery_app:$BAKERY_LOCAL_APP_PASSWORD@postgres:5432/bakery";
 * exec deno run --allow-env --allow-net apps/server/src/dispatch.ts'`. Load the stack's env file (owner
 * `DATABASE_URL`, `INNGEST_*`, `BETTER_AUTH_SECRET`), then:
 * `BAKERY_REAL_API=1 BAKERY_REAL_API_COORDINATOR=1 BAKERY_WEB_PORT=<port> pnpm --dir apps/web test:ui task-conversation-real-api.spec --project=desktop-real-api --workers=1`.
 * The spec seeds the bootstrap admin, a `coordinator`
 * agent and a runnable repository with `tests/helpers/web-auth-seed.ts` and
 * `tests/helpers/web-conversation-seed.ts`, then drives the browser only.
 * It runs in the `desktop-real-api` project and never skips there.
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

function deno(file: string, env: Record<string, string> = {}) {
  return execFileSync("deno", [
    "run",
    "--allow-env",
    "--allow-read",
    "--allow-net",
    helper(file),
    email,
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

const conversationRegion = (page: Page) =>
  page.getByRole("region", { name: "Conversation", exact: true });
const message = (page: Page) =>
  page.getByRole("textbox", { name: "Message this task" });
const send = (page: Page) =>
  page.getByRole("button", { name: "Send", exact: true });
const approve = (page: Page, n: number) =>
  page.getByRole("button", { name: `Approve revision ${n}`, exact: true });

async function say(page: Page, intent: "Discuss" | "Ask agent", body: string) {
  await page.getByLabel(intent, { exact: true }).check({ force: true });
  await message(page).fill(body);
  await send(page).click();
}

async function api<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(path, {
    headers: { "Bakery-Organization-Id": organizationId },
  });
  expect(response.ok(), `${path}: ${response.status()}`).toBe(true);
  return await response.json() as T;
}

let organizationId = "";

test.afterAll(() => {
  for (const file of placed) rmSync(file, { force: true });
});

test(
  "task conversation loop on the real API",
  async ({ browser }, testInfo) => {
    test.skip(
      !realApi,
      "set BAKERY_REAL_API=1 against the owned scripted stack",
    );
    test.setTimeout(240_000);
    expect(process.env.BAKERY_ENV, "needs the isolated test environment").toBe(
      "test",
    );

    deno("web-auth-seed", { WEB_AUTH_SEED_PASSWORD: password });
    const seeded = JSON.parse(
      deno("web-conversation-seed").trim().split("\n").at(-1) ?? "null",
    ) as { organizationId: string; repositoryId: string };
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

    // A previous interrupted run may have left a pseudo-locale preference.
    const stored = await (await page.request.get("/v1/user-preferences"))
      .json() as {
        locale: string | null;
        casVersion: number;
      };
    if (stored.locale !== null) {
      await page.request.patch("/v1/user-preferences", {
        headers: {
          "Idempotency-Key": crypto.randomUUID(),
          Origin: new URL(page.url()).origin,
        },
        data: { locale: null, expectedCasVersion: stored.casVersion },
      });
      await page.reload();
    }

    // ---- Plan first creates the task and no run ---------------------------
    await page.goto("/tasks/new");
    await page.getByRole("combobox", { name: /^Repository/ }).selectOption(
      seeded.repositoryId,
    );
    await page.getByRole("textbox", { name: /^Title/ }).fill(
      "Repository onboarding",
    );
    await page.getByRole("textbox", { name: /^Description/ }).fill(
      "Choose a repository and check the worker toolchain.",
    );
    await page.getByRole("checkbox", { name: "Plan first" }).check({
      force: true,
    });
    await page.getByRole("button", { name: "Create task and plan" }).click();
    // Task creation is three server round trips (create, tasks.list and
    // workflowPresets.list refetches) before the page navigates.
    await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}$/, {
      timeout: 30_000,
    });
    const taskId = page.url().split("/").at(-1)!;
    const task = await api<{
      conversationId: string;
      status: string;
      currentRunId: string | null;
      approvalPolicy: { plan: string };
    }>(page, `/v1/tasks/${taskId}`);
    expect(task.approvalPolicy).toEqual({ plan: "human_approval" });
    expect(task.currentRunId).toBeNull();
    const conversationId = task.conversationId;
    await expect(conversationRegion(page)).toBeVisible();
    await expect(page.locator('[data-stage="plan"]')).toContainText(
      "Waits for your approval",
    );
    expect(
      (await api<{ items: unknown[] }>(page, `/v1/tasks/${taskId}/runs`)).items,
    ).toHaveLength(0);
    await shot(page, "01-plan-first-empty");

    // ---- discuss does not start an agent turn ------------------------------
    await say(page, "Discuss", "Let's make onboarding feel straightforward.");
    await expect(page.getByRole("log").getByText("Let's make onboarding"))
      .toBeVisible();
    expect(
      (await api<{ items: unknown[] }>(
        page,
        `/v1/conversations/${conversationId}/turns`,
      )).items,
    ).toHaveLength(0);

    // ---- ask agent: queued/active turn, then the agent reply replays -------
    script(conversationId, "fs26-reply");
    await say(page, "Ask agent", "What do you think?");
    await expect(page.getByText("I read the task.")).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.locator('[data-variant="agent"]').first()).toContainText(
      "Agent",
    );
    await expect(page.locator('[data-ui-region="turn-status"]')).toHaveCount(
      0,
      {
        timeout: 30_000,
      },
    );

    // ---- a durable question appears and is answered ------------------------
    script(conversationId, "fs26-question");
    await say(page, "Ask agent", "Plan it, please.");
    await expect(page.getByText("Which repositories should we import?"))
      .toBeVisible({
        timeout: 60_000,
      });
    await shot(page, "02-question");
    // The answer enqueues one follow-up turn; script the plan first.
    script(conversationId, "fs26-plan");
    await page.getByLabel("Bakery only").check({ force: true });
    await page.getByRole("button", { name: "Send answer" }).click();
    await expect(page.getByText("Recorded answer")).toBeVisible();

    // ---- plan revision 1 with numbered steps -------------------------------
    const plan = page.locator('[data-ui-region="plan-revision"]');
    await expect(plan).toContainText("Revision 1", { timeout: 60_000 });
    await expect(plan.getByRole("listitem")).toHaveCount(3);
    await expect(plan).toContainText("1. Select the repository");
    await expect(approve(page, 1)).toBeEnabled();
    await shot(page, "03-plan-revision-1");

    // A second browser page keeps revision 1 on screen; its reads are then
    // blocked so it cannot learn about the newer revision.
    const stale = await context.newPage();
    const planReads = (url: URL) =>
      url.pathname === "/v1/plan-revisions" || url.pathname === "/v1/approvals";
    const blockPlanReads = (route: Route) => route.abort();
    await stale.goto(`/tasks/${taskId}`);
    await expect(approve(stale, 1)).toBeVisible({ timeout: 30_000 });
    await stale.route(planReads, blockPlanReads);

    // ---- request changes -> new turn -> revision 2 supersedes 1 ------------
    script(conversationId, "fs26-plan-revised");
    await page.getByRole("button", { name: "Request changes", exact: true })
      .click();
    await page.getByRole("textbox", { name: "What should change?" }).fill(
      "Please give the retry action its own step.",
    );
    await page.getByRole("button", { name: "Send change request" }).click();
    await expect(plan).toContainText("Revision 2", { timeout: 60_000 });
    await expect(plan.getByRole("listitem")).toHaveCount(4);
    await expect(page.getByRole("log").getByText("give the retry action"))
      .toBeVisible();
    await expect(approve(page, 2)).toBeEnabled();
    await shot(page, "04-plan-revision-2");

    // ---- approving the obsolete revision is refused ------------------------
    await approve(stale, 1).click();
    await expect(stale.getByText("Nothing was decided")).toBeVisible();
    await stale.unroute(planReads, blockPlanReads);
    await expect(stale.getByText("Revision 1 is obsolete")).toBeVisible({
      timeout: 30_000,
    });
    await expect(approve(stale, 2)).toBeVisible();
    await shot(stale, "05-obsolete-conflict");
    await stale.close();

    // ---- reject/changes-requested prevent the gated run --------------------
    await page.getByRole("button", { name: "Start run" }).click();
    await expect(page.getByText("The server did not admit the run."))
      .toBeVisible({
        timeout: 30_000,
      });
    expect(
      (await api<{ items: unknown[] }>(page, `/v1/tasks/${taskId}/runs`)).items,
    ).toHaveLength(0);

    // ---- reload continues the same durable conversation --------------------
    await page.reload();
    await expect(plan).toContainText("Revision 2");
    await expect(page.getByRole("log").getByText("Let's make onboarding"))
      .toBeVisible();
    await expect(page.getByText("I read the task.")).toBeVisible();

    // ---- the draft is private: persisted, never sent until Send ------------
    const sentMessages: string[] = [];
    page.on("request", (request) => {
      if (
        request.method() === "POST" && request.url().includes("/messages")
      ) sentMessages.push(request.postData() ?? "");
    });
    await message(page).fill("A private thought");
    await page.reload();
    await expect(message(page)).toHaveValue("A private thought");
    expect(sentMessages).toHaveLength(0);
    await message(page).fill("");

    // ---- planning-only is kept across reload -------------------------------
    const planningOnly = page.getByRole("switch", { name: "Planning only" });
    await planningOnly.check({ force: true });
    await expect(planningOnly).toBeChecked();
    await page.reload();
    await expect(page.getByRole("switch", { name: "Planning only" }))
      .toBeChecked();
    expect(
      (await api<{ planningOnly: boolean }>(page, `/v1/tasks/${taskId}`))
        .planningOnly,
    ).toBe(true);
    await page.getByRole("switch", { name: "Planning only" }).uncheck({
      force: true,
    });
    await expect(page.getByRole("switch", { name: "Planning only" })).not
      .toBeChecked();

    // ---- approve the exact revision, then the run starts -------------------
    await approve(page, 2).click();
    await expect(page.getByText("You approved revision 2")).toBeVisible();
    await expect(approve(page, 2)).toHaveCount(0);
    await page.getByRole("button", { name: "Start run" }).click();
    await expect.poll(
      async () =>
        (await api<{ currentRunId: string | null }>(
          page,
          `/v1/tasks/${taskId}`,
        ))
          .currentRunId,
      { timeout: 60_000 },
    ).not.toBeNull();
    const started = await api<{ currentRunId: string }>(
      page,
      `/v1/tasks/${taskId}`,
    );
    await page.reload();
    await expect(conversationRegion(page)).toBeVisible();
    await expect(plan).toContainText("Revision 2");
    await expect(page.getByText("A run is in progress.")).toBeVisible();
    await shot(page, "06-run-started");
    expect(
      (await api<{ items: { id: string }[] }>(page, `/v1/tasks/${taskId}/runs`))
        .items.map((run) => run.id),
    ).toContain(started.currentRunId);

    // ---- questions during execution are preserved and routed ---------------
    const controls = await api<
      { actions: { action: string; canRequest: boolean; reason: string }[] }
    >(page, `/v1/runs/${started.currentRunId}/controls`);
    for (const control of controls.actions.filter((item) => !item.canRequest)) {
      expect(["no_active_attempt", "unsupported", "already_terminal"])
        .toContain(
          control.reason,
        );
    }
    script(conversationId, "fs26-results");
    await say(page, "Ask agent", "How is the run going?");
    await expect(page.getByText("The run finished.")).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByRole("log").getByText("How is the run going?"))
      .toBeVisible();

    // ---- final results are discussed and a revision is requested (AC3) -----
    script(conversationId, "fs26-plan-revised");
    await say(page, "Ask agent", "Revise the plan to add retries.");
    await expect(plan).toContainText("Revision 3", { timeout: 60_000 });
    await shot(page, "07-results-revision");

    // ---- keyboard: send with Control+Enter, focus stays in the composer ----
    await message(page).focus();
    await page.keyboard.type("Thanks, noted.");
    await page.keyboard.press("Control+Enter");
    await expect(page.getByRole("log").getByText("Thanks, noted."))
      .toBeVisible();

    // ---- a11y and narrow RTL zoom on real data -----------------------------
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    const preferences = await api<{ casVersion: number }>(
      page,
      "/v1/user-preferences",
    );
    const patched = await page.request.patch("/v1/user-preferences", {
      headers: {
        "Bakery-Organization-Id": organizationId,
        "Idempotency-Key": crypto.randomUUID(),
        Origin: new URL(page.url()).origin,
      },
      data: { locale: "ar-XB", expectedCasVersion: preferences.casVersion },
    });
    expect(patched.ok(), await patched.text()).toBe(true);
    const patchedVersion =
      ((await patched.json()) as { casVersion: number }).casVersion;
    await page.setViewportSize({ width: 320, height: 800 });
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    // The region name is pseudo-localized here, so address it by its marker.
    await expect(page.locator('[data-ui-region="task-conversation"]'))
      .toBeVisible();
    expect(
      await page.evaluate(() =>
        document.documentElement.scrollWidth <=
          document.documentElement.clientWidth
      ),
    ).toBe(true);
    await shot(page, "08-rtl-320");
    const reset: Locator = page.locator("html");
    await expect(reset).toHaveAttribute("dir", "rtl");
    const restored = await page.request.patch("/v1/user-preferences", {
      headers: {
        "Bakery-Organization-Id": organizationId,
        "Idempotency-Key": crypto.randomUUID(),
        Origin: new URL(page.url()).origin,
      },
      data: { locale: null, expectedCasVersion: patchedVersion },
    });
    expect(restored.ok(), await restored.text()).toBe(true);
    testInfo.annotations.push({ type: "task", description: taskId });

    // ---- reject prevents the gated run on a second task --------------------
    await page.setViewportSize({ width: 1440, height: 1000 });
    const created = await page.request.post("/v1/tasks", {
      headers: {
        "Bakery-Organization-Id": organizationId,
        "Idempotency-Key": crypto.randomUUID(),
        Origin: new URL(page.url()).origin,
      },
      data: {
        applicationId: (await api<{ applicationId: string }>(
          page,
          `/v1/tasks/${taskId}`,
        )).applicationId,
        repositoryId: seeded.repositoryId,
        taskType: "feature",
        title: "Reject path",
        description: "A plan the person rejects.",
        approvalPolicy: { plan: "human_approval" },
      },
    });
    expect(created.status()).toBe(201);
    const second = await created.json() as {
      id: string;
      conversationId: string;
    };
    script(second.conversationId, "fs26-plan");
    await page.goto(`/tasks/${second.id}`);
    await say(page, "Ask agent", "Plan this one.");
    await expect(approve(page, 1)).toBeEnabled({ timeout: 60_000 });
    await page.getByRole("button", { name: "Reject", exact: true }).click();
    await expect(page.getByText("You rejected revision 1")).toBeVisible();
    await page.getByRole("button", { name: "Start run" }).click();
    await expect(page.getByText("The server did not admit the run."))
      .toBeVisible({
        timeout: 30_000,
      });
    expect(
      (await api<{ items: unknown[] }>(page, `/v1/tasks/${second.id}/runs`))
        .items,
    ).toHaveLength(0);
    await context.close();
  },
);
