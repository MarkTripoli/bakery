import { assertEquals } from "@std/assert";
import {
  countsAsNotPassed,
  limitMinutes,
  nameList,
  needsAttention,
  orderChecks,
  reasonSentence,
  took,
  tryKey,
} from "../../apps/web/src/pages/task-delivery/check-copy.ts";
import type { CheckRow } from "../../apps/web/src/pages/task-delivery/model.ts";

const row = (over: Partial<CheckRow> & Pick<CheckRow, "id">): CheckRow => ({
  name: over.id,
  result: "passed",
  reason: null,
  rule: false,
  evidenceVersionId: null,
  exitCode: null,
  durationMs: null,
  olderSha: null,
  ...over,
});

Deno.test("a pass and a missing reason say nothing; every other reason has a sentence", () => {
  assertEquals(reasonSentence({ reason: null, exitCode: null }), null);
  assertEquals(reasonSentence({ reason: "verified", exitCode: 0 }), null);
  assertEquals(reasonSentence({ reason: "exit_nonzero", exitCode: 2 }), {
    key: "tasks.delivery.check.reason.exit_nonzero",
    values: { code: 2 },
  });
  assertEquals(reasonSentence({ reason: "exit_nonzero", exitCode: null }), {
    key: "tasks.delivery.check.reason.exit_nonzero_bare",
  });
  for (
    const reason of [
      "signal",
      "deadline",
      "output_limit",
      "rule_violation",
      "description_placeholder",
      "tool_missing",
      "unsupported_checker",
      "rule_unbound",
      "rule_binding_ambiguous",
      "policy_missing",
      "revision_unavailable",
      "metadata_missing",
      "metadata_too_large",
      "skipped",
      "awaiting_result",
      "canceled",
    ] as const
  ) {
    assertEquals(
      typeof reasonSentence({ reason, exitCode: null })?.key,
      "string",
      reason,
    );
  }
  // The four ways the rules cannot say how to run a check read the same.
  assertEquals(
    new Set(
      [
        "unsupported_checker",
        "rule_unbound",
        "rule_binding_ambiguous",
        "policy_missing",
      ]
        .map((reason) =>
          reasonSentence({ reason: reason as never, exitCode: null })!.key
        ),
    ).size,
    1,
  );
});

Deno.test("a check that could not run says it counts as not passed", () => {
  assertEquals(countsAsNotPassed({ result: "unavailable" }), true);
  assertEquals(countsAsNotPassed({ result: "failed" }), false);
});

Deno.test("the time a command took, in the parts the copy wants; a rule has none", () => {
  assertEquals(took({ rule: false, durationMs: null }), null);
  assertEquals(took({ rule: true, durationMs: 5000 }), null);
  assertEquals(took({ rule: false, durationMs: 400 }), {
    key: "tasks.delivery.check.tookInstant",
  });
  assertEquals(took({ rule: false, durationMs: 14_000 }), {
    key: "tasks.delivery.check.tookSeconds",
    values: { seconds: 14 },
  });
  assertEquals(took({ rule: false, durationMs: 134_000 }), {
    key: "tasks.delivery.check.tookMinutes",
    values: { minutes: 2, seconds: 14 },
  });
});

Deno.test("checks that did not pass come first, then running, then passed, in server order", () => {
  const ordered = orderChecks([
    row({ id: "a", result: "passed" }),
    row({ id: "b", result: "pending" }),
    row({ id: "c", result: "failed" }),
    row({ id: "d", result: "unavailable" }),
    row({ id: "e", result: "passed" }),
  ]);
  assertEquals(ordered.map((entry) => entry.id), ["c", "d", "b", "a", "e"]);
});

Deno.test("the list opens by itself for anything but all-passed on the current commit", () => {
  assertEquals(needsAttention([row({ id: "a" }), row({ id: "b" })]), false);
  assertEquals(needsAttention([row({ id: "a", result: "failed" })]), true);
  assertEquals(needsAttention([row({ id: "a", olderSha: "4be19c2" })]), true);
  assertEquals(needsAttention([]), false);
});

Deno.test("a try names three checks and counts the rest; its sentence follows what it was asked to fix", () => {
  assertEquals(nameList(["a", "b"]), { shown: ["a", "b"], more: 0 });
  assertEquals(nameList(["a", "b", "c", "d", "e"]), {
    shown: ["a", "b", "c"],
    more: 2,
  });
  assertEquals(
    tryKey({ checks: 1, blocking: 1 }),
    "tasks.delivery.fixing.tried.both",
  );
  assertEquals(
    tryKey({ checks: 2, blocking: 0 }),
    "tasks.delivery.fixing.tried.checks",
  );
  assertEquals(
    tryKey({ checks: 0, blocking: 3 }),
    "tasks.delivery.fixing.tried.findings",
  );
  assertEquals(
    tryKey({ checks: 0, blocking: 0 }),
    "tasks.delivery.fixing.tried.nothing",
  );
});

Deno.test("the loop's time bound is whole minutes, or null when the server did not say", () => {
  assertEquals(limitMinutes(null), null);
  assertEquals(limitMinutes(0), null);
  assertEquals(limitMinutes(1_800_000), 30);
  assertEquals(limitMinutes(20_000), 1);
});
