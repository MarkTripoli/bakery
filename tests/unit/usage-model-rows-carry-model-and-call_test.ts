import { assertEquals, assertThrows } from "@std/assert";
import {
  normalizeReceipt,
  type ParsedUsageReceipt,
} from "../../apps/server/src/modules/work/budget.ts";

// #428 part 3: the ledger lets a compute row omit the model and the provider
// call, so nothing in the database insists a model row has them. The model path
// does, here, before any row is written.

const receipt: ParsedUsageReceipt = {
  usageFactId: "fact-1",
  providerCallId: "call-1",
  provider: "anthropic",
  billingAccountId: "acct-1",
  model: "claude-sonnet-5-5",
  billingRoute: "api",
  pricingMetadataSnapshot: "pricing-1",
  inputTokens: "10",
  outputTokens: "5",
  costUsd: "0.001",
  measurement: "reported",
  occurredAt: "2026-11-22T00:00:00.000Z",
} as ParsedUsageReceipt;

function reasonOf(value: ParsedUsageReceipt): string | undefined {
  try {
    normalizeReceipt(value);
  } catch (error) {
    return (error as { params?: { reason?: string } }).params?.reason;
  }
}

Deno.test("a complete model receipt is accepted", () => {
  assertEquals(normalizeReceipt(receipt).model, "claude-sonnet-5-5");
});

Deno.test("a model receipt without a provider call is refused", () => {
  assertEquals(
    reasonOf({ ...receipt, providerCallId: " " }),
    "provider_call_identity_missing",
  );
});

Deno.test("a model receipt without a model is refused", () => {
  assertEquals(
    reasonOf({ ...receipt, model: "" }),
    "usage_policy_snapshot_missing",
  );
  assertThrows(() => normalizeReceipt({ ...receipt, model: "  " }));
});
