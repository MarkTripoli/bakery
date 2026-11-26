import { assert, assertEquals } from "@std/assert";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";
import { WorkerApiClient } from "../../apps/worker/src/client.ts";
import { errorFault } from "../../apps/worker/src/supervisor-support.ts";
import {
  fitFaultText,
  PROBLEM_DETAIL_MAX_LENGTH,
} from "../../apps/worker/src/fault-text.ts";

const mismatches = Array.from(
  { length: 12 },
  (_, index) =>
    `context file inputs/file-${index}.md changed since it was pinned: expected sha256 ${
      "a".repeat(64)
    }, found ${"b".repeat(64)}`,
).join("; ");

Deno.test("a fault longer than the published limits is trimmed before the result is sent", async () => {
  assert(mismatches.length > PROBLEM_DETAIL_MAX_LENGTH);
  const sent: unknown[] = [];
  const client = new WorkerApiClient({
    baseUrl: "https://bakery.example.test",
    credential: "worker-credential",
    fetcher: (_input, init) => {
      sent.push(JSON.parse(String((init as RequestInit).body)));
      return Promise.resolve(new Response("{}", { status: 503 }));
    },
  });
  const body = {
    leaseToken: "lease-token",
    fence: "1",
    workerSessionId: crypto.randomUUID(),
    workerSessionGeneration: "1",
    localSeq: "1",
    status: "failed",
    fault: errorFault("CONTEXT_SEEDING_FAILED", mismatches),
  } as Parameters<WorkerApiClient["postResult"]>[1];
  await client.postResult(crypto.randomUUID(), body, crypto.randomUUID())
    .catch(() => undefined);
  assertEquals(sent.length, 1);
  const wire = sent[0] as { fault: { detail: string } };
  assertEquals(wire.fault.detail.length, PROBLEM_DETAIL_MAX_LENGTH);
  assert(wire.fault.detail.endsWith("…"));
  assertEquals(contractSchemas.WorkerResult.safeParse(wire).success, true);
});

Deno.test("fault text inside the limits is sent unchanged, and a surrogate pair is never split", () => {
  const short = errorFault("X", "short detail");
  assertEquals(fitFaultText(short), short);
  const emoji = "a".repeat(PROBLEM_DETAIL_MAX_LENGTH - 2) + "😀😀";
  const fitted = fitFaultText({ detail: emoji }) as { detail: string };
  assert(fitted.detail.length <= PROBLEM_DETAIL_MAX_LENGTH);
  assert(fitted.detail.isWellFormed());
});
