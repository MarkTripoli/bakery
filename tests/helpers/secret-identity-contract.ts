import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  contractSchemas,
  workerActionOutputSchema,
} from "../../packages/contracts/src/contracts.ts";
import {
  SealedCredentialOperationSchema,
  SecretIdentityReadInputSchema,
  SecretIdentityToolResultSchema,
} from "../../packages/contracts/src/secret-identity.ts";
import { WorkerApiClient } from "../../apps/worker/src/client.ts";
import {
  createPreparedSecretInvoker,
  PreparedSecretInvocationError,
} from "../../apps/worker/src/prepared-secret-invoker.ts";
import type { JobAssignment } from "../../apps/worker/src/types.ts";

function canonical(value: unknown): string {
  const normalize = (entry: unknown): unknown => {
    if (
      entry === null || typeof entry === "string" ||
      typeof entry === "boolean"
    ) return entry;
    if (typeof entry === "number" && Number.isFinite(entry)) return entry;
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry !== null && typeof entry === "object") {
      return Object.fromEntries(
        Object.keys(entry).sort().map((key) => [
          key,
          normalize((entry as Record<string, unknown>)[key]),
        ]),
      );
    }
    throw new Error("INVALID_JSON");
  };
  return JSON.stringify(normalize(value));
}

async function digest(value: unknown): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(canonical(value)),
    ),
  );
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function identityAssignment(): Promise<JobAssignment> {
  const input = { secretRef: crypto.randomUUID() };
  const attemptId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  return contractSchemas.JobAssignment.parse({
    jobId,
    attemptId,
    workerHostId: crypto.randomUUID(),
    leaseToken: "l".repeat(43),
    fence: "3",
    leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
    action: "secret.identity.read",
    requirements: { capabilities: ["secret.identity"] },
    input,
    currentCheckpoints: [],
    agentConfig: {},
    skillRefs: [],
    agentVersionId: null,
    billing: null,
    installationReservationId: null,
    workerSessionId: crypto.randomUUID(),
    workerSessionGeneration: "4",
    leaseDurationSeconds: 45,
    serverTime: new Date().toISOString(),
    sealedCredentialOperation: {
      preparedOperationId: crypto.randomUUID(),
      jobId,
      attemptId,
      inputDigest: await digest(input),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    },
  }) as JobAssignment;
}

export function registerSecretIdentityContractTests(prefix: string): void {
  Deno.test(`${prefix}: identity input and safe output are strict and bounded`, () => {
    const secretRef = crypto.randomUUID();
    assertEquals(SecretIdentityReadInputSchema.parse({ secretRef }), {
      secretRef,
    });
    assert(
      !SecretIdentityReadInputSchema.safeParse({
        secretRef,
        provider: "github",
      }).success,
    );
    assert(
      !SecretIdentityReadInputSchema.safeParse({
        secretRef,
        preparedOperationId: crypto.randomUUID(),
      }).success,
    );
    assert(
      SecretIdentityToolResultSchema.safeParse({
        status: "completed",
        accountId: "1234567890123456",
        login: "bakery-test",
      }).success,
    );
    assert(
      !SecretIdentityToolResultSchema.safeParse({
        status: "completed",
        accountId: "12345678901234567",
        login: "bakery-test",
      }).success,
    );
    assert(
      !SecretIdentityToolResultSchema.safeParse({
        status: "uncertain",
        code: "PROVIDER_OUTCOME_UNCERTAIN",
        rawBody: "forbidden",
      }).success,
    );
    assert(
      workerActionOutputSchema("secret.identity.read") ===
        SecretIdentityToolResultSchema,
    );
  });

  Deno.test(`${prefix}: generated assignment requires one nullable sealed field`, async () => {
    const assignment = await identityAssignment();
    assert(
      SealedCredentialOperationSchema.safeParse(
        assignment.sealedCredentialOperation,
      ).success,
    );
    const nonIdentity = {
      ...assignment,
      action: "quality.check",
      input: {
        repositoryId: crypto.randomUUID(),
        revision: "fixture",
        checks: ["source.integrity"],
      },
      sealedCredentialOperation: null,
    };
    assert(contractSchemas.JobAssignment.safeParse(nonIdentity).success);
    const missing = { ...nonIdentity } as Record<string, unknown>;
    delete missing.sealedCredentialOperation;
    assert(!contractSchemas.JobAssignment.safeParse(missing).success);
    assert(
      !contractSchemas.JobAssignment.safeParse({
        ...assignment,
        input: {
          ...(assignment.input as Record<string, unknown>),
          account: "caller-selected",
        },
      }).success,
    );
  });

  Deno.test(`${prefix}: daemon invocation uses only sealed operation and lease proof`, async () => {
    const assignment = await identityAssignment();
    const requests: Request[] = [];
    const client = new WorkerApiClient({
      baseUrl: "https://worker.example.test",
      credential: "worker-credential",
      fetcher: (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return Promise.resolve(Response.json({
          status: "completed",
          accountId: "42",
          login: "bakery-test",
        }, {
          headers: { "X-Bakery-Worker-Protocol-Version": "2" },
        }));
      },
    });
    const outcome = await createPreparedSecretInvoker(client).invoke(
      assignment,
      {
        workerSessionId: assignment.workerSessionId!,
        workerSessionGeneration: assignment.workerSessionGeneration!,
      },
      new AbortController().signal,
    );
    assertEquals(outcome, {
      status: "completed",
      result: { status: "completed", accountId: "42", login: "bakery-test" },
    });
    assertEquals(requests.length, 1);
    const request = requests[0]!;
    assertEquals(
      request.url,
      `https://worker.example.test/v1/worker/attempts/${assignment.attemptId}/tools/secrets`,
    );
    assertEquals(
      request.headers.get("Idempotency-Key"),
      assignment.sealedCredentialOperation!.preparedOperationId,
    );
    assertEquals(
      request.headers.get("X-Worker-Lease-Token"),
      assignment.leaseToken,
    );
    assertEquals(request.headers.get("X-Worker-Fence"), assignment.fence);
    assertEquals(await request.clone().json(), {
      preparedOperationId: assignment.sealedCredentialOperation!
        .preparedOperationId,
    });
    const wire = JSON.stringify({
      url: request.url,
      headers: Object.fromEntries(request.headers),
      body: await request.clone().text(),
    });
    assert(
      !wire.includes(
        (assignment.input as { secretRef: string }).secretRef,
      ),
    );
    assert(!wire.includes("provider"));
    assert(!wire.includes("account"));
  });

  Deno.test(`${prefix}: transport failure is unpublished and never becomes a result`, async () => {
    const assignment = await identityAssignment();
    const client = new WorkerApiClient({
      baseUrl: "https://worker.example.test",
      credential: "worker-credential",
      fetcher: () => Promise.reject(new TypeError("controlled network loss")),
    });
    const error = await assertRejects(
      () =>
        createPreparedSecretInvoker(client).invoke(assignment, {
          workerSessionId: assignment.workerSessionId!,
          workerSessionGeneration: assignment.workerSessionGeneration!,
        }, new AbortController().signal),
      PreparedSecretInvocationError,
      "PREPARED_SECRET_INVOCATION_UNPUBLISHED",
    );
    assert(error.cause instanceof Error);
  });

  Deno.test(`${prefix}: invoker rejects a changed assignment digest before HTTP`, async () => {
    const assignment = await identityAssignment();
    let calls = 0;
    const client = new WorkerApiClient({
      baseUrl: "https://worker.example.test",
      credential: "worker-credential",
      fetcher: () => {
        calls += 1;
        return Promise.resolve(new Response());
      },
    });
    await assertRejects(
      () =>
        createPreparedSecretInvoker(client).invoke({
          ...assignment,
          input: { secretRef: crypto.randomUUID() },
        }, {
          workerSessionId: assignment.workerSessionId!,
          workerSessionGeneration: assignment.workerSessionGeneration!,
        }, new AbortController().signal),
      PreparedSecretInvocationError,
      "PREPARED_SECRET_INVOCATION_UNPUBLISHED",
    );
    assertEquals(calls, 0);
  });
}
