import { readReleasePresence } from "./native-worker-release-diagnostics.ts";
import type {
  JobAssignment,
  WorkerCommand,
} from "../../apps/worker/src/types.ts";
import {
  readWorkerLaunchPermissions,
  WORKER_RUNTIME_ENVIRONMENT_NAMES,
  workerRunExecutables,
} from "../../apps/worker/src/config.ts";
import {
  type CgroupLease,
  provisionDelegatedCgroupV2,
} from "../lib/cgroup-v2.ts";

const root = decodeURIComponent(new URL("../..", import.meta.url).pathname);
let lease!: CgroupLease;
let stateDir!: string;
let nativeStateDir!: string;
let tokenPath!: string;
let server!: Deno.HttpServer;
let worker!: Deno.ChildProcess;

let diagnosticAttemptId: string | undefined;
let smokePassed = false;
let cleanupFailure: unknown;
let cleanupFailed = false;
try {
  lease = await provisionDelegatedCgroupV2("bakery-native-smoke-");
  stateDir = await Deno.makeTempDir({
    prefix: "bakery-native-worker-",
  });
  nativeStateDir = await Deno.makeTempDir({
    prefix: "bakery-native-executor-",
  });
  tokenPath = await Deno.makeTempFile({ prefix: "bakery-native-token-" });
  await Deno.writeTextFile(tokenPath, "native-worker-smoke-token\n");
  await Deno.chmod(tokenPath, 0o600);
  const workerHostId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const assignment: JobAssignment = {
    jobId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    workerHostId,
    leaseToken: "x".repeat(43),
    fence: "1",
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    action: "quality.check",
    requirements: {},
    input: {
      repositoryId: crypto.randomUUID(),
      revision: "fixture",
      checks: ["source.integrity"],
    },
    currentCheckpoints: [],
    agentConfig: {},
    skillRefs: [],
    agentVersionId: null,
    billing: null,
    installationReservationId: null,
    leaseDurationSeconds: 45,
    serverTime: new Date().toISOString(),
    sealedCredentialOperation: null,
  };
  diagnosticAttemptId = assignment.attemptId;
  const terminationCleanupMarker =
    `"event":"termination_cleanup_confirmed","attemptId":"${assignment.attemptId}"`;

  type FixtureState = {
    readonly workerHostId: string;
    readonly principalId: string;
    credential: string | null;
    assignment: JobAssignment;
    sessionId: string | null;
    sessionGeneration: string;
    claimed: boolean;
    accepted: boolean;
    started: boolean;
    cancelCommandDelivered: boolean;
    cancelNotBefore: number;
    cancelCommandId: string | null;
    commandAcknowledged: boolean;
    retirementHeartbeatObserved: boolean;
    cleanupRequest: Record<string, unknown> | null;
    cleanup: Record<string, unknown> | null;
    readonly outputSessionId: string;
    readonly organizationId: string;
    readonly applicationId: string;
    outputOpened: boolean;
    outputClosed: boolean;
    outputHighwater: string;
  };

  const fixture: FixtureState = {
    workerHostId,
    principalId,
    credential: null,
    assignment,
    sessionId: null,
    sessionGeneration: "0",
    claimed: false,
    accepted: false,
    started: false,
    cancelCommandDelivered: false,
    commandAcknowledged: false,
    retirementHeartbeatObserved: false,
    cancelNotBefore: 0,
    cancelCommandId: null,
    cleanupRequest: null,
    cleanup: null,
    outputSessionId: crypto.randomUUID(),
    organizationId: crypto.randomUUID(),
    applicationId: crypto.randomUUID(),
    outputOpened: false,
    outputClosed: false,
    outputHighwater: "0",
  };

  const protocolResponse = (body: unknown, status = 200): Response => {
    const response = Response.json(body, {
      status,
      headers: { "X-Bakery-Worker-Protocol-Version": "2" },
    });
    return response;
  };

  const requireCredential = (request: Request): Response | null => {
    if (
      fixture.credential === null ||
      request.headers.get("Authorization") !== `Bearer ${fixture.credential}`
    ) {
      return protocolResponse({ code: "AUTH_FORBIDDEN" }, 401);
    }
    return null;
  };

  const requireClaimIdentity = (
    body: Record<string, unknown>,
    requireLease: boolean,
  ): Response | null => {
    if (!fixture.claimed) {
      return protocolResponse({ code: "NATIVE_FIXTURE_CLAIM_REQUIRED" }, 409);
    }
    if (
      body.workerSessionId !== fixture.sessionId ||
      body.workerSessionGeneration !== fixture.sessionGeneration
    ) {
      return protocolResponse({ code: "LEASE_FENCED" }, 409);
    }
    if (
      requireLease &&
      (body.leaseToken !== fixture.assignment.leaseToken ||
        body.fence !== fixture.assignment.fence)
    ) {
      return protocolResponse({ code: "LEASE_FENCED" }, 409);
    }
    return null;
  };
  const ackResponse = (
    request: Record<string, unknown>,
    idempotencyKey: string | null,
  ): Response => {
    const events = Array.isArray(request.events) ? request.events : [];
    const event = events.at(-1);
    const eventRecord = event && typeof event === "object" &&
        !Array.isArray(event)
      ? event as Record<string, unknown>
      : {};
    return protocolResponse({
      eventId: idempotencyKey ?? (
        typeof eventRecord.eventId === "string"
          ? eventRecord.eventId
          : crypto.randomUUID()
      ),
      status: "applied",
      lastEventSeq: typeof eventRecord.localSeq === "string"
        ? eventRecord.localSeq
        : typeof request.localSeq === "string"
        ? request.localSeq
        : "1",
    });
  };

  const requestJson = async (
    request: Request,
  ): Promise<Record<string, unknown>> => {
    const value: unknown = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("NATIVE_FIXTURE_REQUEST_INVALID");
    }
    return value as Record<string, unknown>;
  };

  const cancellationCommand = (): WorkerCommand => {
    if (!fixture.sessionId) throw new Error("NATIVE_FIXTURE_SESSION_MISSING");
    const command = {
      id: crypto.randomUUID(),
      attemptId: fixture.assignment.attemptId,
      messageId: null,
      commandType: "cancel",
      payload: {
        controlAction: "cancel",
        controlScope: "attempt",
        reason: "native fixture cancellation",
        workerHostId: fixture.workerHostId,
        workerSessionId: fixture.sessionId,
        workerSessionGeneration: fixture.sessionGeneration,
        fence: fixture.assignment.fence,
      },
      status: "pending",
      createdAt: new Date().toISOString(),
    } as WorkerCommand;
    fixture.cancelCommandId = command.id;
    return command;
  };

  const fixtureHandler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method !== "POST") return protocolResponse({}, 405);
    if (url.pathname === "/v1/worker/registration") {
      const body = await requestJson(request);
      if (
        body.enrollmentToken !== "native-worker-smoke-token" ||
        typeof body.workerCredential !== "string" ||
        body.workerCredential.length < 43
      ) {
        return protocolResponse({ code: "AUTH_FORBIDDEN" }, 401);
      }
      if (
        fixture.credential !== null &&
        fixture.credential !== body.workerCredential
      ) {
        return protocolResponse({ code: "AUTH_FORBIDDEN" }, 401);
      }
      fixture.credential = body.workerCredential;
      return protocolResponse({
        workerHostId: fixture.workerHostId,
        principalId: fixture.principalId,
        status: "registered",
        registrationGeneration: 1,
      });
    }
    const authenticationFailure = requireCredential(request);
    if (authenticationFailure) return authenticationFailure;
    if (url.pathname === "/v1/worker/heartbeat") {
      const body = await requestJson(request);
      if (
        body.workerHostId !== fixture.workerHostId ||
        typeof body.workerSessionId !== "string"
      ) {
        return protocolResponse({ code: "AUTH_FORBIDDEN" }, 403);
      }
      const suppliedGeneration =
        typeof body.workerSessionGeneration === "string"
          ? body.workerSessionGeneration
          : "0";
      if (fixture.sessionId === null) {
        fixture.sessionId = body.workerSessionId;
      }
      if (
        body.workerSessionId !== fixture.sessionId ||
        (fixture.sessionGeneration !== "0" &&
          suppliedGeneration !== fixture.sessionGeneration)
      ) {
        return protocolResponse({ code: "LEASE_FENCED" }, 409);
      }
      fixture.sessionGeneration = "1";
      const ackCommandIds = Array.isArray(body.ackCommandIds)
        ? body.ackCommandIds
        : [];
      if (
        fixture.cancelCommandId !== null &&
        ackCommandIds.includes(fixture.cancelCommandId)
      ) {
        fixture.commandAcknowledged = true;
        if (fixture.cleanupRequest) fixture.cleanup = fixture.cleanupRequest;
      }
      if (
        fixture.cleanup &&
        fixture.commandAcknowledged &&
        Array.isArray(body.activeAttemptIds) &&
        !body.activeAttemptIds.includes(fixture.assignment.attemptId)
      ) {
        fixture.retirementHeartbeatObserved = true;
      }
      const pendingCommands: WorkerCommand[] = [];
      if (
        fixture.started &&
        Date.now() >= fixture.cancelNotBefore &&
        !fixture.cancelCommandDelivered
      ) {
        pendingCommands.push(cancellationCommand());
        fixture.cancelCommandDelivered = true;
      }
      const commandAcks = fixture.commandAcknowledged && fixture.cancelCommandId
        ? [{
          commandId: fixture.cancelCommandId,
          status: "acknowledged",
          acknowledgedAt: new Date().toISOString(),
        }]
        : [];
      const active = fixture.claimed && !fixture.cleanupRequest
        ? [fixture.assignment.attemptId]
        : [];
      return protocolResponse({
        workerHostId: fixture.workerHostId,
        status: "accepted",
        receivedAt: new Date().toISOString(),
        pendingCommands,
        commandAcks,
        reconciledAttemptIds: active,
        workerSessionId: fixture.sessionId,
        workerSessionGeneration: fixture.sessionGeneration,
        inventoryRevision: 1,
        serverTime: new Date().toISOString(),
      });
    }
    if (url.pathname === "/v1/worker/claims") {
      const body = await requestJson(request);
      if (
        body.workerHostId !== fixture.workerHostId ||
        body.workerSessionId !== fixture.sessionId ||
        body.workerSessionGeneration !== fixture.sessionGeneration
      ) {
        return protocolResponse({ code: "LEASE_FENCED" }, 409);
      }
      if (!fixture.claimed) {
        fixture.claimed = true;
        fixture.assignment = {
          ...fixture.assignment,
          workerSessionId: fixture.sessionId,
          workerSessionGeneration: fixture.sessionGeneration,
          serverTime: new Date().toISOString(),
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        } as JobAssignment;
        return protocolResponse(fixture.assignment);
      }
      return new Response(null, {
        status: 204,
        headers: { "X-Bakery-Worker-Protocol-Version": "2" },
      });
    }
    const outputAttempt =
      /^\/v1\/worker\/attempts\/([^/]+)\/output-bindings(\/close)?$/.exec(
        url.pathname,
      );
    if (outputAttempt) {
      if (outputAttempt[1] !== fixture.assignment.attemptId) {
        return protocolResponse({ code: "RESOURCE_NOT_FOUND" }, 404);
      }
      const body = await requestJson(request);
      const identityFailure = requireClaimIdentity(body, true);
      if (identityFailure) return identityFailure;
      const operation = outputAttempt[2] ? "close" : "open";
      if (operation === "open") {
        fixture.outputOpened = true;
      } else {
        if (
          !fixture.outputOpened ||
          body.sessionId !== fixture.outputSessionId ||
          body.writerGeneration !== "1"
        ) return protocolResponse({ code: "STATE_CONFLICT" }, 409);
        fixture.outputClosed = true;
      }
      const highwater = BigInt(fixture.outputHighwater);
      return protocolResponse({
        sessionId: fixture.outputSessionId,
        organizationId: fixture.organizationId,
        applicationId: fixture.applicationId,
        jobId: fixture.assignment.jobId,
        taskId: null,
        runStepId: null,
        conversationId: null,
        logicalActor: "quality.check:native",
        attemptId: fixture.assignment.attemptId,
        workerHostId: fixture.workerHostId,
        workerSessionId: fixture.sessionId,
        workerSessionGeneration: fixture.sessionGeneration,
        fence: fixture.assignment.fence,
        writerGeneration: "1",
        highwater: highwater.toString(),
        nextSequence: (highwater + 1n).toString(),
        closed: fixture.outputClosed,
        capture: operation === "close" ? body.capture : "capturing",
        reason: operation === "close" ? body.reason : null,
        archive: "pending",
      });
    }
    const attempt = /^\/v1\/worker\/attempts\/([^/]+)\/([^/]+)$/.exec(
      url.pathname,
    );
    if (!attempt || attempt[1] !== fixture.assignment.attemptId) {
      return protocolResponse({ code: "RESOURCE_NOT_FOUND" }, 404);
    }
    const operation = attempt[2];
    const body = await requestJson(request);
    if (
      operation === "events" ||
      operation === "lease-renewals" ||
      operation === "result"
    ) {
      const identityFailure = requireClaimIdentity(body, true);
      if (identityFailure) return identityFailure;
    }
    if (operation === "events") {
      const events = Array.isArray(body.events) ? body.events : [];
      for (const candidate of events) {
        if (
          !candidate || typeof candidate !== "object" ||
          Array.isArray(candidate) || !("eventType" in candidate)
        ) continue;
        if (candidate.eventType === "job.accepted") fixture.accepted = true;
        if (candidate.eventType === "job.started") {
          fixture.started = true;
          fixture.cancelNotBefore = Date.now() + 500;
        }
        if (
          candidate.eventType === "job.output" &&
          "payload" in candidate && candidate.payload &&
          typeof candidate.payload === "object" &&
          !Array.isArray(candidate.payload) &&
          "sequence" in candidate.payload &&
          typeof candidate.payload.sequence === "string"
        ) fixture.outputHighwater = candidate.payload.sequence;
      }
      return ackResponse(body, request.headers.get("Idempotency-Key"));
    }
    if (operation === "lease-renewals") {
      return protocolResponse({
        attemptId: fixture.assignment.attemptId,
        fence: fixture.assignment.fence,
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        status: "active",
        leaseDurationSeconds: 45,
        serverTime: new Date().toISOString(),
      });
    }
    if (operation === "result") {
      return ackResponse(body, request.headers.get("Idempotency-Key"));
    }
    if (operation === "cleanup") {
      const identityFailure = requireClaimIdentity(body, false);
      if (identityFailure) return identityFailure;
      if (
        body.fence !== fixture.assignment.fence ||
        body.observedByWorkerSessionId !== fixture.sessionId ||
        body.observedByWorkerSessionGeneration !==
          fixture.sessionGeneration ||
        typeof body.exitedAt !== "string"
      ) {
        return protocolResponse({ code: "LEASE_FENCED" }, 409);
      }
      // Process-exit cleanup can arrive after the heartbeat that acknowledges
      // the cancellation command.
      fixture.cleanupRequest = body;
      if (fixture.commandAcknowledged) fixture.cleanup = body;
      const observedByWorkerSessionId = body.observedByWorkerSessionId;
      const observedByWorkerSessionGeneration =
        body.observedByWorkerSessionGeneration;
      return protocolResponse({
        attemptId: fixture.assignment.attemptId,
        status: "canceled",
        cancellation: {
          processExited: true,
          cleanupStatus: "complete",
          terminationStatus: "confirmed",
          exitedAt: body.exitedAt,
          cleanupObserver: {
            observedBy: {
              workerSessionId: observedByWorkerSessionId,
              workerSessionGeneration: observedByWorkerSessionGeneration,
            },
          },
        },
      });
    }
    return protocolResponse({ code: "RESOURCE_NOT_FOUND" }, 404);
  };

  const guardedFixtureHandler = async (request: Request): Promise<Response> => {
    try {
      return await fixtureHandler(request);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "FIXTURE_FAILURE";
      console.error(`NATIVE_FIXTURE_HANDLER_FAILED:${detail}`);
      return protocolResponse({ code: detail }, 500);
    }
  };

  const serverReady = Promise.withResolvers<string>();
  server = Deno.serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      onListen({ port }) {
        serverReady.resolve(`http://127.0.0.1:${port}`);
      },
    },
    guardedFixtureHandler,
  );
  const serverUrl = await serverReady.promise;
  const unauthenticatedPaths = [
    "/v1/worker/heartbeat",
    "/v1/worker/claims",
    `/v1/worker/attempts/${assignment.attemptId}/events`,
    `/v1/worker/attempts/${assignment.attemptId}/lease-renewals`,
    `/v1/worker/attempts/${assignment.attemptId}/result`,
    `/v1/worker/attempts/${assignment.attemptId}/cleanup`,
    `/v1/worker/attempts/${assignment.attemptId}/output-bindings`,
    `/v1/worker/attempts/${assignment.attemptId}/output-bindings/close`,
  ];
  for (const path of unauthenticatedPaths) {
    const response = await fetch(`${serverUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    await response.arrayBuffer();
    if (response.status !== 401) {
      throw new Error(`NATIVE_FIXTURE_AUTH_BYPASS:${path}:${response.status}`);
    }
  }
  const environment: Record<string, string> = {
    BAKERY_WORKER_STARTUP_MARKER: "1",
    BAKERY_WORKER_NATIVE_SMOKE: "1",
    BAKERY_ENV: "test",
    BAKERY_SERVER_URL: serverUrl,
    BAKERY_VERSION: "ci-native-smoke",
    BAKERY_WORKER_CGROUP_ROOT: lease.root,
    BAKERY_WORKER_ENROLLMENT_TOKEN_FILE: tokenPath,
    BAKERY_WORKER_STATE_DIR: stateDir,
    BAKERY_WORKER_CAPABILITIES: "git",
    BAKERY_WORKER_HEARTBEAT_MS: "100",
    BAKERY_WORKER_CLAIM_BACKOFF_MS: "100",
    BAKERY_WORKER_DRAIN_MS: "5000",
    HOME: stateDir,
  };
  const permissions = readWorkerLaunchPermissions(environment, root);
  worker = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--no-prompt",
      "--preload=src/cgroup-permission-preload.ts",
      `--allow-env=${WORKER_RUNTIME_ENVIRONMENT_NAMES.join(",")}`,
      `--allow-read=${permissions.read.join(",")}`,
      `--allow-write=${permissions.write.join(",")}`,
      `--allow-run=${workerRunExecutables(Deno.execPath()).join(",")}`,
      `--allow-net=${permissions.net.join(",")}`,
      `--allow-sys=${permissions.sys.join(",")}`,
      "src/main.ts",
    ],
    cwd: `${root}apps/worker`,
    env: environment,
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let workerOutput = "";
  const assertAuthenticatedIdentityGuards = async (): Promise<void> => {
    const deadline = Date.now() + 10_000;
    while (
      (fixture.credential === null || fixture.sessionId === null ||
        !fixture.claimed) &&
      Date.now() < deadline
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    if (
      fixture.credential === null || fixture.sessionId === null ||
      !fixture.claimed
    ) {
      throw new Error("NATIVE_FIXTURE_IDENTITY_FAULT_SETUP_TIMEOUT");
    }
    const headers = {
      Authorization: `Bearer ${fixture.credential}`,
      "Content-Type": "application/json",
    };
    const claimResponse = await fetch(`${serverUrl}/v1/worker/claims`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        claimKey: crypto.randomUUID(),
        workerHostId: fixture.workerHostId,
        capabilities: ["git"],
        supportedActions: ["quality.check"],
        workerSessionId: crypto.randomUUID(),
        workerSessionGeneration: fixture.sessionGeneration,
      }),
    });
    await claimResponse.arrayBuffer();
    if (claimResponse.status !== 409) {
      throw new Error(
        `NATIVE_FIXTURE_SESSION_BYPASS:${claimResponse.status}`,
      );
    }
    const eventResponse = await fetch(
      `${serverUrl}/v1/worker/attempts/${fixture.assignment.attemptId}/events`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          leaseToken: fixture.assignment.leaseToken,
          fence: "999",
          workerSessionId: fixture.sessionId,
          workerSessionGeneration: fixture.sessionGeneration,
          events: [],
        }),
      },
    );
    await eventResponse.arrayBuffer();
    if (eventResponse.status !== 409) {
      throw new Error(`NATIVE_FIXTURE_FENCE_BYPASS:${eventResponse.status}`);
    }
  };
  const identityFault = assertAuthenticatedIdentityGuards();

  const readStream = async (
    stream: ReadableStream<Uint8Array>,
    onChunk?: (text: string) => void,
  ): Promise<string> => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
      onChunk?.(new TextDecoder().decode(chunk));
    }
    const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
    const combined = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    return new TextDecoder().decode(combined);
  };

  const waitForExit = async (
    process: Deno.ChildProcess,
    timeoutMs: number,
  ): Promise<Deno.CommandStatus | undefined> => {
    const { promise, resolve } = Promise.withResolvers<void>();
    const timer = setTimeout(resolve, timeoutMs);
    const result = await Promise.race([
      process.status,
      promise.then(() => undefined),
    ]);
    clearTimeout(timer);
    return result;
  };

  const isProductionReleaseFinal = async (): Promise<boolean> => {
    const registration = JSON.parse(
      await Deno.readTextFile(`${stateDir}/registration.json`),
    ) as {
      activeAssignments?: Record<string, unknown>;
      terminationEvidence?: Record<string, unknown>;
      releaseMarkers?: Record<string, unknown>;
    };
    const attemptId = fixture.assignment.attemptId;
    return registration.activeAssignments?.[attemptId] === undefined &&
      registration.terminationEvidence?.[attemptId] === undefined &&
      registration.releaseMarkers?.[attemptId] === undefined;
  };

  const waitForProductionCleanup = async (
    process: Deno.ChildProcess,
    output: Promise<[string, string]>,
  ): Promise<void> => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (
        fixture.cleanup &&
        fixture.commandAcknowledged &&
        workerOutput.includes(terminationCleanupMarker) &&
        fixture.retirementHeartbeatObserved &&
        await isProductionReleaseFinal()
      ) return;
      const result = await Promise.race([
        process.status.then((status) => ({ status })),
        new Promise<void>((resolve) => setTimeout(resolve, 25)),
      ]);
      if (result !== undefined) {
        const [stdout, stderr] = await output;
        throw new Error(
          `NATIVE_PRODUCTION_WORKER_EXITED_EARLY:${result.status.code}\n${stdout}\n${stderr}`,
        );
      }
    }
    process.kill("SIGKILL");
    await process.status;
    await output;
    throw new Error("NATIVE_PRODUCTION_FIXTURE_TIMEOUT");
  };

  const waitForEmptyCgroup = async (path: string): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const result = await new Deno.Command("/usr/bin/cat", {
        args: ["--", `${path}/cgroup.events`],
        stdout: "piped",
        stderr: "null",
      }).output();
      if (
        result.success &&
        /^populated 0$/m.test(new TextDecoder().decode(result.stdout))
      ) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("NATIVE_PRODUCTION_CGROUP_NOT_EMPTY");
  };

  const runChildExecutorSmoke = async (): Promise<void> => {
    const childEnvironment = {
      ...environment,
      BAKERY_WORKER_STATE_DIR: nativeStateDir,
    };
    const childPermissions = readWorkerLaunchPermissions(
      childEnvironment,
      root,
    );
    const preload = `${root}apps/worker/src/cgroup-permission-preload.ts`;
    const childScript = `${root}scripts/ci/native-worker-executor-smoke.ts`;
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--no-prompt",
        `--preload=${preload}`,
        "--allow-env=BAKERY_WORKER_CGROUP_ROOT,BAKERY_WORKER_STATE_DIR",
        `--allow-read=${childPermissions.read.join(",")}`,
        `--allow-write=${childPermissions.write.join(",")}`,
        `--allow-run=${workerRunExecutables(Deno.execPath()).join(",")}`,
        childScript,
        lease.root,
        nativeStateDir,
      ],
      cwd: root,
      env: {
        BAKERY_WORKER_CGROUP_ROOT: lease.root,
        BAKERY_WORKER_STATE_DIR: nativeStateDir,
      },
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const output = Promise.all([
      readStream(child.stdout),
      readStream(child.stderr),
    ]);
    const status = await waitForExit(child, 10_000);
    if (!status) {
      child.kill("SIGKILL");
      await child.status;
      const [stdout, stderr] = await output;
      throw new Error(
        `NATIVE_CHILD_CLEANUP_TIMEOUT\n${stdout}\n${stderr}`,
      );
    }
    const [stdout, stderr] = await output;
    const text = `${stdout}\n${stderr}`.trim();
    console.log(text);
    if (!status.success || !text.includes("NATIVE_CHILD_CLEANUP_CONFIRMED")) {
      throw new Error("NATIVE_CHILD_CLEANUP_FAILED");
    }
  };

  const output = Promise.all([
    readStream(worker.stdout, (text) => workerOutput += text),
    readStream(worker.stderr, (text) => workerOutput += text),
  ]);
  await waitForProductionCleanup(worker, output);
  await identityFault;
  if (
    !fixture.claimed ||
    !fixture.accepted ||
    !fixture.started ||
    !fixture.outputOpened ||
    !fixture.cleanup ||
    !fixture.commandAcknowledged
  ) {
    throw new Error("NATIVE_PRODUCTION_FIXTURE_ASSIGNMENT_INCOMPLETE");
  }
  const cleanup = fixture.cleanup;
  if (
    cleanup.fence !== fixture.assignment.fence ||
    cleanup.workerSessionId !== fixture.sessionId ||
    cleanup.workerSessionGeneration !== fixture.sessionGeneration ||
    cleanup.observedByWorkerSessionId !== fixture.sessionId ||
    cleanup.observedByWorkerSessionGeneration !==
      fixture.sessionGeneration ||
    typeof cleanup.exitedAt !== "string" ||
    !fixture.cancelCommandDelivered
  ) {
    throw new Error("NATIVE_PRODUCTION_FIXTURE_CLEANUP_MISMATCH");
  }
  await waitForEmptyCgroup(lease.root);
  worker.kill("SIGTERM");
  const status = await waitForExit(worker, 5_000);
  if (!status) {
    worker.kill("SIGKILL");
    await worker.status;
    throw new Error("NATIVE_PRODUCTION_WORKER_SHUTDOWN_TIMEOUT");
  }
  if (!status.success) {
    throw new Error(`NATIVE_PRODUCTION_WORKER_SHUTDOWN_FAILED:${status.code}`);
  }
  const [stdout, stderr] = await output;
  const completeWorkerOutput = `${stdout}\n${stderr}`.trim();
  console.log(completeWorkerOutput);
  if (
    !completeWorkerOutput.includes("WORKER_SUPERVISOR_STARTUP_REACHED") ||
    !completeWorkerOutput.includes(terminationCleanupMarker)
  ) {
    throw new Error("NATIVE_PRODUCTION_FINALIZATION_MISSING");
  }
  if (!fixture.cancelCommandId) {
    throw new Error("NATIVE_PRODUCTION_COMMAND_ID_MISSING");
  }
  if (!await isProductionReleaseFinal()) {
    throw new Error("NATIVE_PRODUCTION_RELEASE_NOT_FINAL");
  }
  console.log("NATIVE_PRODUCTION_FIXTURE_ASSIGNMENT_CONFIRMED");

  await runChildExecutorSmoke();
  console.log("native child and descendant cleanup confirmed");
  console.log("NATIVE_WORKER_CGROUP_SMOKE_PASSED");
  smokePassed = true;
} finally {
  const cleanupErrors: unknown[] = [];
  const attemptCleanup = async (cleanup: () => Promise<void>) => {
    try {
      await cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
  };
  if (worker !== undefined) {
    await attemptCleanup(async () => {
      try {
        worker.kill("SIGKILL");
      } catch {
        // The worker already exited.
      }
      await worker.status.catch(() => undefined);
    });
  }
  if (server !== undefined) {
    await attemptCleanup(() => server.shutdown());
  }
  if (lease !== undefined) {
    await attemptCleanup(() => lease.release());
  }
  if (
    !smokePassed && stateDir !== undefined && diagnosticAttemptId !== undefined
  ) {
    console.error(
      `NATIVE_PRODUCTION_RELEASE_PRESENCE:${
        JSON.stringify(
          await readReleasePresence(
            `${stateDir}/registration.json`,
            diagnosticAttemptId,
          ),
        )
      }`,
    );
  }
  for (const path of [stateDir, nativeStateDir, tokenPath]) {
    if (path !== undefined) {
      await attemptCleanup(() => Deno.remove(path, { recursive: true }));
    }
  }
  if (cleanupErrors.length > 0) {
    cleanupFailed = true;
    cleanupFailure = cleanupErrors[0];
  } else {
    console.log("NATIVE_WORKER_SMOKE_RESOURCES_RELEASED");
  }
}
if (cleanupFailed) throw cleanupFailure;
