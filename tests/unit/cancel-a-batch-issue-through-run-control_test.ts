import { assertEquals, assertRejects } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import { createBatchCancelPort } from "../../apps/server/src/modules/work/batch-cancel-port.ts";

/**
 * How a batch cancels an issue's run (#58), without a database or an engine: through
 * the existing run control as the person who started the batch, once per request, with
 * a run that has already ended counted as done.
 */

const ORG = "22222222-2222-4222-8222-222222222222";
const STARTER = "44444444-4444-4444-8444-444444444444";
const REQUEST = "55555555-5555-4555-8555-555555555555";
const RUN = "66666666-6666-4666-8666-666666666666";

function transaction(runId: string | null) {
  return {
    query: () => Promise.resolve({ rows: [{ run_id: runId }], rowCount: 1 }),
  } as never;
}

function harness(control: (context: never, input: never) => Promise<unknown>) {
  const resolved: string[] = [];
  const port = createBatchCancelPort({
    database: {} as never,
    resolveCaller: (_database, _org, principal) => {
      resolved.push(principal);
      return Promise.resolve({ role: "developer", principal } as never);
    },
    control: control as never,
  });
  return { port, resolved };
}

const input = {
  organizationId: ORG,
  ticketRequestId: REQUEST,
  startedBy: STARTER,
};

Deno.test("a request with no run has nothing to cancel, and the starter is not even resolved", async () => {
  const calls: unknown[] = [];
  const h = harness((context) => {
    calls.push(context);
    return Promise.resolve({});
  });
  await h.port(transaction(null), input);
  assertEquals(calls, []);
  assertEquals(h.resolved, []);
});

Deno.test("a run is cancelled once through run control, as the starter, with a key tied to the request", async () => {
  const seen: { context: Record<string, unknown>; input: unknown }[] = [];
  const h = harness((context, body) => {
    seen.push({
      context: context as unknown as Record<string, unknown>,
      input: body,
    });
    return Promise.resolve({});
  });
  await h.port(transaction(RUN), input);
  assertEquals(seen.length, 1);
  const { context, input: body } = seen[0];
  assertEquals((body as { action: string }).action, "cancel");
  assertEquals((context.params as { id: string }).id, RUN);
  assertEquals(
    (context.principal as { principalId: string }).principalId,
    STARTER,
  );
  // The starter's live authority, not a service identity.
  assertEquals((context.authority as { principal: string }).principal, STARTER);
  assertEquals(h.resolved, [STARTER]);
  // One stable key per request, so a repeat sends one command.
  const metadata = context.commandMetadata as {
    operation: string;
    idempotencyKey: string;
    target: string;
  };
  assertEquals(metadata.operation, "runs.control");
  assertEquals(metadata.idempotencyKey, `batch-cancel:${REQUEST}`);
  assertEquals(metadata.target, RUN);
  assertEquals(context.requestId, `batch-cancel:${REQUEST}`);
});

Deno.test("a run that has already ended is the answer a cancel wants; any other failure is a failure", async () => {
  const ended = harness(() =>
    Promise.reject(new StandardError({ code: "ALREADY_TERMINAL" }))
  );
  await ended.port(transaction(RUN), input);
  for (
    const code of [
      "STATE_CONFLICT",
      "AUTH_FORBIDDEN",
      "RESOURCE_NOT_FOUND",
    ] as const
  ) {
    const failing = harness(() => Promise.reject(new StandardError({ code })));
    const error = await assertRejects(
      () => failing.port(transaction(RUN), input),
      StandardError,
    );
    assertEquals(error.code, code);
  }
  const broken = harness(() => Promise.reject(new Error("boom")));
  await assertRejects(
    () => broken.port(transaction(RUN), input),
    Error,
    "boom",
  );
});
