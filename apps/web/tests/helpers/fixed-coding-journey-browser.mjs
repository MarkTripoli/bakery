import assert from "node:assert/strict";
import process from "node:process";
import { createHash } from "node:crypto";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";

// One phase of the fixed coding preset journey per invocation. The Deno test
// owns the stack, worker and harness gate; this driver owns the browser and
// reports one JOURNEY_RESULT line. Every assertion compares the UI with the
// server's own record, never with a fixture.

const STATUS_LABEL = {
  queued: "Queued",
  running: "Running",
  paused: "Paused",
  canceling: "Canceling",
  canceled: "Canceled",
  completed: "Completed",
  failed: "Failed",
  blocked: "Blocked",
};
const TERMINAL = new Set(["completed", "failed", "canceled"]);
const POLL_MS = 250;

// Evidence recording is opt-in: `scripts/evidence/record-fixed-coding-journey.mjs`
// sets this directory. Without it the driver records nothing and the
// assertions are the only behavior.
const RECORD_DIR = process.env.BAKERY_JOURNEY_RECORD_DIR?.trim() || undefined;
const CAPTION_TEXT = process.env.BAKERY_JOURNEY_CAPTION?.trim() || undefined;
// Queue shot before these phases, session shot after these phases.
const QUEUE_SHOT_BEFORE = new Set(["pauseResume", "phoneCreate"]);
const SESSION_SHOT_AFTER = new Set(["reconnect", "phoneReload"]);

async function readInput() {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  return JSON.parse(input);
}

function api(input) {
  const headers = {
    cookie: input.sessionCookie,
    "Bakery-Organization-Id": input.organizationId,
    origin: input.baseUrl,
  };
  return async (path) => {
    const response = await fetch(`${input.baseUrl}${path}`, { headers });
    assert.equal(response.status, 200, `GET ${path} ${response.status}`);
    return response.json();
  };
}

async function until(description, timeoutMs, probe) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(`JOURNEY_TIMEOUT:${description}`);
}

const steps = (page) => page.getByRole("list", { name: "Run steps" });
const stepRow = (page, title) =>
  steps(page).getByRole("listitem").filter({ hasText: title });
const runStatus = (page) => page.getByRole("status", { name: "Run updates" });
const control = (page, name) => page.getByRole("button", { name, exact: true });
const composer = (page) => page.getByRole("form", { name: "New task" });

async function release(input) {
  await mkdir(input.harnessDir, { recursive: true });
  await writeFile(`${input.harnessDir}/${input.jobId}.release`, "release\n");
}

async function fillComposer(page, input, title, description) {
  await composer(page).getByRole("combobox", { name: /^Repository/ })
    .selectOption(input.repositoryId);
  await expect(page.getByRole("radio", { name: /Fixed coding/ }))
    .toBeChecked();
  await composer(page).getByRole("textbox", { name: /^Title/ }).fill(title);
  await composer(page).getByRole("textbox", { name: /^Description/ })
    .fill(description);
  await composer(page).getByRole("textbox", { name: /^Budget limit \(USD\)/ })
    .fill(input.budgetLimitUsd);
}

async function newTaskFromQueue(page, input, title, description) {
  await page.goto(`${input.baseUrl}/tasks`, { waitUntil: "domcontentloaded" });
  await page.getByRole("link", { name: "New task", exact: true }).click();
  await expect(page).toHaveURL(/\/tasks\/new$/);
  await fillComposer(page, input, title, description);
}

async function selectedArtifact(get, taskId) {
  const artifacts = await get(`/v1/artifacts?taskId=${taskId}&limit=25`);
  const artifact = artifacts.items[0];
  assert.ok(artifact, "the task has no artifact");
  const versions = await get(`/v1/artifacts/${artifact.id}/versions?limit=100`);
  const version =
    versions.items.find((item) => item.id === artifact.currentVersionId) ??
      versions.items[0];
  assert.ok(version, "the artifact has no version");
  return { artifact, version };
}

async function expectRunMatchesApi(page, get, runId) {
  const run = await get(`/v1/runs/${runId}`);
  await expect(runStatus(page)).toContainText(STATUS_LABEL[run.status]);
  return run;
}

/** Cases 1 and 2 setup: submit, abort the run response once, retry. */
async function submit(page, input) {
  const get = api(input);
  let aborted = 0;
  await page.route("**/v1/tasks/*/runs", async (route) => {
    if (route.request().method() !== "POST" || aborted > 0) {
      return route.continue();
    }
    aborted += 1;
    // The server commits the run, then the response is lost.
    await route.fetch();
    await route.abort("failed");
  });
  await newTaskFromQueue(page, input, input.title, input.description);
  await composer(page).getByRole("button", { name: "Start task", exact: true })
    .click();
  const retry = composer(page).getByRole("button", {
    name: "Retry submission",
    exact: true,
  });
  await expect(retry).toBeVisible();
  assert.equal(aborted, 1, "the run response was not interrupted");
  await retry.click();
  await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}$/);
  const taskId = new URL(page.url()).pathname.split("/").pop();
  const listed = await get(
    `/v1/tasks?search=${
      encodeURIComponent(input.title)
    }&repositoryId=${input.repositoryId}`,
  );
  assert.equal(listed.items.length, 1, "retry must not create a second task");
  const task = await get(`/v1/tasks/${taskId}`);
  assert.ok(task.currentRunId, "the task has no current run");
  await expect(runStatus(page)).toContainText("Current run:");
  return { taskId, runId: task.currentRunId };
}

/** Case 2: queued, brief completed with its artifact card, implement running. */
async function progress(page, input) {
  const get = api(input);
  await page.goto(`${input.baseUrl}/tasks/${input.taskId}`, {
    waitUntil: "domcontentloaded",
  });
  await expect(stepRow(page, "Write task brief")).toContainText("Completed", {
    timeout: 90_000,
  });
  await expect(stepRow(page, "Implement")).toContainText("Running", {
    timeout: 90_000,
  });
  await expect(
    steps(page).getByRole("listitem").filter({
      hasText: "Run queued",
    }),
  ).toHaveCount(1);
  const { version } = await selectedArtifact(get, input.taskId);
  const card = page.locator('[data-ui-component="artifactDescriptor"]');
  await expect(card).toBeVisible();
  await expect(card).toContainText(version.sha256);
  await expectRunMatchesApi(page, get, input.runId);
  return { briefDigest: version.sha256 };
}

/** Case 3: offline mid-run, release the harness, reconnect; nothing doubles. */
async function reconnect(page, input, context) {
  const get = api(input);
  await page.goto(`${input.baseUrl}/tasks/${input.taskId}`, {
    waitUntil: "domcontentloaded",
  });
  await expect(stepRow(page, "Implement")).toContainText("Running", {
    timeout: 90_000,
  });
  await context.setOffline(true);
  await release(input);
  // The server run finishes while this browser cannot see it.
  await until("run terminal on the server", 120_000, async () => {
    const run = await get(`/v1/runs/${input.runId}`);
    return TERMINAL.has(run.status) ? run : undefined;
  });
  await expect(stepRow(page, "Implement")).toContainText("Running");
  await context.setOffline(false);
  await expect(stepRow(page, "Implement")).toContainText("Completed", {
    timeout: 60_000,
  });
  await expect(
    steps(page).getByRole("listitem").filter({
      hasText: "Run completed",
    }),
  ).toHaveCount(1);
  await expect(stepRow(page, "Implement")).toHaveCount(1);
  await expect(stepRow(page, "Write task brief")).toHaveCount(1);
  await expect(
    steps(page).getByRole("listitem").filter({
      hasText: "Run queued",
    }),
  ).toHaveCount(1);
  const run = await expectRunMatchesApi(page, get, input.runId);
  return { status: run.status };
}

/**
 * Brings the verified patch preview, safe download control and the page's
 * bounded-extraction notice on screen. The fixed coding artifact is
 * `text/x-diff`, so the page renders a verified patch preview but does not
 * offer bounded extraction; Details must identify it as attachment-only.
 */
async function showDownloadAndPreview(page) {
  const download = page.getByRole("button", {
    name: "Download verified bytes",
  });
  await download.scrollIntoViewIfNeeded();
  await expect(download).toBeVisible();

  const viewer = page.locator('[data-ui-component="artifactViewer"]');
  await expect(viewer).toHaveAttribute("data-variant", "patch");
  await expect(viewer).toBeVisible();

  const detailsToggle = page.getByTestId("artifact-retrieval-details-toggle");
  await expect(detailsToggle).toHaveAttribute("aria-expanded", "false");
  await detailsToggle.click();
  await expect(detailsToggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("artifact-retrieval-details")).toBeVisible();

  const bounded = page.getByTestId("artifact-retrieval-unsafe-media");
  await bounded.scrollIntoViewIfNeeded();
  await expect(bounded).toBeVisible();
  await expect(bounded).toContainText("attachment-only");
  await expect(page.getByTestId("artifact-retrieval-extract")).toHaveCount(0);
  if (RECORD_DIR) await page.waitForTimeout(1_500);
}

/** Case 4: descriptor digest equals the API sha256; the download is sandboxed. */
async function artifact(page, input) {
  const get = api(input);
  const { artifact: record, version } = await selectedArtifact(
    get,
    input.taskId,
  );
  await page.goto(`${input.baseUrl}/tasks/${input.taskId}`, {
    waitUntil: "domcontentloaded",
  });
  const card = page.locator('[data-ui-component="artifactDescriptor"]');
  await expect(card).toContainText(version.sha256);
  await page.getByRole("link", { name: /^Open/ }).first().click();
  await expect(page).toHaveURL(
    new RegExp(`/tasks/${input.taskId}/artifacts/${record.id}$`),
  );
  await expect(page.locator('[data-ui-component="artifactDescriptor"]'))
    .toContainText(version.sha256);
  await showDownloadAndPreview(page);
  const content = await page.request.get(
    `${input.baseUrl}/v1/artifact-versions/${version.id}/content`,
    {
      headers: {
        cookie: input.sessionCookie,
        "Bakery-Organization-Id": input.organizationId,
      },
    },
  );
  assert.equal(content.status(), 200);
  const headers = content.headers();
  assert.ok(
    headers["content-disposition"]?.toLowerCase().startsWith("attachment"),
    `disposition ${headers["content-disposition"]}`,
  );
  assert.ok(
    headers["content-security-policy"]?.includes("sandbox"),
    "the artifact response must carry a sandboxing CSP",
  );
  assert.equal(headers["x-content-type-options"]?.toLowerCase(), "nosniff");
  const digest = createHash("sha256").update(await content.body()).digest(
    "hex",
  );
  assert.equal(digest, version.sha256.toLowerCase());
  return {
    artifactId: record.id,
    versionId: version.id,
    sha256: version.sha256,
    disposition: headers["content-disposition"],
  };
}

/** Case 5: cancel races the release; the UI shows the API's winner. */
async function race(page, input) {
  const get = api(input);
  await page.goto(`${input.baseUrl}/tasks/${input.taskId}`, {
    waitUntil: "domcontentloaded",
  });
  const cancel = control(page, "Request cancellation");
  await expect(cancel).toBeEnabled({ timeout: 90_000 });
  await Promise.all([cancel.click(), release(input)]);
  const run = await until("raced run terminal", 120_000, async () => {
    const current = await get(`/v1/runs/${input.runId}`);
    return TERMINAL.has(current.status) ? current : undefined;
  });
  assert.ok(["completed", "canceled"].includes(run.status), run.status);
  await expect(runStatus(page)).toContainText(STATUS_LABEL[run.status], {
    timeout: 60_000,
  });
  await expect(
    steps(page).getByRole("listitem").filter({
      hasText: run.status === "completed" ? "Run completed" : "Run canceled",
    }),
  ).toHaveCount(1);
  // A reload shows the same winner.
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(runStatus(page)).toContainText(STATUS_LABEL[run.status]);
  return { winner: run.status };
}

/** Case 6: a blocked run stays blocked and offers no controls. */
async function blocked(page, input) {
  const get = api(input);
  await page.goto(`${input.baseUrl}/tasks/${input.taskId}`, {
    waitUntil: "domcontentloaded",
  });
  await expect(runStatus(page)).toContainText("Blocked", { timeout: 60_000 });
  await expect(
    steps(page).getByRole("listitem").filter({
      hasText: "Run blocked",
    }),
  ).toContainText("Waiting for a dependency task to finish.");
  await expect(page.getByText("Run controls", { exact: true })).toHaveCount(0);
  for (
    const name of ["Request pause", "Request resume", "Request cancellation"]
  ) {
    await expect(control(page, name)).toHaveCount(0);
  }
  const run = await get(`/v1/runs/${input.runId}`);
  assert.equal(run.status, "blocked");
  return { status: run.status };
}

/** Case 7: pause and resume follow `controlCapabilities` exactly. */
async function pauseResume(page, input) {
  const get = api(input);
  await page.goto(`${input.baseUrl}/tasks/${input.taskId}`, {
    waitUntil: "domcontentloaded",
  });
  await expect(control(page, "Request pause")).toBeVisible({ timeout: 90_000 });
  const REASON = {
    no_active_attempt: "Nothing is running that this can be sent to.",
    already_terminal: "This run is already terminal.",
    authority_unavailable: "Request authority is unavailable.",
    unsupported: "This worker's adapter does not support this control.",
  };
  const observed = [];
  async function assertCapabilities() {
    const capabilities = await get(`/v1/runs/${input.runId}/controls`);
    for (const action of ["pause", "resume"]) {
      const capability = capabilities.actions.find((item) =>
        item.action === action
      );
      assert.ok(capability, `no ${action} capability`);
      const button = control(
        page,
        `Request ${action}`,
      );
      if (capability.canRequest) {
        await expect(button).toBeEnabled({ timeout: 30_000 });
      } else {
        await expect(button).toBeDisabled({ timeout: 30_000 });
        await expect(
          page.getByText(REASON[capability.reason], { exact: true })
            .first(),
        ).toBeVisible();
      }
      observed.push({ action, canRequest: capability.canRequest });
    }
    return capabilities;
  }
  const before = await assertCapabilities();
  const canPause = before.actions.find((item) => item.action === "pause")
    ?.canRequest;
  let paused = false;
  let resumed = false;
  const receipt = page.getByRole("status", { name: "Request sent" });
  // Admission is not a worker effect: the receipt says admitted, and the run
  // state shown must equal whatever the server reads back.
  const settle = async () => {
    await expect(receipt).toContainText("Request admitted", {
      timeout: 60_000,
    });
    await expectRunMatchesApi(page, get, input.runId);
  };
  if (canPause) {
    await control(page, "Request pause").click();
    await settle();
    paused = true;
    await control(page, "Start a new control request").click();
    const during = await assertCapabilities();
    if (during.actions.find((item) => item.action === "resume")?.canRequest) {
      await control(page, "Request resume").click();
      await settle();
      resumed = true;
    }
  }
  return { observed, paused, resumed };
}

/** Case 8 setup: create on a phone viewport. */
async function phoneCreate(page, input) {
  return await submit(page, input);
}

/** Case 8: reload and deep links show the same authoritative run and artifact. */
async function phoneReload(page, input) {
  const get = api(input);
  const run = await get(`/v1/runs/${input.runId}`);
  const { artifact: record, version } = await selectedArtifact(
    get,
    input.taskId,
  );
  await page.goto(`${input.baseUrl}/tasks/${input.taskId}`, {
    waitUntil: "domcontentloaded",
  });
  await expect(runStatus(page)).toContainText(STATUS_LABEL[run.status], {
    timeout: 60_000,
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(runStatus(page)).toContainText(STATUS_LABEL[run.status], {
    timeout: 60_000,
  });
  await expect(page.locator('[data-ui-component="artifactDescriptor"]'))
    .toContainText(version.sha256);
  await page.goto(
    `${input.baseUrl}/tasks/${input.taskId}/artifacts/${record.id}`,
    { waitUntil: "domcontentloaded" },
  );
  await expect(page.locator('[data-ui-component="artifactDescriptor"]'))
    .toContainText(version.sha256);
  if (RECORD_DIR) await page.waitForTimeout(1_500);
  return { status: run.status, artifactId: record.id, sha256: version.sha256 };
}

/**
 * Persistent on-screen label; it never intercepts pointer events. It installs
 * as soon as the document element exists, and a MutationObserver re-attaches
 * it whenever navigation, hydration or a re-render removes it.
 */
function captionScript(text) {
  const id = "bakery-evidence-caption";
  const install = () => {
    const root = document.documentElement;
    if (!root || document.getElementById(id)) return;
    const caption = document.createElement("div");
    caption.id = id;
    caption.setAttribute("aria-hidden", "true");
    caption.textContent = text;
    caption.style.cssText = [
      "position:fixed",
      "left:0",
      "right:0",
      "bottom:0",
      "z-index:2147483647",
      "pointer-events:none",
      "padding:4px 8px",
      "font:600 11px/1.3 system-ui,sans-serif",
      "color:#fff",
      "background:rgba(120,20,20,.92)",
      "text-align:center",
    ].join(";");
    root.append(caption);
  };
  install();
  new MutationObserver(install).observe(document, {
    childList: true,
    subtree: false,
  });
  const watch = () => {
    if (!document.documentElement) return;
    new MutationObserver(install).observe(document.documentElement, {
      childList: true,
    });
    install();
  };
  if (document.documentElement) watch();
  else {
    const wait = new MutationObserver(() => {
      if (!document.documentElement) return;
      wait.disconnect();
      watch();
    });
    wait.observe(document, { childList: true });
  }
  setInterval(install, 100);
}

async function capture(page, input, name, { caption = true } = {}) {
  if (!RECORD_DIR) return;
  const dir = join(RECORD_DIR, "screenshots");
  await mkdir(dir, { recursive: true });
  const label = `${input.viewport === "phone" ? "phone" : "desktop"}-${name}`;
  const path = join(dir, `${label}.png`);
  if (caption || !CAPTION_TEXT) {
    await page.screenshot({ path, fullPage: false });
    return;
  }
  // Caption-free shot: hide the band on a throwaway page in the same context,
  // so the recorded page, and its video, keep the band on every frame.
  const shot = await page.context().newPage();
  try {
    await shot.goto(page.url(), { waitUntil: "domcontentloaded" });
    await shot.waitForTimeout(1_500);
    await shot.addStyleTag({
      content: "#bakery-evidence-caption{display:none!important}",
    });
    await shot.screenshot({ path, fullPage: false });
  } finally {
    await shot.close();
  }
}

async function showQueue(page, input) {
  await page.goto(`${input.baseUrl}/tasks`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("link", { name: "New task", exact: true }))
    .toBeVisible();
  await page.waitForTimeout(1_500);
  await capture(page, input, "queue", { caption: false });
}

async function showSession(page, input) {
  await page.goto(`${input.baseUrl}/tasks/${input.taskId}`, {
    waitUntil: "domcontentloaded",
  });
  await expect(runStatus(page)).toBeVisible();
  await page.waitForTimeout(1_500);
  await capture(page, input, "session", { caption: false });
}

/** Next free `NN-phase-viewport` slot, so repeated phases keep their order. */
async function nextVideoName(phase, viewport) {
  const dir = join(RECORD_DIR, "videos");
  await mkdir(dir, { recursive: true });
  const taken = (await readdir(dir)).filter((name) => name.endsWith(".webm"));
  const index = String(taken.length + 1).padStart(2, "0");
  return join(dir, `${index}-${phase}-${viewport}.webm`);
}

const PHASES = {
  submit,
  progress,
  reconnect,
  artifact,
  race,
  blocked,
  pauseResume,
  phoneCreate,
  phoneReload,
};

async function main() {
  const input = await readInput();
  const phase = PHASES[input.phase];
  assert.ok(phase, `unknown phase ${input.phase}`);
  const browser = await chromium.launch({ headless: true });
  try {
    const phone = input.viewport === "phone";
    const viewport = phone
      ? { width: 390, height: 844 }
      : { width: 1280, height: 900 };
    const videoDir = RECORD_DIR
      ? join(RECORD_DIR, "videos", ".raw", `${process.pid}-${input.phase}`)
      : undefined;
    const context = await browser.newContext({
      ...(phone ? { viewport, isMobile: true, hasTouch: true } : { viewport }),
      ...(videoDir ? { recordVideo: { dir: videoDir, size: viewport } } : {}),
    });
    try {
      await context.addCookies([{
        name: "better-auth.session_token",
        value: input.sessionCookie.split("=", 2)[1],
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
      }, input.organizationId);
      if (RECORD_DIR && CAPTION_TEXT) {
        await context.addInitScript(captionScript, CAPTION_TEXT);
      }
      const page = await context.newPage();
      page.setDefaultTimeout(30_000);
      page.on("response", async (response) => {
        const path = new URL(response.url()).pathname;
        if (response.status() >= 400 && path.startsWith("/v1/")) {
          console.error(
            "API_FAILURE",
            response.request().method(),
            path,
            response.status(),
          );
          if (response.status() >= 500) {
            const body = await response.text().catch(() => "");
            console.error("API_FAILURE_BODY", body.slice(0, 600));
          }
        }
      });
      if (RECORD_DIR && QUEUE_SHOT_BEFORE.has(input.phase)) {
        await showQueue(page, input);
      }
      const result = await phase(page, input, context);
      if (RECORD_DIR) {
        await capture(page, input, `${input.phase}-end`);
        if (SESSION_SHOT_AFTER.has(input.phase)) {
          await showSession(page, input);
        }
      }
      console.log(`JOURNEY_RESULT=${JSON.stringify(result ?? {})}`);
    } finally {
      const video = RECORD_DIR ? context.pages()[0]?.video() : undefined;
      // Let the last frame settle with the caption before the video closes.
      if (video) await context.pages()[0].waitForTimeout(750).catch(() => {});
      await context.close();
      if (video && videoDir) {
        const target = await nextVideoName(
          input.phase,
          phone ? "phone" : "desktop",
        );
        const raw = await video.path();
        await rename(raw, target);
        await rm(videoDir, { recursive: true, force: true });
      }
    }
  } finally {
    await browser.close();
  }
}

await main();
