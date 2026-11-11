import { assertEquals, assertExists } from "@std/assert";
import { createSuperuser } from "../../../../apps/server/src/modules/auth/index.ts";
import {
  closePgDatabase,
  openPgDatabase,
} from "../../../../apps/server/src/platform/database.ts";
import { readRuntimeConfig } from "../../../../packages/config/src/env.ts";
import { authRequest, sessionCookie } from "../../../helpers/auth.ts";
import {
  type JobSeed,
  seedFundedModelJob,
  workerFixtureCapabilities,
} from "../../../helpers/worker-execution.ts";
import type { Stack } from "../stack.ts";

export type ArtifactRef = {
  artifactId: string;
  versionId: string;
  sha256: string;
};

export type DurableWorkerAssignment = {
  attemptId: string;
  leaseToken: string;
  fence: string;
  workerHostId: string;
  runStepId: string;
  workerSessionId: string;
  workerSessionGeneration: string;
};

type ProducerState = {
  credential: string;
  assignment: DurableWorkerAssignment;
};
export type Client = {
  readonly stack: Stack;
  readonly organizationId?: string;
  readonly cookie?: string;
  readonly producer?: ProducerState;
};

export type DurableArtifactIdentity = {
  email: string;
  password: string;
  organizationId: string;
  principalId: string;
};

export type DurableArtifactClients = {
  identity: DurableArtifactIdentity;
  job: JobSeed;
  producer: Client;
  consumer: Client;
  foreign: Client;
  anonymous: Client;
};

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as unknown as BufferSource,
  );
  return Array.from(
    new Uint8Array(digest),
    (value) => value.toString(16).padStart(2, "0"),
  ).join("");
}

function jsonHeaders(
  client: Client,
  headers: HeadersInit = {},
): Headers {
  const result = new Headers(headers);
  result.set("origin", client.stack.origin);
  if (client.cookie) result.set("cookie", client.cookie);
  if (client.organizationId) {
    result.set("Bakery-Organization-Id", client.organizationId);
  }
  return result;
}

async function request(
  client: Client,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = jsonHeaders(client, init.headers);
  const body = init.body === undefined || init.body === null
    ? undefined
    : init.body instanceof FormData || init.body instanceof Uint8Array
    ? init.body
    : typeof init.body === "string"
    ? init.body
    : await new Response(init.body).arrayBuffer();
  return await client.stack.fetch(
    new Request(`${client.stack.origin}${path}`, {
      ...init,
      headers,
      body,
    }),
  );
}

async function postJson(
  client: Client,
  path: string,
  body: unknown,
  headers: HeadersInit = {},
): Promise<Response> {
  const requestHeaders = jsonHeaders(client);
  requestHeaders.set("content-type", "application/json");
  for (const [key, value] of new Headers(headers)) {
    requestHeaders.set(key, value);
  }
  return await client.stack.fetch(
    new Request(`${client.stack.origin}${path}`, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify(body),
    }),
  );
}

export type DurableWorkerEvent = {
  readonly eventId: string;
  readonly localSeq: string;
  readonly eventType: string;
  readonly payload: unknown;
};

function workerHeaders(
  client: Client,
  idempotencyKey: string,
  requestMetadata: {
    readonly requestId?: string;
    readonly traceId?: string;
  } = {},
): Headers {
  if (!client.producer) throw new Error("DURABLE_CORE_PRODUCER_REQUIRED");
  const headers = new Headers();
  headers.set("authorization", `Bearer ${client.producer.credential}`);
  headers.set("Idempotency-Key", idempotencyKey);
  headers.set("X-Bakery-Worker-Protocol-Version", "2");
  if (requestMetadata.requestId !== undefined) {
    headers.set("x-request-id", requestMetadata.requestId);
  }
  if (requestMetadata.traceId !== undefined) {
    const traceId = requestMetadata.traceId.replaceAll("-", "");
    if (!/^[\da-f]{32}$/i.test(traceId)) {
      throw new Error("DURABLE_CORE_TRACE_ID_INVALID");
    }
    headers.set("x-trace-id", requestMetadata.traceId);
    headers.set(
      "traceparent",
      `00-${traceId}-${
        crypto.randomUUID().replaceAll("-", "").slice(0, 16)
      }-01`,
    );
  }
  return headers;
}

export async function postWorkerEvents(
  client: Client,
  events: readonly DurableWorkerEvent[],
): Promise<Response> {
  if (!client.producer) throw new Error("DURABLE_CORE_PRODUCER_REQUIRED");
  const tail = events.at(-1);
  if (!tail) throw new Error("DURABLE_CORE_EVENTS_REQUIRED");
  const assignment = client.producer.assignment;
  return await postJson(
    { ...client, cookie: undefined },
    `/v1/worker/attempts/${assignment.attemptId}/events`,
    {
      leaseToken: assignment.leaseToken,
      fence: assignment.fence,
      workerSessionId: assignment.workerSessionId,
      workerSessionGeneration: assignment.workerSessionGeneration,
      events,
    },
    workerHeaders(client, tail.eventId),
  );
}

export async function postWorkerResult(
  client: Client,
  input: {
    readonly localSeq: string;
    readonly status: "completed" | "failed" | "canceled";
    readonly result?: unknown;
    readonly fault?: unknown;
    readonly cancellation?: unknown;
  },
  idempotencyKey: string,
  requestMetadata: {
    readonly requestId?: string;
    readonly traceId?: string;
  } = {},
): Promise<Response> {
  if (!client.producer) throw new Error("DURABLE_CORE_PRODUCER_REQUIRED");
  const assignment = client.producer.assignment;
  return await postJson(
    { ...client, cookie: undefined },
    `/v1/worker/attempts/${assignment.attemptId}/result`,
    {
      leaseToken: assignment.leaseToken,
      fence: assignment.fence,
      workerSessionId: assignment.workerSessionId,
      workerSessionGeneration: assignment.workerSessionGeneration,
      ...input,
    },
    workerHeaders(client, idempotencyKey, requestMetadata),
  );
}

export function withWorkerAssignment(
  client: Client,
  patch: Partial<DurableWorkerAssignment>,
): Client {
  if (!client.producer) throw new Error("DURABLE_CORE_PRODUCER_REQUIRED");
  return {
    ...client,
    producer: {
      ...client.producer,
      assignment: {
        ...client.producer.assignment,
        ...patch,
      },
    },
  };
}

export async function fetchRunSteps(
  client: Client,
  runId: string,
  cursor?: string,
  requestMetadata: {
    readonly requestId?: string;
    readonly traceId?: string;
  } = {},
): Promise<Response> {
  const query = new URLSearchParams({ limit: "25" });
  if (cursor) query.set("cursor", cursor);
  const headers = new Headers();
  if (requestMetadata.requestId !== undefined) {
    headers.set("x-request-id", requestMetadata.requestId);
  }
  if (requestMetadata.traceId !== undefined) {
    const traceId = requestMetadata.traceId.replaceAll("-", "");
    if (!/^[\da-f]{32}$/i.test(traceId)) {
      throw new Error("DURABLE_CORE_TRACE_ID_INVALID");
    }
    headers.set("x-trace-id", requestMetadata.traceId);
    headers.set(
      "traceparent",
      `00-${traceId}-${
        crypto.randomUUID().replaceAll("-", "").slice(0, 16)
      }-01`,
    );
  }
  return await request(
    client,
    `/v1/runs/${runId}/steps?${query.toString()}`,
    { headers },
  );
}

export async function fetchTaskSync(
  client: Client,
  taskId: string,
  after?: string,
): Promise<Response> {
  const query = new URLSearchParams({
    scopeType: "task",
    scopeId: taskId,
  });
  if (after) query.set("after", after);
  return await request(client, `/v1/sync?${query.toString()}`);
}

async function createBrowserClient(
  stack: Stack,
  email: string,
  password: string,
  organizationId: string,
): Promise<Client> {
  const signIn = await stack.fetch(
    authRequest("/api/auth/sign-in/email", { email, password }),
  );
  assertEquals(signIn.status, 200, await signIn.clone().text());
  return { stack, organizationId, cookie: sessionCookie(signIn) };
}

async function createForeignOrganization(
  stack: Stack,
  principalId: string,
): Promise<string> {
  const organizationId = crypto.randomUUID();
  const now = new Date();
  await stack.psql(
    `insert into bakery.organizations (
       id, name, slug, metadata, created_at, updated_at, version
     ) values ($1, $2, $3, '{}'::jsonb, $4, $4, 1)`,
    [
      organizationId,
      "Durable Core Foreign",
      `durable-core-${organizationId}`,
      now,
    ],
  );
  await stack.psql(
    `insert into bakery.organization_memberships (
       id, organization_id, principal_id, role, status,
       joined_at, created_at, updated_at, version
     ) values ($1, $2, $3, 'admin', 'active', $4, $4, $4, 1)`,
    [crypto.randomUUID(), organizationId, principalId, now],
  );
  return organizationId;
}

async function registerProducer(
  client: Client,
  job: JobSeed,
): Promise<ProducerState> {
  const workerName = `durable-core-worker-${crypto.randomUUID()}`;
  const enrollment = await postJson(
    client,
    "/v1/worker-enrollments",
    {
      name: workerName,
      os: "linux",
      architecture: "x64",
      capabilities: workerFixtureCapabilities,
      slots: 1,
    },
    { "Idempotency-Key": `durable-core-enrollment-${crypto.randomUUID()}` },
  );
  assertEquals(enrollment.status, 201, await enrollment.clone().text());
  const enrollmentBody = await enrollment.json() as { enrollmentToken: string };
  const credential = btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
  );
  const registration = await postJson(
    { ...client, cookie: undefined },
    "/v1/worker/registration",
    {
      enrollmentToken: enrollmentBody.enrollmentToken,
      workerCredential: credential,
      name: workerName,
      os: "linux",
      architecture: "x64",
      capabilities: workerFixtureCapabilities,
      toolchainVersions: { deno: "2.x" },
      slots: 1,
    },
    {
      "Idempotency-Key": `durable-core-registration-${crypto.randomUUID()}`,
      "X-Bakery-Worker-Protocol-Version": "2",
    },
  );
  assertEquals(registration.status, 200, await registration.clone().text());
  const registrationBody = await registration.json() as {
    workerHostId: string;
  };
  const heartbeat = await postJson(
    { ...client, cookie: undefined },
    "/v1/worker/heartbeat",
    {
      workerHostId: registrationBody.workerHostId,
      observedAt: "2026-09-20T00:00:00.000Z",
      load: 0,
      activeAttemptIds: [],
      ackCommandIds: [],
      rejectedCommandIds: [],
      workerSessionId: crypto.randomUUID(),
      workerSessionGeneration: "0",
    },
    {
      authorization: `Bearer ${credential}`,
      "Idempotency-Key": `durable-core-heartbeat-${crypto.randomUUID()}`,
      "X-Bakery-Worker-Protocol-Version": "2",
    },
  );
  assertEquals(heartbeat.status, 200, await heartbeat.clone().text());
  const heartbeatBody = await heartbeat.json() as {
    workerSessionId: string;
    workerSessionGeneration: string;
  };
  const claimKey = crypto.randomUUID();
  const claim = await postJson(
    { ...client, cookie: undefined },
    "/v1/worker/claims",
    {
      claimKey,
      workerHostId: registrationBody.workerHostId,
      capabilities: workerFixtureCapabilities,
      workerSessionId: heartbeatBody.workerSessionId,
      workerSessionGeneration: heartbeatBody.workerSessionGeneration,
    },
    {
      authorization: `Bearer ${credential}`,
      "Idempotency-Key": claimKey,
      "X-Bakery-Worker-Protocol-Version": "2",
    },
  );
  assertEquals(claim.status, 200, await claim.clone().text());
  const assignment = await claim.json() as {
    attemptId: string;
    leaseToken: string;
    fence: string;
    workerHostId: string;
  };
  return {
    credential,
    assignment: {
      ...assignment,
      runStepId: job.runStepId,
      workerSessionId: heartbeatBody.workerSessionId,
      workerSessionGeneration: heartbeatBody.workerSessionGeneration,
    },
  };
}

export async function createDurableArtifactClients(
  stack: Stack,
  reuse?: DurableArtifactClients,
): Promise<DurableArtifactClients> {
  const identity = reuse?.identity;
  const suffix = crypto.randomUUID();
  const email = identity?.email ?? `durable-core-${suffix}@example.test`;
  const password = identity?.password ?? `Durable-Core-${suffix}`;
  const database = openPgDatabase(stack.ownerDatabaseUrl);
  try {
    if (!identity) {
      const config = readRuntimeConfig({
        BAKERY_ENV: "test",
        BAKERY_APP_DATABASE_URL: stack.ownerDatabaseUrl,
        BAKERY_PUBLIC_BASE_URL: stack.origin,
        BETTER_AUTH_SECRET: stack.authSecret,
      }).auth!;
      await createSuperuser({ pgDatabase: database, config }, {
        email,
        displayName: "Durable Core Producer",
        password,
      });
    }
    let durableIdentity = identity;
    if (!durableIdentity) {
      const principal = await database.query<{
        organizationId: string;
        principalId: string;
      }>(
        `select membership.organization_id as "organizationId",
                membership.principal_id as "principalId"
           from bakery.organization_memberships as membership
          where membership.role = 'admin'
            and membership.status = 'active'
            and membership.principal_id = (
              select principal.id from bakery.principals as principal
              join public."user" as provider_user
                on provider_user.id = principal.provider_user_id
              where provider_user.email = $1
            )
          order by membership.created_at desc
          limit 1`,
        [email],
      );
      assertExists(principal.rows[0]);
      durableIdentity = {
        email,
        password,
        organizationId: principal.rows[0].organizationId,
        principalId: principal.rows[0].principalId,
      };
    }
    const { organizationId, principalId } = durableIdentity;
    const foreignOrganizationId = reuse?.foreign.organizationId ??
      await createForeignOrganization(stack, principalId);
    let producerSession: Client;
    let consumer: Client;
    let foreign: Client;
    if (reuse) {
      assertExists(reuse.producer.cookie);
      producerSession = {
        stack,
        organizationId,
        cookie: reuse.producer.cookie,
      };
      consumer = reuse.consumer;
      foreign = reuse.foreign;
    } else {
      producerSession = await createBrowserClient(
        stack,
        email,
        password,
        organizationId,
      );
      consumer = await createBrowserClient(
        stack,
        email,
        password,
        organizationId,
      );
      foreign = await createBrowserClient(
        stack,
        email,
        password,
        foreignOrganizationId,
      );
    }
    const job = await seedFundedModelJob(
      database,
      organizationId,
      principalId,
      { action: "harness.implement" },
    );
    const producer = {
      ...producerSession,
      producer: await registerProducer(producerSession, job),
    };
    return {
      identity: durableIdentity,
      job,
      producer,
      consumer,
      foreign,
      anonymous: { stack, organizationId },
    };
  } finally {
    await closePgDatabase(database);
  }
}

async function publicationRequest(
  client: Client,
  bytes: Uint8Array,
  effectKey: string,
): Promise<Request> {
  if (!client.producer || !client.organizationId) {
    throw new Error("DURABLE_CORE_PRODUCER_REQUIRED");
  }
  const { credential, assignment } = client.producer;
  const digest = await sha256(bytes);
  const form = new FormData();
  form.set("leaseToken", assignment.leaseToken);
  form.set("fence", assignment.fence);
  form.set("workerSessionId", assignment.workerSessionId);
  form.set("workerSessionGeneration", assignment.workerSessionGeneration);
  form.set("artifactType", "patch");
  form.set("name", "durable-core-terminal-artifact");
  form.set("contentType", "application/octet-stream");
  form.set("contentDigest", digest);
  form.set("runStepId", assignment.runStepId);
  form.set("stepKey", "worker");
  form.set("metadata", JSON.stringify({ source: "issue-43", immutable: true }));
  form.set(
    "content",
    new File([bytes.slice().buffer as ArrayBuffer], "durable-core.bin"),
  );
  return new Request(
    `${client.stack.origin}/v1/worker/attempts/${assignment.attemptId}/artifacts`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential}`,
        "idempotency-key": effectKey,
        "X-Bakery-Worker-Protocol-Version": "2",
      },
      body: form,
    },
  );
}

export async function publishArtifactResponse(
  client: Client,
  bytes: Uint8Array,
  effectKey: string,
): Promise<Response> {
  return await client.stack.fetch(
    await publicationRequest(client, bytes, effectKey),
  );
}

export async function publishArtifact(
  client: Client,
  bytes: Uint8Array,
  effectKey: string,
): Promise<ArtifactRef> {
  const response = await publishArtifactResponse(client, bytes, effectKey);
  assertEquals(response.status, 201, await response.clone().text());
  const body = await response.json() as {
    id: string;
    artifactId: string;
    sha256: string;
  };
  return {
    artifactId: body.artifactId,
    versionId: body.id,
    sha256: body.sha256,
  };
}

export async function fetchArtifact(
  client: Client,
  ref: ArtifactRef,
): Promise<Response> {
  return await request(
    client,
    `/v1/artifact-versions/${ref.versionId}/content`,
  );
}

export async function fetchArtifactMetadata(
  client: Client,
  ref: ArtifactRef,
): Promise<Response> {
  return await request(client, `/v1/artifacts/${ref.artifactId}`);
}

export async function fetchArtifactVersionMetadata(
  client: Client,
  ref: ArtifactRef,
): Promise<Response> {
  return await request(client, `/v1/artifacts/${ref.artifactId}/versions`);
}
