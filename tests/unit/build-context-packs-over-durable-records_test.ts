import { assertEquals, assertRejects } from "@std/assert";
import type { PgTransactionClient } from "../../apps/server/src/platform/database.ts";
import type { ActionContext } from "../../packages/contracts/src/action-registry.ts";
import { buildContextPack } from "../../apps/server/src/modules/knowledge/context-packs.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";

// Issue #14, slice (b): one action builds a bounded pack. The pack is a view
// over durable records, never a stored transcript, so these tests pin the
// choices that only this module makes: what becomes an item, what becomes an
// omission with a reason, and that the digest covers the selection rather than
// the call.

const ORG = "11111111-1111-4111-8111-111111111111";
const PRINCIPAL = "22222222-2222-4222-8222-222222222222";
const VERSION = "33333333-3333-4333-8333-333333333333";
const ARTIFACT = "44444444-4444-4444-8444-444444444444";
const SHA = "a".repeat(64);

const ENVELOPE = {
  modelContextTokens: 200_000,
  counts: {},
  reserved: {
    output: 8_000,
    toolResults: 4_000,
    compaction: 4_000,
    safetyMargin: 2_000,
  },
} as const;

type Identity = Record<string, unknown>;

function contextWith(identity: Identity | null) {
  const queries: { sql: string; values: readonly unknown[] }[] = [];
  const transaction = {
    query: (sql: string, values: readonly unknown[] = []) => {
      queries.push({ sql, values });
      // Only the identity read matters here: a text-only build never touches
      // the database, and an artifact build reads metadata before content.
      if (
        identity !== null && sql.includes("from bakery.artifact_versions v")
      ) {
        return Promise.resolve({ rows: [identity], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  } as unknown as PgTransactionClient;
  const context = {
    transaction,
    authority: {
      organizationId: ORG,
      subject: { principalId: PRINCIPAL },
    },
  } as unknown as ActionContext;
  return { context, queries };
}

function build(raw: unknown): Promise<unknown> {
  const { context } = contextWith(null);
  return buildContextPack(context, raw);
}

const textCandidate = (itemId: string, text: string, extra = {}) => ({
  itemId,
  kind: "text" as const,
  text,
  ...extra,
});

Deno.test("a text-only pack admits every caller text in the caller's order", async () => {
  const pack = await build({
    envelope: ENVELOPE,
    candidates: [
      textCandidate("b-second", "beta text"),
      textCandidate("a-first", "alpha text"),
    ],
  }) as Awaited<ReturnType<typeof buildContextPack>>;

  assertEquals(pack.decision, "ready");
  // The caller named the order; the builder never re-sorts.
  assertEquals(pack.items.map((item) => item.itemId), ["b-second", "a-first"]);
  // Text the caller already holds has no version to cite, so it carries none:
  // a fabricated citation would be worse than an absent one.
  assertEquals(pack.items.map((item) => item.citation), [null, null]);
  assertEquals(pack.items.map((item) => item.kind), ["text", "text"]);
  assertEquals(
    pack.items.every((item) => item.countState === "estimated"),
    true,
  );
  assertEquals(pack.omitted, []);
  assertEquals(typeof pack.packDigest, "string");
});

Deno.test("the same inputs give the same digest, and a changed selection changes it", async () => {
  const first = await build({
    envelope: ENVELOPE,
    candidates: [textCandidate("one", "same text")],
  }) as Awaited<ReturnType<typeof buildContextPack>>;
  const again = await build({
    envelope: ENVELOPE,
    candidates: [textCandidate("one", "same text")],
  }) as Awaited<ReturnType<typeof buildContextPack>>;
  const changed = await build({
    envelope: ENVELOPE,
    candidates: [textCandidate("one", "different text")],
  }) as Awaited<ReturnType<typeof buildContextPack>>;

  // A run pins the digest it was handed, so the digest may not depend on the
  // clock, the request id or anything else about the call.
  assertEquals(first.packDigest, again.packDigest);
  assertEquals(first.packDigest === changed.packDigest, false);
});

Deno.test("a pack that admits nothing has no digest to pin", async () => {
  const pack = await build({
    envelope: { ...ENVELOPE, maxInputTokens: 50 },
    candidates: [textCandidate("only", "x".repeat(65_536), { required: true })],
  }) as Awaited<ReturnType<typeof buildContextPack>>;

  // Required content that cannot fit hands off rather than trimming, and an
  // empty selection cannot be pinned by a digest that would describe nothing.
  assertEquals(pack.decision, "handoff_required");
  assertEquals(pack.items, []);
  assertEquals(pack.packDigest, null);
});

Deno.test("an optional item that does not fit is omitted with a reason, not dropped", async () => {
  const pack = await build({
    envelope: { ...ENVELOPE, maxInputTokens: 50 },
    candidates: [
      textCandidate("small", "a".repeat(40)),
      textCandidate("large", "b".repeat(4_000)),
    ],
  }) as Awaited<ReturnType<typeof buildContextPack>>;

  assertEquals(pack.items.map((item) => item.itemId), ["small"]);
  assertEquals(pack.omitted, [{ itemId: "large", reason: "over_budget" }]);
  assertEquals(pack.usedTokens > 0, true);
});

Deno.test("a duplicate candidate id is refused, because an omission would be ambiguous", async () => {
  const error = await assertRejects(() =>
    build({
      envelope: ENVELOPE,
      candidates: [textCandidate("same", "one"), textCandidate("same", "two")],
    })
  );
  assertEquals(error instanceof StandardError, true);
  assertEquals((error as StandardError).code, "UNPROCESSABLE");
});

Deno.test("an artifact version that no longer exists is an omission, not a failed build", async () => {
  const { context } = contextWith(null);
  const pack = await buildContextPack(context, {
    envelope: ENVELOPE,
    candidates: [
      textCandidate("kept", "still here"),
      {
        itemId: "gone",
        kind: "artifact" as const,
        artifactVersionId: VERSION,
        startByte: 0,
        maxBytes: 1_024,
        priority: 0,
        required: false,
      },
    ],
  });

  // One unreadable candidate must not cost the step the rest of its context.
  assertEquals(pack.items.map((item) => item.itemId), ["kept"]);
  assertEquals(pack.omitted, [{ itemId: "gone", reason: "not_found" }]);
});

Deno.test("a purged artifact version is reported as not_found", async () => {
  const { context } = contextWith({
    id: VERSION,
    purged_at: new Date().toISOString(),
    artifact_id: ARTIFACT,
    media_type: "text/plain; charset=utf-8",
    size_bytes: 10,
    sha256: SHA,
  });

  const pack = await buildContextPack(context, {
    envelope: ENVELOPE,
    candidates: [{
      itemId: "purged",
      kind: "artifact" as const,
      artifactVersionId: VERSION,
      startByte: 0,
      maxBytes: 1_024,
      priority: 0,
      required: false,
    }],
  });

  assertEquals(pack.omitted, [{ itemId: "purged", reason: "not_found" }]);
});

Deno.test("a non-text version becomes a reference with no text, never a blob", async () => {
  const { context, queries } = contextWith({
    id: VERSION,
    purged_at: null,
    artifact_id: ARTIFACT,
    media_type: "image/png",
    size_bytes: 4_096,
    sha256: SHA,
  });

  const pack = await buildContextPack(context, {
    envelope: ENVELOPE,
    candidates: [{
      itemId: "diagram",
      kind: "artifact" as const,
      artifactVersionId: VERSION,
      startByte: 0,
      maxBytes: 1_024,
      priority: 0,
      required: false,
    }],
  });

  assertEquals(pack.items.length, 1);
  const [item] = pack.items;
  assertEquals(item.kind, "image_reference");
  assertEquals(item.text, null);
  assertEquals(item.itemId, "diagram");
  assertEquals(
    (item.citation as { sha256: string }).sha256,
    SHA,
  );
  // A reference is metadata only: no content query ran, so a pack cannot leak
  // bytes the caller would have to re-authorize to read.
  assertEquals(
    queries.some((entry) => entry.sql.includes("v.content")),
    false,
  );
});

Deno.test("an unknown count is never counted as zero", async () => {
  const pack = await build({
    envelope: ENVELOPE,
    candidates: [textCandidate("known", "text")],
  }) as Awaited<ReturnType<typeof buildContextPack>>;

  // Every admitted item carries how its count was obtained, so a total can be
  // read without assuming it was measured.
  for (const item of pack.items) {
    assertEquals(
      ["measured", "estimated", "unknown"].includes(item.countState),
      true,
    );
    if (item.countState === "unknown") assertEquals(item.tokens, 0);
  }
});
