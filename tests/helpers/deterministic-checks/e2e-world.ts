import { assert, assertEquals } from "@std/assert";
import {
  closePgDatabase,
  openPgDatabase,
  type PgDatabase,
} from "../../../apps/server/src/platform/database.ts";
import type { Client } from "../../e2e/helpers/durable-core/artifact-client.ts";
import type { DurableCoreStack } from "../durable-core/stack.ts";
import {
  openRepositoryInspectionHarness,
  readInspectionAssignment,
  receiveInspectionSource,
} from "../repository-inspection.ts";
import { baseProfileConfig } from "../repository-rule-entries.ts";
import {
  type Candidate,
  createCandidate,
  fixedPolicyDraft,
  organizationRuleEntries,
  PROOF_COMMANDS,
} from "./e2e-candidate.ts";

/**
 * The world the real-process proof runs in. Everything goes through real
 * routes except one step: the compose server has no trusted-repository
 * mapping and cannot read a host repository, so the onboarding inspection
 * (`repository.inspect`) runs through the same server routes and handlers
 * mounted in this process against the stack's own database, with the test
 * playing the inspecting worker the way the integration lanes do. Its output,
 * an active observed profile with a fixed policy, is what the stack's server
 * then admits runs against.
 */

const MAPPING_ENVIRONMENT = "BAKERY_TRUSTED_REPOSITORIES_JSON";

export type ObservedRepository = {
  readonly applicationId: string;
  readonly repositoryId: string;
  readonly profileId: string;
  readonly candidate: Candidate;
};

/** App-role connection string of the stack's database (the compose default password). */
export function appDatabaseUrl(stack: DurableCoreStack): string {
  return `postgres://bakery_app:bakery-local-app@127.0.0.1:${stack.ports.postgres}/bakery`;
}

/**
 * Publishes the fixed-policy profile through onboarding and returns the active
 * observed profile with a candidate commit built on the inspected snapshot.
 */
export async function onboardObservedRepository(
  stack: DurableCoreStack,
  scope: { organizationId: string; principalId: string },
  operatorRepository: string,
): Promise<ObservedRepository> {
  const ownerPg = openPgDatabase(stack.ownerDatabaseUrl);
  const appPg = openPgDatabase(appDatabaseUrl(stack));
  const harness = await openRepositoryInspectionHarness(
    { authDb: ownerPg, appPg },
    scope,
  );
  try {
    const repository = await harness.createRepository(false, {
      profileConfig: { ...baseProfileConfig, fixedPolicy: fixedPolicyDraft() },
      profileHeaders: { "If-Match": '"1"' },
    });
    await harness.onboard(repository.repositoryId);
    const assignment = await readInspectionAssignment(await harness.claim());
    await harness.start(assignment);
    const receipt = await receiveInspectionSource(harness, assignment);
    const report = await harness.report(assignment.input, receipt);
    const result = await harness.result(assignment, report);
    assertEquals(result.status, 200, await result.clone().text());
    const snapshot = await harness.snapshot(
      repository.repositoryId,
      assignment.jobId,
    );
    const profileId = assignment.input.profile.id;
    assertEquals(snapshot.active_profile_id, profileId);

    const mapping = JSON.parse(Deno.env.get(MAPPING_ENVIRONMENT)!) as {
      entries: Array<{ repositoryUuid: string; bareRepositoryPath: string }>;
    };
    const entry = mapping.entries.find(({ repositoryUuid }) =>
      repositoryUuid === repository.repositoryId
    );
    assert(entry, "the inspected repository has no trusted mapping");
    const candidate = await createCandidate(
      entry.bareRepositoryPath,
      operatorRepository,
    );
    // The profile pins the inspected snapshot as its base commit.
    assertEquals(candidate.baseSha, repository.snapshotSha);
    return {
      applicationId: repository.applicationId,
      repositoryId: repository.repositoryId,
      profileId,
      candidate,
    };
  } finally {
    await harness.close();
    await closePgDatabase(appPg);
    await closePgDatabase(ownerPg);
  }
}

/** One authenticated request to the stack's server. */
export async function call(
  client: Client,
  method: "GET" | "POST",
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers = new Headers({
    origin: client.stack.origin,
    cookie: client.cookie ?? "",
    "Bakery-Organization-Id": client.organizationId ?? "",
    ...options.headers,
  });
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  if (method !== "GET") headers.set("Idempotency-Key", crypto.randomUUID());
  return await client.stack.fetch(
    new Request(`${client.stack.origin}${path}`, {
      method,
      headers,
      body: options.body === undefined
        ? undefined
        : JSON.stringify(options.body),
    }),
  );
}

/** Calls and requires `status`, returning the parsed JSON body. */
export async function callJson<T = Record<string, unknown>>(
  client: Client,
  method: "GET" | "POST",
  path: string,
  status: number,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<T> {
  const response = await call(client, method, path, options);
  const text = await response.text();
  assertEquals(response.status, status, `${method} ${path}: ${text}`);
  return JSON.parse(text) as T;
}

/** Publishes the organization rules the run will pin (first revision). */
export async function publishOrganizationRules(
  producer: Client,
  organizationId: string,
): Promise<void> {
  await callJson(
    producer,
    "POST",
    `/v1/organizations/${organizationId}/repository-rule-versions`,
    201,
    { body: { expectedRevision: 0, entries: organizationRuleEntries() } },
  );
}

/**
 * Creates, publishes and activates a one-stage workflow whose `quality.check`
 * lists every proof command literally against the candidate commit.
 */
export async function publishCheckWorkflow(
  producer: Client,
  headSha: string,
): Promise<string> {
  const slug = `checks-proof-${crypto.randomUUID().slice(0, 8)}`;
  const workflow = await callJson<{ id: string }>(
    producer,
    "POST",
    "/v1/workflows",
    201,
    { body: { slug, name: slug, description: "Runs the proof checks." } },
  );
  const definition = {
    kind: "fixed",
    steps: [{
      id: "check",
      uses: "quality.check",
      with: {
        repositoryId: "$task.repositoryId",
        revision: headSha,
        checks: PROOF_COMMANDS.map(({ id }) => id),
      },
    }],
  };
  const draft = await callJson<{ id: string }>(
    producer,
    "POST",
    `/v1/workflows/${workflow.id}/versions`,
    201,
    { body: { definition } },
  );
  await callJson(
    producer,
    "POST",
    `/v1/workflows/${workflow.id}/versions/${draft.id}/publish`,
    200,
    { body: {}, headers: { "If-Match": '"1"' } },
  );
  const current = await callJson<{ version: number }>(
    producer,
    "GET",
    `/v1/workflows/${workflow.id}`,
    200,
  );
  await callJson(
    producer,
    "POST",
    `/v1/workflows/${workflow.id}/activations`,
    200,
    {
      body: { versionId: draft.id },
      headers: { "If-Match": `"${current.version}"` },
    },
  );
  return workflow.id;
}

export type StartedRun = {
  readonly taskId: string;
  readonly runId: string;
  readonly stepId: string;
};

/** Creates a task and starts the workflow on it in repository mode. */
export async function startCheckRun(
  stack: DurableCoreStack,
  producer: Client,
  repository: ObservedRepository,
  workflowId: string,
): Promise<StartedRun> {
  const task = await callJson<{ id: string }>(
    producer,
    "POST",
    "/v1/tasks",
    201,
    {
      body: {
        applicationId: repository.applicationId,
        repositoryId: repository.repositoryId,
        repositoryProfileId: repository.profileId,
        taskType: "feature",
        title: "Check the candidate",
        description:
          "Run the profile's fixed checks against the candidate commit.",
      },
    },
  );
  const run = await callJson<{ id: string }>(
    producer,
    "POST",
    `/v1/tasks/${task.id}/runs`,
    201,
    {
      body: {
        workflowId,
        executionMode: "repository",
        repositoryProfileId: repository.profileId,
      },
    },
  );
  const steps = await stack.psql<{ id: string; step_key: string }>(
    `select id, step_key from bakery.run_steps
      where organization_id = $1 and run_id = $2`,
    [producer.organizationId, run.id],
  );
  const step = steps.find(({ step_key }) => step_key === "check");
  assert(step, "the check step was not created");
  return { taskId: task.id, runId: run.id, stepId: step.id };
}

export type { PgDatabase };
