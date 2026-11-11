import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, type Page, type Route, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { submitUntilAccepted } from "./helpers/api-retry.ts";

/**
 * Real-API proof of the shared task conversation: two
 * browser contexts, an admin and a Developer teammate, work one conversation
 * against the same compose stack as `task-conversation-real-api.spec.ts`:
 *
 *   BAKERY_ENV=test \
 *   BAKERY_PUBLIC_BASE_URL=http://127.0.0.1:$BAKERY_WEB_PORT \
 *   BETTER_AUTH_SECRET=<32+ random chars> \
 *   BAKERY_INNGEST_EVENT_KEY=<event-key> \
 *   BAKERY_SCRIPTED_COORDINATOR_DIR=/workspace/tests/fixtures/scripted-coordinator \
 *   BAKERY_BUDGET_INSTALLATION_MONTHLY_LIMIT_USD=100 \
 *   BAKERY_BUDGET_RESERVATION_TTL_SECONDS=3600 \
 *   BAKERY_BUDGET_MAX_RUN_DURATION_SECONDS=86400 \
 *   scripts/dev/compose-up.sh bakery-e06-fs10-<hash> \
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
 * `BAKERY_REAL_API=1 BAKERY_REAL_API_COORDINATOR=1 BAKERY_WEB_PORT=<port> pnpm --dir apps/web test:ui shared-conversation-real-api.spec --project=desktop-real-api --workers=1`.
 * The spec seeds the admin, the coordinator agent and a runnable repository
 * (`web-auth-seed`, `web-conversation-seed`) and the teammate
 * (`web-member-seed`), then drives the browsers only. It runs in the
 * `desktop-real-api` project and never skips there.
 */
const realApi = process.env.BAKERY_REAL_API === "1";
const email = process.env.BAKERY_REAL_EMAIL ?? "fs26-admin@example.test";
const password = process.env.BAKERY_REAL_PASSWORD ?? "Fs26-Admin-Passw0rd-1";
const teammateEmail = "fs10-dana@example.test";
const teammateName = "Dana Teammate";
const scriptDirectory = fileURLToPath(
  new URL("../../../tests/fixtures/scripted-coordinator/", import.meta.url),
);
const shotDirectory = process.env.BAKERY_FS10_SHOTS ?? "";
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
const send = (page: Page) =>
  page.getByRole("button", { name: "Send", exact: true });
const log = (page: Page) => page.getByRole("log");
const approve = (page: Page, n: number) =>
  page.getByRole("button", { name: `Approve revision ${n}`, exact: true });
const planningOnly = (page: Page) =>
  page.getByRole("switch", { name: "Planning only" });

async function say(page: Page, intent: "Discuss" | "Ask agent", body: string) {
  await page.getByLabel(intent, { exact: true }).check({ force: true });
  await message(page).fill(body);
  await send(page).click();
}

let organizationId = "";
async function api<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(path, {
    headers: { "Bakery-Organization-Id": organizationId },
  });
  expect(response.ok(), `${path}: ${response.status()}`).toBe(true);
  return await response.json() as T;
}

type Message = { id: string; body: string; authorId: string | null };
const messagesOf = async (page: Page, conversationId: string) =>
  (await api<{ items: Message[] }>(
    page,
    `/v1/conversations/${conversationId}/messages?limit=100`,
  )).items;

test.afterAll(() => {
  for (const file of placed) rmSync(file, { force: true });
});

test(
  "two participants share one conversation on the real API",
  async ({ browser }) => {
    test.skip(
      !realApi,
      "set BAKERY_REAL_API=1 against the owned scripted stack",
    );
    test.setTimeout(360_000);
    expect(process.env.BAKERY_ENV, "needs the isolated test environment").toBe(
      "test",
    );

    deno("web-auth-seed", [email], { WEB_AUTH_SEED_PASSWORD: password });
    const seeded = JSON.parse(
      deno("web-conversation-seed", [email]).trim().split("\n").at(-1) ??
        "null",
    ) as { organizationId: string; repositoryId: string };
    organizationId = seeded.organizationId;
    const member = JSON.parse(
      deno("web-member-seed", [email, teammateEmail, teammateName]).trim()
        .split("\n").at(-1) ?? "null",
    ) as {
      principalId: string;
      cookieName: string;
      cookieValue: string;
    };

    // ---- context A: the admin signs in through the UI ----------------------
    const contextA = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    const a = await contextA.newPage();
    await a.goto("/sign-in");
    await submitUntilAccepted(a, "/api/auth/sign-in/email", async () => {
      await a.getByLabel("Email", { exact: true }).fill(email);
      await a.getByLabel("Password", { exact: true }).fill(password);
      await a.getByRole("button", { name: "Sign in", exact: true }).click();
    });
    await expect(a).toHaveURL("/");
    const stored = await (await a.request.get("/v1/user-preferences"))
      .json() as {
        locale: string | null;
        casVersion: number;
      };
    if (stored.locale !== null) {
      await a.request.patch("/v1/user-preferences", {
        headers: {
          "Idempotency-Key": crypto.randomUUID(),
          Origin: new URL(a.url()).origin,
        },
        data: { locale: null, expectedCasVersion: stored.casVersion },
      });
      await a.reload();
    }

    // ---- A creates a plan-first task ---------------------------------------
    await a.goto("/tasks/new");
    await a.getByRole("combobox", { name: /^Repository/ }).selectOption(
      seeded.repositoryId,
    );
    await a.getByRole("textbox", { name: /^Title/ }).fill("Shared onboarding");
    await a.getByRole("textbox", { name: /^Description/ }).fill(
      "Two people plan the repository onboarding together.",
    );
    await a.getByRole("checkbox", { name: "Plan first" }).check({
      force: true,
    });
    await a.getByRole("button", { name: "Create task and plan" }).click();
    await expect(a).toHaveURL(/\/tasks\/[0-9a-f-]{36}$/);
    const taskId = a.url().split("/").at(-1)!;
    const task = await api<{ conversationId: string }>(
      a,
      `/v1/tasks/${taskId}`,
    );
    const conversationId = task.conversationId;
    await expect(a.getByRole("region", { name: "Conversation", exact: true }))
      .toBeVisible();

    // ---- context B: the teammate joins with a seeded session ---------------
    const contextB = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    await contextB.addCookies([{
      name: member.cookieName,
      value: member.cookieValue,
      url: new URL(a.url()).origin,
    }]);
    const b = await contextB.newPage();
    await b.goto(`/tasks/${taskId}`);
    await expect(b.getByRole("region", { name: "Conversation", exact: true }))
      .toBeVisible({ timeout: 30_000 });
    const principalA = (await api<{ principalId: string }>(a, "/v1/me"))
      .principalId;

    // ---- one transcript: a message from either side reaches the other ------
    await say(a, "Discuss", "Hello from the admin.");
    await expect(log(a).getByText("Hello from the admin.")).toBeVisible();
    await expect(log(b).getByText("Hello from the admin.")).toBeVisible({
      timeout: 30_000,
    });
    const adminName = (await api<
      { items: { principalId: string; displayName: string }[] }
    >(a, `/v1/conversations/${conversationId}/participants`)).items.find((
      item,
    ) => item.principalId === principalA)!.displayName;
    await expect(
      log(b).locator("article", { hasText: "Hello from the admin." }),
    ).toContainText(adminName);
    await expect(
      log(a).locator("article", { hasText: "Hello from the admin." }),
    ).toContainText("You");

    await say(b, "Discuss", "Hello from the teammate.");
    await expect(log(b).getByText("Hello from the teammate.")).toBeVisible();
    await expect(log(a).getByText("Hello from the teammate.")).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      log(a).locator("article", { hasText: "Hello from the teammate." }),
    ).toContainText(teammateName);
    await expect(
      log(b).locator("article", { hasText: "Hello from the teammate." }),
    ).toContainText("You");

    // Participants come from the transcript authors and the API projection.
    for (const page of [a, b]) {
      const people = page.locator('[data-ui-region="participants"]');
      await expect(people).toContainText("Participants (2)");
      await expect(people).toContainText(teammateName);
      await expect(people).toContainText(adminName);
      await expect(people.getByRole("img", { name: teammateName }))
        .toBeVisible();
    }
    await shot(a, "01-participants-admin");
    await shot(b, "02-participants-teammate");

    // ---- no duplicated sends: a double click sends one message -------------
    const posts: string[] = [];
    b.on("request", (request) => {
      if (
        request.method() === "POST" && request.url().includes("/messages")
      ) posts.push(request.postData() ?? "");
    });
    await b.getByLabel("Discuss", { exact: true }).check({ force: true });
    await message(b).fill("Sent exactly once.");
    await send(b).dblclick();
    await expect(log(b).getByText("Sent exactly once.")).toBeVisible();
    await expect(log(a).getByText("Sent exactly once.")).toBeVisible({
      timeout: 30_000,
    });
    await b.waitForTimeout(1_000);
    expect(posts).toHaveLength(1);
    const once = (await messagesOf(a, conversationId)).filter((item) =>
      item.body === "Sent exactly once."
    );
    expect(once).toHaveLength(1);
    await expect(log(a).getByText("Sent exactly once.")).toHaveCount(1);
    await expect(log(b).getByText("Sent exactly once.")).toHaveCount(1);
    // Both pages render the same transcript, in the same order.
    const order = async (page: Page) =>
      await log(page).locator("article").evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("data-message-id"))
      );
    expect(await order(a)).toEqual(await order(b));
    expect(await order(a)).toEqual(
      (await messagesOf(a, conversationId)).map((item) => item.id).reverse(),
    );

    // ---- private drafts are never shared -----------------------------------
    await message(a).fill("Admin private draft");
    await say(b, "Discuss", "Teammate writes while the admin drafts.");
    await expect(log(a).getByText("Teammate writes while the admin drafts."))
      .toBeVisible({ timeout: 30_000 });
    await expect(message(a)).toHaveValue("Admin private draft");
    await expect(b.getByText("Admin private draft")).toHaveCount(0);
    expect(
      (await messagesOf(a, conversationId)).some((item) =>
        item.body.includes("Admin private draft")
      ),
    ).toBe(false);
    expect(
      await b.evaluate(() =>
        Object.keys(localStorage).some((key) =>
          (localStorage.getItem(key) ?? "").includes("Admin private draft")
        )
      ),
    ).toBe(false);
    await a.reload();
    await expect(message(a)).toHaveValue("Admin private draft");
    await message(a).fill("");

    // ---- a durable question; a stale answer becomes a conflict -------------
    script(conversationId, "fs26-question");
    await say(a, "Ask agent", "Plan it, please.");
    await expect(a.getByText("Which repositories should we import?"))
      .toBeVisible({ timeout: 60_000 });
    await expect(b.getByText("Which repositories should we import?"))
      .toBeVisible({ timeout: 30_000 });
    // A stops learning anything, then B answers first.
    const questionReads = (url: URL) => url.pathname === "/v1/questions";
    const blockReads = (route: Route) => route.abort();
    await a.route(questionReads, blockReads);
    script(conversationId, "fs26-plan");
    await b.getByLabel("Bakery only").check({ force: true });
    await b.getByRole("button", { name: "Send answer" }).click();
    await expect(b.getByText("Recorded answer")).toBeVisible();
    await expect(a.getByRole("button", { name: "Send answer" })).toBeVisible();
    await a.getByLabel("Choose repositories").check({ force: true });
    await a.getByRole("button", { name: "Send answer" }).click();
    await expect(a.getByText("Someone already answered")).toBeVisible();
    await a.unroute(questionReads, blockReads);
    // Any event refreshes A; the recorded answer and its author replace the form.
    await say(b, "Discuss", "Answered, thanks.");
    await expect(a.getByText("Answered by " + teammateName)).toBeVisible({
      timeout: 30_000,
    });
    await expect(a.getByRole("button", { name: "Send answer" })).toHaveCount(0);
    await shot(a, "03-stale-answer-conflict");

    // ---- the plan appears for both; the teammate decides explicitly --------
    const planA = a.locator('[data-ui-region="plan-revision"]');
    const planB = b.locator('[data-ui-region="plan-revision"]');
    await expect(planA).toContainText("Revision 1", { timeout: 60_000 });
    await expect(planB).toContainText("Revision 1", { timeout: 30_000 });
    await expect(approve(a, 1)).toBeEnabled();
    await expect(approve(b, 1)).toBeEnabled();

    // Planning-only is shared state: set by A, seen live by B.
    await planningOnly(a).check({ force: true });
    await expect(planningOnly(a)).toBeChecked();
    await expect(planningOnly(b)).toBeChecked({ timeout: 30_000 });

    // The second participant flips it too: A sees each change live.
    await planningOnly(b).uncheck({ force: true });
    await expect(planningOnly(b)).not.toBeChecked();
    await expect(planningOnly(a)).not.toBeChecked({ timeout: 30_000 });
    await planningOnly(b).check({ force: true });
    await expect(planningOnly(a)).toBeChecked({ timeout: 30_000 });

    // A goes offline: it says so, keeps the page, and catches up on return.
    // B turns planning-only off meanwhile; A's return re-reads it, then B
    // turns it on again before deciding.
    await contextA.setOffline(true);
    await expect(a.getByText("You are offline.").first()).toBeVisible();
    await planningOnly(b).uncheck({ force: true });
    await expect(planningOnly(b)).not.toBeChecked();
    await say(b, "Discuss", "Sent while the admin was offline.");
    await contextA.setOffline(false);
    await expect(log(a).getByText("Sent while the admin was offline."))
      .toBeVisible({ timeout: 45_000 });
    await expect(planningOnly(a)).not.toBeChecked({ timeout: 45_000 });
    await planningOnly(b).check({ force: true });
    await expect(planningOnly(a)).toBeChecked({ timeout: 30_000 });
    await approve(b, 1).click();
    await expect(b.getByText("You approved revision 1")).toBeVisible();
    await expect(a.getByText(`${teammateName} approved revision 1`))
      .toBeVisible({ timeout: 45_000 });
    await expect(approve(a, 1)).toHaveCount(0);
    await expect(planningOnly(a)).toBeChecked();
    await shot(a, "04-reconnected-decision");

    // The planning-only intent and the explicit decision survive reload and a
    // second participant: both are server records, not page state.
    for (const page of [a, b]) {
      await page.reload();
      await expect(planningOnly(page)).toBeChecked();
      await expect(
        page.getByText(
          page === b
            ? "You approved revision 1"
            : `${teammateName} approved revision 1`,
        ),
      ).toBeVisible({ timeout: 30_000 });
      await expect(approve(page, 1)).toHaveCount(0);
    }
    const state = await api<
      { planningOnly: boolean; currentRunId: string | null }
    >(
      a,
      `/v1/tasks/${taskId}`,
    );
    expect(state.planningOnly).toBe(true);
    expect(state.currentRunId).toBeNull();
    const approvals = await api<
      { items: { decision: string | null; decidedBy: string | null }[] }
    >(a, `/v1/approvals?taskId=${taskId}`);
    expect(approvals.items.map((item) => item.decision)).toContain("approve");
    expect(approvals.items.map((item) => item.decidedBy)).toContain(
      member.principalId,
    );
    expect(
      (await api<{ items: unknown[] }>(a, `/v1/tasks/${taskId}/runs`)).items,
    ).toHaveLength(0);
    await shot(b, "05-explicit-decision-teammate");

    // ---- a11y on real data for both participants ---------------------------
    for (const page of [a, b]) {
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    }

    // ---- the coordination route is reachable and shows the empty state -----
    await a.goto(`/tasks/${taskId}/coordination`);
    await expect(
      a.getByRole("heading", { name: "Coordination plan", exact: true }),
    ).toBeVisible();
    await expect(a.getByText("No coordination plan yet")).toBeVisible();
    await shot(a, "06-coordination-empty");

    await contextB.close();
    await contextA.close();
  },
);
