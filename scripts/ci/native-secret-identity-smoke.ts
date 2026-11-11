import { assert, assertEquals } from "@std/assert";
import { provisionDelegatedCgroupV2 } from "../lib/cgroup-v2.ts";
import { openSecretsFixture } from "../../tests/helpers/secrets.ts";
import {
  enrollWorker,
  seedEligibleJob,
  type WorkerFixture,
} from "../../tests/helpers/worker-execution.ts";

const root = decodeURIComponent(new URL("../..", import.meta.url).pathname);
const marker = `controlled-fixture-token-${crypto.randomUUID()}`;
let fixture: Awaited<ReturnType<typeof openSecretsFixture>> | undefined;
let server: Deno.HttpServer | undefined;
let worker: Deno.ChildProcess | undefined;
let lease: Awaited<ReturnType<typeof provisionDelegatedCgroupV2>> | undefined;
let stateDir: string | undefined;
let tokenPath: string | undefined;
let output = "";

function asWorkerFixture(
  f: Awaited<ReturnType<typeof openSecretsFixture>>,
): WorkerFixture {
  return {
    app: f.fixture.app,
    pgDatabase: f.fixture.pgDatabase,
    runtimePgDatabase: f.fixture.pgDatabase,
    config: f.fixture.config,
    email: "native-secret-fixture@example.test",
    organizationId: f.organizationId,
    principalId: f.principalId,
    adminCookie: f.adminCookie,
    ownsAuthIdentity: false,
    workerHostIds: [],
    close: () => Promise.resolve(),
    releaseFixture: () => {},
  };
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<void> {
  for await (const chunk of stream) {
    output += new TextDecoder().decode(chunk);
    if (output.length > 256_000) output = output.slice(-256_000);
  }
}

try {
  fixture = await openSecretsFixture();
  const workerFixture = asWorkerFixture(fixture);
  const enrollmentResponse = await enrollWorker(workerFixture, {
    name: "issue286-production-worker",
    capabilities: ["secret.identity"],
  });
  assertEquals(enrollmentResponse.status, 201);
  const enrollment = await enrollmentResponse.json() as {
    enrollmentToken: string;
  };

  const placeholder = crypto.randomUUID();
  const job = await seedEligibleJob(
    fixture.fixture.pgDatabase,
    fixture.organizationId,
    fixture.principalId,
    {
      action: "secret.identity.read",
      input: { secretRef: placeholder },
    },
  );
  const secretResponse = await fixture.request("/v1/secrets", {
    applicationId: job.applicationId,
    name: "Issue 286 controlled provider fixture",
    provider: "github",
    value: marker,
    allowedPrincipalIds: [fixture.principalId],
    allowedActions: ["identity.read"],
  }, crypto.randomUUID());
  assertEquals(secretResponse.status, 201, await secretResponse.clone().text());
  const secret = await secretResponse.json() as { id: string };
  await fixture.fixture.pgDatabase.query(
    `update bakery.jobs
        set input = jsonb_set(input, '{secretRef}', to_jsonb($2::text), true)
      where organization_id = $1 and id = $3`,
    [fixture.organizationId, secret.id, job.jobId],
  );
  await fixture.fixture.pgDatabase.query(
    `update bakery.workflow_runs
        set snapshot = jsonb_set(
          snapshot,
          '{workflow,normalizedSpec,steps,0,with,secretRef}',
          to_jsonb($2::text),
          true
        )
      where organization_id = $1 and id = $3`,
    [fixture.organizationId, secret.id, job.runId],
  );

  const listening = Promise.withResolvers<string>();
  server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: ({ port }) => listening.resolve(`http://127.0.0.1:${port}`),
  }, fixture.fixture.app.fetch);
  const serverUrl = await listening.promise;

  lease = await provisionDelegatedCgroupV2("bakery-secret-identity-");
  stateDir = await Deno.makeTempDir({ prefix: "bakery-secret-worker-" });
  tokenPath = await Deno.makeTempFile({ prefix: "bakery-secret-enrollment-" });
  await Deno.writeTextFile(tokenPath, `${enrollment.enrollmentToken}\n`);
  await Deno.chmod(tokenPath, 0o600);

  worker = new Deno.Command("pnpm", {
    args: ["--filter", "@bakery/worker", "start"],
    cwd: root,
    env: {
      ...Deno.env.toObject(),
      BAKERY_ENV: "test",
      BAKERY_SERVER_URL: serverUrl,
      BAKERY_VERSION: "issue286-native-evidence",
      BAKERY_WORKER_CGROUP_ROOT: lease.root,
      BAKERY_WORKER_ENROLLMENT_TOKEN_FILE: tokenPath,
      BAKERY_WORKER_STATE_DIR: stateDir,
      BAKERY_WORKER_NAME: "issue286-production-worker",
      BAKERY_WORKER_CAPABILITIES: "secret.identity",
      BAKERY_WORKER_SLOTS: "1",
      BAKERY_WORKER_HEARTBEAT_MS: "100",
      BAKERY_WORKER_CLAIM_BACKOFF_MS: "100",
      BAKERY_WORKER_CLAIM_BACKOFF_MAX_MS: "500",
      BAKERY_WORKER_REQUEST_TIMEOUT_MS: "5000",
      BAKERY_WORKER_DRAIN_MS: "5000",
    },
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const readers = Promise.all([
    readStream(worker.stdout),
    readStream(worker.stderr),
  ]);

  let observed:
    | { status: string; result: unknown; attempt_status: string }
    | undefined;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const rows = await fixture.fixture.pgDatabase.query<{
      status: string;
      result: unknown;
      attempt_status: string;
    }>(
      `select job.status, attempt.result, attempt.status as attempt_status
         from bakery.jobs job
         left join bakery.job_attempts attempt
           on attempt.organization_id = job.organization_id
          and attempt.job_id = job.id
        where job.organization_id = $1 and job.id = $2
        order by attempt.attempt_no desc nulls last limit 1`,
      [fixture.organizationId, job.jobId],
    );
    observed = rows.rows[0];
    if (observed?.status === "completed") break;
    const status = await Promise.race([
      worker.status.then((value) => value),
      new Promise<undefined>((resolve) =>
        setTimeout(() => resolve(undefined), 100)
      ),
    ]);
    if (status !== undefined) {
      await readers;
      throw new Error(`PRODUCTION_WORKER_EXITED:${status.code}:${output}`);
    }
  }
  if (!observed) throw new Error(`NATIVE_RESULT_MISSING:${output}`);
  assertEquals(observed.status, "completed", output);
  assertEquals(observed.attempt_status, "completed", output);
  const terminal = observed.result as {
    status?: unknown;
    localSeq?: unknown;
    result?: unknown;
  };
  assertEquals(terminal.status, "completed");
  assertEquals(terminal.localSeq, "3");
  assertEquals(terminal.result, {
    status: "completed",
    accountId: "12345",
    login: "fixture-user",
  });
  assertEquals(fixture.calls(), 2);
  const prepared = await fixture.fixture.pgDatabase.query<{
    status: string;
    io_attempt: number;
    requester_id: string;
  }>(
    `select status, io_attempt, requester_id
       from bakery.prepared_operations
      where organization_id = $1 and job_id = $2`,
    [fixture.organizationId, job.jobId],
  );
  assertEquals(prepared.rows, [{
    status: "completed",
    io_attempt: 1,
    requester_id: fixture.principalId,
  }]);
  const stateText = await Array.fromAsync(
    Deno.readDir(stateDir),
    async (entry) =>
      entry.isFile
        ? await Deno.readTextFile(`${stateDir}/${entry.name}`).catch(() => "")
        : "",
  );
  assert(!output.includes(marker));
  assert(!stateText.join("\n").includes(marker));
  console.log(JSON.stringify({
    evidence: "FIXED_SECRET_IDENTITY_NATIVE_CONFIRMED",
    provider: "controlled fixture; not connected GitHub proof",
    jobStatus: observed.status,
    attemptStatus: observed.attempt_status,
    preparedStatus: prepared.rows[0].status,
    ioAttempts: prepared.rows[0].io_attempt,
    providerCallsIncludingCreatePreflight: fixture.calls(),
    productionCommand: "pnpm --filter @bakery/worker start",
  }));

  worker.kill("SIGTERM");
  const status = await worker.status;
  await readers;
  assert(status.success, output);
} finally {
  if (worker) {
    try {
      worker.kill("SIGKILL");
    } catch {
      // Already exited.
    }
    await worker.status.catch(() => undefined);
  }
  if (server) await server.shutdown().catch(() => undefined);
  if (lease) await lease.release().catch(() => undefined);
  if (fixture) await fixture.cleanup().catch(() => undefined);
  for (const path of [stateDir, tokenPath]) {
    if (path) {
      await Deno.remove(path, { recursive: true }).catch(() => undefined);
    }
  }
}
