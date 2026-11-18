import { assert, assertEquals } from "@std/assert";
import type {
  ContextEnvelope,
  ContextItem,
} from "../../packages/contracts/src/context-packs.ts";
import {
  admitContext,
  type Candidate,
  extractStillValid,
} from "../../apps/server/src/modules/knowledge/context-packs.ts";

/**
 * Bounded context packs and cited artifact extraction.
 *
 * The organ these tests defend is the budget. Every AC here fails in the same
 * direction if the arithmetic is wrong: a step gets handed more than the model
 * can hold, and it fails at the point of use rather than the point of admission.
 */

const envelope = (
  windowTokens: number,
  headroom = { output: 0, toolResults: 0, compaction: 0 },
): ContextEnvelope => ({ windowTokens, headroom });

const extract = (id: string): ContextItem => ({
  kind: "extract",
  citation: {
    artifactVersionId: id,
    digest: `sha256:${"a".repeat(64)}`,
    scope: "repo:read",
  },
  provenance: { name: "text", version: "1" },
  text: "some extracted text",
  truncated: false,
});

const measured = (label: string, tokens: number): Candidate => ({
  item: extract(`00000000-0000-4000-8000-00000000000${label.length % 9}`),
  usage: { kind: "measured", tokens },
  label,
});

Deno.test("AC1: an unknown-size item is refused, not counted as zero", () => {
  // This is the whole point. If unknown were admitted as 0 the pack would report
  // success and the step would overflow exactly when the input is large.
  const result = admitContext({ envelope: envelope(1000) }, [
    {
      item: extract("00000000-0000-4000-8000-000000000001"),
      usage: { kind: "unknown", reason: "no tokenizer for this media type" },
      label: "big-pdf",
    },
  ]);
  assertEquals(result.pack.items.length, 0);
  assertEquals(result.pack.omitted.length, 1);
  assertEquals(result.pack.omitted[0]!.reason, "unknown-size");
  assert(
    result.pack.omitted[0]!.detail.includes("big-pdf"),
    "the refusal must name what it refused",
  );
});

Deno.test("AC1: unknown is admitted only inside an explicit allowance", () => {
  const candidates: Candidate[] = [
    {
      item: extract("00000000-0000-4000-8000-000000000001"),
      usage: { kind: "unknown", reason: "x" },
      label: "a",
    },
    {
      item: extract("00000000-0000-4000-8000-000000000002"),
      usage: { kind: "unknown", reason: "x" },
      label: "b",
    },
  ];
  const none = admitContext({ envelope: envelope(1000) }, candidates);
  assertEquals(none.pack.items.length, 0, "default allowance is zero");

  const one = admitContext(
    { envelope: envelope(1000), unknownAllowanceTokens: 1 },
    candidates,
  );
  assertEquals(one.pack.items.length, 1);
  assertEquals(one.pack.omitted.length, 1);
  assertEquals(one.unknownSpentTokens, 1);
});

Deno.test("AC1: unknown allowance is a number, never an unbounded opt-in", () => {
  // "admit unknowns" with no ceiling is the zero-defect one indirection later.
  const candidates: Candidate[] = Array.from({ length: 5 }, (_, i) => ({
    item: extract(`00000000-0000-4000-8000-00000000000${i + 1}`),
    usage: { kind: "unknown" as const, reason: "x" },
    label: `u${i}`,
  }));
  const result = admitContext(
    { envelope: envelope(1000), unknownAllowanceTokens: 2 },
    candidates,
  );
  assertEquals(result.pack.items.length, 2);
  assertEquals(result.pack.omitted.length, 3);
});

Deno.test("AC1: oversized measured content is narrowed by the budget", () => {
  const result = admitContext({ envelope: envelope(100) }, [
    measured("huge", 500),
    measured("small", 50),
  ]);
  assertEquals(result.pack.items.length, 1, "only what fits is admitted");
  assertEquals(result.pack.omitted[0]!.reason, "over-budget");
  assertEquals(result.consumedTokens, 50);
});

Deno.test("headroom is reserved BEFORE items, so output always has room", () => {
  // Reserved after the loop means the reservation competes with content already
  // admitted, and the loser is whichever code path runs last.
  const result = admitContext(
    {
      envelope: envelope(1000, {
        output: 400,
        toolResults: 100,
        compaction: 100,
      }),
    },
    [measured("fill", 600), measured("next", 100)],
  );
  // Usable is 1000 - 600 = 400, so 600 does not fit and 100 does.
  assertEquals(result.pack.items.length, 1);
  assertEquals(result.consumedTokens, 100);
  assertEquals(result.pack.omitted[0]!.reason, "over-budget");
});

Deno.test("order is the caller's relevance order, never sorted by size", () => {
  // A pack that sorts by size hands a step its cheapest evidence instead of its
  // most relevant.
  const result = admitContext({ envelope: envelope(1000) }, [
    measured("relevant", 300),
    measured("tiny", 10),
  ]);
  assertEquals(result.pack.items.length, 2);
  assertEquals(result.pack.usage.length, result.pack.items.length);
});

Deno.test("AC2: a cached extract survives only while version, digest AND scope hold", () => {
  const cited = {
    artifactVersionId: "00000000-0000-4000-8000-000000000001",
    digest: `sha256:${"a".repeat(64)}`,
    scope: "repo:read",
  };
  const current = (
    over: Partial<{
      artifactVersionId: string;
      digest: string;
      scope: string | null;
    }> = {},
  ) => ({
    artifactVersionId: cited.artifactVersionId,
    digest: cited.digest,
    scope: cited.scope as string | null,
    ...over,
  });

  assert(extractStillValid(cited, current()), "unchanged must remain valid");
  assert(
    !extractStillValid(
      cited,
      current({ artifactVersionId: "00000000-0000-4000-8000-000000000002" }),
    ),
    "a new artifact version invalidates the cache",
  );
  assert(
    !extractStillValid(cited, current({ digest: `sha256:${"b".repeat(64)}` })),
    "a mutated artifact invalidates the cache",
  );
  assert(
    !extractStillValid(cited, current({ scope: "repo:write" })),
    "a changed scope invalidates the cache",
  );
  assert(
    !extractStillValid(cited, current({ scope: null })),
    "a revoked scope invalidates the cache; null is revocation, not a match",
  );
});

Deno.test("AC2: omitting an unauthorized item is recorded, never silently dropped", () => {
  // An item that vanishes without a record reads as "there was nothing", which
  // is the opposite of what happened.
  const result = admitContext({ envelope: envelope(1000) }, [
    measured("ok", 10),
    {
      item: extract("00000000-0000-4000-8000-000000000003"),
      usage: { kind: "unknown", reason: "unreadable" },
      label: "revoked",
    },
  ]);
  assertEquals(result.pack.items.length, 1);
  assertEquals(result.pack.omitted.length, 1);
  assert(
    result.pack.omitted[0]!.detail.length > 0,
    "every omission carries a detail a caller can act on",
  );
});

Deno.test("AC3: a reference carries no content, only a safe pointer and limits", () => {
  // A credential or a whole PDF must never reach a prompt because extraction
  // failed to summarise it.
  const ref: ContextItem = {
    kind: "ref",
    artifactVersionId: "00000000-0000-4000-8000-000000000004",
    digest: `sha256:${"c".repeat(64)}`,
    mediaType: "application/pdf",
    reason: "oversized",
    limits: { maxBytes: 1_000_000, observedBytes: 40_000_000 },
  };
  const serialized = JSON.stringify(ref);
  assert(!("text" in ref), "a reference must not carry extracted text");
  assert(
    !serialized.includes("BEGIN PRIVATE KEY"),
    "nothing credential-shaped belongs in a pack item",
  );
  const result = admitContext({ envelope: envelope(1000) }, [
    { item: ref, usage: { kind: "measured", tokens: 5 }, label: "pdf" },
  ]);
  assertEquals(result.pack.items[0]!.kind, "ref");
});

Deno.test("a pack records usage per item, so an estimate is visible", () => {
  // A pack that presents one confident total hides that some of it was guessed.
  const result = admitContext({ envelope: envelope(1000) }, [
    {
      item: extract("00000000-0000-4000-8000-000000000005"),
      usage: { kind: "estimated", tokens: 100, basis: "bytes/4" },
      label: "e",
    },
    measured("m", 50),
  ]);
  assertEquals(result.pack.usage.length, 2);
  assertEquals(result.pack.usage[0]!.kind, "estimated");
  assertEquals(result.pack.usage[1]!.kind, "measured");
});

Deno.test("the item cap bounds the pack independently of the budget", () => {
  const result = admitContext({ envelope: envelope(1_000_000), maxItems: 2 }, [
    measured("a", 1),
    measured("b", 1),
    measured("c", 1),
  ]);
  assertEquals(result.pack.items.length, 2);
  assertEquals(result.pack.omitted[0]!.reason, "over-budget");
});
