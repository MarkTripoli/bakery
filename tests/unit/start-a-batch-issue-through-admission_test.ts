import { assertEquals, assertRejects } from "@std/assert";
import {
  createBatchStartPort,
  listBatchCandidates,
} from "../../apps/server/src/modules/work/batch-start-port.ts";

/**
 * How a batch starts an issue (#58), without a database or a provider: the
 * candidates come in number order, each goes through the existing admission as a
 * manual request by the starter, and the first real admission wins. A refusal passes
 * the issue over with the readiness reason; a provider that does not answer passes
 * nothing over and fails the attempt, so the next tick tries again.
 */

const ORG = "22222222-2222-4222-8222-222222222222";
const REPO = "33333333-3333-4333-8333-333333333333";
const BATCH = "11111111-1111-4111-8111-111111111111";
const STARTER = "44444444-4444-4444-8444-444444444444";

type Candidate = { id: string; source_id: string; number: number };

/**
 * The candidate query answers with the candidates. The audit lookup (did this batch admit the
 * request?) answers with a row only for the request ids named in `madeByBatch`.
 */
function transaction(candidates: Candidate[], madeByBatch: string[] = []) {
  const queries: { sql: string; values: unknown[] }[] = [];
  return {
    queries,
    transaction: {
      query: (sql: string, values: unknown[] = []) => {
        queries.push({ sql, values });
        const rows = sql.includes("bakery.audit_events")
          ? (madeByBatch.includes(values[1] as string)
            ? [{ "?column?": 1 }]
            : [])
          : candidates;
        return Promise.resolve({ rows, rowCount: rows.length });
      },
    } as never,
  };
}

const candidate = (number: number): Candidate => ({
  id: `ticket-${number}`,
  source_id: "source-1",
  number,
});

type Verdict =
  | { kind: "admitted"; id: string }
  | { kind: "existing" }
  | { kind: "unadmitted"; reason: string };

function harness(verdicts: Record<number, Verdict>) {
  const calls: {
    number: number;
    caller: unknown;
    call: Record<string, unknown>;
  }[] = [];
  const resolved: string[] = [];
  const admit = ((_deps: unknown, call: Record<string, unknown>) => {
    const number = call.number as number;
    calls.push({ number, caller: call.caller, call });
    const verdict = verdicts[number];
    return Promise.resolve({
      kind: verdict.kind,
      request: verdict.kind === "unadmitted"
        ? null
        : { id: (verdict as { id?: string }).id ?? "existing-request" },
      report: {
        checks: verdict.kind === "unadmitted"
          ? [{ status: "fail", reason: verdict.reason, evidence: [] }]
          : [{ status: "pass" }],
      },
      storedReport: null,
      ticketId: `ticket-${number}`,
    });
  }) as never;
  const port = (rows: Candidate[], madeByBatch: string[] = []) => {
    const t = transaction(rows, madeByBatch);
    const start = createBatchStartPort({
      database: {} as never,
      reader: {} as never,
      budget: undefined,
      admit,
      resolveCaller: (_database, _org, principal) => {
        resolved.push(principal);
        return Promise.resolve({ role: "developer", principal } as never);
      },
    });
    return {
      start: () =>
        start(t.transaction, {
          organizationId: ORG,
          batchId: BATCH,
          repositoryId: REPO,
          startedBy: STARTER,
        }),
      queries: t.queries,
    };
  };
  return { calls, resolved, port };
}

Deno.test("the first real admission wins, as the starter, with the issues passed over before it named by their reason", async () => {
  const h = harness({
    7: { kind: "unadmitted", reason: "dependency_open" },
    8: { kind: "unadmitted", reason: "epic" },
    9: { kind: "admitted", id: "request-9" },
    10: { kind: "admitted", id: "request-10" },
  });
  const result = await h.port([7, 8, 9, 10].map(candidate)).start();
  assertEquals(result, {
    started: true,
    externalTicketId: "ticket-9",
    ticketRequestId: "request-9",
    passedOver: [
      { externalTicketId: "ticket-7", reason: "dependency_open" },
      { externalTicketId: "ticket-8", reason: "epic" },
    ],
  });
  // Issue 10 was never asked: the batch starts one at a time.
  assertEquals(h.calls.map((call) => call.number), [7, 8, 9]);
  // Each is an explicit manual start by the starter, reading the provider itself.
  for (const call of h.calls) {
    assertEquals(call.call.origin, "manual");
    assertEquals(call.call.intent, "start");
    assertEquals(call.call.prefetch, null);
    assertEquals(call.call.organizationId, ORG);
  }
});

Deno.test("the starter's authority is resolved fresh for every issue, so a revocation between issues stops the rest", async () => {
  const h = harness({
    1: { kind: "unadmitted", reason: "not_ready" },
    2: { kind: "unadmitted", reason: "not_ready" },
    3: { kind: "admitted", id: "r3" },
  });
  await h.port([1, 2, 3].map(candidate)).start();
  assertEquals(h.resolved, [STARTER, STARTER, STARTER]);
});

Deno.test("an issue someone already requested is not the batch's to take", async () => {
  const h = harness({
    4: { kind: "existing" },
    5: { kind: "admitted", id: "r5" },
  });
  const result = await h.port([4, 5].map(candidate)).start();
  assertEquals(result, {
    started: true,
    externalTicketId: "ticket-5",
    ticketRequestId: "r5",
    passedOver: [{ externalTicketId: "ticket-4", reason: "already_requested" }],
  });
});

Deno.test("when nothing can start, every candidate is passed over and the batch is told so", async () => {
  const h = harness({
    1: { kind: "unadmitted", reason: "dependency_open" },
    2: { kind: "unadmitted", reason: "changed_since_check" },
  });
  const result = await h.port([1, 2].map(candidate)).start();
  assertEquals(result, {
    started: false,
    passedOver: [
      { externalTicketId: "ticket-1", reason: "dependency_open" },
      { externalTicketId: "ticket-2", reason: "changed_since_check" },
    ],
  });
  // No candidates at all is the same answer, with nothing to list.
  const none = await harness({}).port([]).start();
  assertEquals(none, { started: false, passedOver: [] });
});

Deno.test("a provider that does not answer passes nothing over: the attempt fails and is tried again", async () => {
  const h = harness({
    1: { kind: "unadmitted", reason: "dependency_open" },
    2: { kind: "unadmitted", reason: "provider_unavailable" },
    3: { kind: "admitted", id: "r3" },
  });
  const error = await assertRejects(
    () => h.port([1, 2, 3].map(candidate)).start(),
    Error,
  );
  assertEquals(error.message, "PROVIDER_UNAVAILABLE");
  // It stopped there: issue 3 was not tried on a provider that is not answering.
  assertEquals(h.calls.map((call) => call.number), [1, 2]);
});

Deno.test("candidates are the repository's open issues in number order, minus those the batch already took", async () => {
  const t = transaction([candidate(3), candidate(5)]);
  const found = await listBatchCandidates(t.transaction, {
    organizationId: ORG,
    repositoryId: REPO,
    batchId: BATCH,
  });
  assertEquals(found, [
    { id: "ticket-3", sourceId: "source-1", number: 3 },
    { id: "ticket-5", sourceId: "source-1", number: 5 },
  ]);
  const { sql, values } = t.queries[0];
  assertEquals(values.slice(0, 3), [ORG, REPO, BATCH]);
  // Number order, a numeric one (text "10" sorts before "9" otherwise).
  assertEquals(/order by ticket\.number::int asc/.test(sql), true);
  // Only enabled sources and open issues.
  assertEquals(/source\.enabled/.test(sql), true);
  assertEquals(/ticket\.state = 'open'/.test(sql), true);
  // Anything the batch took and did not merely pass over is excluded; a passed-over
  // issue stays a candidate because GitHub is read again each time.
  assertEquals(/taken\.state <> 'passed_over'/.test(sql), true);
});

Deno.test("an issue this batch admitted on an earlier tick that lost its transaction is taken back as the started one", async () => {
  const h = harness({
    7: { kind: "unadmitted", reason: "dependency_open" },
    8: { kind: "existing" },
    9: { kind: "admitted", id: "request-9" },
  });
  // The admission committed in its own transaction, then the tick failed before recording the
  // issue. The audit row admission wrote under this batch's trace id is how it is recognised.
  const adopting = h.port([7, 8, 9].map(candidate), ["existing-request"]);
  const result = await adopting.start();
  assertEquals(result, {
    started: true,
    externalTicketId: "ticket-8",
    ticketRequestId: "existing-request",
    passedOver: [{ externalTicketId: "ticket-7", reason: "dependency_open" }],
  });
  // It asked who made the request with this batch's trace id, and never admitted issue 9.
  const lookup = adopting.queries.find((q) =>
    q.sql.includes("bakery.audit_events")
  );
  assertEquals(lookup?.values, [ORG, "existing-request", `batch:${BATCH}`]);
  assertEquals(h.calls.map((c) => c.number), [7, 8]);
});

Deno.test("a request a person made for the issue is not taken, even with a batch's other requests around", async () => {
  const h = harness({
    8: { kind: "existing" },
    9: { kind: "admitted", id: "request-9" },
  });
  // Another request id is the batch's own; this one is not.
  const result = await h.port([8, 9].map(candidate), ["some-other-request"])
    .start();
  assertEquals(result, {
    started: true,
    externalTicketId: "ticket-9",
    ticketRequestId: "request-9",
    passedOver: [{ externalTicketId: "ticket-8", reason: "already_requested" }],
  });
});
