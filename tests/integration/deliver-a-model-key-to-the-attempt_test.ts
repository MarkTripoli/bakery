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

const HARNESS_COMPONENTS = ["harness.claude", "harness.codex", "harness.pi"];

async function reportHarnesses(fixture: WorkerFixture, worker: Worker) {
  const response = await workerRequest(
    fixture,
    worker.credential,
    "/v1/worker/inventory",
    {
      reportId: crypto.randomUUID(),
      hostGeneration: worker.registration.registrationGeneration,
      expectedInventoryRevision: 1,
      components: HARNESS_COMPONENTS.map((componentKey) => ({
        componentKey,
        kind: "harness",
        actualVersion: "1.0",
        installOwner: "external",
        adapterVersion: "1.0",
        observedAt: OBSERVED,
        capabilities: ["git", "shell"],
        maintenanceSupport: { remoteLogin: "none" },
      })),
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
  policy: { principals?: string[]; actions?: string[] } = {},
): Promise<string> {
  const created = await f.request("/v1/secrets", {
    applicationId,
    name: `Model key ${crypto.randomUUID().slice(0, 8)}`,
    provider,
    value,
    allowedPrincipalIds: policy.principals ?? [f.principalId],
    allowedActions: policy.actions ?? ["model.inference"],
  }, crypto.randomUUID());
  assertEquals(created.status, 201, await created.clone().text());
  return (await created.json() as { id: string }).id;
}

function bindKey(
  fixture: WorkerFixture,
  worker: Worker,
  secretId: string,
  provider = "anthropic",
  componentKey = "harness.claude",
): Promise<Response> {
  return adminRequest(
    fixture,
    `/v1/workers/${worker.registration.workerHostId}/provider-bindings`,
    {
      componentKey,
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
  agent: { harness: string; provider: string } = {
    harness: "claude_code",
    provider: "anthropic",
  },
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
        set agent_config = jsonb_set(coalesce(agent_config, '{}'::jsonb), '{harness}', to_jsonb($4::text)),
            billing = jsonb_build_object('provider', $5::text, 'billingRoute', $3::text)
      where organization_id = $1 and id = $2`,
    [
      fixture.organizationId,
      job.jobId,
      billingRoute,
      agent.harness,
      agent.provider,
    ],
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
    await reportHarnesses(fixture, worker);

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
    await reportHarnesses(fixture, worker);
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
    await reportHarnesses(fixture, worker);
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

Deno.test("each coding agent's job reads the key bound to its own harness", async () => {
  const f = await openSecretsFixture();
  try {
    const fixture = asWorkerFixture(f);
    for (
      const [harness, provider, componentKey] of [
        ["claude_code", "anthropic", "harness.claude"],
        ["codex", "openai", "harness.codex"],
        ["pi", "openrouter", "harness.pi"],
      ] as const
    ) {
      const worker = await registeredWorker(fixture, {
        name: `issue70-${harness}`,
      });
      const { assignment, applicationId } = await claimMeteredJob(
        fixture,
        worker,
        "api",
        { harness, provider },
      );
      await reportHarnesses(fixture, worker);
      const value = `${provider}-fixture-${crypto.randomUUID()}`;
      const secretId = await saveKey(f, applicationId, provider, value);
      const bound = await bindKey(
        fixture,
        worker,
        secretId,
        provider,
        componentKey,
      );
      assertEquals(bound.status, 201, await bound.clone().text());
      await bound.body?.cancel();
      const read = await readModelKey(fixture, worker, assignment);
      assertEquals(
        read.status,
        200,
        `${harness}: ${await read.clone().text()}`,
      );
      assertEquals(await read.json(), { provider, apiKey: value });
      const audits = await fixture.pgDatabase.query<
        { details: Record<string, unknown> }
      >(
        `select details from bakery.audit_events
          where operation = 'worker.modelKey' and resource_id = $1::text`,
        [secretId],
      );
      assertEquals(audits.rows.length, 1);
      assertEquals(audits.rows[0]!.details.attemptId, assignment.attemptId);
      assertEquals(audits.rows[0]!.details.startedBy, f.principalId);
      const reader = await fixture.pgDatabase.query<{ matches: boolean }>(
        `select audit.principal_id = host.principal_id as matches
           from bakery.audit_events audit
           join bakery.worker_hosts host on host.id = $2
          where audit.operation = 'worker.modelKey' and audit.resource_id = $1::text`,
        [secretId, worker.registration.workerHostId],
      );
      assertEquals(reader.rows[0]?.matches, true);
    }
  } finally {
    await f.cleanup();
  }
});

Deno.test("a key outside the job's project or its own allowed list is never released", async () => {
  const f = await openSecretsFixture();
  try {
    const fixture = asWorkerFixture(f);
    const cases = [
      {
        name: "issue70-project",
        reason: "model_key_project_mismatch",
        save: (_applicationId: string) =>
          saveKey(
            f,
            f.applicationB,
            "anthropic",
            `sk-ant-${crypto.randomUUID()}`,
          ),
      },
      {
        name: "issue70-allowed",
        reason: "model_key_not_allowed",
        save: (applicationId: string) =>
          saveKey(
            f,
            applicationId,
            "anthropic",
            `sk-ant-${crypto.randomUUID()}`,
            {
              principals: [],
            },
          ),
      },
    ];
    for (const item of cases) {
      const worker = await registeredWorker(fixture, { name: item.name });
      const { assignment, applicationId } = await claimMeteredJob(
        fixture,
        worker,
        "api",
      );
      await reportHarnesses(fixture, worker);
      const secretId = await item.save(applicationId);
      const bound = await bindKey(fixture, worker, secretId);
      assertEquals(bound.status, 201, await bound.clone().text());
      await bound.body?.cancel();
      assertEquals(
        await refusal(await readModelKey(fixture, worker, assignment)),
        [409, item.reason],
      );
      const audits = await fixture.pgDatabase.query(
        `select 1 from bakery.audit_events
          where operation = 'worker.modelKey' and resource_id = $1::text`,
        [secretId],
      );
      assertEquals(audits.rows, []);
    }
  } finally {
    await f.cleanup();
  }
});

Deno.test("an attempt that is being canceled gets no key", async () => {
  const f = await openSecretsFixture();
  try {
    const fixture = asWorkerFixture(f);
    const worker = await registeredWorker(fixture, {
      name: "issue70-canceling",
    });
    const { assignment, applicationId } = await claimMeteredJob(
      fixture,
      worker,
      "api",
    );
    await reportHarnesses(fixture, worker);
    const secretId = await saveKey(
      f,
      applicationId,
      "anthropic",
      `sk-ant-${crypto.randomUUID()}`,
    );
    const bound = await bindKey(fixture, worker, secretId);
    assertEquals(bound.status, 201, await bound.clone().text());
    await bound.body?.cancel();
    await fixture.pgDatabase.query(
      `update bakery.job_attempts set status = 'canceling' where id = $1`,
      [assignment.attemptId],
    );
    assertEquals(
      await refusal(await readModelKey(fixture, worker, assignment)),
      [409, "model_key_attempt_ending"],
    );
  } finally {
    await f.cleanup();
  }
});

Deno.test("a key whose bytes cannot be read is refused and leaves no audit row", async () => {
  const f = await openSecretsFixture();
  try {
    const fixture = asWorkerFixture(f);
    const worker = await registeredWorker(fixture, {
      name: "issue70-unreadable",
    });
    const { assignment, applicationId } = await claimMeteredJob(
      fixture,
      worker,
      "api",
    );
    await reportHarnesses(fixture, worker);
    const secretId = await saveKey(
      f,
      applicationId,
      "anthropic",
      `sk-ant-${crypto.randomUUID()}`,
    );
    const bound = await bindKey(fixture, worker, secretId);
    assertEquals(bound.status, 201, await bound.clone().text());
    await bound.body?.cancel();
    await fixture.pgDatabase.query(
      `update bakery.secret_versions set key_id = 'another-key-v9' where secret_id = $1`,
      [secretId],
    );
    assertEquals(
      await refusal(await readModelKey(fixture, worker, assignment)),
      [409, "model_key_unreadable"],
    );
    const audits = await fixture.pgDatabase.query(
      `select 1 from bakery.audit_events
        where operation = 'worker.modelKey' and resource_id = $1::text`,
      [secretId],
    );
    assertEquals(audits.rows, []);
  } finally {
    await f.cleanup();
  }
});

Deno.test("a policy update cannot give a key the other kind of secret's action", async () => {
  const f = await openSecretsFixture();
  try {
    const fixture = asWorkerFixture(f);
    const job = await seedEligibleNonmodelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const modelKey = await saveKey(
      f,
      job.applicationId,
      "anthropic",
      `sk-ant-${crypto.randomUUID()}`,
    );
    const refused = await f.request(
      `/v1/secrets/${modelKey}`,
      {
        applicationId: job.applicationId,
        allowedPrincipalIds: [f.principalId],
        allowedActions: ["identity.read"],
      },
      crypto.randomUUID(),
      f.organizationId,
      { method: "PATCH", ifMatch: '"v1"' },
    );
    assertEquals(refused.status, 422, await refused.clone().text());
    await refused.body?.cancel();
    const kept = await fixture.pgDatabase.query<{ allowed_actions: unknown }>(
      `select allowed_actions from bakery.secrets where id = $1`,
      [modelKey],
    );
    assertEquals(kept.rows[0]?.allowed_actions, ["model.inference"]);
  } finally {
    await f.cleanup();
  }
});
