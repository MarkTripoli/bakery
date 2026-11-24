import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { submitUntilAccepted } from "./helpers/api-retry.ts";
import { laneBudgetMs } from "./helpers/lane-budget.ts";

const realApi = process.env.BAKERY_REAL_API === "1";
const email = process.env.BAKERY_REAL_EMAIL ?? "fs26-admin@example.test";
const password = process.env.BAKERY_REAL_PASSWORD ?? "Fs26-Admin-Passw0rd-1";
const shotDirectory = process.env.BAKERY_W1_SHOTS ?? "";
const helper = (name: string) =>
  fileURLToPath(new URL(`../../../tests/helpers/${name}.ts`, import.meta.url));

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

type Seeded = {
  organizationId: string;
  repositoryId: string;
  applicationId: string;
};
type Task = { id: string; currentRunId: string | null };
type Run = { id: string; status: string };
type Approval = {
  id: string;
  status: string;
  decision: string | null;
  subjectType: string;
  decisionComment: string | null;
};

const SIGN_OFF = "flow.hold";
const PROMPT =
  "Is the design for the invoice export ready for Bakery to build?";

let seeded: Seeded;

const VARIANTS = [
  { width: 1440, height: 900, scheme: "light" },
  { width: 1440, height: 900, scheme: "dark" },
  { width: 390, height: 844, scheme: "light" },
  { width: 390, height: 844, scheme: "dark" },
] as const;

async function shot(page: Page, name: string) {
  if (!shotDirectory) return;
  mkdirSync(shotDirectory, { recursive: true });
  const before = page.viewportSize() ?? { width: 1440, height: 900 };
  for (const variant of VARIANTS) {
    await page.setViewportSize({
      width: variant.width,
      height: variant.height,
    });
    await page.emulateMedia({ colorScheme: variant.scheme });
    await page.waitForTimeout(400);
    await page.screenshot({
      path: `${shotDirectory}/${name}-${variant.width}-${variant.scheme}.png`,
    });
  }
  await page.setViewportSize(before);
  await page.emulateMedia({ colorScheme: "light" });
}

async function shotOne(page: Page, name: string) {
  if (!shotDirectory) return;
  mkdirSync(shotDirectory, { recursive: true });
  await page.screenshot({ path: `${shotDirectory}/${name}-1440-light.png` });
}

async function signedIn(page: Page) {
  await page.goto("/sign-in");
  await submitUntilAccepted(page, "/api/auth/sign-in/email", async () => {
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  });
  await expect(page).toHaveURL("/");
}

const headers = (page: Page) => ({
  "Bakery-Organization-Id": seeded.organizationId,
  "Idempotency-Key": crypto.randomUUID(),
  Origin: new URL(page.url()).origin,
});

async function get<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(path, {
    headers: { "Bakery-Organization-Id": seeded.organizationId },
  });
  expect(response.ok(), `${path}: ${response.status()}`).toBe(true);
  return await response.json() as T;
}

async function post<T>(
  page: Page,
  path: string,
  data: unknown,
  extra: Record<string, string> = {},
): Promise<T> {
  const response = await page.request.post(path, {
    headers: { ...headers(page), ...extra },
    data: data as Record<string, unknown>,
  });
  expect(
    response.ok(),
    `${path}: ${response.status()} ${await response.text()}`,
  ).toBe(true);
  return await response.json() as T;
}

async function publishedWorkflow(page: Page): Promise<string> {
  const slug = `w1-proof-${crypto.randomUUID().slice(0, 8)}`;
  const workflow = await post<{ id: string }>(page, "/v1/workflows", {
    slug,
    name: "Design sign-off proof",
    description: "A sign-off, then nothing: proves the approval step.",
  });
  const version = await post<{ id: string; digest: string; version: number }>(
    page,
    `/v1/workflows/${workflow.id}/versions`,
    {
      definition: {
        apiVersion: "bakery.dev/v1",
        kind: "workflow",
        name: slug,
        description: "A sign-off, then nothing.",
        steps: [{
          id: "flow",
          steps: [
            { id: "hold", wait: { duration: "10m" } },
            { id: "after", needs: ["hold"], uses: "workflow.noop", with: {} },
          ],
        }],
      },
    },
  );
  await post(
    page,
    `/v1/workflows/${workflow.id}/versions/${version.id}/publish`,
    { expectedDigest: version.digest },
    { "If-Match": `"v${version.version}"` },
  );
  return version.id;
}

async function waiting(page: Page): Promise<{ task: Task; runId: string }> {
  const versionId = await publishedWorkflow(page);
  const task = await post<Task>(page, "/v1/tasks", {
    applicationId: seeded.applicationId,
    repositoryId: seeded.repositoryId,
    taskType: "feature",
    title: `Sign-off ${crypto.randomUUID().slice(0, 8)}`,
    description: "A task whose run waits for a design sign-off.",
  });
  const run = await post<Run>(page, `/v1/tasks/${task.id}/runs`, {
    workflowVersionId: versionId,
    executionMode: "cloud_only",
  });
  deno("web-step-approval-seed", [run.id, SIGN_OFF, PROMPT]);
  await page.goto(`/tasks/${task.id}`);
  return { task, runId: run.id };
}

const runLine = (page: Page) => page.locator("#task-run-heading");
const visibleRunLine = (page: Page) =>
  page.locator("#task-run-heading").locator("xpath=..");
const review = (page: Page) =>
  page.getByRole("button", { name: /^Review the / });

async function approvals(page: Page, taskId: string) {
  return (await get<{ items: Approval[] }>(
    page,
    `/v1/approvals?taskId=${taskId}`,
  )).items.filter((item) => item.subjectType === "run_step");
}

test.describe.configure({ mode: "serial" });
test.beforeAll(() => {
  if (!realApi) return;
  deno("web-auth-seed", [email], { WEB_AUTH_SEED_PASSWORD: password });
  seeded = JSON.parse(
    deno("web-conversation-seed", [email]).trim().split("\n").at(-1) ?? "null",
  ) as Seeded;
});

test.describe("a workflow approval step, on the real stack", () => {
  test.skip(!realApi, "needs the real-API stack");
  test.setTimeout(laneBudgetMs(240_000));
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the run waits, and Approve is recorded without ending it", async ({ page }) => {
    await signedIn(page);
    const { task, runId } = await waiting(page);
    await expect(page.getByText("Waiting for you").first()).toBeVisible({
      timeout: 60_000,
    });
    await expect(review(page)).toBeVisible();
    await shot(page, "waiting-line");
    const open = await approvals(page, task.id);
    expect(open.map((item) => item.status)).toEqual(["open"]);
    expect((await get<Run>(page, `/v1/runs/${runId}`)).status).not.toBe(
      "completed",
    );

    await review(page).click();
    await expect(page.getByRole("button", { name: "Approve", exact: true }))
      .toBeVisible();
    await shot(page, "pane");
    await page.getByRole("button", { name: "Approve", exact: true }).click();

    await expect(page.getByText("Waiting for you")).toHaveCount(0, {
      timeout: 60_000,
    });
    const decided = await approvals(page, task.id);
    expect(decided.map((item) => [item.status, item.decision])).toEqual([
      ["answered", "approve"],
    ]);
    expect(["canceled", "failed", "completed"]).not.toContain(
      (await get<Run>(page, `/v1/runs/${runId}`)).status,
    );
    await expect(visibleRunLine(page)).not.toContainText("Canceled");
    await shot(page, "approved");
  });

  test("Request changes ends the run and says so", async ({ page }) => {
    await signedIn(page);
    const { task, runId } = await waiting(page);
    await expect(review(page)).toBeVisible({ timeout: 60_000 });
    await review(page).click();
    await page.getByRole("button", { name: "Request changes", exact: true })
      .click();
    await page.getByRole("button", { name: "Ask for changes", exact: true })
      .click();
    await expect(page.getByText("Say what should change.")).toBeVisible();
    await page.getByLabel("What should change?").fill("Cover the empty case.");
    await shotOne(page, "changes-dialog");
    await page.getByRole("button", { name: "Ask for changes", exact: true })
      .click();

    await expect(page.getByText("Changes requested").first()).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByText("Cover the empty case.").first())
      .toBeVisible();
    await expect(visibleRunLine(page)).not.toContainText("Canceled");
    const decided = await approvals(page, task.id);
    expect(decided.map((item) => [item.status, item.decision])).toEqual([
      ["answered", "request_changes"],
    ]);
    expect(decided[0]!.decisionComment).toBe("Cover the empty case.");
    await expect.poll(
      async () => (await get<Run>(page, `/v1/runs/${runId}`)).status,
      { timeout: 90_000 },
    ).not.toBe("running");
    const status = (await get<Run>(page, `/v1/runs/${runId}`)).status;
    expect(["canceled", "failed"]).toContain(status);
    await shot(page, "changes-requested");
  });

  test("Reject ends the run and says so", async ({ page }) => {
    await signedIn(page);
    const { task, runId } = await waiting(page);
    await expect(review(page)).toBeVisible({ timeout: 60_000 });
    await review(page).click();
    await page.getByRole("button", { name: "Reject", exact: true }).click();
    await shotOne(page, "reject-dialog");
    await page.getByRole("button", { name: "Reject", exact: true }).last()
      .click();

    await expect(runLine(page)).toBeVisible();
    await expect(page.getByText("Rejected").first()).toBeVisible({
      timeout: 60_000,
    });
    await expect(visibleRunLine(page)).not.toContainText("Canceled");
    const decided = await approvals(page, task.id);
    expect(decided.map((item) => [item.status, item.decision])).toEqual([
      ["answered", "reject"],
    ]);
    await expect.poll(
      async () => (await get<Run>(page, `/v1/runs/${runId}`)).status,
      { timeout: 90_000 },
    ).not.toBe("running");
    await shot(page, "rejected");
  });
});
