import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  expect,
  type Locator,
  type Page,
} from "@playwright/test";
import { submitUntilAccepted } from "./api-retry.ts";

/**
 * Shared run-observation helpers for the real-stack Playwright specs: the FS06
 * real-harness spec (`../run-observation-real-harness.spec.ts`, issue #420) and
 * the M1 journey spec. They were moved out of the FS06 spec
 * unchanged, so the FS06 selectors, assertions and evidence JSON fields are
 * identical. Nothing here reads an environment variable by a fixed name: each
 * caller passes the name (`loadCanaries`) or the resolved value (the screenshot
 * directory, the owner credentials, `CompletedRunOptions`) from its own
 * `BAKERY_FS06_*` or `BAKERY_M1_*` variables. No `page.route` or
 * `routeWebSocket`: every response, frame and download is observed from the
 * real server and the real worker.
 */

export type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

// ---- small utilities --------------------------------------------------------
export const sha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

const helper = fileURLToPath(
  new URL(
    "../../../../tests/helpers/web-run-artifact-seed.ts",
    import.meta.url,
  ),
);

export function helperJson<T>(...args: string[]): T {
  const output = execFileSync("deno", [
    "run",
    "--allow-env",
    "--allow-read",
    "--allow-net",
    helper,
    ...args,
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return JSON.parse(output.trim().split("\n").at(-1) ?? "null") as T;
}

/** Every spelling of a canary a JSON or ASCII-escaping producer could emit. */
export function needleVariants(canaries: readonly string[]): string[] {
  const needles = new Set<string>();
  for (const canary of canaries) {
    needles.add(canary);
    const json = JSON.stringify(canary).slice(1, -1);
    needles.add(json);
    needles.add(
      json.replace(
        new RegExp("[\\u007f-\\uffff]", "g"),
        (character) =>
          "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"),
      ),
    );
    needles.add(encodeURIComponent(canary));
  }
  return [...needles].filter((needle) => needle.length > 0);
}

/** `envName` names the variable that holds the canaries file path. */
export function loadCanaries(envName: string): string[] {
  const file = process.env[envName];
  if (!file) throw new Error(`${envName} is required`);
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (
    !Array.isArray(parsed) || parsed.length === 0 ||
    !parsed.every((value) => typeof value === "string" && value.length > 0)
  ) throw new Error("canaries file must be a non-empty JSON string array");
  return parsed as string[];
}

/** `shotDirectory` is the evidence directory; an empty string disables it. */
export function save(shotDirectory: string, name: string, value: unknown) {
  if (!shotDirectory) return;
  mkdirSync(shotDirectory, { recursive: true });
  writeFileSync(`${shotDirectory}/${name}`, JSON.stringify(value, null, 2));
}

export async function shot(shotDirectory: string, page: Page, name: string) {
  if (!shotDirectory) return;
  mkdirSync(shotDirectory, { recursive: true });
  const path = `${shotDirectory}/${name}.png`;
  // A page taller than the browser can capture falls back to the viewport.
  await page.screenshot({ path, fullPage: true }).catch(() =>
    page.screenshot({ path })
  );
}

/** Desktop and phone, light and dark, from the signed-in session. */
export async function shootAll(
  shotDirectory: string,
  browser: Browser,
  storageState: StorageState,
  organizationId: string,
  taskId: string,
  prefix: string,
) {
  if (!shotDirectory) return;
  const viewports = [
    { name: "desktop", viewport: { width: 1440, height: 1000 }, phone: false },
    { name: "phone", viewport: { width: 390, height: 844 }, phone: true },
  ];
  for (const { name, viewport, phone } of viewports) {
    for (const theme of ["light", "dark"] as const) {
      const context = await browser.newContext({
        storageState,
        viewport,
        colorScheme: theme,
        hasTouch: phone,
        isMobile: phone,
        locale: "en-US",
        timezoneId: "UTC",
      });
      try {
        await context.addInitScript(
          ({ organization, selected }) => {
            localStorage.setItem(
              "bakery.organization.lastSelected.v1",
              organization,
            );
            localStorage.setItem("bakery.theme.v1", selected);
          },
          { organization: organizationId, selected: theme },
        );
        const page = await context.newPage();
        await page.goto(`/tasks/${taskId}`, { waitUntil: "networkidle" });
        await selectImplementStep(page);
        // A run that never reached a worker has no output panel; its page
        // shows the empty-stream copy instead (case "unavailable").
        await expect(
          page.locator('[data-ui-component="runOutputPanel"]').first().or(
            page.getByText("No output stream recorded for this step."),
          ),
        ).toBeVisible({ timeout: 30_000 });
        await shot(shotDirectory, page, `${prefix}-${name}-${theme}`);
      } finally {
        await context.close();
      }
    }
  }
}

/**
 * The run view defaults its "Output step" to the first step (`brief`, which
 * has no output) instead of the implement step (finding D9, recorded in
 * live-proof.md). A person picks `implement` by hand; so does the proof. A
 * single-step run has no selector and needs nothing.
 */
export async function selectImplementStep(page: Page) {
  const picker = page.getByRole("combobox", { name: /^Output step/ });
  const ready = await expect.poll(async () => {
    if (await picker.count() === 0) return false;
    return (await picker.locator("option").allTextContents()).includes(
      "implement",
    );
  }, { timeout: 90_000, intervals: [500] }).toBe(true).then(
    () => true,
    () => false,
  );
  if (ready) await picker.selectOption({ label: "implement" });
}

export type OwnerCredentials = { ownerEmail: string; ownerPassword: string };

export async function signIn(
  page: Page,
  { ownerEmail, ownerPassword }: OwnerCredentials,
) {
  await page.goto("/sign-in");
  await submitUntilAccepted(page, "/api/auth/sign-in/email", async () => {
    await page.getByLabel("Email", { exact: true }).fill(ownerEmail);
    await page.getByLabel("Password", { exact: true }).fill(ownerPassword);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  });
  await expect(page).toHaveURL("/");
}

// ---- API reads (server evidence) ---------------------------------------------
export type Paged<T> = { items: T[]; nextCursor: string | null };
export type OutputPart = { itemId: string; channel: string; text: string };
export type OutputBatch = {
  sessionId: string;
  /** Producer binding generation that committed this batch. */
  writerGeneration: string;
  batchId: string;
  sequence: string;
  digest: string;
  parts: OutputPart[];
};
export type Segment = {
  segmentIndex: number;
  firstSequence: string;
  lastSequence: string;
  artifactVersionId: string;
  sha256: string;
  sizeBytes: number;
};
export type Producer = {
  writerGeneration: string;
  attemptId: string;
  attemptNo: number;
};
export type Stream = {
  streamId: string;
  jobId: string;
  runStepId: string | null;
  highwater: string;
  closed: boolean;
  capture: string;
  archive: string;
  segments: Segment[];
  /** One entry per attempt that produced this stream's batches. */
  producers: Producer[];
};
export type Attempt = {
  id: string;
  attemptNo: number;
  status: string;
  isCurrent: boolean;
  workerHostId: string;
  workerName: string;
  startedAt: string | null;
  endedAt: string | null;
  outcome: {
    resultStatus: string | null;
    reasonCode: string | null;
    exitCode: number | null;
    usage: unknown;
  };
};
export type Artifact = {
  id: string;
  name: string;
  artifactType: string;
  currentVersionId: string | null;
};
export type Version = {
  id: string;
  artifactId: string;
  revision: number;
  runStepId: string | null;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  subjectHeadSha: string | null;
  subjectBaseSha: string | null;
};

export class Evidence {
  constructor(
    readonly request: APIRequestContext,
    readonly organizationId: string,
  ) {}

  async raw(path: string, organizationId = this.organizationId) {
    const response = await this.request.get(path, {
      headers: { "Bakery-Organization-Id": organizationId },
    });
    return {
      status: response.status(),
      headers: response.headers(),
      body: await response.body(),
    };
  }

  async get<T>(path: string): Promise<T> {
    const result = await this.raw(path);
    expect(result.status, `${path}: ${result.status}`).toBe(200);
    return JSON.parse(result.body.toString("utf8")) as T;
  }

  async all<T>(path: string): Promise<T[]> {
    const items: T[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 50; page++) {
      const joiner = path.includes("?") ? "&" : "?";
      const result: Paged<T> = await this.get<Paged<T>>(
        `${path}${
          cursor ? `${joiner}cursor=${encodeURIComponent(cursor)}` : ""
        }`,
      );
      items.push(...result.items);
      cursor = result.nextCursor;
      if (!cursor) return items;
    }
    throw new Error(`${path}: more than 50 pages`);
  }

  /** The stream's committed batches, replayed page by page from the start. */
  async replay(streamId: string): Promise<OutputBatch[]> {
    const batches: OutputBatch[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 500; page++) {
      const result: {
        disposition: string;
        batches: OutputBatch[];
        cursor: string;
      } = await this.get(
        `/v1/output-streams/${streamId}?limit=64&maxBytes=262144${
          cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
        }`,
      );
      expect(result.disposition, "replay must not need a reset").toBe("page");
      if (result.batches.length === 0) return batches;
      batches.push(...result.batches);
      cursor = result.cursor;
    }
    throw new Error("output replay exceeded 500 pages");
  }
}

export function displayedText(batches: readonly OutputBatch[]): string {
  return batches.flatMap((batch) =>
    batch.parts.map((part) => `[${part.channel}] ${part.text}`)
  ).join("\n");
}

export function assertContiguous(
  batches: readonly { sequence: string; parts: { itemId: string }[] }[],
  label: string,
) {
  const seen = new Set<string>();
  batches.forEach((batch, index) => {
    expect(
      BigInt(batch.sequence),
      `${label}: sequence gap at ${batch.sequence}`,
    ).toBe(BigInt(batches[0].sequence) + BigInt(index));
    for (const part of batch.parts) {
      expect(seen.has(part.itemId), `${label}: duplicate item ${part.itemId}`)
        .toBe(false);
      seen.add(part.itemId);
    }
  });
}

// ---- browser observation -------------------------------------------------------
export type Seen = {
  path: string;
  status: number;
  headers: Record<string, string>;
  sha256: string;
  bytes: number;
  text: string | null;
};

export function observe(page: Page, needles: readonly string[]) {
  const responses: Seen[] = [];
  const requests: string[] = [];
  const frames: { connection: number; text: string }[] = [];
  const closedConnections: number[] = [];
  const canaryHits: string[] = [];
  /** Evidence bodies (streams, artifact versions) whose bytes were never read. */
  const unread: string[] = [];
  const pending: Promise<void>[] = [];
  const unsettled = new Map<Promise<void>, string>();
  let connections = 0;
  page.on("request", (request) => {
    requests.push(new URL(request.url()).pathname);
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith("/v1/") && !url.pathname.startsWith("/api/")) {
      return;
    }
    const read = (async () => {
      try {
        const body = await response.body();
        const type = response.headers()["content-type"] ?? "";
        if (needles.some((needle) => body.includes(needle))) {
          canaryHits.push(`response ${url.pathname}`);
        }
        responses.push({
          path: url.pathname,
          status: response.status(),
          headers: response.headers(),
          sha256: sha256(body),
          bytes: body.byteLength,
          text: /json|text/.test(type) && body.byteLength <= 4 * 1024 * 1024
            ? body.toString("utf8")
            : null,
        });
      } catch {
        // Redirects and aborted non-evidence requests are fine; an evidence
        // body that could not be read was not canary-checked.
        if (
          response.status() === 200 &&
          /^\/v1\/(output-streams|artifact-versions)\b/.test(url.pathname)
        ) unread.push(url.pathname);
      }
    })();
    pending.push(read);
    unsettled.set(read, url.pathname);
    void read.finally(() => unsettled.delete(read));
  });
  page.on("websocket", (socket) => {
    const connection = connections++;
    socket.on("framereceived", (frame) => {
      const text = typeof frame.payload === "string"
        ? frame.payload
        : frame.payload.toString("utf8");
      if (needles.some((needle) => text.includes(needle))) {
        canaryHits.push(`frame on connection ${connection}`);
      }
      frames.push({ connection, text });
    });
    socket.on("close", () => closedConnections.push(connection));
  });
  return {
    responses,
    requests,
    frames,
    closedConnections,
    canaryHits,
    unread,
    /**
     * Waits for every response body. A body that is still open after the cap
     * is a streaming response; its path is returned so the caller can state
     * what was not byte-checked instead of hanging until the test timeout.
     */
    settle: async (capMs = 20_000): Promise<string[]> => {
      await Promise.race([
        Promise.all(pending),
        new Promise((resolve) => setTimeout(resolve, capMs)),
      ]);
      return [...unsettled.values()];
    },
    connectionCount: () => connections,
    /** Output batches the page received, grouped by socket connection. */
    batchesByConnection(): Map<number, OutputBatch[]> {
      const grouped = new Map<number, OutputBatch[]>();
      for (const { connection, text } of frames) {
        let frame: { type?: string; batch?: OutputBatch };
        try {
          frame = JSON.parse(text);
        } catch {
          continue;
        }
        if (frame.type !== "output.batch" || !frame.batch) continue;
        const list = grouped.get(connection) ?? [];
        list.push(frame.batch);
        grouped.set(connection, list);
      }
      return grouped;
    },
  };
}
export type Observer = ReturnType<typeof observe>;

export async function downloadOf(page: Page, click: () => Promise<void>) {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    click(),
  ]);
  const path = await download.path();
  expect(path, "download did not finish").toBeTruthy();
  return readFileSync(path);
}

export async function assertNoCanary(
  page: Page,
  observer: Observer,
  needles: readonly string[],
  extra: Record<string, Uint8Array | string> = {},
) {
  const open = await observer.settle();
  if (open.length > 0) {
    console.log(
      `fs06: response bodies still streaming, not byte-checked: ${
        [...new Set(open)].join(", ")
      }`,
    );
  }
  const unchecked = [
    ...observer.unread,
    ...open.filter((path) =>
      /^\/v1\/(output-streams|artifact-versions)\b/.test(path)
    ),
  ];
  expect(
    unchecked,
    "evidence response bodies that were never read, so never canary-checked",
  ).toEqual([]);
  const dom = await page.content();
  const text = await page.locator("body").innerText();
  const storage = await page.evaluate(() =>
    JSON.stringify({
      local: { ...localStorage },
      session: { ...sessionStorage },
    })
  );
  const haystacks: Record<string, Uint8Array | string> = {
    dom,
    text,
    storage,
    ...extra,
  };
  for (const [label, haystack] of Object.entries(haystacks)) {
    for (const needle of needles) {
      const found = typeof haystack === "string"
        ? haystack.includes(needle)
        : Buffer.from(haystack).includes(needle);
      expect(found, `canary found in ${label}`).toBe(false);
    }
  }
  expect(observer.canaryHits, "canary in a response or socket frame").toEqual(
    [],
  );
}

// ---- the page's contract for one run ----------------------------------------------
const OUTCOME_HEADING: Record<string, RegExp> = {
  completed: /Execution completed|Process exited/,
  failed: /Execution failed/,
  timeout: /Run timed out/,
  quota: /Provider quota exceeded/,
  "lost-lease": /Worker lease lost/,
  canceled: /Run canceled/,
};

export type RunFacts = {
  taskId: string;
  runId: string;
  /** Admission pin of the inspected observation; null for strict-v1 runs. */
  baseSha: string | null;
  /** Commit the first completed harness step started from. */
  workspaceBaseSha: string | null;
  stepId: string;
  stream: Stream | null;
  attempts: Attempt[];
};

export async function collectRun(
  evidence: Evidence,
  taskId: string,
): Promise<RunFacts> {
  const task = await evidence.get<{ currentRunId: string | null }>(
    `/v1/tasks/${taskId}`,
  );
  expect(task.currentRunId, "task has a current run").toBeTruthy();
  const runId = task.currentRunId!;
  const run = await evidence.get<
    { baseSha: string | null; workspaceBaseSha: string | null }
  >(`/v1/runs/${runId}`);
  const steps = await evidence.all<{ id: string; stepKey: string }>(
    `/v1/runs/${runId}/steps?limit=100`,
  );
  expect(steps.length, "run has steps").toBeGreaterThan(0);
  const stepIds = new Set(steps.map((step) => step.id));
  const streams = (await evidence.all<Stream>(
    `/v1/output-streams?taskId=${taskId}&limit=64`,
  )).filter((stream) => stream.runStepId && stepIds.has(stream.runStepId));
  // The fixed preset runs `brief` (an empty stream) then `implement`; the run
  // under observation is the implement step's stream, never the brief's.
  const implementStepId = steps.find((step) => step.stepKey === "implement")
    ?.id;
  const stream =
    streams.find((candidate) => candidate.runStepId === implementStepId) ??
      streams.at(-1) ?? null;
  const attempts = stream
    ? await evidence.all<Attempt>(
      `/v1/jobs/${stream.jobId}/attempts?taskId=${taskId}&limit=100`,
    )
    : [];
  return {
    taskId,
    runId,
    baseSha: run.baseSha,
    workspaceBaseSha: run.workspaceBaseSha,
    stepId: stream?.runStepId ?? steps[0].id,
    stream,
    attempts,
  };
}

export async function assertOutcomePage(
  page: Page,
  evidence: Evidence,
  facts: RunFacts,
  expectation: string,
) {
  const run = await evidence.get<{ status: string }>(`/v1/runs/${facts.runId}`);
  if (expectation === "unavailable") {
    expect(facts.stream, "no stream exists for an unavailable worker")
      .toBeNull();
    await expect(page.getByText("No output stream recorded for this step."))
      .toBeVisible();
    expect(run.status).not.toBe("completed");
    await expect(page.getByText("Execution completed")).toHaveCount(0);
    return;
  }
  const heading = OUTCOME_HEADING[expectation];
  expect(heading, `unknown BAKERY_FS06_EXPECT ${expectation}`).toBeTruthy();
  // A quota failure on a step with no output stream renders as a warning
  // notice ("Provider quota exceeded: ..."), not a heading; every other
  // outcome, and a quota failure that has a stream, renders a heading. The
  // brief step's empty stream makes `facts.stream` non-null, so the quota
  // case accepts either form.
  const asHeading = page.getByRole("heading", { name: heading });
  const outcome = expectation === "quota"
    ? asHeading.or(page.getByText(heading)).first()
    : asHeading.first();
  await expect(outcome).toBeVisible({ timeout: 60_000 });
  if (expectation !== "completed") {
    expect(run.status, "no false completion").not.toBe("completed");
    await expect(page.getByText("Execution completed")).toHaveCount(0);
    await expect(
      page.locator('[data-ui-component="revisionSummary"]').first(),
    ).toHaveAttribute("data-state", "unknown");
  }
}

/**
 * Everything `assertCompleted` used to read from module-level `BAKERY_FS06_*`
 * constants. The caller resolves them from its own variables.
 */
export type CompletedRunOptions = {
  needles: string[];
  expectPatch: boolean;
  /** Labels the evidence; a `fake` executable publishes no patch. */
  harnessKind: "real" | "fake";
  /** Owner e-mail the database-owner seed helper resolves the scope from. */
  ownerEmail: string;
  /** Harness clone to compare `git diff --binary` against; empty skips it. */
  harnessRepository: string;
  /** Enrolled host id the attempt must have run on; empty or unset skips it. */
  workerHostId?: string;
  /**
   * Where the "no review or merge decision" scan looks. The default is the
   * whole page, as the FS06 spec has always scanned; the M1 journey passes the
   * page's own chrome, because its page also shows model-written text.
   */
  completionCopyScope?: (page: Page) => Locator;
};

export async function assertCompleted(
  page: Page,
  observer: Observer,
  evidence: Evidence,
  facts: RunFacts,
  options: CompletedRunOptions,
) {
  const { harnessKind, ownerEmail, harnessRepository, workerHostId } = options;
  const copyScope = options.completionCopyScope?.(page) ?? page;
  const { stream } = facts;
  expect(stream, "the run has an output stream").not.toBeNull();
  const attempts = facts.attempts;

  // One attempt, one inference, identity from the trusted worker record.
  expect(attempts.length, "one attempt for the implement job").toBe(1);
  const attempt = attempts[0];
  expect(attempt.status).toBe("completed");
  const worker = await evidence.get<{ id: string; name: string }>(
    `/v1/workers/${attempt.workerHostId}`,
  );
  expect(worker.name).toBe(attempt.workerName);
  if (workerHostId) {
    expect(attempt.workerHostId).toBe(workerHostId);
  }
  const identity = page.locator('[data-ui-component="runIdentity"]');
  await expect(identity).toContainText(worker.name);
  await expect(identity).toContainText("Attempt 1");
  await expect(identity).toContainText("trusted worker record");

  // Completion copy: no review or merge decision implied.
  await expect(
    page.getByText(
      "Observed repository state. No review or merge decision recorded.",
    )
      .first(),
  ).toBeVisible();
  await expect(copyScope.getByText(/\b(reviewed|merged)\b/i)).toHaveCount(0);
  const usage = attempt.outcome.usage;
  if (usage === null || usage === undefined) {
    await expect(page.getByText("Provider usage: unknown")).toBeVisible();
  } else {
    await expect(page.getByText(/^Provider usage: \d|input tokens/).first())
      .toBeVisible();
  }

  // Output: the displayed file equals the server replay; one system/init.
  const panel = page.locator('[data-ui-component="runOutputPanel"]');
  await expect(panel).toHaveAttribute("data-state", "complete", {
    timeout: 120_000,
  });
  const batches = await evidence.replay(stream!.streamId);
  assertContiguous(batches, "server replay");
  expect(BigInt(batches.at(-1)?.sequence ?? "0")).toBe(
    BigInt(stream!.highwater),
  );
  const full = displayedText(batches);
  const downloaded = await downloadOf(
    page,
    () =>
      panel.getByRole("link", { name: "Download displayed output" }).click(),
  );
  const windowed = await panel.getByText("Earlier output omitted").count() > 0;
  if (windowed) {
    expect(full.endsWith(downloaded.toString("utf8"))).toBe(true);
  } else {
    expect(sha256(downloaded), "displayed output digest").toBe(sha256(full));
  }
  const stdout = batches.flatMap((batch) => batch.parts).filter((part) =>
    part.channel === "stdout"
  ).map((part) => part.text).join("");
  // A retry continues the same stream, so count `system/init` per attempt: a
  // batch's writer generation names the attempt that committed it.
  const producers = (await evidence.get<{ stream: Stream }>(
    `/v1/output-streams/${stream!.streamId}?limit=1`,
  )).stream.producers;
  const attemptOf = new Map(
    producers.map((producer) => [producer.writerGeneration, producer]),
  );
  const stdoutByAttempt = new Map<string, string>();
  for (const batch of batches) {
    const producer = attemptOf.get(batch.writerGeneration);
    expect(producer, `batch ${batch.sequence} names its attempt`).toBeTruthy();
    const text = batch.parts.filter((part) => part.channel === "stdout")
      .map((part) => part.text).join("");
    stdoutByAttempt.set(
      producer!.attemptId,
      (stdoutByAttempt.get(producer!.attemptId) ?? "") + text,
    );
  }
  const initIn = (text: string) =>
    text.match(/"subtype"\s*:\s*"init"/g)?.length ?? 0;
  for (const [attemptId, text] of stdoutByAttempt) {
    expect(initIn(text), `at most one system/init in attempt ${attemptId}`)
      .toBeLessThanOrEqual(1);
  }
  const initRecords = [...stdoutByAttempt.values()].reduce(
    (total, text) => total + initIn(text),
    0,
  );
  const finalAttempt = producers.reduce((latest, producer) =>
    BigInt(producer.writerGeneration) > BigInt(latest.writerGeneration)
      ? producer
      : latest
  );
  if (harnessKind === "real" || stdout.includes('"subtype"')) {
    expect(
      initIn(stdoutByAttempt.get(finalAttempt.attemptId) ?? ""),
      "one Claude system/init record in the final attempt",
    ).toBe(1);
  }
  const marker = stdout.includes("[REDACTED]") || full.includes("[REDACTED]");

  // Archive segments: downloaded bytes equal the segment and the server copy.
  const segmentFacts: Record<string, unknown>[] = [];
  await expect.poll(
    async () =>
      (await evidence.get<{ stream: Stream }>(
        `/v1/output-streams/${stream!.streamId}?limit=1`,
      )).stream.archive,
    { timeout: 120_000 },
  ).not.toBe("pending");
  const settled = (await evidence.get<{ stream: Stream }>(
    `/v1/output-streams/${stream!.streamId}?limit=1`,
  )).stream;
  expect(settled.archive, "transcript archive state").not.toBe("failed");
  if (settled.archive === "archived") {
    await page.reload();
    await selectImplementStep(page);
    const buttons = page.getByRole("button", { name: /^Download transcript / });
    await expect(buttons).toHaveCount(settled.segments.length, {
      timeout: 30_000,
    });
    for (const [index, segment] of settled.segments.entries()) {
      const bytes = await downloadOf(page, () => buttons.nth(index).click());
      const served = await evidence.raw(
        `/v1/artifact-versions/${segment.artifactVersionId}/content`,
      );
      expect(sha256(bytes), `segment ${segment.segmentIndex} digest`).toBe(
        segment.sha256,
      );
      expect(bytes.byteLength).toBe(segment.sizeBytes);
      expect(sha256(served.body)).toBe(segment.sha256);
      segmentFacts.push({
        index: segment.segmentIndex,
        versionId: segment.artifactVersionId,
        sha256: segment.sha256,
        sizeBytes: segment.sizeBytes,
      });
    }
  }

  // Revision, patch chain, aside, artifact cards.
  const artifacts = await evidence.all<Artifact>(
    `/v1/artifacts?taskId=${facts.taskId}&limit=25`,
  );
  const stepIds = new Set(
    (await evidence.all<{ id: string }>(
      `/v1/runs/${facts.runId}/steps?limit=100`,
    ))
      .map((step) => step.id),
  );
  const versionsByArtifact = new Map<string, Version[]>();
  for (const artifact of artifacts) {
    versionsByArtifact.set(
      artifact.id,
      await evidence.all<Version>(
        `/v1/artifacts/${artifact.id}/versions?limit=100`,
      ),
    );
  }
  const patchVersions = artifacts.filter((artifact) =>
    artifact.artifactType === "patch"
  ).flatMap((artifact) =>
    (versionsByArtifact.get(artifact.id) ?? []).filter((version) =>
      version.runStepId !== null && stepIds.has(version.runStepId) &&
      version.subjectHeadSha !== null
    ).map((version) => ({ artifact, version }))
  );
  const revision = page.locator('[data-ui-component="revisionSummary"]');
  const chain: Record<string, unknown> = { expected: options.expectPatch };
  if (options.expectPatch) {
    expect(patchVersions.length, "one patch version for this run").toBe(1);
    const { artifact, version } = patchVersions[0];
    const served = await evidence.raw(
      `/v1/artifact-versions/${version.id}/content`,
    );
    expect(served.status).toBe(200);
    expect(served.body.byteLength).toBe(version.sizeBytes);
    expect(sha256(served.body), "served patch digest").toBe(version.sha256);
    expect(served.headers["x-content-type-options"]).toBe("nosniff");
    const db = helperJson<{
      versions: {
        storedSha256: string;
        computedSha256: string;
        storedSizeBytes: number;
        computedSizeBytes: number;
      }[];
    }>("digests", ownerEmail, version.id).versions[0];
    expect(db.storedSha256).toBe(version.sha256);
    expect(db.computedSha256, "DB bytes digest").toBe(version.sha256);
    expect(db.computedSizeBytes).toBe(version.sizeBytes);
    const attemptShas = helperJson<
      { headSha: string | null; baseSha: string | null }
    >("head", ownerEmail, attempt.id);
    expect(version.subjectHeadSha, "head SHA equals the attempt result").toBe(
      attemptShas.headSha,
    );
    expect(version.subjectBaseSha, "base SHA equals the attempt result").toBe(
      attemptShas.baseSha,
    );
    // The run read projects the base the harness started from, so it equals
    // the attempt result and the patch. The admission pin may be unset for a
    // strict-v1 profile; when a producer sets it, it must agree.
    expect(facts.workspaceBaseSha, "run workspace base equals the patch's")
      .toBe(
        version.subjectBaseSha,
      );
    if (facts.baseSha !== null) {
      expect(version.subjectBaseSha, "base SHA equals the run's").toBe(
        facts.baseSha,
      );
    }
    let gitDigest: string | null = null;
    if (harnessRepository) {
      const diff = execFileSync("git", [
        "-C",
        harnessRepository,
        "diff",
        "--binary",
        `${version.subjectBaseSha}..${version.subjectHeadSha}`,
      ], { maxBuffer: 64 * 1024 * 1024 });
      gitDigest = sha256(diff);
      expect(gitDigest, "git diff --binary digest").toBe(version.sha256);
    }

    // The card, expanded: shown bytes equal the served bytes.
    await revision.getByRole("button", { name: "View diff" }).first().click();
    await expect(revision.locator('[data-ui-component="codeBlock"]'))
      .toBeVisible();
    const shown = await revision.locator('code[data-language="diff"]')
      .first().textContent();
    expect(shown, "diff shown in the page").toBe(
      new TextDecoder("utf-8", { fatal: true }).decode(served.body),
    );
    await expect(revision).toContainText(version.sha256);
    await expect(revision).toContainText(
      `${version.subjectBaseSha!.slice(0, 7)} → ${
        version.subjectHeadSha!.slice(0, 7)
      }`,
    );
    const uiFetch = observer.responses.find((entry) =>
      entry.path === `/v1/artifact-versions/${version.id}/content`
    );
    expect(uiFetch?.status, "the page fetched the patch").toBe(200);
    // Playwright's `response.body()` re-encodes charset-less `text/*` bodies
    // (it showed U+202E as mojibake, 696 bytes for a 692 byte patch), so its
    // digest is not the wire digest. The wire bytes are the page's own
    // fetch, hashed in the browser.
    const uiFetchedSha256 = await page.evaluate(
      async ({ url, organization }) => {
        const response = await fetch(url, {
          credentials: "include",
          headers: {
            accept: "application/octet-stream",
            "Bakery-Organization-Id": organization,
          },
        });
        const digest = await crypto.subtle.digest(
          "SHA-256",
          await response.arrayBuffer(),
        );
        return Array.from(new Uint8Array(digest)).map((byte) =>
          byte.toString(16).padStart(2, "0")
        ).join("");
      },
      {
        url: `/v1/artifact-versions/${version.id}/content`,
        organization: evidence.organizationId,
      },
    );
    expect(uiFetchedSha256, "bytes the page fetched").toBe(version.sha256);

    // D1: the aside shows this run's patch, not the newest transcript log.
    const pane = page.locator('[data-ui-component="artifactPane"]');
    await expect(pane).toHaveCount(1);
    await expect(pane).toContainText(version.sha256);
    // The descriptor lists the artifact id, not its name.
    await expect(pane).toContainText(artifact.id);
    // `text/x-diff` has no text extraction, so the pane shows the descriptor
    // (id, version, digest, size, media type) and no preview body.
    await expect(pane).toContainText(
      `${version.sizeBytes.toLocaleString("en-US")} bytes`,
    );
    await expect(pane).toContainText(version.mediaType);

    // Hostile content in the diff is inert text.
    expect(await page.evaluate(() => (window as { __fs06?: unknown }).__fs06))
      .toBeUndefined();
    await expect(
      revision.locator("script, iframe, object, embed, [onclick], [onerror]"),
    ).toHaveCount(0);
    chain.version = {
      id: version.id,
      sha256: version.sha256,
      sizeBytes: version.sizeBytes,
      base: version.subjectBaseSha,
      head: version.subjectHeadSha,
      db: db.computedSha256,
      git: gitDigest,
      uiFetched: uiFetchedSha256,
    };
  } else {
    expect(patchVersions.length, "fake executable publishes no patch").toBe(0);
    await expect(revision.first()).toHaveAttribute("data-state", "unknown");
  }

  // Every artifact card downloads exactly the version's bytes.
  const cardFacts: Record<string, unknown>[] = [];
  for (const artifact of artifacts) {
    const version = (versionsByArtifact.get(artifact.id) ?? []).find((item) =>
      item.id === artifact.currentVersionId
    );
    if (!version || version.sizeBytes > 8 * 1024 * 1024) continue;
    const card = page.locator('[data-ui-component="runArtifactSummary"]')
      .filter({ hasText: artifact.name });
    await expect(card.first(), `card for ${artifact.name}`).toBeVisible();
    const bytes = await downloadOf(
      page,
      () => card.first().getByRole("button", { name: "Download" }).click(),
    );
    expect(sha256(bytes), `${artifact.name} download digest`).toBe(
      version.sha256,
    );
    expect(bytes.byteLength).toBe(version.sizeBytes);
    cardFacts.push({
      artifactId: artifact.id,
      versionId: version.id,
      type: artifact.artifactType,
      sha256: version.sha256,
      sizeBytes: version.sizeBytes,
    });
  }

  // Canaries: nothing the page saw, rendered or downloaded carries one.
  await assertNoCanary(page, observer, options.needles, {
    displayedOutput: downloaded,
    serverReplay: full,
  });
  return {
    attemptId: attempt.id,
    jobId: stream!.jobId,
    streamId: stream!.streamId,
    workerHostId: attempt.workerHostId,
    workerName: worker.name,
    highwater: stream!.highwater,
    outputSha256: sha256(full),
    systemInitRecords: initRecords,
    redactionMarkerInOutput: marker,
    segments: segmentFacts,
    patch: chain,
    artifacts: cardFacts,
  };
}
