import { type Browser, expect, type Page, test } from "@playwright/test";
import {
  type Artifact,
  assertCompleted as assertCompletedRun,
  assertContiguous,
  assertNoCanary,
  assertOutcomePage,
  collectRun,
  Evidence,
  helperJson,
  loadCanaries as loadCanariesFrom,
  needleVariants,
  observe,
  type Observer,
  type OutputBatch,
  type RunFacts,
  save as saveEvidence,
  selectImplementStep,
  sha256,
  shootAll as shootAllTo,
  shot as shotTo,
  signIn as signInAs,
  type StorageState,
  type Version,
} from "./helpers/real-run-observation.ts";

/**
 * Real-harness run-observation journey: the run
 * page of a real Claude Code harness run shows logs, diff and artifacts whose
 * bytes and digests equal server evidence, survives a reload and an offline
 * window without a second inference, and never leaks a canary or shows a false
 * completion. No `page.route` or `routeWebSocket`: every response, frame and
 * download is observed from the real server and the real worker.
 *
 * It needs the isolated per-worktree stack of
 * per-worktree stack (scripts/dev/compose-up.sh) with a separate enrolled worker
 * (`tests/fixtures/fake-harness/fake-claude-slow.sh` as its harness), the stack's
 * owner `DATABASE_URL` and `BETTER_AUTH_SECRET` in the environment (the seed
 * helper `tests/helpers/web-run-artifact-seed.ts` reads them), and:
 *
 *   BAKERY_REAL_API=1 BAKERY_REAL_API_HARNESS=1 BAKERY_FS06_MODE=<mode> \
 *   BAKERY_FS06_CANARIES_FILE=<json array of the configured canaries> \
 *   BAKERY_WEB_PORT=<port> \
 *   pnpm --dir apps/web test:ui run-observation-real-harness.spec \
 *     --project=desktop-real-harness --workers=2
 *
 * Modes (`BAKERY_FS06_MODE`):
 * - `start`: sign in, start a task and its run from the composer, watch it
 *   live (reload, offline window), then every completion assertion.
 *   `BAKERY_FS06_HARNESS=real|fake` only labels the evidence: `fake` is the
 *   $0 fake executable, which edits nothing, so it publishes no patch and the
 *   patch chain is asserted absent instead of present.
 * - `observe`: `BAKERY_FS06_TASK_ID` names an existing run; no run is started.
 *   `BAKERY_FS06_EXPECT` (completed, failed, timeout, quota, lost-lease,
 *   canceled, unavailable) picks the outcome the page must show.
 * - `negatives`: cross-organization reads of the task named by
 *   `BAKERY_FS06_TASK_ID`, plus DB-seeded oversized and hostile artifacts on a
 *   separate seed task.
 *
 * Other variables: `BAKERY_REAL_EMAIL`/`BAKERY_REAL_PASSWORD` (the owner),
 * `BAKERY_FS06_OUTSIDER_EMAIL`, `BAKERY_FS06_REPOSITORY_ID`,
 * `BAKERY_FS06_INSTRUCTIONS`, `BAKERY_FS06_HARNESS_REPO` (the harness clone, to
 * compare `git diff --binary`), `BAKERY_FS06_WORKER_HOST_ID` (the enrolled
 * host id), `BAKERY_FS06_SHOTS` (screenshot and evidence directory).
 */
const enabled = process.env.BAKERY_REAL_API === "1" &&
  process.env.BAKERY_REAL_API_HARNESS === "1";
const mode = process.env.BAKERY_FS06_MODE ?? "";
const harnessKind = process.env.BAKERY_FS06_HARNESS === "fake"
  ? "fake"
  : "real";
const expectedState = process.env.BAKERY_FS06_EXPECT ?? "completed";
// A real run whose task was already satisfied publishes no patch; the
// operator says so explicitly (BAKERY_FS06_EXPECT_PATCH=0) and the record notes it.
const noPatchExpected = process.env.BAKERY_FS06_EXPECT_PATCH === "0";
const ownerEmail = process.env.BAKERY_REAL_EMAIL ??
  "fs06-proof-owner@example.test";
const ownerPassword = process.env.BAKERY_REAL_PASSWORD ??
  "Fs06-Proof-Passw0rd-1";
const outsiderEmail = process.env.BAKERY_FS06_OUTSIDER_EMAIL ??
  "fs06-proof-outsider@example.test";
const shotDirectory = process.env.BAKERY_FS06_SHOTS ?? "";
const harnessRepository = process.env.BAKERY_FS06_HARNESS_REPO ?? "";

const REAL_INSTRUCTIONS = [
  "Work only inside this repository and use no shell command.",
  "Make about ten sequential small edits to NOTES.md, one section per edit,",
  "each edit its own tool call, and say what you wrote after each one.",
  "Then create hostile.html containing exactly the line",
  "<script>window.__fs06=1</script>, then an ANSI escape sequence (the byte",
  "0x1b followed by [31m) and the U+202E character, each on their own line.",
  "As your very last step read the file .bakery-canary and quote both of its",
  "lines in your final reply only. Never write them into any file.",
].join(" ");
const FAKE_INSTRUCTIONS =
  "FS06 fake executable run: the executable ignores these instructions.";

// ---- shared helpers bound to this spec's BAKERY_FS06_* variables -----------------
// The helpers live in ./helpers/real-run-observation.ts and take every
// variable name or value from the caller, so the M1 journey spec can bind its
// own BAKERY_M1_* names. These one-line bindings keep the test bodies below
// unchanged.
const loadCanaries = () => loadCanariesFrom("BAKERY_FS06_CANARIES_FILE");
const save = (name: string, value: unknown) =>
  saveEvidence(shotDirectory, name, value);
const shot = (page: Page, name: string) => shotTo(shotDirectory, page, name);
const shootAll = (
  browser: Browser,
  storageState: StorageState,
  organizationId: string,
  taskId: string,
  prefix: string,
) =>
  shootAllTo(
    shotDirectory,
    browser,
    storageState,
    organizationId,
    taskId,
    prefix,
  );
const signIn = (page: Page) => signInAs(page, { ownerEmail, ownerPassword });
const assertCompleted = (
  page: Page,
  observer: Observer,
  evidence: Evidence,
  facts: RunFacts,
  options: { needles: string[]; expectPatch: boolean },
) =>
  assertCompletedRun(page, observer, evidence, facts, {
    ...options,
    harnessKind,
    ownerEmail,
    harnessRepository,
    workerHostId: process.env.BAKERY_FS06_WORKER_HOST_ID,
  });

// ---- tests ---------------------------------------------------------------------------
test.describe.configure({ mode: "serial" });

test(
  "start: a real harness run is observed live and verified against the server",
  async ({ browser }, testInfo) => {
    test.skip(!enabled, "set BAKERY_REAL_API=1 and BAKERY_REAL_API_HARNESS=1");
    test.skip(mode !== "start", "set BAKERY_FS06_MODE=start");
    test.setTimeout(10 * 60_000);
    const needles = needleVariants(loadCanaries());
    const scope = helperJson<{ organizationId: string }>("scope", ownerEmail);
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage();
    const observer = observe(page, needles);
    await signIn(page);
    const evidence = new Evidence(page.request, scope.organizationId);

    // Start the task and its run from the composer, like a person would.
    await page.goto("/tasks/new");
    const repositories = page.getByRole("combobox", { name: /^Repository/ });
    const repositoryId = process.env.BAKERY_FS06_REPOSITORY_ID ??
      await repositories.locator("option:not([value=''])").first()
        .getAttribute("value");
    expect(repositoryId, "a repository to run against").toBeTruthy();
    await repositories.selectOption(repositoryId!);
    await expect(page.getByRole("radio", { name: /Fixed coding/ }))
      .toBeChecked();
    await page.getByRole("textbox", { name: /^Title/ }).fill(
      `FS06 run observation (${harnessKind}) ${new Date().toISOString()}`,
    );
    await page.getByRole("textbox", { name: /^Description/ }).fill(
      process.env.BAKERY_FS06_INSTRUCTIONS ??
        (harnessKind === "real" ? REAL_INSTRUCTIONS : FAKE_INSTRUCTIONS),
    );
    await page.getByRole("button", { name: "Start task", exact: true }).click();
    await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}$/);
    const taskId = page.url().split("/").at(-1)!;
    console.log(JSON.stringify({ fs06: "task", taskId, harnessKind }));
    await selectImplementStep(page);

    // Live: the output panel goes live and lines arrive.
    const panel = page.locator('[data-ui-component="runOutputPanel"]');
    await expect(panel).toHaveAttribute("data-state", "live", {
      timeout: 5 * 60_000,
    });
    await expect.poll(async () => {
      const text = (await panel.textContent()) ?? "";
      return Number(/sequence (\d+)/.exec(text)?.[1] ?? "0");
    }, { timeout: 5 * 60_000 }).toBeGreaterThanOrEqual(3);
    await shot(page, "start-live-before-reload");

    // Reload: the same lines return in order and new ones continue.
    const beforeReload = observer.batchesByConnection();
    const lastBefore = Math.max(
      ...[...beforeReload.values()].flat().map((batch) =>
        Number(batch.sequence)
      ),
    );
    const reloadAt = new Date();
    await page.reload();
    await selectImplementStep(page);
    await expect(panel).toHaveAttribute("data-state", /live|complete/, {
      timeout: 120_000,
    });
    await expect.poll(() => {
      const grouped = observer.batchesByConnection();
      const latest = grouped.get(observer.connectionCount() - 1) ?? [];
      return Number(latest.at(-1)?.sequence ?? "0");
    }, { timeout: 120_000 }).toBeGreaterThan(lastBefore);
    await shot(page, "start-live-after-reload");

    // Offline window: the socket drops and resumes from its cursor.
    const offlineAt = new Date();
    await context.setOffline(true);
    const closedBefore = observer.closedConnections.length;
    await page.waitForTimeout(10_000);
    const droppedWhileOffline =
      observer.closedConnections.length > closedBefore;
    let reconnectingShown = false;
    if (droppedWhileOffline) {
      reconnectingShown = (await panel.getAttribute("data-state")) ===
        "reconnecting";
      expect(reconnectingShown, "reconnecting notice while offline").toBe(true);
      await shot(page, "start-offline-reconnecting");
    }
    await context.setOffline(false);
    const onlineAt = new Date();
    await expect(panel).toHaveAttribute("data-state", /live|complete/, {
      timeout: 120_000,
    });

    // The run completes (or fails loudly) without a second inference.
    await expect.poll(
      async () => {
        // The server may be paused by a drill: an unreachable server is
        // "unreachable", never a pass and never a failure.
        try {
          const task = await evidence.get<{ currentRunId: string }>(
            `/v1/tasks/${taskId}`,
          );
          return (await evidence.get<{ status: string }>(
            `/v1/runs/${task.currentRunId}`,
          )).status;
        } catch {
          return "unreachable";
        }
      },
      { timeout: 8 * 60_000, intervals: [2_000] },
    ).toMatch(/^(completed|failed|canceled)$/);
    await page.goto(`/tasks/${taskId}`);
    await selectImplementStep(page);
    const facts = await collectRun(evidence, taskId);
    expect(facts.attempts.length, "one attempt, no second inference").toBe(1);
    const attempt = facts.attempts[0];

    // Timing guard: the interruption really happened while the attempt ran.
    expect(attempt.startedAt && attempt.endedAt, "attempt timestamps")
      .toBeTruthy();
    const started = Date.parse(attempt.startedAt!);
    const ended = Date.parse(attempt.endedAt!);
    for (
      const [label, at] of [
        ["reload", reloadAt],
        ["offline", offlineAt],
        ["online", onlineAt],
      ] as const
    ) {
      expect(at.getTime(), `${label} after the attempt started`)
        .toBeGreaterThan(started);
      expect(at.getTime(), `${label} before the attempt ended`)
        .toBeLessThan(ended);
    }

    save(`evidence-live-${taskId}.json`, {
      harnessKind,
      taskId,
      attemptId: attempt.id,
      startedAt: attempt.startedAt,
      endedAt: attempt.endedAt,
      reloadAt: reloadAt.toISOString(),
      offlineAt: offlineAt.toISOString(),
      onlineAt: onlineAt.toISOString(),
      socketDroppedWhileOffline: droppedWhileOffline,
      reconnectingShown,
    });

    // Replay across connections: identical batches, contiguous, no duplicates.
    const grouped = observer.batchesByConnection();
    const byConnection = [...grouped.entries()];
    expect(byConnection.length, "reload opened a second socket")
      .toBeGreaterThanOrEqual(2);
    const firstSeen = new Map<string, OutputBatch>();
    for (const [connection, batches] of byConnection) {
      assertContiguous(batches, `connection ${connection}`);
      for (const batch of batches) {
        const earlier = firstSeen.get(batch.sequence);
        if (earlier) {
          expect(batch.batchId).toBe(earlier.batchId);
          expect(batch.digest).toBe(earlier.digest);
        } else firstSeen.set(batch.sequence, batch);
      }
    }

    await expect(
      page.locator('[data-ui-component="runOutputPanel"]'),
    ).toHaveAttribute("data-state", "complete", { timeout: 120_000 });
    await shot(page, "start-complete");
    const completed = await assertCompleted(page, observer, evidence, facts, {
      needles,
      expectPatch: harnessKind === "real" && !noPatchExpected,
    });
    const state = await context.storageState();
    await shootAll(browser, state, scope.organizationId, taskId, "start");
    save(`evidence-start-${taskId}.json`, {
      label: harnessKind === "real"
        ? "real Claude Code harness"
        : "fake executable, $0",
      organizationId: scope.organizationId,
      taskId,
      runId: facts.runId,
      stepId: facts.stepId,
      baseSha: facts.baseSha,
      startedAt: attempt.startedAt,
      endedAt: attempt.endedAt,
      reloadAt: reloadAt.toISOString(),
      offlineAt: offlineAt.toISOString(),
      onlineAt: onlineAt.toISOString(),
      socketDroppedWhileOffline: droppedWhileOffline,
      reconnectingShown,
      socketConnections: observer.connectionCount(),
      ...completed,
    });
    testInfo.annotations.push({ type: "task", description: taskId });
    await context.close();
  },
);

test(
  "observe: an existing run still matches server evidence",
  async ({ browser }, testInfo) => {
    test.skip(!enabled, "set BAKERY_REAL_API=1 and BAKERY_REAL_API_HARNESS=1");
    test.skip(mode !== "observe", "set BAKERY_FS06_MODE=observe");
    test.setTimeout(10 * 60_000);
    const taskId = process.env.BAKERY_FS06_TASK_ID;
    expect(taskId, "BAKERY_FS06_TASK_ID").toBeTruthy();
    const needles = needleVariants(loadCanaries());
    const scope = helperJson<{ organizationId: string }>("scope", ownerEmail);
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage();
    const observer = observe(page, needles);
    await signIn(page);
    const evidence = new Evidence(page.request, scope.organizationId);
    await page.goto(`/tasks/${taskId}`);
    await selectImplementStep(page);
    const facts = await collectRun(evidence, taskId!);
    await assertOutcomePage(page, evidence, facts, expectedState);
    let completed: Record<string, unknown> = {};
    if (expectedState === "completed") {
      completed = await assertCompleted(page, observer, evidence, facts, {
        needles,
        expectPatch: harnessKind === "real" && !noPatchExpected,
      });
    } else {
      await assertNoCanary(page, observer, needles);
    }
    await shot(page, `observe-${expectedState}`);
    await shootAll(
      browser,
      await context.storageState(),
      scope.organizationId,
      taskId!,
      `observe-${expectedState}`,
    );
    save(`evidence-observe-${expectedState}-${taskId}.json`, {
      organizationId: scope.organizationId,
      taskId,
      runId: facts.runId,
      expectation: expectedState,
      attempts: facts.attempts.map((attempt) => ({
        id: attempt.id,
        attemptNo: attempt.attemptNo,
        status: attempt.status,
        workerHostId: attempt.workerHostId,
        startedAt: attempt.startedAt,
        endedAt: attempt.endedAt,
        resultStatus: attempt.outcome.resultStatus,
        reasonCode: attempt.outcome.reasonCode,
      })),
      ...completed,
    });
    testInfo.annotations.push({ type: "task", description: taskId! });
    await context.close();
  },
);

test(
  "negatives: other organizations, oversized and hostile artifacts",
  async ({ browser }) => {
    test.skip(!enabled, "set BAKERY_REAL_API=1 and BAKERY_REAL_API_HARNESS=1");
    test.skip(mode !== "negatives", "set BAKERY_FS06_MODE=negatives");
    test.setTimeout(10 * 60_000);
    const taskId = process.env.BAKERY_FS06_TASK_ID;
    expect(taskId, "BAKERY_FS06_TASK_ID of the run under test").toBeTruthy();
    const needles = needleVariants(loadCanaries());
    const scope = helperJson<{ organizationId: string }>("scope", ownerEmail);
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage();
    const observer = observe(page, needles);
    await signIn(page);
    const owner = new Evidence(page.request, scope.organizationId);

    // ---- cross-organization: another owner reads nothing of this run ------
    const facts = await collectRun(owner, taskId!);
    expect(facts.stream, "the run under test has output").not.toBeNull();
    const patchVersion = (await owner.all<Artifact>(
      `/v1/artifacts?taskId=${taskId}&artifactType=patch&limit=25`,
    )).at(0);
    const patchVersions = patchVersion
      ? await owner.all<Version>(
        `/v1/artifacts/${patchVersion.id}/versions?limit=100`,
      )
      : [];
    const outsider = helperJson<{
      outsiderOrganizationId: string;
      cookieName: string;
      cookieValue: string;
    }>("outsider", ownerEmail, outsiderEmail);
    const foreign = await browser.newContext();
    const origin = new URL(test.info().project.use.baseURL ?? page.url());
    await foreign.addCookies([{
      name: outsider.cookieName,
      value: outsider.cookieValue,
      domain: origin.hostname,
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    }]);
    const stranger = new Evidence(
      foreign.request,
      outsider.outsiderOrganizationId,
    );
    const targets = [
      `/v1/output-streams/${facts.stream!.streamId}`,
      `/v1/output-streams?taskId=${taskId}&limit=64`,
      `/v1/tasks/${taskId}`,
      ...patchVersions.map((version) =>
        `/v1/artifact-versions/${version.id}/content`
      ),
    ];
    const probes: Record<string, unknown>[] = [];
    for (const target of targets) {
      for (
        const organization of [
          outsider.outsiderOrganizationId,
          scope.organizationId,
        ]
      ) {
        const result = await stranger.raw(target, organization);
        const body = result.body.toString("latin1");
        const listing = target.startsWith("/v1/output-streams?");
        // A list is scoped to the caller's own organization: an empty page.
        if (listing && result.status === 200) {
          expect(JSON.parse(body).items, `${target} leaks streams`).toEqual([]);
        } else {
          expect([403, 404], `${target} as ${organization}`).toContain(
            result.status,
          );
        }
        for (const needle of needles) {
          expect(body.includes(needle), "canary in a foreign response").toBe(
            false,
          );
        }
        for (const version of patchVersions) {
          expect(body.includes(version.sha256)).toBe(false);
        }
        probes.push({ target, organization, status: result.status });
      }
    }
    await foreign.close();

    // ---- DB-seeded oversized and hostile artifacts on a separate task -------
    const seeded = helperJson<{
      label: string;
      taskId: string;
      artifacts: Record<
        "patch" | "card" | "html",
        {
          artifactId: string;
          versionId: string;
          sha256: string;
          sizeBytes: number;
          name: string;
        }
      >;
    }>("seed", ownerEmail);
    await page.goto(`/tasks/${seeded.taskId}`);
    await expect(
      page.getByText("No output stream recorded for this step."),
    ).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("Execution completed")).toHaveCount(0);

    // (a) a 1.5 MiB patch is too large to show inline and is never fetched.
    const revision = page.locator('[data-ui-component="revisionSummary"]');
    await revision.getByRole("button", { name: "View diff" }).first().click();
    await expect(revision).toContainText(
      "This patch exceeds the inline preview limit.",
    );
    await observer.settle();
    expect(
      observer.requests.filter((path) =>
        path ===
          `/v1/artifact-versions/${seeded.artifacts.patch.versionId}/content`
      ),
      "no byte request for an oversized patch",
    ).toEqual([]);

    // (b) a 9 MiB artifact cannot be downloaded from its card.
    const big = page.locator('[data-ui-component="runArtifactSummary"]').filter(
      {
        hasText: seeded.artifacts.card.name,
      },
    );
    await expect(big.first()).toBeVisible();
    await expect(big.first().getByRole("button", { name: "Download" }))
      .toBeDisabled();
    await expect(page.getByText(
      "Open the artifact to download files larger than 8 MiB.",
    )).toBeVisible();

    // (c) text/html is served as an attachment, sniffing off, and stays inert.
    const html = seeded.artifacts.html;
    const served = await owner.raw(
      `/v1/artifact-versions/${html.versionId}/content`,
    );
    expect(served.status).toBe(200);
    expect(served.headers["content-disposition"]).toMatch(/^attachment/);
    expect(served.headers["x-content-type-options"]).toBe("nosniff");
    expect(sha256(served.body)).toBe(html.sha256);
    expect(served.body.toString("utf8")).toContain(
      "<script>window.__fs06=1</script>",
    );
    expect(await page.evaluate(() => (window as { __fs06?: unknown }).__fs06))
      .toBeUndefined();
    await shot(page, "negatives-seeded-task");
    await assertNoCanary(page, observer, needles);

    // The artifact page is the download-only view of that hostile HTML. A
    // fresh page keeps its renderer clear of the task page's state.
    const hostile = await context.newPage();
    const hostileObserver = observe(hostile, needles);
    await hostile.goto(`/tasks/${seeded.taskId}/artifacts/${html.artifactId}`, {
      waitUntil: "networkidle",
    });
    await expect(hostile.getByText("This media type is download-only."))
      .toBeVisible({ timeout: 60_000 });
    await expect(hostile.getByText(html.sha256).first()).toBeVisible();
    expect(
      await hostile.evaluate(() => (window as { __fs06?: unknown }).__fs06),
    ).toBeUndefined();
    await expect(hostile.locator("script", { hasText: "__fs06" })).toHaveCount(
      0,
    );
    await shot(hostile, "negatives-hostile-html");
    await assertNoCanary(hostile, hostileObserver, needles);
    save(`evidence-negatives-${taskId}.json`, {
      label: seeded.label,
      taskId,
      seedTaskId: seeded.taskId,
      outsiderOrganizationId: outsider.outsiderOrganizationId,
      probes,
      artifacts: seeded.artifacts,
    });
    await context.close();
  },
);
