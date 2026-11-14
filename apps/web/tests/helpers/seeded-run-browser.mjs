import assert from "node:assert/strict";
import process from "node:process";
import { createHash, randomUUID } from "node:crypto";
import { chromium, expect } from "@playwright/test";

async function readInput() {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  return JSON.parse(input);
}

/**
 * Records why a page did not render: document loads, rendered UI components
 * and their states, failed or slow API calls and console errors. Paths and
 * codes only; no cookies, headers or bodies.
 */
function watchPageLoad(page) {
  const startedAt = Date.now();
  let documents = 0;
  const requests = [];
  const errors = [];
  const onRequest = (request) => {
    if (request.resourceType() === "document") documents++;
  };
  const onFinished = (request) => {
    const elapsed = request.timing().responseEnd;
    if (elapsed > 2_000) {
      requests.push(
        `${Math.round(elapsed)}ms ${new URL(request.url()).pathname}`,
      );
    }
  };
  const onFailed = (request) => {
    requests.push(
      `${request.failure()?.errorText ?? "failed"} ${
        new URL(request.url()).pathname
      }`,
    );
  };
  const onResponse = (response) => {
    if (response.status() >= 400) {
      requests.push(`${response.status()} ${new URL(response.url()).pathname}`);
    }
  };
  const onConsole = (message) => {
    if (message.type() === "error") errors.push(message.text().slice(0, 160));
  };
  const onPageError = (error) => errors.push(String(error).slice(0, 160));
  page.on("request", onRequest);
  page.on("requestfinished", onFinished);
  page.on("requestfailed", onFailed);
  page.on("response", onResponse);
  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  const stop = () => {
    page.off("request", onRequest);
    page.off("requestfinished", onFinished);
    page.off("requestfailed", onFailed);
    page.off("response", onResponse);
    page.off("console", onConsole);
    page.off("pageerror", onPageError);
  };
  return {
    stop,
    async report() {
      stop();
      const components = await page.locator("[data-ui-component]").evaluateAll(
        (nodes) =>
          [
            ...new Set(
              nodes.map((node) =>
                `${node.getAttribute("data-ui-component")}${
                  node.getAttribute("data-state")
                    ? `:${node.getAttribute("data-state")}`
                    : ""
                }`
              ).filter((name) => !name.startsWith("icon")),
            ),
          ].slice(0, 24),
      ).catch(() => []);
      return JSON.stringify({
        elapsedMs: Date.now() - startedAt,
        url: new URL(page.url()).pathname,
        documents,
        components,
        requests: requests.slice(0, 12),
        errors: errors.slice(0, 6),
      });
    },
  };
}

// Real API-created repository/profile metadata; no provider or worker execution.
async function proveIntake(page, baseUrl, organizationId) {
  const suffix = randomUUID();
  const headers = {
    "Bakery-Organization-Id": organizationId,
    origin: baseUrl,
  };
  async function create(path, data) {
    const response = await page.request.post(`${baseUrl}${path}`, {
      headers: { ...headers, "Idempotency-Key": randomUUID() },
      data,
    });
    assert.equal(response.status(), 201, `intake fixture ${path}`);
    return await response.json();
  }
  const app = await create("/v1/applications", {
    slug: `intake-${suffix}`,
    name: "Phone intake proof",
    description: "",
  });
  const repo = await create("/v1/repositories", {
    applicationId: app.id,
    slug: `intake-${suffix}`,
    integrationConnectionId: randomUUID(),
    providerRepoId: "fixture/intake",
    owner: "fixture",
    name: "intake",
    defaultBranch: "main",
  });
  // Sorted object keys match the canonical immutable strict-v1 profile digest.
  const config = {
    branches: { allowedPatterns: ["delivery/*"], base: "main" },
    schemaVersion: 1,
    workflow: { kind: "fixed" },
    worktree: { root: ".agents/worktrees/intake" },
  };
  const digest = createHash("sha256").update(JSON.stringify(config)).digest(
    "hex",
  );
  const profile = await create(`/v1/repositories/${repo.id}/profiles`, {
    revision: 1,
    config,
    digest,
  });
  await page.goto(
    `${baseUrl}/projects/onboarding?application=${app.id}&repository=${repo.id}&profile=${profile.id}`,
  );
  const composer = page.getByTestId("projects-onboarding-task-scope");
  const title = `Phone intake ${suffix}`;
  await composer.getByLabel("Task title").fill(title);
  await composer.getByLabel("Task description", { exact: true }).fill(
    "Real authenticated phone intake; no coding execution claimed.",
  );
  const admitted = page.waitForResponse((response) =>
    response.request().method() === "POST" &&
    new URL(response.url()).pathname === "/v1/tasks"
  );
  await composer.getByRole("button", { name: "Create draft task", exact: true })
    .click();
  const response = await admitted;
  assert.equal(response.status(), 201);
  const task = await response.json();
  const request = response.request();
  const key = request.headers()["idempotency-key"];
  assert.ok(key);
  assert.equal(task.repositoryProfileId, profile.id);
  assert.equal(task.repositoryProfileRevision, 1);
  assert.equal(task.repositoryProfileDigest, digest);
  assert.equal(task.currentRunId, null);
  const replay = await page.request.post(`${baseUrl}/v1/tasks`, {
    headers: { ...headers, "Idempotency-Key": key },
    data: request.postDataJSON(),
  });
  assert.equal(replay.status(), 201);
  assert.deepEqual(await replay.json(), task);
  await composer.getByRole("link", { name: task.id, exact: true }).click();
  await expect(page).toHaveURL(`${baseUrl}/tasks/${task.id}`);
  await expect(page.getByText(title, { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText(title, { exact: true })).toBeVisible();
  // A draft task offers the fixed-preset start; its run state is the server's.
  await expect(page.getByText("Start a run", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start run", exact: true }))
    .toBeVisible();
  // Activating another profile must not retarget the existing task's pins.
  await create(`/v1/repositories/${repo.id}/profiles`, {
    revision: 2,
    config,
    digest,
  });
  const restored = await page.request.get(`${baseUrl}/v1/tasks/${task.id}`, {
    headers,
  });
  assert.equal(restored.status(), 200);
  const restoredTask = await restored.json();
  assert.equal(restoredTask.repositoryProfileId, profile.id);
  assert.equal(restoredTask.repositoryProfileRevision, 1);
  assert.equal(restoredTask.repositoryProfileDigest, digest);
  assert.equal(restoredTask.currentRunId, null);
  const listed = await page.request.get(
    `${baseUrl}/v1/tasks?search=${
      encodeURIComponent(title)
    }&repositoryId=${repo.id}`,
    { headers },
  );
  assert.equal(listed.status(), 200);
  assert.deepEqual((await listed.json()).items.map((item) => item.id), [
    task.id,
  ]);
  const inbox = watchPageLoad(page);
  await page.goto(`${baseUrl}/tasks`);
  // The search is a field in the Work list toolbar row, labelled "Search tasks".
  const search = page.getByRole("searchbox", { name: "Search tasks" });
  await search.waitFor({ timeout: 30_000 }).catch(async () => {
    throw new Error(`SEEDED_RUN_TASK_INBOX_MISSING:${await inbox.report()}`);
  });
  inbox.stop();
  await search.fill(title);
  await page.getByRole("link", { name: title, exact: true }).click();
  await expect(page).toHaveURL(`${baseUrl}/tasks/${task.id}`);
  assert.equal(
    await page.evaluate(() =>
      document.documentElement.scrollWidth > innerWidth
    ),
    false,
  );
  console.log(
    "REAL_PHONE_INTAKE=created,replayed-once,pins-retained,reloaded,inbox-linked",
  );
}

async function run() {
  const {
    baseUrl,
    phase,
    fixtureIds: { organizationId, taskId, runId },
    sessionCookie,
  } = await readInput();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    try {
      await context.addCookies([{
        name: "better-auth.session_token",
        value: sessionCookie.split("=", 2)[1],
        domain: "127.0.0.1",
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      }]);
      await context.addInitScript((selectedOrganizationId) => {
        localStorage.setItem(
          "bakery.organization.lastSelected.v1",
          selectedOrganizationId,
        );
      }, organizationId);
      const page = await context.newPage();
      page.on("response", (response) => {
        const path = new URL(response.url()).pathname;
        if (response.status() >= 400 && path.startsWith("/v1/")) {
          console.error(
            "API_FAILURE",
            response.request().method(),
            path,
            response.status(),
          );
        }
      });
      if (phase === "intake") {
        await proveIntake(page, baseUrl, organizationId);
        return;
      }
      console.error("SEEDED_BROWSER_STEP", phase, "navigate");
      await page.goto(`${baseUrl}/tasks/${taskId}`, {
        waitUntil: "domcontentloaded",
      });
      await page.getByText("Seeded durable task").waitFor({
        state: "visible",
        timeout: 20_000,
      });
      assert.equal(await page.getByText("Seeded durable task").count(), 1);
      await expect(page.getByText(runId, { exact: true })).toHaveCount(1);
      await expect(page.getByText("inspect", { exact: true })).toHaveCount(1);
      console.error("SEEDED_BROWSER_STEP", phase, "loaded-run-and-step");
      const controls = page.getByRole("button", { name: /Request/ });
      await controls.first().waitFor({ state: "visible" });
      assert.equal(await controls.count(), 4);
      if (phase === "terminal") {
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(page.getByText(runId, { exact: true })).toHaveCount(1);
        await expect(page.getByText("inspect", { exact: true })).toHaveCount(1);
        await expect(page.getByRole("status", { name: "Run updates" }))
          .toHaveText("Current run: Completed");
        const runResponse = await page.request.get(
          `${baseUrl}/v1/runs/${runId}`,
          {
            headers: {
              cookie: sessionCookie,
              "Bakery-Organization-Id": organizationId,
            },
          },
        );
        assert.equal(runResponse.status(), 200);
        assert.equal((await runResponse.json()).status, "completed");
        const terminalCapabilities = await page.request.get(
          `${baseUrl}/v1/runs/${runId}/controls`,
          { headers: { "Bakery-Organization-Id": organizationId } },
        );
        assert.equal(terminalCapabilities.status(), 200);
        const terminalBody = await terminalCapabilities.json();
        assert.equal(terminalBody.actions.length, 4);
        assert.ok(
          terminalBody.actions.every((item) =>
            item.canRequest === false && item.reason === "already_terminal"
          ),
        );
        for (const button of await controls.all()) {
          assert.equal(await button.isDisabled(), true);
        }
        return;
      }
      const cancel = page.getByRole("button", {
        name: "Request cancellation",
        exact: true,
      });
      await expect(cancel).toBeEnabled();
      console.error("SEEDED_BROWSER_STEP", phase, "cancel-enabled");
      const capabilities = await page.request.get(
        `${baseUrl}/v1/runs/${runId}/controls`,
        {
          headers: {
            cookie: sessionCookie,
            "Bakery-Organization-Id": organizationId,
          },
        },
      );
      assert.equal(capabilities.status(), 200);
      const capabilityBody = await capabilities.json();
      assert.equal(
        capabilityBody.actions.find((item) => item.action === "cancel")
          ?.canRequest,
        true,
      );
      console.error("SEEDED_BROWSER_STEP", phase, "capability-verified");
      const foreignOrigin = await page.request.post(
        `${baseUrl}/v1/runs/${runId}/controls`,
        {
          headers: {
            "Bakery-Organization-Id": organizationId,
            "Idempotency-Key": "denied-foreign-origin",
            origin: "https://invalid.example.test",
          },
          data: { action: "cancel" },
        },
      );
      assert.equal(foreignOrigin.status(), 403);
      let key;
      page.on("request", (request) => {
        if (
          request.method() === "POST" &&
          request.url().endsWith(`/v1/runs/${runId}/controls`)
        ) key = request.headers()["idempotency-key"];
      });
      const admissionResponse = page.waitForResponse((response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`/v1/runs/${runId}/controls`)
      );
      await cancel.click();
      const admitted = await admissionResponse;
      console.error("SEEDED_BROWSER_POST_STATUS", admitted.status());
      assert.equal(admitted.status(), 201);
      const admittedBody = await admitted.json();
      const receipt = page.getByRole("status", {
        name: "Control request receipt",
      });
      await receipt.waitFor({ state: "visible" });
      await expect(receipt).toContainText("Request admitted.");
      console.error("SEEDED_BROWSER_STEP", phase, "receipt-admitted");
      assert.ok(key, "real UI request did not expose its idempotency key");
      const replay = await page.request.post(
        `${baseUrl}/v1/runs/${runId}/controls`,
        {
          headers: {
            cookie: sessionCookie,
            "Bakery-Organization-Id": organizationId,
            "Idempotency-Key": key,
            origin: baseUrl,
          },
          data: { action: "cancel" },
        },
      );
      assert.equal(replay.status(), 201, "HTTP-level native replay failed");
      assert.deepEqual(await replay.json(), admittedBody);
      console.log(`SEEDED_CONTROL_KEY=${key}`);
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

try {
  await run();
} catch (error) {
  console.error(
    "SEEDED_RUN_BROWSER_FAILED",
    error instanceof Error ? error.message : "Unknown failure",
  );
  process.exitCode = 1;
}
