import { assert, assertEquals } from "@std/assert";
import {
  confirmMcpEffect,
  dispatchMcpEffect,
  type McpEffectPort,
  type McpWriteClass,
  type McpWriteResult,
} from "../../apps/server/src/modules/effects/mcp.ts";
import type { ExternalEffectRow } from "../../apps/server/src/modules/effects/schema.ts";

/**
 * What the ledger does with a write to an MCP tool (#435, slice 2c): how a send
 * that ended in each way becomes a recorded outcome, and what each way an Admin
 * classified the tool changes. The port is a fake that counts what it was asked
 * to send, because the case that matters is the write that must not go out twice.
 */

function effect(generation = 1): ExternalEffectRow {
  return {
    operation: "create_issue",
    target: "mcp-tool:c0000000-0000-4000-8000-000000000001:create_issue",
    dispatchGeneration: generation,
  } as unknown as ExternalEffectRow;
}

function port(
  effectClass: McpWriteClass,
  write: () => Promise<McpWriteResult>,
  confirm: McpEffectPort["confirm"] = () =>
    Promise.resolve({ status: "unconfirmed" }),
) {
  const calls = { admit: 0, write: 0, confirm: 0 };
  const fake: McpEffectPort = {
    admit: () => {
      calls.admit += 1;
      return Promise.resolve({ ok: true, effectClass });
    },
    write: () => {
      calls.write += 1;
      return write();
    },
    confirm: (e, s) => {
      calls.confirm += 1;
      return confirm(e, s);
    },
  };
  return { fake, calls };
}

const LIMITS = { deadlineMs: 1000 };

Deno.test("a write the server answers is confirmed with what it said", async () => {
  const { fake } = port(
    "write_opaque",
    () =>
      Promise.resolve({ kind: "done", output: { remoteId: "gh-7", ok: 1 } }),
  );
  const result = await dispatchMcpEffect({ ...LIMITS, mcp: fake }, effect());
  assertEquals(result.outcome, {
    kind: "confirmed",
    remoteId: "gh-7",
    safeResult: { remoteId: "gh-7", ok: 1 },
  });
});

Deno.test("a send refused before anything left, or answered with a definite error, is failed, or retried when the refusal says so", async () => {
  const cases: [McpWriteResult, unknown][] = [
    [{ kind: "not_sent", retryable: false }, {
      kind: "failed",
      failureCode: "provider_not_sent",
    }],
    [{ kind: "rejected", retryable: false }, {
      kind: "failed",
      failureCode: "provider_rejected",
    }],
    [{ kind: "not_sent", retryable: true }, { kind: "retry" }],
    [{ kind: "rejected", retryable: true, retryAfterSeconds: 30 }, {
      kind: "retry",
      retryAfterSeconds: 30,
    }],
  ];
  for (const [sent, expected] of cases) {
    const { fake } = port("write_opaque", () => Promise.resolve(sent));
    const { outcome } = await dispatchMcpEffect(
      { ...LIMITS, mcp: fake },
      effect(),
    );
    assertEquals(outcome.kind, (expected as { kind: string }).kind);
    if (outcome.kind === "failed") {
      assertEquals(outcome, expected);
    }
    if (
      outcome.kind === "retry" && "retryAfterSeconds" in (expected as object)
    ) {
      assertEquals(outcome, expected);
    }
  }
});

Deno.test("an unproven send stays uncertain for a reconcilable or opaque tool and is retried for an idempotent one", async () => {
  for (
    const [effectClass, expected] of [
      ["write_opaque", "uncertain"],
      ["write_reconcilable", "uncertain"],
      ["write_idempotent", "retry"],
    ] as const
  ) {
    const { fake } = port(
      effectClass,
      () => Promise.resolve({ kind: "unknown" }),
    );
    const { outcome } = await dispatchMcpEffect(
      { ...LIMITS, mcp: fake },
      effect(),
    );
    assertEquals(outcome.kind, expected, effectClass);
  }
  // A throw is the same as an unknown send.
  const thrown = port("write_opaque", () => Promise.reject(new Error("boom")));
  assertEquals(
    (await dispatchMcpEffect({ ...LIMITS, mcp: thrown.fake }, effect())).outcome
      .kind,
    "uncertain",
  );
});

Deno.test("a send that outlives its deadline may have arrived: uncertain, and retried only for an idempotent tool", async () => {
  const never = () => new Promise<McpWriteResult>(() => {});
  const opaque = port("write_opaque", never);
  const timed = await dispatchMcpEffect(
    { deadlineMs: 20, mcp: opaque.fake },
    effect(),
  );
  assertEquals(timed.outcome.kind, "uncertain");
  assertEquals(timed.requests.map((r) => r.state), ["pending"]);
  const idempotent = port("write_idempotent", never);
  assertEquals(
    (await dispatchMcpEffect(
      { deadlineMs: 20, mcp: idempotent.fake },
      effect(),
    ))
      .outcome.kind,
    "retry",
  );
});

Deno.test("an idempotent tool stops being retried once the generations are spent", async () => {
  const { fake } = port(
    "write_idempotent",
    () => Promise.resolve({ kind: "unknown" }),
  );
  const result = await dispatchMcpEffect(
    { ...LIMITS, maxDispatchGenerations: 3, mcp: fake },
    effect(3),
  );
  assertEquals(result.outcome, {
    kind: "failed",
    failureCode: "retry_exhausted",
  });
});

Deno.test("a write whose authority is gone, or that cannot be read, is never sent", async () => {
  let writes = 0;
  const refused: McpEffectPort = {
    admit: () => Promise.resolve({ ok: false, failureCode: "adapter_changed" }),
    write: () => {
      writes += 1;
      return Promise.resolve({ kind: "done", output: null });
    },
    confirm: () => Promise.resolve({ status: "unconfirmed" }),
  };
  assertEquals(
    (await dispatchMcpEffect({ ...LIMITS, mcp: refused }, effect())).outcome,
    { kind: "failed", failureCode: "adapter_changed" },
  );
  const unreadable: McpEffectPort = {
    ...refused,
    admit: () => Promise.reject(new Error("snapshot port down")),
  };
  assertEquals(
    (await dispatchMcpEffect({ ...LIMITS, mcp: unreadable }, effect())).outcome
      .kind,
    "retry",
  );
  // No port at all is a refusal, not a send.
  assertEquals(
    (await dispatchMcpEffect(LIMITS, effect())).outcome,
    { kind: "failed", failureCode: "authorization_denied" },
  );
  assertEquals(writes, 0);
});

Deno.test("a confirmation proves the write, or leaves it uncertain, and never sends it for a tool that is not idempotent", async () => {
  const proven = port(
    "write_reconcilable",
    () => Promise.reject(new Error("must not send")),
    () => Promise.resolve({ status: "confirmed", result: { found: 1 } }),
  );
  const confirmed = await confirmMcpEffect(
    { ...LIMITS, mcp: proven.fake },
    effect(),
  );
  assertEquals(confirmed.kind, "confirmed");
  assertEquals(proven.calls.write, 0);

  const missing = port(
    "write_reconcilable",
    () => Promise.reject(new Error("must not send")),
  );
  const unproven = await confirmMcpEffect(
    { ...LIMITS, mcp: missing.fake },
    effect(),
  );
  assertEquals(unproven.kind, "uncertain");
  if (unproven.kind === "uncertain") {
    assertEquals(unproven.outcome, "uncertain");
  }

  const broken = port(
    "write_reconcilable",
    () => Promise.reject(new Error("must not send")),
    () => Promise.reject(new Error("read failed")),
  );
  const threw = await confirmMcpEffect(
    { ...LIMITS, mcp: broken.fake },
    effect(),
  );
  assert(threw.kind === "uncertain" && threw.outcome === "threw");
  assertEquals(
    (await confirmMcpEffect(LIMITS, effect())).kind,
    "uncertain",
  );
});
