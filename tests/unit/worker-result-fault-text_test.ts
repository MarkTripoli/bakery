import { assert, assertEquals } from "@std/assert";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";
import { WorkerApiClient } from "../../apps/worker/src/client.ts";
import { errorFault } from "../../apps/worker/src/supervisor-support.ts";
import {
  fitFaultText,
  ISSUE_CODE_MAX_LENGTH,
  ISSUE_MESSAGE_MAX_LENGTH,
  ISSUE_PATH_MAX_LENGTH,
  PROBLEM_DETAIL_MAX_LENGTH,
  PROBLEM_ISSUES_MAX_ITEMS,
  PROBLEM_TITLE_MAX_LENGTH,
} from "../../apps/worker/src/fault-text.ts";

type Parses = { safeParse(value: unknown): { success: boolean } };
const shapeOf = (name: string) =>
  (contractSchemas as unknown as Record<
    string,
    { shape: Record<string, Parses> }
  >)[
    name
  ].shape;

const acceptsExactly = (
  schema: Parses,
  limit: number,
  at: (n: number) => unknown,
) =>
  schema.safeParse(at(limit)).success &&
  !schema.safeParse(at(limit + 1)).success;

Deno.test("the worker's fault limits are the ones the contract publishes", () => {
  const problem = shapeOf("Problem");
  const issue = shapeOf("ValidationIssue");
  const text = (n: number) => "x".repeat(n);
  assert(acceptsExactly(problem.title, PROBLEM_TITLE_MAX_LENGTH, text));
  assert(acceptsExactly(problem.detail, PROBLEM_DETAIL_MAX_LENGTH, text));
  assert(acceptsExactly(issue.path, ISSUE_PATH_MAX_LENGTH, text));
  assert(acceptsExactly(issue.code, ISSUE_CODE_MAX_LENGTH, text));
  assert(acceptsExactly(issue.message, ISSUE_MESSAGE_MAX_LENGTH, text));
  const anIssue = { path: "p", code: "c", message: "m" };
  assert(
    acceptsExactly(
      problem.issues,
      PROBLEM_ISSUES_MAX_ITEMS,
      (n) => Array.from({ length: n }, () => anIssue),
    ),
  );
});

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
