import { assert, assertEquals } from "@std/assert";
import { openSecretsFixture } from "../helpers/secrets.ts";
import {
  adminRequest,
  registeredWorker,
  seedEligibleJob,
  type WorkerFixture,
  workerFixtureCapabilities,
  workerRequest,
} from "../helpers/worker-execution.ts";
import type { WorkerAssignment } from "../helpers/worker-execution/scenarios.ts";
import { seedEligibleNonmodelJob } from "../helpers/worker-execution/nonmodel-job.ts";

type SecretsFixture = Awaited<ReturnType<typeof openSecretsFixture>>;
type Worker = Awaited<ReturnType<typeof registeredWorker>>;

const OBSERVED = "2026-11-28T00:00:00.000Z";

function asWorkerFixture(f: SecretsFixture): WorkerFixture {
  return {
    app: f.fixture.app,
    pgDatabase: f.fixture.pgDatabase,
    runtimePgDatabase: f.fixture.pgDatabase,
    config: f.fixture.config,
    email: "fixture-owned-by-secrets-helper@example.test",
    organizationId: f.organizationId,
    principalId: f.principalId,
    adminCookie: f.adminCookie,
    ownsAuthIdentity: false,
    workerHostIds: [],
    close: () => Promise.resolve(),
    releaseFixture: () => {},
  };
}

async function reportClaudeHarness(fixture: WorkerFixture, worker: Worker) {
  const response = await workerRequest(
    fixture,
    worker.credential,
    "/v1/worker/inventory",
    {
      reportId: crypto.randomUUID(),
      hostGeneration: worker.registration.registrationGeneration,
      expectedInventoryRevision: 1,
      components: [{
        componentKey: "harness.claude",
        kind: "harness",
        actualVersion: "1.0",
        installOwner: "external",
        adapterVersion: "1.0",
        observedAt: OBSERVED,
        capabilities: ["git", "shell"],
        maintenanceSupport: { remoteLogin: "none" },
      }],
      checks: [],
    },
    {
      headers: { "X-Bakery-Worker-Protocol-Version": "2" },
      idempotencyKey: crypto.randomUUID(),
    },
  );
  assertEquals(response.status, 200, await response.clone().text());
  await response.body?.cancel();
}

async function saveKey(
  f: SecretsFixture,
  applicationId: string,
  provider: string,
  value: string,
): Promise<string> {
  const created = await f.request("/v1/secrets", {
    applicationId,
    name: `Model key ${crypto.randomUUID().slice(0, 8)}`,
    provider,
    value,
    allowedPrincipalIds: [f.principalId],
    allowedActions: ["identity.read"],
  }, crypto.randomUUID());
  assertEquals(created.status, 201, await created.clone().text());
  return (await created.json() as { id: string }).id;
}

function bindKey(
  fixture: WorkerFixture,
  worker: Worker,
  secretId: string,
  provider = "anthropic",
): Promise<Response> {
  return adminRequest(
    fixture,
    `/v1/workers/${worker.registration.workerHostId}/provider-bindings`,
    {
      componentKey: "harness.claude",
      provider,
      billingRoute: "api_metered",
      authMode: "api_secret",
      credentialLocation: "bakery_secret",
      secretId,
    },
    { idempotencyKey: crypto.randomUUID() },
  );
}

async function claimMeteredJob(
  fixture: WorkerFixture,
  worker: Worker,
  billingRoute: string,
): Promise<{ assignment: WorkerAssignment; applicationId: string }> {
  const job = await seedEligibleNonmodelJob(
    fixture.pgDatabase,
    fixture.organizationId,
    fixture.principalId,
  );
  const claimKey = crypto.randomUUID();
  const response = await workerRequest(
    fixture,
    worker.credential,
    "/v1/worker/claims",
    {
      claimKey,
      workerHostId: worker.registration.workerHostId,
      capabilities: workerFixtureCapabilities,
    },
    { idempotencyKey: claimKey },
  );
  assertEquals(response.status, 200, await response.clone().text());
  const assignment = await response.json() as WorkerAssignment;
  assertEquals(assignment.jobId, job.jobId);
  await fixture.pgDatabase.query(
    `update bakery.jobs
        set agent_config = jsonb_set(coalesce(agent_config, '{}'::jsonb), '{harness}', '"claude"'),
            billing = jsonb_build_object('provider', 'anthropic', 'billingRoute', $3::text)
      where organization_id = $1 and id = $2`,
    [fixture.organizationId, job.jobId, billingRoute],
  );
  return { assignment, applicationId: job.applicationId };
}

function readModelKey(
  fixture: WorkerFixture,
  worker: Worker,
  assignment: WorkerAssignment,
  fence = assignment.fence,
): Promise<Response> {
  return Promise.resolve(fixture.app.fetch(
    new Request(
      `${fixture.config.publicBaseUrl}/v1/worker/attempts/${assignment.attemptId}/model-key`,
      {
        headers: {
          authorization: `Bearer ${worker.credential}`,
          "X-Worker-Session-Id": worker.registration.workerSessionId,
          "X-Worker-Session-Generation":
            worker.registration.workerSessionGeneration,
          "X-Worker-Lease-Token": assignment.leaseToken,
          "X-Worker-Fence": fence,
          "X-Bakery-Worker-Protocol-Version": "2",
        },
      },
    ),
  ));
}

async function refusal(response: Response): Promise<[number, string]> {
  const body = await response.json() as { code: string; reason?: string };
  return [response.status, body.reason ?? body.code];
}

Deno.test("the worker holding the lease reads the bound model key, and nothing else can", async () => {
  const f = await openSecretsFixture();
  try {
    const fixture = asWorkerFixture(f);
    const worker = await registeredWorker(fixture, {
      name: "issue70-model-key",
    });
    const { assignment, applicationId } = await claimMeteredJob(
      fixture,
      worker,
      "api",
    );
    await reportClaudeHarness(fixture, worker);

    assertEquals(
      await refusal(await readModelKey(fixture, worker, assignment)),
      [409, "model_key_unbound"],
    );

    const value = `sk-ant-fixture-${crypto.randomUUID()}`;
    const secretId = await saveKey(f, applicationId, "anthropic", value);
    const bound = await bindKey(fixture, worker, secretId);
    assertEquals(bound.status, 201, await bound.clone().text());
    const binding = await bound.json() as { id: string };

    const read = await readModelKey(fixture, worker, assignment);
    assertEquals(read.status, 200, await read.clone().text());
    assertEquals(read.headers.get("Cache-Control"), "no-store");
    assertEquals(await read.json(), { provider: "anthropic", apiKey: value });

    const stale = await readModelKey(
      fixture,
      worker,
      assignment,
      String(BigInt(assignment.fence) + 1n),
    );
    assert(stale.status >= 400 && stale.status < 500);
    await stale.body?.cancel();

    await fixture.pgDatabase.query(
      `update bakery.worker_provider_bindings set enabled = false where id = $1`,
      [binding.id],
    );
    assertEquals(
      await refusal(await readModelKey(fixture, worker, assignment)),
      [409, "model_key_unbound"],
    );
  } finally {
    await f.cleanup();
  }
});

Deno.test("a subscription job gets no key even when the machine has one bound", async () => {
  const f = await openSecretsFixture();
  try {
    const fixture = asWorkerFixture(f);
    const worker = await registeredWorker(fixture, {
      name: "issue70-subscription",
    });
    const { assignment, applicationId } = await claimMeteredJob(
      fixture,
      worker,
      "subscription",
    );
    await reportClaudeHarness(fixture, worker);
    const secretId = await saveKey(
      f,
      applicationId,
      "anthropic",
      `sk-ant-fixture-${crypto.randomUUID()}`,
    );
    const bound = await bindKey(fixture, worker, secretId);
    assertEquals(bound.status, 201, await bound.clone().text());
    await bound.body?.cancel();
    assertEquals(
      await refusal(await readModelKey(fixture, worker, assignment)),
      [409, "model_key_not_metered"],
    );
  } finally {
    await f.cleanup();
  }
});

Deno.test("a binding refuses a key saved for another provider", async () => {
  const f = await openSecretsFixture();
  try {
    const fixture = asWorkerFixture(f);
    const worker = await registeredWorker(fixture, {
      name: "issue70-mismatch",
    });
    await reportClaudeHarness(fixture, worker);
    const job = await seedEligibleJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const openaiKey = await saveKey(
      f,
      job.applicationId,
      "openai",
      `sk-fixture-${crypto.randomUUID()}`,
    );
    const refused = await bindKey(fixture, worker, openaiKey);
    assertEquals(refused.status, 422, await refused.clone().text());
    const problem = await refused.json() as { issues?: { code: string }[] };
    assertEquals(
      problem.issues?.map((issue) => issue.code),
      ["model_key_provider_mismatch"],
    );
    const rows = await fixture.pgDatabase.query(
      `select id from bakery.worker_provider_bindings where worker_host_id = $1`,
      [worker.registration.workerHostId],
    );
    assertEquals(rows.rows, []);
  } finally {
    await f.cleanup();
  }
});
