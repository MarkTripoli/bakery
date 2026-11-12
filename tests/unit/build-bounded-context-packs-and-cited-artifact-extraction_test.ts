import { assertEquals, assertThrows } from "@std/assert";
import {
  allocateContext,
  ContextDecision,
  type ContextEnvelopeInput,
  resolveContextEnvelope,
} from "../../apps/server/src/modules/knowledge/context-budget.ts";

const reserved = {
  output: 12_000,
  toolResults: 16_000,
  compaction: 10_000,
  safetyMargin: 2_000,
};

function envelope(
  counts: ContextEnvelopeInput["counts"],
  modelContextTokens = 128_000,
): ContextEnvelopeInput {
  return { modelContextTokens, counts, reserved };
}

Deno.test("measured and estimated counts and every reservation reduce the available budget", () => {
  const result = resolveContextEnvelope(envelope({
    conversation: { state: "measured", tokens: 6_800 },
    instructions: { state: "measured", tokens: 2_100 },
    toolSchemas: { state: "estimated", tokens: 3_200 },
  }));
  assertEquals(result.countedInputTokens, 12_100);
  assertEquals(result.reservedTokens, 40_000);
  assertEquals(result.availableTokens, 128_000 - 12_100 - 40_000);
  assertEquals(result.decision, ContextDecision.Ready);
});

Deno.test("an unknown unbounded count blocks admission and is never counted as zero (AC1)", () => {
  const result = resolveContextEnvelope(envelope({
    conversation: { state: "measured", tokens: 1_000 },
    harnessOverhead: { state: "unknown", tokens: null, boundTokens: null },
  }));
  assertEquals(result.decision, ContextDecision.BoundMoreBeforeDispatch);
  assertEquals(result.unboundedUnknown, ["harnessOverhead"]);
  assertEquals(result.countedInputTokens, 1_000);
});

Deno.test("a bounded unknown is counted at its bound", () => {
  const result = resolveContextEnvelope(envelope({
    harnessOverhead: { state: "unknown", tokens: null, boundTokens: 4_000 },
  }));
  assertEquals(result.countedInputTokens, 4_000);
  assertEquals(result.decision, ContextDecision.Ready);
});

Deno.test("content already over the budget needs bounding before any slice is admitted", () => {
  const result = resolveContextEnvelope(envelope({
    conversation: { state: "measured", tokens: 95_000 },
  }));
  assertEquals(result.availableTokens, 128_000 - 95_000 - 40_000);
  assertEquals(result.decision, ContextDecision.NeedsBounding);
});

Deno.test("allocation keeps required items, selects optional ones by priority and omits oversized or unknown ones", () => {
  const allocation = allocateContext({
    envelope: {
      modelContextTokens: 100_000,
      counts: {},
      reserved: {
        output: 20_000,
        toolResults: 0,
        compaction: 0,
        safetyMargin: 10_000,
      },
    },
    items: [
      {
        id: "policy-task-tools",
        count: { state: "measured", tokens: 8_000 },
        required: true,
        priority: 100,
      },
      {
        id: "approved-plan-v3",
        count: { state: "measured", tokens: 4_000 },
        required: true,
        priority: 100,
      },
      {
        id: "failing-test-excerpt",
        count: { state: "estimated", tokens: 2_000 },
        required: false,
        priority: 90,
      },
      {
        id: "whole-session-log",
        count: { state: "estimated", tokens: 90_000 },
        required: false,
        priority: 10,
      },
      {
        id: "unsized-attachment",
        count: { state: "unknown", tokens: null, boundTokens: null },
        required: false,
        priority: 95,
      },
    ],
  });
  assertEquals(allocation.decision, ContextDecision.Ready);
  assertEquals(allocation.selected, [
    "policy-task-tools",
    "approved-plan-v3",
    "failing-test-excerpt",
  ]);
  assertEquals(allocation.selectedTokens, 14_000);
  assertEquals(allocation.omitted, [
    { id: "unsized-attachment", reason: "unbounded_unknown" },
    { id: "whole-session-log", reason: "over_budget" },
  ]);
});

Deno.test("required content over the budget hands off and selects nothing", () => {
  const allocation = allocateContext({
    envelope: envelope({}),
    items: [
      {
        id: "huge-required",
        count: { state: "measured", tokens: 90_000 },
        required: true,
        priority: 100,
      },
    ],
  });
  assertEquals(allocation.decision, ContextDecision.HandoffRequired);
  assertEquals(allocation.selected, []);
});

Deno.test("a required unknown unbounded item blocks the step rather than counting as zero", () => {
  const allocation = allocateContext({
    envelope: envelope({}),
    items: [
      {
        id: "unbounded-required",
        count: { state: "unknown", tokens: null, boundTokens: null },
        required: true,
        priority: 100,
      },
    ],
  });
  assertEquals(allocation.decision, ContextDecision.BoundMoreBeforeDispatch);
  assertEquals(allocation.selected, []);
});

Deno.test("reservations survive a retry: the same inputs give the same envelope", () => {
  const input = envelope({
    conversation: { state: "measured", tokens: 20_000 },
  });
  assertEquals(resolveContextEnvelope(input), resolveContextEnvelope(input));
});

Deno.test("malformed counts and duplicate item ids are rejected", () => {
  assertThrows(() =>
    resolveContextEnvelope(envelope({
      // Unknown cannot carry a token count.
      bad: { state: "unknown", tokens: 5 as never, boundTokens: null },
    }))
  );
  assertThrows(() =>
    resolveContextEnvelope(envelope({
      bad: { state: "measured", tokens: -1 },
    }))
  );
  assertThrows(() =>
    allocateContext({
      envelope: envelope({}),
      items: [
        {
          id: "x",
          count: { state: "measured", tokens: 1 },
          required: false,
          priority: 1,
        },
        {
          id: "x",
          count: { state: "measured", tokens: 1 },
          required: false,
          priority: 1,
        },
      ],
    })
  );
});

Deno.test("maxInputTokens caps input below what the window minus reserves allows (#154)", () => {
  // The doc 19 specimen: window 100k, input cap 60k, reserves 30k.
  const policy = {
    modelContextTokens: 100_000,
    reserved: {
      output: 20_000,
      toolResults: 0,
      compaction: 0,
      safetyMargin: 10_000,
    },
    maxInputTokens: 60_000,
  };
  const capped = resolveContextEnvelope({
    ...policy,
    counts: { base: { state: "measured", tokens: 10_000 } },
  });
  assertEquals(capped.availableTokens, 60_000 - 10_000);
  assertEquals(capped.decision, ContextDecision.Ready);
  // Without the cap the window minus reserves applies (70k - 10k).
  const { maxInputTokens: _cap, ...uncapped } = policy;
  assertEquals(
    resolveContextEnvelope({
      ...uncapped,
      counts: { base: { state: "measured", tokens: 10_000 } },
    }).availableTokens,
    60_000,
  );
  // A cap above the reserve-limited budget changes nothing.
  assertEquals(
    resolveContextEnvelope({
      ...policy,
      maxInputTokens: 500_000,
      counts: { base: { state: "measured", tokens: 10_000 } },
    }).availableTokens,
    60_000,
  );
  // Base input over the cap needs bounding even though the window has room.
  assertEquals(
    resolveContextEnvelope({
      ...policy,
      counts: { base: { state: "measured", tokens: 61_000 } },
    }).decision,
    ContextDecision.NeedsBounding,
  );
  // The specimen allocation: 14,000 tokens selected, the session log omitted.
  const allocation = allocateContext({
    envelope: { ...policy, counts: {} },
    items: [
      {
        id: "policy-task-tools",
        count: { state: "measured", tokens: 8_000 },
        required: true,
        priority: 100,
      },
      {
        id: "approved-plan-v3",
        count: { state: "measured", tokens: 4_000 },
        required: true,
        priority: 100,
      },
      {
        id: "failing-test-excerpt",
        count: { state: "measured", tokens: 2_000 },
        required: false,
        priority: 90,
      },
      {
        id: "whole-session-log",
        count: { state: "estimated", tokens: 90_000 },
        required: false,
        priority: 10,
      },
    ],
  });
  assertEquals(allocation.decision, ContextDecision.Ready);
  assertEquals(allocation.selectedTokens, 14_000);
  assertEquals(allocation.omitted, [{
    id: "whole-session-log",
    reason: "over_budget",
  }]);
  // A zero or negative cap is invalid.
  assertThrows(() =>
    resolveContextEnvelope({ ...policy, maxInputTokens: 0, counts: {} })
  );
});

Deno.test("an overflowing base wins over required items: needs_bounding, not handoff_required (#155)", () => {
  const allocation = allocateContext({
    envelope: envelope({ conversation: { state: "measured", tokens: 95_000 } }),
    items: [
      {
        id: "required-plan",
        count: { state: "measured", tokens: 4_000 },
        required: true,
        priority: 100,
      },
    ],
  });
  assertEquals(allocation.decision, ContextDecision.NeedsBounding);
  assertEquals(allocation.selected, []);
});
