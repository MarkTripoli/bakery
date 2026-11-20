import { assertEquals } from "@std/assert";
import {
  type BatchState,
  decideBatchStep,
  limitReached,
  type StepBatch,
  type StepWorld,
} from "../../apps/server/src/modules/work/batch-supervisor.ts";

/**
 * The batch supervisor's decisions (#58): every rule of when a batch starts the
 * next issue, waits, stops or finishes, and each limit at its exact edge. Pure, so
 * nothing here needs a database; the rules are the contract the tick executes.
 */

const START = new Date("2026-11-19T10:00:00.000Z");
const at = (hours: number, extraMs = 0) =>
  new Date(START.getTime() + hours * 3_600_000 + extraMs);

type Issue = StepBatch["issues"][number]["state"];
type Over = Omit<Partial<StepBatch>, "issues"> & { issues?: Issue[] };
const batch = (
  over: Over = {},
): StepBatch => {
  const { issues = [], ...rest } = over;
  return {
    state: "running",
    continueMode: "carry_on",
    maxIssues: 5,
    maxHours: 8,
    maxSpendMicroUsd: 25_000_000n,
    startedAt: START,
    stopCancelledCurrent: false,
    nextApproved: false,
    finishReason: null,
    issues: issues.map((state, index) => ({ id: `i${index}`, state })),
    ...rest,
  };
};
const world = (over: Partial<StepWorld> = {}): StepWorld => ({
  now: at(1),
  spentMicroUsd: 0n,
  authorityOk: true,
  current: null,
  ...over,
});
const running = { issueId: "i0", outcome: "running" as const };

Deno.test("each limit stops at its exact edge, and a passed-over issue is not a merged one", () => {
  // Issues: the count of merged issues, reached at the maximum.
  const merged = (n: number): Issue[] =>
    Array.from({ length: n }, () => "merged");
  assertEquals(limitReached(batch({ issues: merged(4) }), world()), null);
  assertEquals(
    limitReached(batch({ issues: merged(5) }), world()),
    "issues_reached",
  );
  assertEquals(
    limitReached(
      batch({ issues: [...merged(4), "passed_over", "failed", "cancelled"] }),
      world(),
    ),
    null,
  );
  // Hours: from the start, reached at exactly the maximum.
  assertEquals(limitReached(batch(), world({ now: at(8, -1) })), null);
  assertEquals(limitReached(batch(), world({ now: at(8) })), "time_exhausted");
  // Dollars: reached at exactly the maximum, a micro-dollar short is not.
  assertEquals(
    limitReached(batch(), world({ spentMicroUsd: 24_999_999n })),
    null,
  );
  assertEquals(
    limitReached(batch(), world({ spentMicroUsd: 25_000_000n })),
    "spend_exhausted",
  );
  // Issues is named before time, time before spend, when more than one is reached.
  assertEquals(
    limitReached(
      batch({ issues: merged(5) }),
      world({ now: at(9), spentMicroUsd: 99_000_000n }),
    ),
    "issues_reached",
  );
  assertEquals(
    limitReached(batch(), world({ now: at(9), spentMicroUsd: 99_000_000n })),
    "time_exhausted",
  );
});

Deno.test("an issue's end is recorded before anything else, in every state", () => {
  const states: BatchState[] = [
    "running",
    "waiting",
    "paused",
    "stopping",
    "finishing",
    "stopped",
  ];
  for (const state of states) {
    for (const outcome of ["merged", "failed", "cancelled"] as const) {
      assertEquals(
        decideBatchStep(
          batch({ state, issues: ["started"] }),
          world({ current: { issueId: "i0", outcome } }),
        ),
        { kind: "record_end", issueId: "i0", outcome },
        `${state} ${outcome}`,
      );
    }
  }
  assertEquals(
    decideBatchStep(
      batch({ state: "finished" }),
      world({ current: { issueId: "i0", outcome: "merged" } }),
    ),
    { kind: "none" },
  );
});

Deno.test("a Stopping batch that asked to cancel has one job: cancel the run still going", () => {
  const stopping = (over: Over) =>
    batch({ state: "stopping", issues: ["started"], ...over });
  assertEquals(
    decideBatchStep(
      stopping({ stopCancelledCurrent: true }),
      world({ current: running }),
    ),
    { kind: "cancel_current", issueId: "i0" },
  );
  // No cancel asked for: the issue runs on, and the batch waits for it.
  assertEquals(
    decideBatchStep(
      stopping({ stopCancelledCurrent: false }),
      world({ current: running }),
    ),
    { kind: "none" },
  );
  // The run has ended (cancelled or merged anyway): record it, then the batch stops.
  assertEquals(
    decideBatchStep(
      stopping({ stopCancelledCurrent: true }),
      world({ current: { issueId: "i0", outcome: "cancelled" } }),
    ),
    { kind: "record_end", issueId: "i0", outcome: "cancelled" },
  );
  assertEquals(
    decideBatchStep(
      stopping({ stopCancelledCurrent: true, issues: ["cancelled"] }),
      world(),
    ),
    { kind: "stop" },
  );
  // A batch that is already Stopped has nothing left to do.
  assertEquals(
    decideBatchStep(
      batch({ state: "stopped", issues: ["cancelled"] }),
      world(),
    ),
    { kind: "none" },
  );
});

Deno.test("while an issue runs, a limit moves the batch to Finishing and nothing else interrupts it", () => {
  const issues: Issue[] = ["started"];
  for (const state of ["running", "waiting"] as const) {
    assertEquals(
      decideBatchStep(batch({ state, issues }), world({ current: running })),
      { kind: "none" },
    );
    assertEquals(
      decideBatchStep(
        batch({ state, issues }),
        world({ current: running, now: at(8) }),
      ),
      { kind: "finishing", reason: "time_exhausted" },
    );
    assertEquals(
      decideBatchStep(
        batch({ state, issues }),
        world({ current: running, spentMicroUsd: 26_000_000n }),
      ),
      { kind: "finishing", reason: "spend_exhausted" },
    );
  }
  // Paused, stopping or already finishing: a limit changes nothing, the issue runs on.
  for (const state of ["paused", "stopping", "finishing"] as const) {
    assertEquals(
      decideBatchStep(
        batch({ state, issues }),
        world({ current: running, now: at(9) }),
      ),
      { kind: "none" },
      state,
    );
  }
});

Deno.test("with nothing running, each state does its own thing", () => {
  assertEquals(decideBatchStep(batch({ state: "stopping" }), world()), {
    kind: "stop",
  });
  assertEquals(
    decideBatchStep(
      batch({ state: "finishing", finishReason: "time_exhausted" }),
      world(),
    ),
    { kind: "finish", reason: "time_exhausted" },
  );
  // A finishing batch always says why; with none recorded it says nothing was left.
  assertEquals(decideBatchStep(batch({ state: "finishing" }), world()), {
    kind: "finish",
    reason: "nothing_eligible",
  });
  assertEquals(
    decideBatchStep(batch({ state: "paused" }), world({ now: at(99) })),
    { kind: "none" },
  );
  assertEquals(
    decideBatchStep(batch({ state: "waiting" }), world({ now: at(99) })),
    { kind: "none" },
  );
});

Deno.test("a running batch with nothing running does not go on past a failure, lost authority or a limit", () => {
  assertEquals(
    decideBatchStep(batch({ issues: ["merged", "failed"] }), world()),
    { kind: "finish", reason: "issue_failed" },
  );
  assertEquals(
    decideBatchStep(batch({ issues: ["merged", "cancelled"] }), world()),
    { kind: "finish", reason: "issue_cancelled" },
  );
  assertEquals(decideBatchStep(batch(), world({ authorityOk: false })), {
    kind: "finish",
    reason: "authority_lost",
  });
  assertEquals(decideBatchStep(batch(), world({ now: at(8) })), {
    kind: "finish",
    reason: "time_exhausted",
  });
  assertEquals(
    decideBatchStep(batch(), world({ spentMicroUsd: 25_000_000n })),
    { kind: "finish", reason: "spend_exhausted" },
  );
  assertEquals(
    decideBatchStep(
      batch({ maxIssues: 2, issues: ["merged", "merged"] }),
      world(),
    ),
    { kind: "finish", reason: "issues_reached" },
  );
  // Precedence: a failure outranks lost authority, which outranks a limit.
  assertEquals(
    decideBatchStep(
      batch({ issues: ["failed"] }),
      world({ authorityOk: false, now: at(9) }),
    ),
    { kind: "finish", reason: "issue_failed" },
  );
  assertEquals(
    decideBatchStep(batch(), world({ authorityOk: false, now: at(9) })),
    { kind: "finish", reason: "authority_lost" },
  );
});

Deno.test("carry on starts the next issue by itself; ask first waits for a yes, once", () => {
  assertEquals(decideBatchStep(batch({ issues: ["merged"] }), world()), {
    kind: "start_next",
  });
  assertEquals(decideBatchStep(batch(), world()), { kind: "start_next" });
  const ask = (over: Over) => batch({ continueMode: "ask_first", ...over });
  // The first issue starts at once: the person chose to start the batch.
  assertEquals(decideBatchStep(ask({}), world()), { kind: "start_next" });
  assertEquals(decideBatchStep(ask({ issues: ["passed_over"] }), world()), {
    kind: "start_next",
  });
  // After a merge it asks, and a yes is used once.
  assertEquals(decideBatchStep(ask({ issues: ["merged"] }), world()), {
    kind: "wait",
  });
  assertEquals(
    decideBatchStep(ask({ issues: ["merged"], nextApproved: true }), world()),
    { kind: "start_next" },
  );
  // A limit still wins over a yes: a batch never starts past a limit.
  assertEquals(
    decideBatchStep(
      ask({ issues: ["merged"], nextApproved: true }),
      world({ now: at(8) }),
    ),
    { kind: "finish", reason: "time_exhausted" },
  );
});

Deno.test("a Stopping batch whose starter has lost authority ends, instead of asking for a cancel it cannot make", () => {
  const stopping = batch({
    state: "stopping",
    stopCancelledCurrent: true,
    issues: ["started"],
  });
  // With authority the cancel is asked for, every tick, until the run ends.
  assertEquals(decideBatchStep(stopping, world({ current: running })), {
    kind: "cancel_current",
    issueId: "i0",
  });
  // Without it the cancel can never be made as that person: the batch ends and says why.
  assertEquals(
    decideBatchStep(stopping, world({ current: running, authorityOk: false })),
    { kind: "finish", reason: "authority_lost" },
  );
  // A stop that did not ask to cancel waits for the run, whoever the starter is.
  assertEquals(
    decideBatchStep(
      batch({
        state: "stopping",
        stopCancelledCurrent: false,
        issues: ["started"],
      }),
      world({ current: running, authorityOk: false }),
    ),
    { kind: "none" },
  );
  // The issue's own end still comes first.
  assertEquals(
    decideBatchStep(
      stopping,
      world({
        current: { issueId: "i0", outcome: "failed" },
        authorityOk: false,
      }),
    ),
    { kind: "record_end", issueId: "i0", outcome: "failed" },
  );
});
