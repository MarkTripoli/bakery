import {
  assert,
  assertEquals,
  assertExists,
  assertNotEquals,
} from "@std/assert";
import { SecretIdentityToolResultSchema } from "../../packages/contracts/src/secret-identity.ts";
import { openSecretsFixture } from "../helpers/secrets.ts";
import {
  registeredWorker,
  seedEligibleJob,
  type WorkerFixture,
  workerRequest,
} from "../helpers/worker-execution.ts";
import type { WorkerAssignment } from "../helpers/worker-execution/scenarios.ts";

const SAFE_PROVIDER_BODY = '{"id":12345,"login":"fixture-user"}';
const SAFE_PROVIDER_BYTES = [...new TextEncoder().encode(SAFE_PROVIDER_BODY)];
const CHILD_READY_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 20_000;
const BARRIER_TIMEOUT_MS = 5_000;
const MAX_CHILD_OUTPUT_BYTES = 65_536;
const TELEMETRY_PATH = "/__fixture/credential-recovery-telemetry";
const SHUTDOWN_PATH = "/__fixture/credential-recovery-shutdown";
const EXACT_CHILD_ENVIRONMENT_KEYS = [
  "FIXTURE_APP_DATABASE_URL",
  "FIXTURE_BETTER_AUTH_SECRET",
  "FIXTURE_PROVIDER_URL",
  "FIXTURE_PUBLIC_BASE_URL",
  "FIXTURE_SECRETS_KEY_FILE",
  "FIXTURE_SECRETS_KEY_ID",
] as const;

type RecoveryFixture = Awaited<ReturnType<typeof openSecretsFixture>>;
type RegisteredWorker = Awaited<ReturnType<typeof registeredWorker>>;
type OperationRow = {
  status: string;
  io_attempt: number;
  request_digest: string | null;
  safe_result: unknown;
  safe_code: string | null;
  result_digest: string | null;
  completed_at: string | null;
};
type SafeTelemetry = {
  targetAccepted: boolean;
  responseStatus: number | null;
  responseContentType: string | null;
  responseBodyBytes: number[];
  responseEof: boolean;
  upstreamCancelled: boolean;
  signalAborted: boolean;
};
type Invocation = {
  controller: AbortController;
  result: Promise<
    | { kind: "response"; response: Response; body: string }
    | { kind: "error"; error: unknown }
  >;
};
type IdentityRequest = {
  operationId: string;
  path: string;
  body: string;
  headers: Record<string, string>;
};
type ProviderCase = {
  credential: string;
  receipt: Promise<void>;
  release(): void;
  acceptedCount(): number;
  violations: string[];
};
type ChildServer = {
  process: Deno.ChildProcess;
  origin: string;
  output(): string;
  waitForOutput(): Promise<void>;
  stopped: boolean;
};

function asWorkerFixture(fixture: RecoveryFixture): WorkerFixture {
  return {
    app: fixture.fixture.app,
    pgDatabase: fixture.fixture.pgDatabase,
    runtimePgDatabase: fixture.fixture.pgDatabase,
    config: fixture.fixture.config,
    email: "fixture-owned-by-secrets-helper@example.test",
    organizationId: fixture.organizationId,
    principalId: fixture.principalId,
    adminCookie: fixture.adminCookie,
    ownsAuthIdentity: false,
    workerHostIds: [],
    close: () => Promise.resolve(),
    releaseFixture: () => {},
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  code: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(code)), milliseconds);
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function providerCanary(): string {
  return `credential-recovery-${crypto.randomUUID()}`;
}

function canaryForms(canary: string): readonly string[] {
  const bytes = new TextEncoder().encode(canary);
  return [
    ...new Set([
      canary,
      encodeURIComponent(canary),
      btoa(canary),
      [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    ]),
  ];
}

function assertNoCanary(canary: string, surfaces: readonly unknown[]): void {
  const encoded = surfaces.map((surface) => JSON.stringify(surface)).join("\n");
  for (const [index, form] of canaryForms(canary).entries()) {
    if (encoded.includes(form)) {
      throw new Error(`CREDENTIAL_CANARY_LEAK:${index}`);
    }
  }
}

function createControlledProvider() {
  const cases = new Map<string, ProviderCase>();
  const globalViolations: string[] = [];
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0 },
    async (request) => {
      if (new URL(request.url).pathname !== "/controlled-github-user") {
        return new Response(null, { status: 404 });
      }
      const authorization = request.headers.get("authorization");
      const providerCase = authorization === null
        ? undefined
        : cases.get(authorization);
      if (!providerCase) {
        const authorizationClass = authorization === null
          ? "missing"
          : authorization.startsWith("Bearer ")
          ? "unknown-bearer"
          : "malformed";
        globalViolations.push(
          `${request.method}:${
            new URL(request.url).pathname
          }:${authorizationClass}`,
        );
        return new Response(null, { status: 400 });
      }
      const violations = providerCase.violations;
      if (request.method !== "GET") violations.push("method");
      if (request.body !== null) violations.push("body");
      if (new URL(request.url).pathname !== "/controlled-github-user") {
        violations.push("path");
      }
      if (authorization !== `Bearer ${providerCase.credential}`) {
        violations.push("authorization");
      }
      if (request.headers.get("accept") !== "application/vnd.github+json") {
        violations.push("accept");
      }
      if (
        request.headers.get("x-github-api-version") !== "2022-11-28"
      ) {
        violations.push("api-version");
      }
      if (violations.length > 0) return new Response(null, { status: 400 });
      (providerCase as ProviderCase & { accept(): void }).accept();
      await (providerCase as ProviderCase & { released: Promise<void> })
        .released;
      return new Response(SAFE_PROVIDER_BODY, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  );
  const port = (server.addr as Deno.NetAddr).port;
  return {
    url: `http://127.0.0.1:${port}/controlled-github-user`,
    addCase(credential: string): ProviderCase {
      const receipt = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let accepted = 0;
      const providerCase: ProviderCase & {
        accept(): void;
        released: Promise<void>;
      } = {
        credential,
        receipt: receipt.promise,
        release: release.resolve,
        acceptedCount: () => accepted,
        violations: [],
        accept: () => {
          accepted++;
          receipt.resolve();
        },
        released: release.promise,
      };
      cases.set(`Bearer ${credential}`, providerCase);
      return providerCase;
    },
    assertValid() {
      assertEquals(globalViolations, []);
      for (const providerCase of cases.values()) {
        assertEquals(providerCase.violations, []);
      }
    },
    async close() {
      for (const providerCase of cases.values()) providerCase.release();
      await server.shutdown();
    },
  };
}

async function createIdentityRequest(
  fixture: RecoveryFixture,
  workerFixture: WorkerFixture,
  worker: RegisteredWorker,
  credential: string,
): Promise<IdentityRequest> {
  const placeholder = crypto.randomUUID();
  const job = await seedEligibleJob(
    workerFixture.pgDatabase,
    workerFixture.organizationId,
    workerFixture.principalId,
    {
      action: "secret.identity.read",
      input: { secretRef: placeholder },
    },
  );
  const created = await fixture.request("/v1/secrets", {
    applicationId: job.applicationId,
    name: `Recovery fixture ${job.jobId.slice(0, 8)}`,
    provider: "github",
    value: credential,
    allowedPrincipalIds: [workerFixture.principalId],
    allowedActions: ["identity.read"],
  }, crypto.randomUUID());
  assertEquals(created.status, 201, await created.clone().text());
  const secret = await created.json() as { id: string };
  await workerFixture.pgDatabase.query(
    `update bakery.jobs
        set input = jsonb_set(input, '{secretRef}', to_jsonb($2::text), true)
      where organization_id = $1 and id = $3`,
    [workerFixture.organizationId, secret.id, job.jobId],
  );
  await workerFixture.pgDatabase.query(
    `update bakery.workflow_runs
        set snapshot = jsonb_set(
          snapshot,
          '{workflow,normalizedSpec,steps,0,with,secretRef}',
          to_jsonb($2::text),
          true
        )
      where organization_id = $1 and id = $3`,
    [workerFixture.organizationId, secret.id, job.runId],
  );
  const claimKey = crypto.randomUUID();
  const claimResponse = await workerRequest(
    workerFixture,
    worker.credential,
    "/v1/worker/claims",
    {
      claimKey,
      workerHostId: worker.registration.workerHostId,
      capabilities: ["secret.identity"],
      supportedActions: ["secret.identity.read"],
    },
    { idempotencyKey: claimKey },
  );
  assertEquals(claimResponse.status, 200, await claimResponse.clone().text());
  const assignment = await claimResponse.json() as WorkerAssignment;
  assertEquals(assignment.jobId, job.jobId);
  assertEquals(assignment.action, "secret.identity.read");
  assert(assignment.sealedCredentialOperation !== null);
  const sealed = assignment.sealedCredentialOperation as {
    preparedOperationId: string;
  };
  const body = JSON.stringify({
    preparedOperationId: sealed.preparedOperationId,
  });
  return {
    operationId: sealed.preparedOperationId,
    path: `/v1/worker/attempts/${assignment.attemptId}/tools/secrets`,
    body,
    headers: {
      authorization: `Bearer ${worker.credential}`,
      "content-type": "application/json",
      "Idempotency-Key": sealed.preparedOperationId,
      "X-Worker-Session-Id": worker.registration.workerSessionId,
      "X-Worker-Session-Generation": worker.registration
        .workerSessionGeneration,
      "X-Worker-Lease-Token": assignment.leaseToken,
      "X-Worker-Fence": assignment.fence,
      "X-Bakery-Worker-Protocol-Version": "2",
    },
  };
}

function appendBounded(current: string, next: string): string {
  const combined = current + next;
  return combined.length <= MAX_CHILD_OUTPUT_BYTES
    ? combined
    : combined.slice(combined.length - MAX_CHILD_OUTPUT_BYTES);
}

async function startChild(
  fixture: RecoveryFixture,
  providerUrl: string,
  workerCredential: string,
  canary: string,
): Promise<ChildServer> {
  const repoRoot = Deno.cwd();
  const childEntrypoint =
    `${repoRoot}/tests/helpers/credential-recovery-server.child.ts`;
  const appDatabaseAuthority = new URL(fixture.appDatabaseUrl).host;
  const providerAuthority = new URL(providerUrl).host;
  const args = [
    "run",
    "--cached-only",
    "--frozen",
    "--no-prompt",
    `--config=${repoRoot}/deno.json`,
    `--lock=${repoRoot}/deno.lock`,
    "--allow-env=FIXTURE_APP_DATABASE_URL,FIXTURE_BETTER_AUTH_SECRET,FIXTURE_SECRETS_KEY_FILE,FIXTURE_SECRETS_KEY_ID,FIXTURE_PROVIDER_URL,FIXTURE_PUBLIC_BASE_URL",
    `--allow-read=${fixture.key.file}`,
    `--allow-net=${appDatabaseAuthority},${providerAuthority},127.0.0.1:0`,
    childEntrypoint,
  ];
  const environment = {
    FIXTURE_APP_DATABASE_URL: fixture.appDatabaseUrl,
    FIXTURE_BETTER_AUTH_SECRET: fixture.fixture.config.auth!.secret,
    FIXTURE_SECRETS_KEY_FILE: fixture.key.file,
    FIXTURE_SECRETS_KEY_ID: fixture.key.keyId,
    FIXTURE_PROVIDER_URL: providerUrl,
    FIXTURE_PUBLIC_BASE_URL: fixture.fixture.config.publicBaseUrl,
  };
  assertEquals(Object.keys(environment).sort(), [
    ...EXACT_CHILD_ENVIRONMENT_KEYS,
  ]);
  assertEquals(args.slice(0, 6), [
    "run",
    "--cached-only",
    "--frozen",
    "--no-prompt",
    `--config=${repoRoot}/deno.json`,
    `--lock=${repoRoot}/deno.lock`,
  ]);
  const launchSurface = JSON.stringify({ args, environment });
  assert(!launchSurface.includes(canary));
  assert(!launchSurface.includes(workerCredential));

  const process = new Deno.Command(Deno.execPath(), {
    args,
    cwd: repoRoot,
    clearEnv: true,
    env: environment,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const ready = Promise.withResolvers<number>();
  let stdout = "";
  let stderr = "";
  let pendingLine = "";
  const stdoutTask = (async () => {
    const reader = process.stdout.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        const text = decoder.decode(result.value, { stream: true });
        stdout = appendBounded(stdout, text);
        pendingLine += text;
        while (pendingLine.includes("\n")) {
          const newline = pendingLine.indexOf("\n");
          const line = pendingLine.slice(0, newline);
          pendingLine = pendingLine.slice(newline + 1);
          try {
            const event = JSON.parse(line) as { event?: string; port?: number };
            if (
              event.event === "CREDENTIAL_RECOVERY_SERVER_READY" &&
              Number.isInteger(event.port)
            ) ready.resolve(event.port!);
          } catch {
            // Non-readiness output remains captured and bounded for leakage checks.
          }
        }
      }
      stdout = appendBounded(stdout, decoder.decode());
    } finally {
      reader.releaseLock();
    }
  })();
  const stderrTask = (async () => {
    const reader = process.stderr.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        stderr = appendBounded(
          stderr,
          decoder.decode(result.value, { stream: true }),
        );
      }
      stderr = appendBounded(stderr, decoder.decode());
    } finally {
      reader.releaseLock();
    }
  })();
  try {
    const port = await withTimeout(
      Promise.race([
        ready.promise,
        process.status.then((status) => {
          throw new Error(`CHILD_EXITED_BEFORE_READY:${status.code}`);
        }),
      ]),
      CHILD_READY_TIMEOUT_MS,
      "CHILD_READINESS_TIMEOUT",
    );
    return {
      process,
      origin: `http://127.0.0.1:${port}`,
      output: () => `${stdout}\n${stderr}`,
      waitForOutput: () => Promise.all([stdoutTask, stderrTask]).then(() => {}),
      stopped: false,
    };
  } catch (error) {
    try {
      process.kill("SIGKILL");
    } catch {
      // A startup failure may have already reaped the child.
    }
    await process.status.catch(() => undefined);
    await Promise.all([stdoutTask, stderrTask]);
    const deniedEnvironment = stderr.match(
      /Requires env access to ["']([A-Z0-9_]+)["']/,
    )?.[1];
    const startupReason = stderr.includes("Requires net access")
      ? "net-permission"
      : stderr.includes("Requires read access")
      ? "read-permission"
      : deniedEnvironment
      ? `env-permission-${deniedEnvironment}`
      : stderr.includes("Requires sys access")
      ? "sys-permission"
      : stderr.includes("Could not find") || stderr.includes("Module not found")
      ? "dependency"
      : stderr.includes("FIXTURE_ENV_REQUIRED")
      ? "fixture-environment"
      : stderr.includes("AUTH_CONFIGURATION_INVALID")
      ? "auth-configuration"
      : stderr.includes("Address already in use")
      ? "address-in-use"
      : stderr.includes("ReferenceError")
      ? "reference-error"
      : stderr.includes("TypeError")
      ? "type-error"
      : stderr.includes("Uncaught")
      ? "uncaught"
      : "unclassified";
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}:${startupReason}`);
  }
}

function invoke(child: ChildServer, request: IdentityRequest): Invocation {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("IDENTITY_REQUEST_TIMEOUT")),
    REQUEST_TIMEOUT_MS,
  );
  const result = fetch(`${child.origin}${request.path}`, {
    method: "POST",
    headers: request.headers,
    body: request.body,
    signal: controller.signal,
  }).then(async (response) => ({
    kind: "response" as const,
    response,
    body: await response.text(),
  }), (error) => ({ kind: "error" as const, error })).finally(() =>
    clearTimeout(timeout)
  );
  return { controller, result };
}

async function invokeCompleted(
  child: ChildServer,
  request: IdentityRequest,
): Promise<{ response: Response; body: string }> {
  const invocation = invoke(child, request);
  const result = await withTimeout(
    invocation.result,
    REQUEST_TIMEOUT_MS,
    "IDENTITY_REQUEST_WAIT_TIMEOUT",
  );
  if (result.kind === "error") throw result.error;
  return result;
}

async function killChild(child: ChildServer): Promise<void> {
  if (child.stopped) return;
  child.process.kill("SIGKILL");
  await withTimeout(
    child.process.status,
    BARRIER_TIMEOUT_MS,
    "CHILD_EXIT_TIMEOUT",
  );
  child.stopped = true;
  await withTimeout(
    child.waitForOutput(),
    BARRIER_TIMEOUT_MS,
    "CHILD_OUTPUT_CLOSE_TIMEOUT",
  );
}

async function stopChild(child: ChildServer): Promise<void> {
  if (child.stopped) return;
  try {
    await fetch(`${child.origin}${SHUTDOWN_PATH}`, {
      method: "POST",
      signal: AbortSignal.timeout(BARRIER_TIMEOUT_MS),
    });
    await withTimeout(
      child.process.status,
      BARRIER_TIMEOUT_MS,
      "CHILD_GRACEFUL_EXIT_TIMEOUT",
    );
  } catch {
    child.process.kill("SIGKILL");
    await withTimeout(
      child.process.status,
      BARRIER_TIMEOUT_MS,
      "CHILD_FORCE_EXIT_TIMEOUT",
    );
  }
  child.stopped = true;
  await withTimeout(
    child.waitForOutput(),
    BARRIER_TIMEOUT_MS,
    "CHILD_OUTPUT_CLOSE_TIMEOUT",
  );
}

async function readTelemetry(child: ChildServer): Promise<SafeTelemetry> {
  const response = await fetch(`${child.origin}${TELEMETRY_PATH}`, {
    signal: AbortSignal.timeout(BARRIER_TIMEOUT_MS),
  });
  assertEquals(response.status, 200);
  return await response.json() as SafeTelemetry;
}

async function readOperation(
  fixture: RecoveryFixture,
  operationId: string,
): Promise<OperationRow> {
  const result = await fixture.adminPgDatabase.query<OperationRow>(
    `select status, io_attempt, request_digest, safe_result, safe_code,
            result_digest, completed_at::text
       from bakery.prepared_operations
      where id = $1`,
    [operationId],
  );
  assertExists(result.rows[0]);
  return result.rows[0];
}

async function waitForInFlight(
  fixture: RecoveryFixture,
  operationId: string,
): Promise<OperationRow> {
  const deadline = performance.now() + BARRIER_TIMEOUT_MS;
  while (performance.now() < deadline) {
    const row = await readOperation(fixture, operationId);
    if (
      row.status === "in_flight" && row.io_attempt === 1 &&
      row.request_digest !== null
    ) return row;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("IN_FLIGHT_ROW_NOT_OBSERVED");
}

async function lockOperation(
  fixture: RecoveryFixture,
  operationId: string,
) {
  const client = await fixture.fixture.pgDatabase.connect();
  let released = false;
  try {
    await client.query("begin");
    const pidResult = await client.query<{ pid: number }>(
      "select pg_backend_pid() as pid",
    );
    await client.query(
      "select id from bakery.prepared_operations where id = $1 for update",
      [operationId],
    );
    const release = async () => {
      if (released) return;
      released = true;
      try {
        await client.query("rollback");
      } finally {
        client.release();
      }
    };
    return {
      client,
      pid: pidResult.rows[0].pid,
      release,
      isReleased: () => released,
    };
  } catch (error) {
    client.release(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

async function waitForBlockedCompletion(
  fixture: RecoveryFixture,
  blockingPid: number,
): Promise<number> {
  const deadline = performance.now() + BARRIER_TIMEOUT_MS;
  while (performance.now() < deadline) {
    // PostgreSQL's default 1 KiB activity text truncates this SELECT before its
    // trailing FOR UPDATE clause. Match the exact unique loadOperation prefix;
    // the blocker PID proves this invocation is waiting on our operation lock.
    const result = await fixture.adminPgDatabase.query<{ pid: number }>(
      `select activity.pid
         from pg_stat_activity activity
        where activity.datname = current_database()
          and activity.backend_type = 'client backend'
          and activity.state = 'active'
          and activity.wait_event_type = 'Lock'
          and $1 = any(pg_blocking_pids(activity.pid))
          and position('select operation.*' in lower(activity.query)) > 0
          and position(
            'run.requested_by as run_requested_by' in lower(activity.query)
          ) > 0
          and position(
            'run.repository_profile_digest as current_profile_digest'
            in lower(activity.query)
          ) > 0`,
      [blockingPid],
    );
    if (result.rows.length === 1) return result.rows[0].pid;
    if (result.rows.length > 1) throw new Error("MULTIPLE_COMPLETION_WAITERS");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("COMPLETION_LOCK_WAITER_NOT_OBSERVED");
}

async function waitForBackendExit(
  fixture: RecoveryFixture,
  backendPid: number,
): Promise<void> {
  const deadline = performance.now() + BARRIER_TIMEOUT_MS;
  while (performance.now() < deadline) {
    const result = await fixture.adminPgDatabase.query<{ present: boolean }>(
      `select exists(
         select 1 from pg_stat_activity
          where datname = current_database() and pid = $1
       ) as present`,
      [backendPid],
    );
    if (!result.rows[0]?.present) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("KILLED_CHILD_BACKEND_STILL_PRESENT");
}

function assertInFlightRow(row: OperationRow): void {
  assertEquals(row.status, "in_flight");
  assertEquals(row.io_attempt, 1);
  assert(row.request_digest !== null);
  assertEquals(row.safe_result, null);
  assertEquals(row.safe_code, null);
  assertEquals(row.result_digest, null);
  assertEquals(row.completed_at, null);
}

function assertSuccessTelemetry(telemetry: SafeTelemetry): void {
  assertEquals(telemetry, {
    targetAccepted: true,
    responseStatus: 200,
    responseContentType: "application/json",
    responseBodyBytes: SAFE_PROVIDER_BYTES,
    responseEof: true,
    upstreamCancelled: false,
    signalAborted: false,
  });
}

async function assertUncertainReplay(
  child: ChildServer,
  request: IdentityRequest,
): Promise<unknown[]> {
  const first = await invokeCompleted(child, request);
  assertEquals(first.response.status, 200);
  assertEquals(first.response.headers.get("idempotent-replayed"), "true");
  const firstBody = SecretIdentityToolResultSchema.parse(
    JSON.parse(first.body),
  );
  assertEquals(firstBody, {
    status: "uncertain",
    code: "OPERATION_RECOVERY_UNCERTAIN",
  });
  const stable = await invokeCompleted(child, request);
  assertEquals(stable.response.status, 200);
  assertEquals(stable.response.headers.get("idempotent-replayed"), "true");
  const stableBody = SecretIdentityToolResultSchema.parse(
    JSON.parse(stable.body),
  );
  assertEquals(stableBody, firstBody);
  return [first.body, stable.body];
}

Deno.test({
  name:
    "fixed secret identity recovery survives killed production-app processes without repeating provider I/O",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const fixture = await openSecretsFixture();
    const provider = createControlledProvider();
    const children: ChildServer[] = [];
    const invocations: Invocation[] = [];
    let heldLock: Awaited<ReturnType<typeof lockOperation>> | undefined;
    try {
      const workerFixture = asWorkerFixture(fixture);
      const worker = await registeredWorker(workerFixture, {
        capabilities: ["secret.identity"],
        slots: 3,
      });
      assertNotEquals(worker.registration.principalId, fixture.principalId);

      // Admission loss: receipt follows committed admission, while the provider
      // response and verifier remain live in the process that is killed.
      const admissionCanary = providerCanary();
      const admissionProvider = provider.addCase(admissionCanary);
      const admissionRequest = await createIdentityRequest(
        fixture,
        workerFixture,
        worker,
        admissionCanary,
      );
      const admissionChild = await startChild(
        fixture,
        provider.url,
        worker.credential,
        admissionCanary,
      );
      children.push(admissionChild);
      const admissionInvocation = invoke(admissionChild, admissionRequest);
      invocations.push(admissionInvocation);
      await withTimeout(
        admissionProvider.receipt,
        BARRIER_TIMEOUT_MS,
        "ADMISSION_PROVIDER_RECEIPT_TIMEOUT",
      );
      assertInFlightRow(
        await waitForInFlight(fixture, admissionRequest.operationId),
      );
      const admissionTelemetry = await readTelemetry(admissionChild);
      assertEquals(admissionTelemetry.targetAccepted, true);
      assertEquals(admissionTelemetry.responseStatus, null);
      assertEquals(admissionTelemetry.responseEof, false);
      assertEquals(admissionTelemetry.upstreamCancelled, false);
      assertEquals(admissionTelemetry.signalAborted, false);
      await killChild(admissionChild);
      const admissionInterrupted = await withTimeout(
        admissionInvocation.result,
        BARRIER_TIMEOUT_MS,
        "ADMISSION_REQUEST_DID_NOT_END",
      );
      assertEquals(admissionInterrupted.kind, "error");
      admissionProvider.release();
      const admissionReplayChild = await startChild(
        fixture,
        provider.url,
        worker.credential,
        admissionCanary,
      );
      children.push(admissionReplayChild);
      const admissionReplaySurfaces = await assertUncertainReplay(
        admissionReplayChild,
        admissionRequest,
      );
      assertEquals(admissionProvider.acceptedCount(), 1);
      provider.assertValid();
      const admissionTerminal = await readOperation(
        fixture,
        admissionRequest.operationId,
      );
      assertEquals(admissionTerminal.safe_result, {
        status: "uncertain",
        code: "OPERATION_RECOVERY_UNCERTAIN",
      });
      assertNoCanary(admissionCanary, [
        admissionTelemetry,
        admissionTerminal.safe_result,
        admissionReplaySurfaces,
        admissionChild.output(),
        admissionReplayChild.output(),
      ]);
      await stopChild(admissionReplayChild);

      // Completion loss: exact response bytes reach EOF and the verifier remains
      // un-aborted before the real completion transaction blocks on our row lock.
      const completionCanary = providerCanary();
      const completionProvider = provider.addCase(completionCanary);
      const completionRequest = await createIdentityRequest(
        fixture,
        workerFixture,
        worker,
        completionCanary,
      );
      const completionChild = await startChild(
        fixture,
        provider.url,
        worker.credential,
        completionCanary,
      );
      children.push(completionChild);
      const completionInvocation = invoke(completionChild, completionRequest);
      invocations.push(completionInvocation);
      await withTimeout(
        completionProvider.receipt,
        BARRIER_TIMEOUT_MS,
        "COMPLETION_PROVIDER_RECEIPT_TIMEOUT",
      );
      assertInFlightRow(
        await waitForInFlight(fixture, completionRequest.operationId),
      );
      heldLock = await lockOperation(fixture, completionRequest.operationId);
      completionProvider.release();
      const blockedBackendPid = await waitForBlockedCompletion(
        fixture,
        heldLock.pid,
      );
      const completionTelemetry = await readTelemetry(completionChild);
      assertSuccessTelemetry(completionTelemetry);
      await killChild(completionChild);
      const completionInterrupted = await withTimeout(
        completionInvocation.result,
        BARRIER_TIMEOUT_MS,
        "COMPLETION_REQUEST_DID_NOT_END",
      );
      assertEquals(completionInterrupted.kind, "error");
      const lockedRowResult = await heldLock.client.query<OperationRow>(
        `select status, io_attempt, request_digest, safe_result, safe_code,
                result_digest, completed_at::text
           from bakery.prepared_operations where id = $1`,
        [completionRequest.operationId],
      );
      assertExists(lockedRowResult.rows[0]);
      assertInFlightRow(lockedRowResult.rows[0]);
      await heldLock.release();
      heldLock = undefined;
      await waitForBackendExit(fixture, blockedBackendPid);
      const completionReplayChild = await startChild(
        fixture,
        provider.url,
        worker.credential,
        completionCanary,
      );
      children.push(completionReplayChild);
      const completionReplaySurfaces = await assertUncertainReplay(
        completionReplayChild,
        completionRequest,
      );
      assertEquals(completionProvider.acceptedCount(), 1);
      provider.assertValid();
      const completionTerminal = await readOperation(
        fixture,
        completionRequest.operationId,
      );
      assertEquals(completionTerminal.safe_result, {
        status: "uncertain",
        code: "OPERATION_RECOVERY_UNCERTAIN",
      });
      assertNoCanary(completionCanary, [
        completionTelemetry,
        completionTerminal.safe_result,
        completionReplaySurfaces,
        completionChild.output(),
        completionReplayChild.output(),
      ]);
      await stopChild(completionReplayChild);

      // Genuine completion: the first response and durable terminal row exist
      // before process loss; the replacement process replays without provider I/O.
      const completedCanary = providerCanary();
      const completedProvider = provider.addCase(completedCanary);
      const completedRequest = await createIdentityRequest(
        fixture,
        workerFixture,
        worker,
        completedCanary,
      );
      const completedChild = await startChild(
        fixture,
        provider.url,
        worker.credential,
        completedCanary,
      );
      children.push(completedChild);
      const completedInvocation = invoke(completedChild, completedRequest);
      invocations.push(completedInvocation);
      await withTimeout(
        completedProvider.receipt,
        BARRIER_TIMEOUT_MS,
        "COMPLETED_PROVIDER_RECEIPT_TIMEOUT",
      );
      completedProvider.release();
      const completedResult = await withTimeout(
        completedInvocation.result,
        REQUEST_TIMEOUT_MS,
        "COMPLETED_REQUEST_WAIT_TIMEOUT",
      );
      if (completedResult.kind === "error") throw completedResult.error;
      assertEquals(completedResult.response.status, 200);
      assertEquals(
        completedResult.response.headers.get("idempotent-replayed"),
        null,
      );
      const completedBody = SecretIdentityToolResultSchema.parse(
        JSON.parse(completedResult.body),
      );
      assertEquals(completedBody, {
        status: "completed",
        accountId: "12345",
        login: "fixture-user",
      });
      const completedTelemetry = await readTelemetry(completedChild);
      assertSuccessTelemetry(completedTelemetry);
      const completedRow = await readOperation(
        fixture,
        completedRequest.operationId,
      );
      assertEquals(completedRow.status, "completed");
      assertEquals(completedRow.io_attempt, 1);
      assert(completedRow.request_digest !== null);
      assertEquals(completedRow.safe_result, completedBody);
      assert(completedRow.result_digest !== null);
      assert(completedRow.completed_at !== null);
      await killChild(completedChild);
      const completedReplayChild = await startChild(
        fixture,
        provider.url,
        worker.credential,
        completedCanary,
      );
      children.push(completedReplayChild);
      const replayedCompleted = await invokeCompleted(
        completedReplayChild,
        completedRequest,
      );
      assertEquals(replayedCompleted.response.status, 200);
      assertEquals(
        replayedCompleted.response.headers.get("idempotent-replayed"),
        "true",
      );
      assertEquals(
        SecretIdentityToolResultSchema.parse(
          JSON.parse(replayedCompleted.body),
        ),
        completedBody,
      );
      assertEquals(completedProvider.acceptedCount(), 1);
      provider.assertValid();
      assertNoCanary(completedCanary, [
        completedResult.body,
        replayedCompleted.body,
        completedRow.safe_result,
        completedTelemetry,
        completedChild.output(),
        completedReplayChild.output(),
      ]);
      await stopChild(completedReplayChild);
    } finally {
      for (const invocation of invocations) invocation.controller.abort();
      await heldLock?.release().catch(() => undefined);
      await Promise.all(
        children.map((child) => stopChild(child).catch(() => undefined)),
      );
      await provider.close().catch(() => undefined);
      await fixture.cleanup();
    }
  },
});
