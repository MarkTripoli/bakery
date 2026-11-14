import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { type Browser, expect as baseExpect, test } from "@playwright/test";
import {
  coordinatorModels,
  createFirstAdmin,
  forceApprovalExpiry,
  killWorker,
  restartInngest,
  restartServer,
  spendSettledUsd,
  startWorker,
  storedStatus,
  waitReady,
} from "./helpers/m1-stack-control.ts";
import {
  createAgent,
  createRepository,
  M1Api,
  readBilling,
  startRunWithApproval,
} from "./helpers/m1-api.ts";
import {
  checkBriefApprovedPlan,
  checkDuplicateDecision,
  claudeInitModels,
  decideRefused,
  M1_CHANGE_REQUEST,
  M1_PLAN_ONLY_REQUEST,
  M1_PLAN_REQUEST,
  M1_QUESTION_TEXT_ANSWER,
  M1_RUN_TASKS,
  M1_TASK_DESCRIPTION,
  M1_TASK_FILE,
  M1_TASK_FUNCTION,
  M1_TASK_TITLE,
  type RunTask,
  verifyDocCommentPatch,
} from "./helpers/m1-task.ts";
import {
  abortReads,
  answerQuestion,
  approve,
  axeClean,
  controlButton,
  conversationRegion,
  DESKTOP,
  fillComposer,
  longestTransition,
  loseResponseOnce,
  messageBox,
  noHorizontalScroll,
  planRegion,
  questionCard,
  recordVideoFor,
  runStatus,
  runTerminalEntries,
  say,
  sessionContext,
  shootAnonymous,
  shootRoute,
  startRunButton,
  STATUS_LABEL,
  stepRow,
  TERMINAL_RUN_STATUSES,
} from "./helpers/m1-journey-ui.ts";
import {
  type Artifact,
  assertCompleted,
  assertNoCanary,
  collectRun,
  Evidence,
  loadCanaries,
  needleVariants,
  observe,
  type OutputBatch,
  save,
  selectImplementStep,
  shootAll,
  shot,
  signIn,
  type StorageState,
  type Stream,
} from "./helpers/real-run-observation.ts";
import { M1_PROOF_MODEL } from "../../../scripts/evidence/m1-billing.ts";

/**
 * M1 (#132) real-journey proof: one serial spec that drives the whole usable
 * Bakery against the stack `scripts/evidence/prove-m1.ts` boots (a development
 * compose stack, a production web build, an enrolled Claude Code worker) and
 * exports. Real web, API, Postgres, Inngest, outbox dispatcher, Claude Code
 * coordinator job and Claude Code executor; no scripted coordinator or harness
 * can load under `BAKERY_ENV=development`, and the first test refuses to run if
 * one is configured. Faults (browser, server, engine, worker) are injected
 * between steps with `./helpers/m1-stack-control.ts`.
 *
 * The orchestrator runs it as `playwright test --project=desktop-real-m1
 * --workers=1` with `BAKERY_REAL_API=1`, `BAKERY_REAL_API_M1=1`,
 * `BAKERY_M1_STATE_DIR`, `BAKERY_M1_COMPOSE_PROJECT`, `BAKERY_M1_SPEND_CAP_USD`,
 * `BAKERY_M1_CANARIES_FILE`, `BAKERY_M1_HARNESS_REPO`, `BAKERY_M1_SHOTS`
 * (screenshots and evidence JSON land there), `BASE_URL`, the stack's own
 * variables and the owner's `BAKERY_REAL_EMAIL`/`BAKERY_REAL_PASSWORD`.
 * `BAKERY_M1_STOP_AFTER=P<n>` skips every phase after P<n>, so an early failure
 * is cheap to re-run; the run proves nothing then.
 *
 * Phases (each its own test, each with a screenshot):
 *   P0 adapter guards            P5 wait and restart
 *   P1 first admin              P6 approve and run
 *   P2 repository and profile   P7 observe
 *   P3 worker                   P8 faults on a run
 *   P4 plan                     P9 changes, cancel and recover
 *                               P10 negatives
 *
 * The journey ends with the worker unit active (the orchestrator reads its
 * environment afterwards and refuses a dead unit), including after a failed
 * phase that had killed it.
 *
 * The only owner-database writes are the three recorded operator steps:
 * the pricing snapshot (the orchestrator), the first administrator
 * (`createFirstAdmin`, because `/setup` offers no way to create one) and the
 * approval-expiry clock move (`forceApprovalExpiry`).
 */

/** Real-stack pages answer slower than fixtures: 30 s for every assertion. */
const expect = baseExpect.configure({ timeout: 30_000 });

// ---- environment (read lazily: `--list` runs with only the two gates) -----------
function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
const stateDirectory = () => env("BAKERY_M1_STATE_DIR");
const shots = () => process.env.BAKERY_M1_SHOTS ?? "";
const ownerEmail = () => env("BAKERY_REAL_EMAIL");
const ownerPassword = () => env("BAKERY_REAL_PASSWORD");
const webOrigin = () => new URL(env("BASE_URL")).origin;
const serverOrigin = () => `http://127.0.0.1:${env("BAKERY_SERVER_PORT")}`;
const needles = () => needleVariants(loadCanaries("BAKERY_M1_CANARIES_FILE"));

/** `BAKERY_M1_STOP_AFTER=P3` -> 3; unset -> run every phase. */
function stopAfter(): number {
  const raw = process.env.BAKERY_M1_STOP_AFTER?.trim();
  if (!raw) return Number.POSITIVE_INFINITY;
  const match = /^P(\d+)$/.exec(raw);
  if (!match) throw new Error(`BAKERY_M1_STOP_AFTER must be P<n>, got ${raw}`);
  return Number(match[1]);
}
function phase(number: number) {
  test.skip(
    number > stopAfter(),
    `BAKERY_M1_STOP_AFTER=${process.env.BAKERY_M1_STOP_AFTER}`,
  );
}

const MINUTE = 60_000;
/** The in-process brief step publishes within seconds of the claim. */
const BRIEF_POLL_TIMEOUT = 4 * MINUTE;
/**
 * Per-phase budgets: a wedge fails its own phase, not the whole journey. They
 * are what each phase needs when the model and the worker behave (a coordinator
 * turn up to 8 minutes, an executor run 10 to 15, a recovery after a worker
 * kill another 10 to 15). Budgets total 211 minutes; the orchestrator's
 * journey timeout must exceed that (211 minutes is 3 h 31 min).
 */
const BUDGET = {
  P0: 2 * MINUTE,
  P1: 4 * MINUTE,
  P2: 4 * MINUTE,
  P3: 10 * MINUTE,
  P4: 25 * MINUTE,
  P5: 6 * MINUTE,
  P6: 10 * MINUTE,
  P7: 25 * MINUTE,
  P8: 35 * MINUTE,
  P9: 50 * MINUTE,
  P10: 40 * MINUTE,
} as const;

// ---- journey state shared by the serial tests ---------------------------------------
type Journey = {
  session?: StorageState;
  organizationId: string;
  applicationId: string;
  repositoryId: string;
  profileId: string;
  coderVersionId: string;
  hostId: string;
  taskId: string;
  conversationId: string;
  revision1ApprovalId: string;
  revision2ApprovalId: string;
  runId: string;
  ids: Record<string, string>;
  spend: { step: string; settledUsd: string }[];
  keyboardApprove: boolean;
  /** The worker unit was killed and not yet started again. */
  workerDown: boolean;
  decisionStatuses: number[];
};
const j: Journey = {
  organizationId: "",
  applicationId: "",
  repositoryId: "",
  profileId: "",
  coderVersionId: "",
  hostId: "",
  taskId: "",
  conversationId: "",
  revision1ApprovalId: "",
  revision2ApprovalId: "",
  runId: "",
  ids: {},
  spend: [],
  keyboardApprove: false,
  decisionStatuses: [],
  workerDown: false,
};

function session(): StorageState {
  if (!j.session) throw new Error("M1_JOURNEY_NO_SESSION: P1 did not sign in");
  return j.session;
}

/** Records an id for the manifest (`ids.json` is merged as `journey.<key>`). */
function remember(key: string, value: string) {
  j.ids[key] = value;
  const directory = shots();
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(`${directory}/ids.json`, JSON.stringify(j.ids, null, 2));
}

function evidenceFile(name: string, value: unknown) {
  save(shots(), name, value);
}

/** Fails the run before a funded step when the settled spend is over the cap. */
async function fundedStep(step: string) {
  const settledUsd = await spendSettledUsd();
  j.spend.push({ step, settledUsd });
  const cap = Number(env("BAKERY_M1_SPEND_CAP_USD"));
  if (!(Number(settledUsd) <= cap)) {
    throw new Error(
      `M1_SPEND_CAP_REACHED: ${settledUsd} USD settled, cap ${cap} USD, before ${step}`,
    );
  }
}

/** A signed-in browser context, its first page and the page's API helpers. */
async function open(
  browser: Browser,
  options: Parameters<typeof sessionContext>[3] = {},
) {
  const context = await sessionContext(
    browser,
    session(),
    j.organizationId,
    options,
  );
  const page = await context.newPage();
  const api = new M1Api(page.request, webOrigin(), j.organizationId);
  const evidence = new Evidence(page.request, j.organizationId);
  return { context, page, api, evidence };
}

type Task = {
  id: string;
  conversationId: string;
  currentRunId: string | null;
  repositoryProfileId: string;
  approvalPolicy: { plan: string };
};
type PlanRevision = {
  id: string;
  revision: number;
  status: string;
  digest: string;
};
type Approval = {
  id: string;
  status: string;
  decision: string | null;
  subjectId: string;
  consumedAt: string | null;
  consumedByRunId: string | null;
  expiresAt: string | null;
  version: number;
};
type Run = { id: string; status: string };
type Worker = { connectivity: string; readiness: string };

const approvalsOf = async (api: M1Api, taskId: string) =>
  (await api.get<{ items: Approval[] }>(`/v1/approvals?taskId=${taskId}`))
    .items;
const revisionsOf = async (api: M1Api, taskId: string) =>
  (await api.get<{ items: PlanRevision[] }>(
    `/v1/plan-revisions?taskId=${taskId}`,
  )).items;
const runsOf = async (api: M1Api, taskId: string) =>
  (await api.get<{ items: Run[] }>(`/v1/tasks/${taskId}/runs`)).items;

/** The approval bound to plan revision `revision` of the task. */
async function approvalForRevision(
  api: M1Api,
  taskId: string,
  revision: number,
): Promise<Approval> {
  const plan = (await revisionsOf(api, taskId)).find((item) =>
    item.revision === revision
  );
  expect(plan, `plan revision ${revision}`).toBeTruthy();
  const approval = (await approvalsOf(api, taskId)).find((item) =>
    item.subjectId === plan!.id
  );
  expect(approval, `approval for revision ${revision}`).toBeTruthy();
  return approval!;
}

async function untilTerminal(
  api: M1Api,
  runId: string,
  timeout: number,
): Promise<string> {
  let status = "";
  await expect.poll(async () => {
    status = (await api.get<Run>(`/v1/runs/${runId}`)).status;
    return TERMINAL_RUN_STATUSES.includes(status);
  }, { timeout, intervals: [5_000], message: `run ${runId} terminal` })
    .toBe(true);
  return status;
}

async function untilWorker(api: M1Api, hostId: string, state: string) {
  await expect.poll(async () => {
    const worker = await api.get<Worker>(`/v1/workers/${hostId}`);
    return `${worker.connectivity}/${worker.readiness}`;
  }, { timeout: 6 * MINUTE, intervals: [3_000], message: "worker host state" })
    .toBe(state);
}

/**
 * A run that completed must have published exactly one patch, and that patch
 * must be its own task's doc comments: the named files only, one comment block
 * directly above each named function, nothing removed. A run that did not
 * complete has nothing to check and the evidence says why.
 */
async function checkRunPatch(
  evidence: Evidence,
  taskId: string,
  task: RunTask,
  status: string,
): Promise<{ checked: boolean; reason?: string; targets: RunTask["targets"] }> {
  if (status !== "completed") {
    return { checked: false, reason: `run ${status}`, targets: task.targets };
  }
  const patches = await evidence.all<Artifact>(
    `/v1/artifacts?taskId=${taskId}&artifactType=patch&limit=25`,
  );
  expect(patches.length, `one patch artifact for ${task.key}`).toBe(1);
  const versionId = patches[0].currentVersionId;
  expect(versionId, "the patch artifact has a current version").toBeTruthy();
  const patch = (await evidence.raw(
    `/v1/artifact-versions/${versionId}/content`,
  )).body.toString("utf8");
  expect(
    verifyDocCommentPatch(patch, task.targets),
    `the ${task.key} patch is the requested doc comments`,
  ).toEqual([]);
  return { checked: true, targets: task.targets };
}

/** Creates a plan-first task through the API, as the FS26 specs do. */
async function createPlanFirstTask(api: M1Api, title: string): Promise<Task> {
  const created = await api.create("/v1/tasks", {
    applicationId: j.applicationId,
    repositoryId: j.repositoryId,
    taskType: "feature",
    title,
    description: M1_TASK_DESCRIPTION,
    approvalPolicy: { plan: "human_approval" },
  });
  return created as unknown as Task;
}

/** Models named by `system/init` records on each stream, replayed from the server. */
async function initModelsOf(
  evidence: Evidence,
  streams: readonly Stream[],
): Promise<Record<string, string[]>> {
  const models: Record<string, string[]> = {};
  for (const stream of streams) {
    const batches: OutputBatch[] = await evidence.replay(stream.streamId);
    const stdout = batches.flatMap((batch) => batch.parts).filter((part) =>
      part.channel === "stdout"
    ).map((part) => part.text).join("");
    models[stream.streamId] = claudeInitModels(stdout);
  }
  return models;
}

/** Kills the worker unit and remembers it is down. */
async function stopWorker() {
  j.workerDown = true;
  await killWorker();
}

/** Starts the worker unit again; the journey must end with it active. */
async function resumeWorker() {
  await startWorker();
  j.workerDown = false;
}

test.describe.configure({ mode: "serial" });

// A failed phase must not leave the worker dead: the orchestrator reads the
// unit's environment after the journey and refuses a dead unit.
test.afterAll(async () => {
  // Hooks run under the 15 s default; launching the unit resets the clone.
  test.setTimeout(3 * MINUTE);
  if (j.workerDown) await resumeWorker();
});

// ---- P0 ----------------------------------------------------------------------------------
test("P0 no scripted adapter can run; the stack is the real one", async () => {
  test.setTimeout(BUDGET.P0);
  // The spec's own environment: a scripted coordinator or harness fails here.
  expect(
    process.env.BAKERY_SCRIPTED_COORDINATOR_DIR ?? "",
    "BAKERY_SCRIPTED_COORDINATOR_DIR must be unset or empty",
  ).toBe("");
  expect(
    process.env.BAKERY_WORKER_SCRIPTED_HARNESS_DIR ?? "",
    "BAKERY_WORKER_SCRIPTED_HARNESS_DIR must be unset or empty",
  ).toBe("");
  expect(process.env.BAKERY_REAL_API).toBe("1");
  expect(process.env.BAKERY_REAL_API_M1).toBe("1");
  expect(process.env.BAKERY_ENV, "the proof stack is a development stack")
    .toBe("development");
  for (
    const name of [
      "BAKERY_M1_STATE_DIR",
      "BAKERY_M1_COMPOSE_PROJECT",
      "BAKERY_M1_SPEND_CAP_USD",
      "BAKERY_M1_CANARIES_FILE",
      "BAKERY_M1_HARNESS_REPO",
      "BASE_URL",
      "BAKERY_SERVER_PORT",
      "DATABASE_URL",
      "BAKERY_REAL_EMAIL",
      "BAKERY_REAL_PASSWORD",
    ]
  ) env(name);
  expect(Number(env("BAKERY_M1_SPEND_CAP_USD"))).toBeLessThanOrEqual(40);
  // The orchestrator's guard result, written before the journey started.
  const guards = JSON.parse(
    readFileSync(`${stateDirectory()}/adapter-guards.json`, "utf8"),
  ) as {
    schema: string;
    scriptedCoordinator: boolean | null;
    scriptedHarness: boolean | null;
  };
  expect(guards.schema).toBe("bakery.m1-adapter-guards/v1");
  expect(guards.scriptedCoordinator, "server guard result").toBe(false);
  expect(guards.scriptedHarness, "worker guard result").not.toBe(true);
  // The stack answers, and the read-only spend path works before any funded step.
  await waitReady(serverOrigin(), 60_000);
  expect(Number(await spendSettledUsd())).toBeGreaterThanOrEqual(0);
  writeFileSync(
    `${stateDirectory()}/task.txt`,
    `${M1_TASK_TITLE}\n\n${M1_TASK_DESCRIPTION}\n`,
  );
  evidenceFile("evidence-P0.json", {
    guards,
    serverEnvironment: process.env.BAKERY_ENV,
    taskFile: M1_TASK_FILE,
    taskFunction: M1_TASK_FUNCTION,
    model: M1_PROOF_MODEL,
  });
});

// ---- P1 ----------------------------------------------------------------------------------
test("P1 first admin: /setup, the recorded operator step, UI sign-in", async ({ browser }) => {
  phase(1);
  test.setTimeout(BUDGET.P1);
  const context = await browser.newContext({
    viewport: DESKTOP,
    ...recordVideoFor("P1"),
  });
  const page = await context.newPage();
  const setupOffered = {
    textboxes: -1,
    passwordFields: -1,
    buttons: [] as string[],
  };
  await test.step("an empty install sends the visitor to /setup", async () => {
    await page.goto("/settings/sessions");
    // A client-side redirect after the router resolves the installation status.
    await page.waitForURL("/setup", { timeout: 20_000 });
    await expect(page.getByTestId("setup-default")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByRole("heading", { name: "Finish local setup" }))
      .toBeVisible();
    // /setup offers instructions only: no field to type an admin into.
    await expect(page.getByRole("textbox")).toHaveCount(0);
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    setupOffered.textboxes = await page.getByRole("textbox").count();
    setupOffered.passwordFields = await page.locator('input[type="password"]')
      .count();
    setupOffered.buttons = await page.getByRole("button").allTextContents();
    await shootAnonymous(
      shots(),
      browser,
      "/setup",
      "P1-setup-default",
      (other) => expect(other.getByTestId("setup-default")).toBeVisible(),
    );
  });
  await test.step("operator step 2: /setup offers no admin creation, so the recorded fallback runs", async () => {
    const admin = await createFirstAdmin(ownerEmail(), ownerPassword());
    remember("firstAdminOrganizationId", admin.organizationId);
    // The open /setup page polls the installation status and flips to ready.
    await expect(page.getByTestId("setup-ready")).toBeVisible({
      timeout: 90_000,
    });
    await shot(shots(), page, "P1-setup-ready-desktop");
    await page.getByRole("button", { name: "Continue to sign in" }).click();
    await expect(page).toHaveURL(/\/sign-in/);
    await shot(shots(), page, "P1-sign-in-desktop");
  });
  await test.step("UI sign-in and organization entry", async () => {
    await signIn(page, {
      ownerEmail: ownerEmail(),
      ownerPassword: ownerPassword(),
    });
    await expect(page.getByTestId("health-ready")).toBeVisible();
    const organizations = await (await page.request.get("/v1/organizations"))
      .json() as { items: { id: string }[] };
    expect(organizations.items.length).toBeGreaterThan(0);
    j.organizationId = organizations.items[0].id;
    remember("organizationId", j.organizationId);
    j.session = await context.storageState();
    await shot(shots(), page, "P1-signed-in-desktop");
  });
  evidenceFile("evidence-P1.json", {
    organizationId: j.organizationId,
    setupOffered,
    setupOfferedAdminCreation: setupOffered.textboxes > 0 ||
      setupOffered.passwordFields > 0,
    operatorStep: "first-admin-createsuperuser",
  });
  await context.close();
});

// ---- P2 ----------------------------------------------------------------------------------
test("P2 repository, profile and agents through the API; onboarding in the UI", async ({ browser }) => {
  phase(2);
  test.setTimeout(BUDGET.P2);
  const { context, page, api } = await open(browser, { video: "P2" });
  const billing = readBilling(stateDirectory());
  const suffix = crypto.randomUUID().slice(0, 8);
  const application = await api.create("/v1/applications", {
    slug: `m1-${suffix}`,
    name: `M1 proof ${suffix}`,
    description: "The M1 real-journey proof application.",
  });
  j.applicationId = application.id as string;
  remember("applicationId", j.applicationId);

  // Agents, versions (configs from billing.json) and activations: no owner SQL.
  const coordinator = await createAgent(
    api,
    "coordinator",
    billing.agents.coordinator,
  );
  const coder = await createAgent(api, "coder", billing.agents.coder);
  j.coderVersionId = coder.versionId;
  remember("coordinatorAgentId", coordinator.agentId);
  remember("coordinatorVersionId", coordinator.versionId);
  remember("coderAgentId", coder.agentId);
  remember("coderVersionId", coder.versionId);

  const repository = await createRepository(
    api,
    j.applicationId,
    coder.versionId,
    suffix,
  );
  j.repositoryId = repository.repositoryId;
  j.profileId = repository.profileId;
  remember("repositoryId", j.repositoryId);
  remember("profileId", j.profileId);

  const onboarding =
    `/projects/onboarding?application=${j.applicationId}&repository=${j.repositoryId}&profile=${j.profileId}`;
  await page.goto(onboarding);
  await expect(page.getByTestId("projects-onboarding-profile-boundary"))
    .toContainText(`${repository.owner}/${repository.name}`);
  await axeClean(page, "/projects/onboarding");
  await shootRoute(
    shots(),
    browser,
    session(),
    j.organizationId,
    onboarding,
    "P2-onboarding",
    (other) =>
      expect(other.getByTestId("projects-onboarding-profile-boundary"))
        .toBeVisible(),
  );

  // The composer offers the repository with the fixed coding preset ready.
  await page.goto("/tasks/new");
  await fillComposer(
    page,
    j.repositoryId,
    "P2 composer check",
    "Not submitted.",
  );
  await expect(page.getByText("Setup required before this preset can run"))
    .toHaveCount(0);
  await axeClean(page, "/tasks/new");
  await shot(shots(), page, "P2-composer-ready-desktop");
  evidenceFile("evidence-P2.json", {
    applicationId: j.applicationId,
    repositoryId: j.repositoryId,
    profileId: j.profileId,
    agents: { coordinator, coder },
    note:
      "The repository record is metadata; the worker runs in its dedicated clone.",
  });
  await context.close();
});

// ---- P3 ----------------------------------------------------------------------------------
test("P3 worker: Machines UI enrollment, token reveal, worker start, truthful readiness", async ({ browser }) => {
  phase(3);
  test.setTimeout(BUDGET.P3);
  const { context, page, api } = await open(browser);
  await page.goto("/machines/new");
  await expect(page.getByTestId("machine-wizard")).toBeVisible();
  await axeClean(page, "/machines/new");
  // Name and system match what the worker registers with (worker.env); the
  // server compares them at registration (it treats x86_64 and x64 as one).
  await page.getByLabel("Name").fill("m1-claude-worker");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("radio", { name: /Claude Code/ }).check({
    force: true,
  });
  const created = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/v1/worker-enrollments" &&
    response.request().method() === "POST"
  );
  await page.getByRole("button", { name: "Continue" }).click();
  const response = await created;
  expect(response.request().headers()["idempotency-key"]).toBeTruthy();
  expect(response.status()).toBe(201);
  const enrollmentId =
    ((await response.json()) as { enrollmentId: string }).enrollmentId;
  remember("enrollmentId", enrollmentId);

  // The one-time reveal: the code is on screen once; it goes to a 0600 file the
  // worker reads, never into the evidence.
  const setupKey = page.locator('[data-ui-component="setupKey"]');
  await expect(setupKey).toBeVisible();
  const token = ((await setupKey.textContent()) ?? "").trim();
  expect(token.length, "a setup code was revealed").toBeGreaterThan(16);
  const tokenFile = `${stateDirectory()}/enrollment-token`;
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  chmodSync(tokenFile, 0o600);
  await expect(page.getByText("Waiting for the machine to connect…"))
    .toBeVisible();
  // The code is a live credential until the worker registers: mask it.
  if (shots()) {
    mkdirSync(shots(), { recursive: true });
    await page.screenshot({
      path: `${shots()}/P3-token-revealed-desktop.png`,
      fullPage: true,
      mask: [setupKey],
    });
  }

  await startWorker();
  // The page polls the enrollment and says so when the machine registers.
  await expect(page.getByText("m1-claude-worker is connected.")).toBeVisible({
    timeout: 5 * MINUTE,
  });
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page).toHaveURL(/\/machines\/[0-9a-f]{8}-[0-9a-f-]{27}$/, {
    timeout: 2 * MINUTE,
  });
  j.hostId = new URL(page.url()).pathname.split("/").pop()!;
  const enrollmentRecord = await api.get<
    { state: string; workerHostId: string }
  >(
    `/v1/worker-enrollments/${enrollmentId}`,
  );
  expect(enrollmentRecord.state).toBe("consumed");
  expect(enrollmentRecord.workerHostId).toBe(j.hostId);
  writeFileSync(`${stateDirectory()}/worker-host-id.txt`, `${j.hostId}\n`);
  remember("workerHostId", j.hostId);

  // Readiness is the server's: the host must be online and ready, and the
  // detail page must say the same.
  await untilWorker(api, j.hostId, "online/ready");
  await page.goto(`/machines/${j.hostId}`);
  const detail = page.getByTestId("machine-detail-page");
  await expect(detail).toBeVisible();
  await expect(detail.getByText("Ready", { exact: true }).first())
    .toBeVisible({ timeout: 60_000 });
  // A ready, reachable machine has nothing wrong to say: no problem banner.
  await expect(page.getByTestId("machine-problem-banner")).toHaveCount(0);
  await axeClean(page, "/machines/<host>");
  await shootRoute(
    shots(),
    browser,
    session(),
    j.organizationId,
    `/machines/${j.hostId}`,
    "P3-machine-ready",
    (other) => expect(other.getByTestId("machine-detail-page")).toBeVisible(),
  );
  evidenceFile("evidence-P3.json", {
    enrollmentId,
    workerHostId: j.hostId,
    readiness: await api.get<Worker>(`/v1/workers/${j.hostId}`),
    tokenRevealedOnce: true,
  });
  await context.close();
});

// ---- P4 ----------------------------------------------------------------------------------
test("P4 plan: a real coordinator turn, a question, a revision and a refused stale approval", async ({ browser }) => {
  phase(4);
  test.setTimeout(BUDGET.P4);
  const { context, page, api } = await open(browser, { video: "P4" });
  const observer = observe(page, needles());
  await fundedStep("P4 coordinator turns");

  // Plan first creates the task and no run.
  await page.goto("/tasks/new");
  await fillComposer(
    page,
    j.repositoryId,
    M1_TASK_TITLE,
    M1_TASK_DESCRIPTION,
  );
  await page.getByRole("checkbox", { name: "Plan first" }).check({
    force: true,
  });
  await page.getByRole("button", { name: "Create task and plan" }).click();
  await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  j.taskId = page.url().split("/").at(-1)!;
  const task = await api.get<Task>(`/v1/tasks/${j.taskId}`);
  expect(task.approvalPolicy).toEqual({ plan: "human_approval" });
  expect(task.currentRunId).toBeNull();
  j.conversationId = task.conversationId;
  remember("taskId", j.taskId);
  remember("conversationId", j.conversationId);
  await expect(conversationRegion(page)).toBeVisible();
  await expect(page.locator('[data-stage="plan"]')).toContainText(
    "Waits for your approval",
  );
  expect(await runsOf(api, j.taskId)).toHaveLength(0);
  await axeClean(page, "/tasks/<id> empty conversation");

  // Discuss shares a message and starts no agent turn.
  await say(page, "Discuss", "Let's keep this change tiny and exact.");
  await expect(page.getByRole("log").getByText("keep this change tiny"))
    .toBeVisible();
  expect(
    (await api.get<{ items: unknown[] }>(
      `/v1/conversations/${j.conversationId}/turns`,
    )).items,
  ).toHaveLength(0);

  // Ask agent: the real coordinator turn must pause at a real question.
  await say(page, "Ask agent", M1_PLAN_REQUEST);
  const plan = planRegion(page);
  await expect(questionCard(page).first().or(plan).first()).toBeVisible({
    timeout: 8 * MINUTE,
  });
  if (!(await questionCard(page).first().isVisible())) {
    throw new Error(
      "M1_COORDINATOR_ASKED_NO_QUESTION: the plan arrived without the requested question",
    );
  }
  await shot(shots(), page, "P4-question-desktop");
  const answered = await answerQuestion(
    page,
    /block/i,
    M1_QUESTION_TEXT_ANSWER,
  );
  await expect(page.getByText("Recorded answer")).toBeVisible();
  remember("questionId", answered.id ?? "unreadable");

  // Plan revision 1 with an open approval.
  await expect(plan).toContainText("Revision 1", { timeout: 8 * MINUTE });
  expect(await plan.getByRole("listitem").count()).toBeGreaterThan(0);
  await expect(approve(page, 1)).toBeEnabled();
  await shot(shots(), page, "P4-plan-revision-1-desktop");
  const approval1 = await approvalForRevision(api, j.taskId, 1);
  expect(approval1.status).toBe("open");
  j.revision1ApprovalId = approval1.id;
  remember("approvalRevision1Id", approval1.id);

  // A second page keeps revision 1 on screen and cannot read newer plans.
  const stale = await context.newPage();
  const planReads = (url: URL) =>
    url.pathname === "/v1/plan-revisions" || url.pathname === "/v1/approvals";
  await stale.goto(`/tasks/${j.taskId}`);
  await expect(approve(stale, 1)).toBeVisible({ timeout: 30_000 });
  const blocked = await abortReads(stale, planReads);

  // Request changes: a new turn proposes revision 2, which supersedes 1.
  await page.getByRole("button", { name: "Request changes", exact: true })
    .click();
  await page.getByRole("textbox", { name: "What should change?" }).fill(
    M1_CHANGE_REQUEST,
  );
  await page.getByRole("button", { name: "Send change request" }).click();
  await expect(plan).toContainText("Revision 2", { timeout: 8 * MINUTE });
  await expect(approve(page, 2)).toBeEnabled();
  await shot(shots(), page, "P4-plan-revision-2-desktop");
  const revisions = await revisionsOf(api, j.taskId);
  expect(revisions.find((item) => item.revision === 1)?.status).toBe(
    "superseded",
  );
  const approval2 = await approvalForRevision(api, j.taskId, 2);
  expect(approval2.status).toBe("open");
  j.revision2ApprovalId = approval2.id;
  remember("approvalRevision2Id", approval2.id);

  // Approving the obsolete revision from the stale page is refused.
  await approve(stale, 1).click();
  await expect(stale.getByText("Nothing was decided")).toBeVisible();
  await blocked.restore();
  await expect(stale.getByText("Revision 1 is obsolete")).toBeVisible({
    timeout: 30_000,
  });
  await expect(approve(stale, 2)).toBeVisible();
  await shot(shots(), stale, "P4-obsolete-conflict-desktop");
  await stale.close();
  const decisions = (await approvalsOf(api, j.taskId)).map((item) =>
    item.decision
  ).filter((decision) => decision !== null);
  expect(decisions, "only the change request was decided").toEqual([
    "request_changes",
  ]);

  await shootRoute(
    shots(),
    browser,
    session(),
    j.organizationId,
    `/tasks/${j.taskId}`,
    "P4-plan",
    (other) => expect(planRegion(other)).toContainText("Revision 2"),
  );
  // The coordinator ran on the pinned model. A coordinator turn has no output
  // stream and no usage record, so the worker's result stored on the turn's
  // job attempt (read only, by owner query) is where the model is recorded.
  // What the worker stores is `state.model ?? options.model` (see
  // `claude-coordinator.ts`): the model of the Claude Code `system/init`
  // record, or the configured `--model` pin when that record carried none. So
  // this proves the recorded model equals the pin, and it is an observation of
  // the CLI's own model only when the init record had one; the evidence says so.
  const turns = await coordinatorModels(j.conversationId);
  const completedTurns = turns.filter((turn) =>
    turn.attemptStatus === "completed"
  );
  expect(
    completedTurns.length,
    "a completed coordinator turn for the question, the plan and the revision",
  ).toBeGreaterThanOrEqual(3);
  for (const turn of completedTurns) {
    expect(turn.model, `model of coordinator turn ${turn.turnId}`).toBe(
      M1_PROOF_MODEL,
    );
  }
  await assertNoCanary(page, observer, needles());
  evidenceFile("evidence-P4.json", {
    taskId: j.taskId,
    conversationId: j.conversationId,
    question: {
      id: answered.id,
      answer: answered.answer,
      preferredMatched: answered.preferredMatched,
    },
    revisions: revisions.map((item) => ({
      revision: item.revision,
      status: item.status,
    })),
    approvals: { revision1: approval1.id, revision2: approval2.id },
    coordinatorTurns: turns,
    pinnedModel: M1_PROOF_MODEL,
    modelSource:
      "recorded by the worker; equals the configured pin when the CLI init record carried no model",
    spend: j.spend,
  });
  await context.close();
});

// ---- P5 ----------------------------------------------------------------------------------
test("P5 wait and restart: browser, server and engine restart with the approval pending", async ({ browser }) => {
  phase(5);
  test.setTimeout(BUDGET.P5);
  const first = await open(browser, { video: "P5" });
  const { context, page, api } = first;
  await page.goto(`/tasks/${j.taskId}`);
  await expect(planRegion(page)).toContainText("Revision 2", {
    timeout: 30_000,
  });
  const before = {
    messages: (await api.get<{ items: { id: string }[] }>(
      `/v1/conversations/${j.conversationId}/messages?limit=100`,
    )).items.map((item) => item.id),
    approvals: (await approvalsOf(api, j.taskId)).map((item) => ({
      id: item.id,
      status: item.status,
      version: item.version,
    })),
  };
  // A private draft stays on this device; it is never sent.
  const draft = "A private thought across the restart";
  await messageBox(page).fill(draft);
  await page.waitForTimeout(1_000);
  const saved = await context.storageState();
  await context.close();

  await restartServer();
  await restartInngest();
  await waitReady(serverOrigin(), 120_000);

  // Reopen with the saved storage state: the same session, the same draft.
  const reopened = await browser.newContext({
    storageState: saved,
    viewport: DESKTOP,
    ...recordVideoFor("P5-reopened"),
  });
  const again = await reopened.newPage();
  const againApi = new M1Api(again.request, webOrigin(), j.organizationId);
  await again.goto(`/tasks/${j.taskId}`);
  await expect(conversationRegion(again)).toBeVisible({ timeout: 60_000 });
  await expect(planRegion(again)).toContainText("Revision 2");
  await expect(approve(again, 2)).toBeEnabled();
  await expect(again.getByRole("log").getByText("keep this change tiny"))
    .toBeVisible();
  await expect(messageBox(again)).toHaveValue(draft);
  const after = {
    messages: (await againApi.get<{ items: { id: string }[] }>(
      `/v1/conversations/${j.conversationId}/messages?limit=100`,
    )).items.map((item) => item.id),
    approvals: (await approvalsOf(againApi, j.taskId)).map((item) => ({
      id: item.id,
      status: item.status,
      version: item.version,
    })),
  };
  expect(after.messages, "transcript intact").toEqual(before.messages);
  expect(after.approvals, "pending approval intact").toEqual(before.approvals);
  expect(
    after.approvals.find((item) => item.id === j.revision2ApprovalId)
      ?.status,
  ).toBe("open");
  expect(await runsOf(againApi, j.taskId)).toHaveLength(0);
  await shot(shots(), again, "P5-after-restart-desktop");
  evidenceFile("evidence-P5.json", {
    restarted: ["server", "inngest"],
    messageCount: after.messages.length,
    approvals: after.approvals,
    draftRestored: true,
  });
  await reopened.close();
});

// ---- P6 ----------------------------------------------------------------------------------
test("P6 approve and run: revision 2 by keyboard, one run on the enrolled host", async ({ browser }) => {
  phase(6);
  test.setTimeout(BUDGET.P6);
  const { context, page, api, evidence } = await open(browser, { video: "P6" });
  await page.goto(`/tasks/${j.taskId}`);
  await expect(approve(page, 2)).toBeEnabled({ timeout: 60_000 });

  // Keyboard path: focus the button and press Enter. Every decision request
  // the page sends is counted from its responses; a second Enter is a
  // duplicate, and so is a second decision sent behind the page's back.
  const decisionStatuses: number[] = [];
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (
      response.request().method() === "POST" &&
      /^\/v1\/approvals\/[^/]+\/decision$/.test(url.pathname)
    ) decisionStatuses.push(response.status());
  });
  await approve(page, 2).focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  j.keyboardApprove = true;
  await expect(page.getByText("You approved revision 2")).toBeVisible();
  await expect(approve(page, 2)).toHaveCount(0);
  await page.waitForTimeout(1_000);
  j.decisionStatuses = [...decisionStatuses];
  expect(decisionStatuses.length, "the page sent a decision").toBeGreaterThan(
    0,
  );
  expect(
    decisionStatuses.filter((status) => status < 400),
    "at most one accepted decision from the page",
  ).toHaveLength(1);
  const decided = (await approvalsOf(api, j.taskId)).filter((item) =>
    item.decision === "approve"
  );
  expect(decided, "one approval decision").toHaveLength(1);
  expect(decided[0].id).toBe(j.revision2ApprovalId);
  // Duplicates sent behind the page's back, each with a fresh idempotency key.
  // The identical decision (same decision and comment, so the same digest) is
  // acknowledged with the stored approval and changes nothing; a conflicting
  // decision (a reject on the approved approval) is refused with 409
  // `approval_decided`. Neither may move the stored approval.
  const approved = decided[0];
  const identical = await api.send(
    "POST",
    `/v1/approvals/${j.revision2ApprovalId}/decision`,
    { decision: "approve", expectedVersion: approved.version },
  );
  const conflicting = await api.send(
    "POST",
    `/v1/approvals/${j.revision2ApprovalId}/decision`,
    { decision: "reject", expectedVersion: approved.version },
  );
  const afterDuplicates = (await approvalsOf(api, j.taskId)).find((item) =>
    item.id === j.revision2ApprovalId
  )!;
  const duplicateProblems = checkDuplicateDecision({
    before: approved,
    identical,
    conflicting,
    after: afterDuplicates,
  });
  expect(duplicateProblems, "duplicate and conflicting decisions").toEqual([]);
  expect(
    (await approvalsOf(api, j.taskId)).filter((item) =>
      item.decision === "approve"
    ),
    "still one approve decision",
  ).toHaveLength(1);

  // The start form reads the approval id from its own query; its hint goes
  // away once that read has caught up with the decision.
  await expect(page.getByText(
    "This task waits for an approved plan revision. The run starts from the revision you approve.",
  )).toHaveCount(0);
  await fundedStep("P6 executor run");
  // A double click on Start run admits one run, not two.
  await startRunButton(page).dblclick();
  await expect.poll(
    async () => (await api.get<Task>(`/v1/tasks/${j.taskId}`)).currentRunId,
    { timeout: 90_000, message: "the task has a current run" },
  ).not.toBeNull();
  j.runId = (await api.get<Task>(`/v1/tasks/${j.taskId}`)).currentRunId!;
  remember("runId", j.runId);
  await page.waitForTimeout(3_000);
  expect(await runsOf(api, j.taskId), "one run").toHaveLength(1);
  await page.reload();
  await expect(page.getByText("A run is in progress.")).toBeVisible();
  await shot(shots(), page, "P6-run-started-desktop");

  // The approval is consumed by exactly this run, and the run's brief artifact
  // (published by its first step) carries the approved revision, plan id and
  // digest. The step inputs hold unresolved templates, so the artifact is the
  // place the approved plan is visible.
  const approval = (await approvalsOf(api, j.taskId)).find((item) =>
    item.id === j.revision2ApprovalId
  );
  expect(approval?.consumedByRunId).toBe(j.runId);
  const revision2 = (await revisionsOf(api, j.taskId)).find((item) =>
    item.revision === 2
  );
  expect(revision2, "plan revision 2").toBeTruthy();
  let briefVersionId = "";
  await expect.poll(async () => {
    const artifacts = await evidence.all<Artifact>(
      `/v1/artifacts?taskId=${j.taskId}&limit=25`,
    );
    briefVersionId = artifacts.find((artifact) =>
      artifact.name.startsWith("task-brief-")
    )?.currentVersionId ?? "";
    return briefVersionId;
  }, {
    timeout: BRIEF_POLL_TIMEOUT,
    intervals: [5_000],
    message: "the brief artifact",
  })
    .not.toBe("");
  const briefText = (await evidence.raw(
    `/v1/artifact-versions/${briefVersionId}/content`,
  )).body.toString("utf8");
  const briefProblems = checkBriefApprovedPlan(briefText, {
    revision: 2,
    planRevisionId: revision2!.id,
    digest: revision2!.digest,
  });
  expect(briefProblems, "the brief carries the approved plan").toEqual([]);

  // The attempt lands on the enrolled host.
  let hostOfAttempt = "";
  await expect.poll(async () => {
    try {
      const facts = await collectRun(evidence, j.taskId);
      hostOfAttempt = facts.attempts[0]?.workerHostId ?? "";
    } catch {
      hostOfAttempt = "";
    }
    return hostOfAttempt;
  }, { timeout: 10 * MINUTE, intervals: [5_000], message: "first attempt" })
    .not.toBe("");
  expect(hostOfAttempt, "attempt host is the enrolled host").toBe(j.hostId);
  evidenceFile("evidence-P6.json", {
    taskId: j.taskId,
    runId: j.runId,
    approvalId: j.revision2ApprovalId,
    keyboardApprove: j.keyboardApprove,
    decisionResponseStatuses: j.decisionStatuses,
    duplicateDecisions: {
      identical: identical.status,
      conflicting: conflicting.status,
      conflictingReason: conflicting.body.reason,
    },
    runsAfterDoubleClick: 1,
    attemptWorkerHostId: hostOfAttempt,
    enrolledWorkerHostId: j.hostId,
    briefVersionId,
    briefCarriesApprovedPlan: { revision: 2, planRevisionId: revision2!.id },
    spend: j.spend,
  });
  await context.close();
});

// ---- P7 ----------------------------------------------------------------------------------
test("P7 observe: logs, diff and artifact equal the server; accessibility and layout on real data", async ({ browser }) => {
  phase(7);
  test.setTimeout(BUDGET.P7);
  const { context, page, api, evidence } = await open(browser, { video: "P7" });
  const observer = observe(page, needles());
  await page.goto(`/tasks/${j.taskId}`);
  await selectImplementStep(page);
  const status = await untilTerminal(api, j.runId, 35 * MINUTE);
  expect(status, "the main run completes").toBe("completed");
  await page.reload();
  await selectImplementStep(page);
  const facts = await collectRun(evidence, j.taskId);
  const completed = await assertCompleted(page, observer, evidence, facts, {
    needles: needles(),
    expectPatch: true,
    harnessKind: "real",
    ownerEmail: ownerEmail(),
    harnessRepository: env("BAKERY_M1_HARNESS_REPO"),
    workerHostId: j.hostId,
    // The "no review or merge claimed" scan covers the page's own chrome, never
    // model-written conversation, plan or transcript text.
    completionCopyScope: (other) =>
      other.locator(
        '[data-ui-component="runIdentity"], [data-ui-component="revisionSummary"]',
      ).or(other.getByRole("status", { name: "Run updates" })),
  });
  await shot(shots(), page, "P7-run-complete-desktop");

  // The change is the one asked for: the named file only, one comment block
  // directly above the named function, no removed line.
  const patchVersionId = (completed.patch as { version: { id: string } })
    .version.id;
  const patch = (await evidence.raw(
    `/v1/artifact-versions/${patchVersionId}/content`,
  )).body.toString("utf8");
  expect(
    verifyDocCommentPatch(patch, M1_RUN_TASKS.main.targets),
    "the patch is the requested doc comment",
  ).toEqual([]);

  // The executor ran on the pinned model (its final attempt's system/init).
  const executorModels = await initModelsOf(
    evidence,
    facts.stream ? [facts.stream] : [],
  );
  const models = Object.values(executorModels).flat();
  expect(models.length, "executor system/init records").toBeGreaterThan(0);
  for (const model of models) expect(model).toBe(M1_PROOF_MODEL);

  // Accessibility on each journey screen, with real data.
  const artifacts = await evidence.all<Artifact>(
    `/v1/artifacts?taskId=${j.taskId}&limit=25`,
  );
  const patchArtifact = artifacts.find((artifact) =>
    artifact.artifactType === "patch"
  );
  // The screens that need no run were scanned in P2 and P3, before any funded
  // step; here are the ones that show the run itself.
  const screens: [string, () => Promise<unknown>][] = [
    ["/tasks/<id> run", async () => {}],
  ];
  if (patchArtifact) {
    screens.push([
      "/tasks/<id>/artifacts/<id>",
      () => page.goto(`/tasks/${j.taskId}/artifacts/${patchArtifact.id}`),
    ]);
  }
  const axeScreens: string[] = [];
  for (const [label, go] of screens) {
    await go();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator("main").first()).toBeVisible();
    await axeClean(page, label);
    axeScreens.push(label);
  }

  // 320 px, right-to-left pseudo-locale: no horizontal scroll on the run.
  await page.goto(`/tasks/${j.taskId}`);
  const preferences = await api.get<{ casVersion: number }>(
    "/v1/user-preferences",
  );
  const patched = await api.send("PATCH", "/v1/user-preferences", {
    locale: "ar-XB",
    expectedCasVersion: preferences.casVersion,
  });
  expect(patched.status, JSON.stringify(patched.body)).toBe(200);
  try {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.locator('[data-ui-region="task-conversation"]'))
      .toBeVisible();
    expect(await noHorizontalScroll(page), "no scroll at 320 px RTL").toBe(
      true,
    );
    await shot(shots(), page, "P7-run-rtl-320");
  } finally {
    const restored = await api.send("PATCH", "/v1/user-preferences", {
      locale: null,
      expectedCasVersion: (patched.body as { casVersion: number }).casVersion,
    });
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    await page.setViewportSize(DESKTOP);
  }

  // 200% zoom (a 640 px window), reduced motion.
  await page.setViewportSize({ width: 640, height: 450 });
  await page.reload();
  await expect(conversationRegion(page)).toBeVisible();
  expect(await noHorizontalScroll(page), "no scroll at 200% zoom").toBe(true);
  await shot(shots(), page, "P7-run-zoom-200");
  await page.setViewportSize(DESKTOP);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  expect(await longestTransition(page), "reduced motion").toBeLessThanOrEqual(
    0.01,
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });

  // Light, dark and system themes; desktop and phone.
  const state = await context.storageState();
  await shootAll(shots(), browser, state, j.organizationId, j.taskId, "P7-run");
  const systemThemes: Record<string, string> = {};
  for (const scheme of ["light", "dark"] as const) {
    const themed = await sessionContext(browser, session(), j.organizationId, {
      colorScheme: scheme,
      theme: "system",
    });
    try {
      const themedPage = await themed.newPage();
      await themedPage.goto(`/tasks/${j.taskId}`);
      await expect(themedPage.locator("html")).toHaveAttribute(
        "data-theme",
        scheme,
      );
      systemThemes[scheme] = scheme;
    } finally {
      await themed.close();
    }
  }
  evidenceFile("evidence-P7.json", {
    runId: j.runId,
    patchTargets: M1_RUN_TASKS.main.targets,
    patchIsRequestedDocComment: true,
    executorModels,
    pinnedModel: M1_PROOF_MODEL,
    axeScreens,
    rtl320NoScroll: true,
    zoom200NoScroll: true,
    reducedMotion: true,
    systemThemes,
    keyboardApprove: j.keyboardApprove,
    ...completed,
  });
  await context.close();
});

// ---- P8 ----------------------------------------------------------------------------------
test("P8 faults on a run: lost response, offline window, worker killed mid-run, recovery", async ({ browser }) => {
  phase(8);
  test.setTimeout(BUDGET.P8);
  const { context, page, api, evidence } = await open(browser, { video: "P8" });
  await fundedStep("P8 executor run");
  const task = M1_RUN_TASKS.faults;
  const title = `${task.title} ${new Date().toISOString()}`;

  // Duplicate submission: the server commits the run, the response is lost,
  // Retry replays the same request, and one task and one run exist.
  const lost = await loseResponseOnce(page, "**/v1/tasks/*/runs", "POST");
  await page.goto("/tasks/new");
  const form = await fillComposer(
    page,
    j.repositoryId,
    title,
    task.description,
  );
  await form.getByRole("button", { name: "Start task", exact: true }).click();
  const retry = form.getByRole("button", {
    name: "Retry submission",
    exact: true,
  });
  await expect(retry).toBeVisible({ timeout: 60_000 });
  expect(lost.lostResponses(), "the run response was lost once").toBe(1);
  await retry.click();
  await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}$/, { timeout: 60_000 });
  await lost.restore();
  const taskId = page.url().split("/").at(-1)!;
  remember("faultTaskId", taskId);
  const listed = await api.get<{ items: unknown[] }>(
    `/v1/tasks?search=${
      encodeURIComponent(title)
    }&repositoryId=${j.repositoryId}`,
  );
  expect(listed.items, "retry must not create a second task").toHaveLength(1);
  expect(await runsOf(api, taskId), "exactly one run").toHaveLength(1);
  const runId = (await api.get<Task>(`/v1/tasks/${taskId}`)).currentRunId!;
  remember("faultRunId", runId);

  // The executor starts; the browser goes offline for a window and returns.
  await expect(stepRow(page, "Implement")).toContainText("Running", {
    timeout: 12 * MINUTE,
  });
  const offlineAt = new Date();
  await context.setOffline(true);
  await page.waitForTimeout(10_000);
  await context.setOffline(false);
  const onlineAt = new Date();
  await expect(stepRow(page, "Implement")).toHaveCount(1);
  await expect(stepRow(page, "Write task brief")).toHaveCount(1);
  expect(
    TERMINAL_RUN_STATUSES.includes(
      (await api.get<Run>(`/v1/runs/${runId}`)).status,
    ),
    "the run did not finish inside the offline window",
  ).toBe(false);
  await shot(shots(), page, "P8-after-offline-desktop");

  // The worker is killed mid-run. While it is down the run is not terminal and
  // the page claims no completion.
  await selectImplementStep(page);
  const killedAt = new Date();
  await stopWorker();
  await expect.poll(async () => {
    const worker = await api.get<Worker>(`/v1/workers/${j.hostId}`);
    return worker.connectivity;
  }, { timeout: 4 * MINUTE, intervals: [3_000], message: "host leaves online" })
    .not.toBe("online");
  const whileDown = (await api.get<Run>(`/v1/runs/${runId}`)).status;
  expect(TERMINAL_RUN_STATUSES, "no terminal state while the worker is down")
    .not.toContain(whileDown);
  await page.reload();
  await expect(runStatus(page)).toContainText(STATUS_LABEL[whileDown]);
  await expect(page.getByText("Execution completed")).toHaveCount(0);
  await shot(shots(), page, "P8-worker-down-desktop");

  // The worker returns; the run recovers to exactly one terminal outcome.
  await resumeWorker();
  const restartedAt = new Date();
  await untilWorker(api, j.hostId, "online/ready");
  const outcome = await untilTerminal(api, runId, 35 * MINUTE);
  await page.reload();
  await expect(runStatus(page)).toContainText(STATUS_LABEL[outcome], {
    timeout: 60_000,
  });
  await expect(runTerminalEntries(page)).toHaveCount(1);
  const facts = await collectRun(evidence, taskId);
  expect(facts.attempts.length, "at least one attempt").toBeGreaterThan(0);
  expect(facts.attempts.at(-1)?.workerHostId).toBe(j.hostId);
  const patchVersions = (await evidence.all<Artifact>(
    `/v1/artifacts?taskId=${taskId}&artifactType=patch&limit=25`,
  )).length;
  expect(patchVersions, "no duplicate patch artifact").toBeLessThanOrEqual(1);
  const patchCheck = await checkRunPatch(evidence, taskId, task, outcome);
  expect(await runsOf(api, taskId), "still one run").toHaveLength(1);
  await shot(shots(), page, "P8-recovered-desktop");
  evidenceFile("evidence-P8.json", {
    taskId,
    runId,
    lostResponses: 1,
    offlineAt: offlineAt.toISOString(),
    onlineAt: onlineAt.toISOString(),
    killedAt: killedAt.toISOString(),
    restartedAt: restartedAt.toISOString(),
    statusWhileWorkerDown: whileDown,
    outcome,
    patchCheck,
    attempts: facts.attempts.map((attempt) => ({
      id: attempt.id,
      attemptNo: attempt.attemptNo,
      status: attempt.status,
      reasonCode: attempt.outcome.reasonCode,
      workerHostId: attempt.workerHostId,
    })),
    spend: j.spend,
  });
  await context.close();
});

// ---- P9 ----------------------------------------------------------------------------------
test("P9 changes, cancel and recover: revision 3, a cancelled run, a run queued behind a dead worker", async ({ browser }) => {
  phase(9);
  test.setTimeout(BUDGET.P9);
  const { context, page, api, evidence } = await open(browser, { video: "P9" });

  // Request changes on the finished run: the agent proposes revision 3.
  await page.goto(`/tasks/${j.taskId}`);
  await fundedStep("P9 coordinator turn after the run");
  await say(
    page,
    "Ask agent",
    "The run finished. Please revise the plan so the comment also names the fallback value.",
  );
  await expect(planRegion(page)).toContainText("Revision 3", {
    timeout: 8 * MINUTE,
  });
  await expect(approve(page, 3)).toBeEnabled();
  const approval3 = await approvalForRevision(api, j.taskId, 3);
  expect(approval3.status).toBe("open");
  remember("approvalRevision3Id", approval3.id);
  expect(await runsOf(api, j.taskId), "revision 3 starts no run").toHaveLength(
    1,
  );
  await shot(shots(), page, "P9-revision-3-desktop");

  // Second run: cancel it while it executes and show the server's winner.
  await fundedStep("P9 cancel run");
  await page.goto("/tasks/new");
  const cancelTask = M1_RUN_TASKS.cancel;
  const title = `${cancelTask.title} ${new Date().toISOString()}`;
  const form = await fillComposer(
    page,
    j.repositoryId,
    title,
    cancelTask.description,
  );
  await form.getByRole("button", { name: "Start task", exact: true }).click();
  await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}$/, { timeout: 60_000 });
  const cancelTaskId = page.url().split("/").at(-1)!;
  remember("cancelTaskId", cancelTaskId);
  const cancelRunId = (await api.get<Task>(`/v1/tasks/${cancelTaskId}`))
    .currentRunId!;
  remember("cancelRunId", cancelRunId);
  await expect(stepRow(page, "Implement")).toContainText("Running", {
    timeout: 12 * MINUTE,
  });
  const cancel = controlButton(page, "Request cancellation");
  await expect(cancel).toBeEnabled({ timeout: 90_000 });
  await cancel.click();
  const winner = await untilTerminal(api, cancelRunId, 10 * MINUTE);
  expect(["canceled", "completed"], "the server's winner").toContain(winner);
  await expect(runStatus(page)).toContainText(STATUS_LABEL[winner], {
    timeout: 60_000,
  });
  await expect(runTerminalEntries(page)).toHaveCount(1);
  await page.reload();
  await expect(runStatus(page)).toContainText(STATUS_LABEL[winner]);
  const cancelPatchCheck = await checkRunPatch(
    evidence,
    cancelTaskId,
    cancelTask,
    winner,
  );
  await shot(shots(), page, "P9-cancel-winner-desktop");

  // Third run: the worker is dead when the run is admitted. The run stays
  // truthfully non-terminal and queued; when the worker returns it recovers.
  await stopWorker();
  await expect.poll(async () => {
    const worker = await api.get<Worker>(`/v1/workers/${j.hostId}`);
    return worker.connectivity;
  }, { timeout: 4 * MINUTE, intervals: [3_000], message: "host leaves online" })
    .not.toBe("online");
  await fundedStep("P9 queued run");
  await page.goto("/tasks/new");
  const queuedTask = M1_RUN_TASKS.queued;
  const queuedTitle = `${queuedTask.title} ${new Date().toISOString()}`;
  const queuedForm = await fillComposer(
    page,
    j.repositoryId,
    queuedTitle,
    queuedTask.description,
  );
  await queuedForm.getByRole("button", { name: "Start task", exact: true })
    .click();
  await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}$/, { timeout: 60_000 });
  const recoverTaskId = page.url().split("/").at(-1)!;
  remember("recoverTaskId", recoverTaskId);
  const recoverRunId = (await api.get<Task>(`/v1/tasks/${recoverTaskId}`))
    .currentRunId!;
  remember("recoverRunId", recoverRunId);
  await page.waitForTimeout(45_000);
  const waiting = (await api.get<Run>(`/v1/runs/${recoverRunId}`)).status;
  expect(TERMINAL_RUN_STATUSES, "nothing runs on a dead worker").not.toContain(
    waiting,
  );
  await page.reload();
  await expect(runStatus(page)).toContainText(STATUS_LABEL[waiting]);
  await expect(page.getByText("Execution completed")).toHaveCount(0);
  await shot(shots(), page, "P9-queued-worker-down-desktop");

  await resumeWorker();
  await untilWorker(api, j.hostId, "online/ready");
  const recovered = await untilTerminal(api, recoverRunId, 35 * MINUTE);
  await page.reload();
  await expect(runStatus(page)).toContainText(STATUS_LABEL[recovered], {
    timeout: 60_000,
  });
  await expect(runTerminalEntries(page)).toHaveCount(1);
  const facts = await collectRun(evidence, recoverTaskId);
  expect(facts.attempts.length).toBeGreaterThan(0);
  expect(facts.attempts[0].workerHostId).toBe(j.hostId);
  expect(await runsOf(api, recoverTaskId)).toHaveLength(1);
  const recoverPatchCheck = await checkRunPatch(
    evidence,
    recoverTaskId,
    queuedTask,
    recovered,
  );
  await shot(shots(), page, "P9-recovered-desktop");
  evidenceFile("evidence-P9.json", {
    revision3ApprovalId: approval3.id,
    cancel: {
      taskId: cancelTaskId,
      runId: cancelRunId,
      winner,
      patchCheck: cancelPatchCheck,
    },
    recover: {
      taskId: recoverTaskId,
      runId: recoverRunId,
      statusWhileWorkerDown: waiting,
      outcome: recovered,
      patchCheck: recoverPatchCheck,
      attempts: facts.attempts.map((attempt) => ({
        id: attempt.id,
        status: attempt.status,
        workerHostId: attempt.workerHostId,
      })),
    },
    spend: j.spend,
  });
  await context.close();
});

// ---- P10 ---------------------------------------------------------------------------------
test("P10 negatives: reject, expiry, stale and duplicate approvals never execute the wrong action", async ({ browser }) => {
  phase(10);
  test.setTimeout(BUDGET.P10);
  const { context, page, api } = await open(browser, { video: "P10" });
  const mechanisms: Record<string, unknown> = {};

  // A rejected plan: Start run is refused and no run exists.
  await fundedStep("P10 reject plan");
  const rejected = await createPlanFirstTask(api, "M1 reject path");
  remember("rejectTaskId", rejected.id);
  await page.goto(`/tasks/${rejected.id}`);
  await say(page, "Ask agent", M1_PLAN_ONLY_REQUEST);
  await expect(approve(page, 1)).toBeEnabled({ timeout: 8 * MINUTE });
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  await expect(page.getByText("You rejected revision 1")).toBeVisible();
  await startRunButton(page).click();
  await expect(page.getByText("The server did not admit the run."))
    .toBeVisible({ timeout: 30_000 });
  expect(await runsOf(api, rejected.id)).toHaveLength(0);
  expect((await api.get<Task>(`/v1/tasks/${rejected.id}`)).currentRunId)
    .toBeNull();
  await shot(shots(), page, "P10-rejected-no-run-desktop");

  // Expiry of a pending approval: the clock moves (operator step 3), a
  // decision is refused as expired, and the scheduled sweep stores `expired`.
  await fundedStep("P10 expiry plan");
  const expiring = await createPlanFirstTask(api, "M1 expiry path");
  remember("expiryTaskId", expiring.id);
  await page.goto(`/tasks/${expiring.id}`);
  await say(page, "Ask agent", M1_PLAN_ONLY_REQUEST);
  await expect(approve(page, 1)).toBeEnabled({ timeout: 8 * MINUTE });
  const pending = await approvalForRevision(api, expiring.id, 1);
  expect(pending.status).toBe("open");
  remember("expiryApprovalOpenId", pending.id);
  await forceApprovalExpiry(pending.id);
  const forcedAt = Date.now();
  // The page still shows the approval as open (the clock move emits no event),
  // so a person's click reaches the server, which must refuse it as expired.
  // If a refetch already removed the button, the same decision goes by API.
  // The decision goes through the UI while the button is there. The page's
  // response promise exists only for a click that happened.
  const uiResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        `/v1/approvals/${pending.id}/decision` &&
      response.request().method() === "POST",
    { timeout: 20_000 },
  )
    .then(async (response) => ({
      status: response.status(),
      body: await response.text().catch(() => ""),
    }))
    .catch(() => null);
  const refused = await decideRefused({
    clickApprove: () => approve(page, 1).click({ timeout: 10_000 }),
    uiResponse,
    sendByApi: async () => {
      const result = await api.send(
        "POST",
        `/v1/approvals/${pending.id}/decision`,
        { decision: "approve", expectedVersion: pending.version },
      );
      return { status: result.status, body: JSON.stringify(result.body) };
    },
  });
  const decisionPath = refused.path;
  expect(refused.status, "a decision on an expired approval is refused")
    .toBeGreaterThanOrEqual(400);
  expect(refused.status).toBeLessThan(500);
  const refusedBody = refused.body;
  if (decisionPath === "ui") {
    await expect(
      page.getByText(/Nothing was decided|Your decision was not recorded/)
        .first(),
    ).toBeVisible();
  }
  const readThrough = await api.get<Approval>(`/v1/approvals/${pending.id}`);
  expect(readThrough.status, "API read-through status").toBe("expired");
  expect(await runsOf(api, expiring.id)).toHaveLength(0);
  // No manual sweep: poll the stored status until the cron marks it expired.
  await expect.poll(() => storedStatus(pending.id), {
    timeout: 90_000,
    intervals: [3_000],
    message: "the scheduled sweep stores expired",
  }).toBe("expired");
  const sweepSeconds = Math.round((Date.now() - forcedAt) / 1000);
  mechanisms.openApproval = {
    approvalId: pending.id,
    mechanism:
      "operator step 3 moved expires_at into the past; the scheduled sweep stored expired",
    decisionPath,
    refusedStatus: refused.status,
    refusedReason: refusedBody.slice(0, 200),
    readThroughStatus: readThrough.status,
    storedStatus: "expired",
    sweepSeconds,
  };
  await page.reload();
  await expect(approve(page, 1)).toHaveCount(0);
  await expect(page.getByText("No approval request is open for this revision."))
    .toBeVisible();
  await shot(shots(), page, "P10-open-approval-expired-desktop");

  // Expiry of an approved, unconsumed approval: only the read-through acts.
  await say(
    page,
    "Ask agent",
    "The approval expired. Please propose the plan again.",
  );
  await expect(planRegion(page)).toContainText("Revision 2", {
    timeout: 8 * MINUTE,
  });
  await expect(approve(page, 2)).toBeEnabled();
  await approve(page, 2).click();
  await expect(page.getByText("You approved revision 2")).toBeVisible();
  const approved = await approvalForRevision(api, expiring.id, 2);
  expect(approved.decision).toBe("approve");
  remember("expiryApprovalApprovedId", approved.id);
  await forceApprovalExpiry(approved.id);
  await page.reload();
  await expect(approve(page, 2)).toHaveCount(0);
  const approvedReadThrough = await api.get<Approval>(
    `/v1/approvals/${approved.id}`,
  );
  expect(approvedReadThrough.status, "API read-through status").toBe("expired");
  // Start run, with no approval to send and with the expired one, is refused.
  await startRunButton(page).click();
  await expect(page.getByText("The server did not admit the run."))
    .toBeVisible({ timeout: 30_000 });
  const startExpired = await startRunWithApproval(
    api,
    expiring.id,
    j.repositoryId,
    approved.id,
  );
  expect(startExpired.status).toBe(409);
  expect(startExpired.body).toMatchObject({
    code: "STATE_CONFLICT",
    reason: "approval_unavailable",
  });
  expect(await runsOf(api, expiring.id), "zero runs").toHaveLength(0);
  // The sweep touches open approvals only: give it two cron ticks, then the
  // stored status must still be the one the decision wrote.
  await page.waitForTimeout(130_000);
  const storedAfterSweeps = await storedStatus(approved.id);
  expect(storedAfterSweeps, "the sweep writes nothing for an approved approval")
    .toBe("answered");
  mechanisms.approvedApproval = {
    approvalId: approved.id,
    mechanism:
      "operator step 3 moved expires_at into the past; the API and UI read it through as expired",
    readThroughStatus: approvedReadThrough.status,
    storedStatus: storedAfterSweeps,
    startRefusedStatus: startExpired.status,
    startRefusedReason: startExpired.body.reason,
  };
  await shot(shots(), page, "P10-approved-approval-expired-desktop");

  // Question expiry without SQL happens only when the coordinator set a short
  // TTL of at least 60 s; record which mechanism produced what.
  const questions = (await api.get<{
    items: {
      id: string;
      status: string;
      expiresAt: string | null;
      createdAt: string;
      kind: string;
    }[];
  }>(`/v1/questions?taskId=${j.taskId}&limit=100`)).items;
  mechanisms.questions = questions.map((question) => ({
    id: question.id,
    kind: question.kind,
    status: question.status,
    ttlSeconds: question.expiresAt
      ? Math.round(
        (Date.parse(question.expiresAt) - Date.parse(question.createdAt)) /
          1000,
      )
      : null,
    mechanism: question.status === "expired"
      ? "coordinator-set expiresInSeconds, no SQL"
      : "not expired",
  }));

  // Wrong or used approvals never start the main task again.
  const staleStart = await startRunWithApproval(
    api,
    j.taskId,
    j.repositoryId,
    j.revision1ApprovalId,
  );
  expect(staleStart.status, "revision 1's approval is the wrong revision")
    .toBe(409);
  expect(staleStart.body).toMatchObject({ code: "STATE_CONFLICT" });
  const usedStart = await startRunWithApproval(
    api,
    j.taskId,
    j.repositoryId,
    j.revision2ApprovalId,
  );
  expect(usedStart.status, "revision 2's approval was consumed once").toBe(409);
  expect(await runsOf(api, j.taskId), "duplicate approve, one run")
    .toHaveLength(1);
  // On tasks that have no run at all: an older revision's approval, and an
  // approval that belongs to another task, both start nothing.
  const olderRevision = await startRunWithApproval(
    api,
    expiring.id,
    j.repositoryId,
    pending.id,
  );
  expect(olderRevision.status, "an older revision's approval").toBe(409);
  const otherTask = await startRunWithApproval(
    api,
    rejected.id,
    j.repositoryId,
    j.ids.approvalRevision3Id,
  );
  expect(otherTask.status, "another task's approval").toBe(409);
  expect(await runsOf(api, expiring.id), "still zero runs").toHaveLength(0);
  expect(await runsOf(api, rejected.id), "still zero runs").toHaveLength(0);
  mechanisms.wrongRevision = {
    staleApprovalId: j.revision1ApprovalId,
    status: staleStart.status,
    reason: staleStart.body.reason,
    olderRevisionOnRunlessTask: {
      status: olderRevision.status,
      reason: olderRevision.body.reason,
    },
    anotherTasksApproval: {
      status: otherTask.status,
      reason: otherTask.body.reason,
    },
  };
  mechanisms.consumedApproval = {
    approvalId: j.revision2ApprovalId,
    status: usedStart.status,
    reason: usedStart.body.reason,
  };

  // The journey ends with the stack answering and the worker unit active: the
  // orchestrator reads the unit's environment next and refuses a dead unit.
  await waitReady(serverOrigin(), 60_000);
  expect(j.workerDown, "the worker was started again after every kill").toBe(
    false,
  );
  await untilWorker(api, j.hostId, "online/ready");
  evidenceFile("evidence-P10.json", {
    mechanisms,
    approveDecisionResponsesOnMainTask: j.decisionStatuses,
    spend: j.spend,
  });
  evidenceFile("evidence-journey.json", {
    ids: j.ids,
    spend: j.spend,
    finalSettledUsd: await spendSettledUsd(),
  });
  await context.close();
});
