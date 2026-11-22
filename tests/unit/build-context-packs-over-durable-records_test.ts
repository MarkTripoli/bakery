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

/** The organization the identity row belongs to; a read in another one finds nothing. */
const ROW_ORG = ORG;

function contextWith(
  identity: Identity | null,
  callerOrganization: string = ORG,
) {
  const queries: { sql: string; values: readonly unknown[] }[] = [];
  const transaction = {
    query: (sql: string, values: readonly unknown[] = []) => {
      queries.push({ sql, values });
      // Only the identity read matters here: a text-only build never touches
      // the database, and an artifact build reads metadata before content.
      // Like the real lookup, the row is only visible in its own organization:
      // $1 is the organization, $2 the version.
      if (
        identity !== null && sql.includes("from bakery.artifact_versions v") &&
        values[0] === ROW_ORG
      ) {
        return Promise.resolve({ rows: [identity], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  } as unknown as PgTransactionClient;
  const context = {
    transaction,
    authority: {
      organizationId: callerOrganization,
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

Deno.test("the digest changes when caller text changes, even at the same token count", async () => {
  // Both are 12 bytes, so both count as 12 estimated tokens: only the text differs.
  const pack = (text: string) =>
    build({
      envelope: ENVELOPE,
      candidates: [textCandidate("one", text)],
    }) as Promise<Awaited<ReturnType<typeof buildContextPack>>>;
  const first = await pack("rm -rf build");
  const second = await pack("rm -rf /home");
  assertEquals(first.usedTokens, second.usedTokens);
  assertEquals(first.packDigest === second.packDigest, false);
});

Deno.test("the digest changes with the conversation cutoff and the repository the pack names", async () => {
  const pack = (extra: Record<string, unknown>) =>
    build({
      envelope: ENVELOPE,
      candidates: [textCandidate("one", "same text")],
      ...extra,
    }) as Promise<Awaited<ReturnType<typeof buildContextPack>>>;
  const base = await pack({});
  const cutoff = await pack({ conversationCutoff: 42 });
  const repo = await pack({ repository: { commitSha: "a".repeat(40) } });
  const otherRepo = await pack({ repository: { commitSha: "b".repeat(40) } });
  const digests = [base, cutoff, repo, otherRepo].map((p) => p.packDigest);
  assertEquals(new Set(digests).size, 4);
  // And the same inputs still give the same digest.
  assertEquals(
    (await pack({ conversationCutoff: 42 })).packDigest,
    cutoff.packDigest,
  );
});

Deno.test("a bad nested request and a duplicate id are 422s that name the field", async () => {
  const error = await assertRejects(
    () =>
      build({
        envelope: ENVELOPE,
        candidates: [{ itemId: "x", kind: "nope" }],
      }),
    StandardError,
  );
  assertEquals((error as StandardError).code, "UNPROCESSABLE");
  const duplicate = await assertRejects(
    () =>
      build({
        envelope: ENVELOPE,
        candidates: [textCandidate("same", "a"), textCandidate("same", "b")],
      }),
    StandardError,
  );
  assertEquals((duplicate as StandardError).code, "UNPROCESSABLE");
  assertEquals(
    JSON.stringify((duplicate as StandardError).params).includes("candidates"),
    true,
  );
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

Deno.test("a text artifact in a pack carries its window, redacted, with a citation of the raw bytes", async () => {
  const raw = "config\npassword: hunter2hunter2 and ghp_" +
    "abcdefghijklmnopqrstuvwxyz0123456789" + "\nend\n";
  const bytes = new TextEncoder().encode(raw);
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  const identity = {
    id: VERSION,
    purged_at: null,
    artifact_id: ARTIFACT,
    media_type: "text/plain",
    size_bytes: bytes.byteLength,
    sha256: digest,
  };
  const transaction = {
    query: (sql: string, values: readonly unknown[] = []) => {
      if (sql.includes("sha256(v.content)")) {
        const [, , probe, windowStart, windowLength] = values as number[];
        const start = Number(windowStart) - 1;
        return Promise.resolve({
          rowCount: 1,
          rows: [{
            ...identity,
            content_size_bytes: bytes.byteLength,
            validated_text_size: bytes.byteLength,
            content_sha256: digest,
            media_probe: bytes.subarray(0, Number(probe)),
            window: bytes.subarray(start, start + Number(windowLength)),
          }],
        });
      }
      if (sql.includes("from bakery.artifact_versions v")) {
        return Promise.resolve({ rowCount: 1, rows: [identity] });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  } as unknown as PgTransactionClient;
  const context = {
    transaction,
    // A pack is built by POST /v1/context-packs: no :id in the path.
    params: {},
    authority: { organizationId: ORG, subject: { principalId: PRINCIPAL } },
  } as unknown as ActionContext;

  const pack = await buildContextPack(context, {
    envelope: ENVELOPE,
    candidates: [{
      itemId: "log",
      kind: "artifact" as const,
      artifactVersionId: VERSION,
      startByte: 0,
      maxBytes: 4_096,
      priority: 0,
      required: false,
    }],
  });

  assertEquals(pack.omitted, []);
  const [item] = pack.items;
  assertEquals(item.kind, "text_window");
  assertEquals(item.text!.includes("hunter2hunter2"), false);
  assertEquals(item.text!.includes("ghp_"), false);
  assertEquals(item.text!.includes("config"), true);
  assertEquals(item.limits, null);
  assertEquals(item.redactions, 2);
  // The citation still pins the raw bytes and digest.
  const citation = item.citation as {
    sha256: string;
    location: { startByte: number; endByteExclusive: number };
  };
  assertEquals(citation.sha256, digest);
  assertEquals(citation.location, {
    startByte: 0,
    endByteExclusive: bytes.byteLength,
  });
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
  assertEquals(item.limits, "binary_media");
  assertEquals(item.redactions, 0);
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

Deno.test("a PDF is a reference that says it has no text extractor, an unknown binary says it is binary", async () => {
  for (
    const [mediaType, kind, limits] of [
      ["application/pdf", "pdf_reference", "no_text_extractor"],
      ["application/zip", "binary_reference", "binary_media"],
    ] as const
  ) {
    const { context } = contextWith({
      id: VERSION,
      purged_at: null,
      artifact_id: ARTIFACT,
      media_type: mediaType,
      size_bytes: 4_096,
      sha256: SHA,
    });
    const pack = await buildContextPack(context, {
      envelope: ENVELOPE,
      candidates: [{
        itemId: "doc",
        kind: "artifact" as const,
        artifactVersionId: VERSION,
        startByte: 0,
        maxBytes: 1_024,
        priority: 0,
        required: false,
      }],
    });
    const [item] = pack.items;
    assertEquals(item.kind, kind);
    assertEquals(item.limits, limits);
    assertEquals(item.text, null);
  }
});

Deno.test("a caller's own text carries no limit and no redaction", async () => {
  const pack = await build({
    envelope: ENVELOPE,
    candidates: [{
      itemId: "note",
      kind: "text",
      text: "plain note",
      priority: 0,
      required: false,
    }],
  }) as { items: Array<{ limits: unknown; redactions: number }> };
  assertEquals(pack.items[0].limits, null);
  assertEquals(pack.items[0].redactions, 0);
});

Deno.test("a pack digest moves when an item's limit moves", async () => {
  const digestFor = async (mediaType: string) => {
    const { context } = contextWith({
      id: VERSION,
      purged_at: null,
      artifact_id: ARTIFACT,
      media_type: mediaType,
      size_bytes: 4_096,
      sha256: SHA,
    });
    const pack = await buildContextPack(context, {
      envelope: ENVELOPE,
      candidates: [{
        itemId: "doc",
        kind: "artifact" as const,
        artifactVersionId: VERSION,
        startByte: 0,
        maxBytes: 1_024,
        priority: 0,
        required: false,
      }],
    });
    return pack.packDigest;
  };
  // Same sha, same size, different media type: kind and limit both differ.
  assertEquals(
    (await digestFor("application/pdf")) ===
      (await digestFor("application/zip")),
    false,
  );
});

Deno.test("an unknown, unbounded count in the envelope blocks the pack instead of counting as zero", async () => {
  const pack = await build({
    envelope: {
      ...ENVELOPE,
      counts: {
        conversation: { state: "unknown", tokens: null, boundTokens: null },
      },
    },
    candidates: [textCandidate("note", "small", { required: true })],
  }) as Awaited<ReturnType<typeof buildContextPack>>;

  // Treating the unknown as 0 would admit the note as if there were room.
  assertEquals(pack.decision, "bound-more-before-dispatch");
  assertEquals(pack.items, []);
  assertEquals(pack.packDigest, null);
});

Deno.test("every admitted item says how its count was obtained, and none is unknown", async () => {
  const pack = await build({
    envelope: ENVELOPE,
    candidates: [textCandidate("known", "text")],
  }) as Awaited<ReturnType<typeof buildContextPack>>;

  assertEquals(pack.items.length, 1);
  for (const item of pack.items) assertEquals(item.countState, "estimated");
});

Deno.test("the identity read is made in the caller's organization, and another organization's version is not found", async () => {
  const identity = {
    id: VERSION,
    purged_at: null,
    artifact_id: ARTIFACT,
    media_type: "image/png",
    size_bytes: 4_096,
    sha256: SHA,
  };
  const candidates = [
    textCandidate("kept", "still here"),
    {
      itemId: "theirs",
      kind: "artifact" as const,
      artifactVersionId: VERSION,
      startByte: 0,
      maxBytes: 1_024,
      priority: 0,
      required: false,
    },
  ];

  // The caller's organization owns the row: found, and the read names it.
  const own = contextWith(identity, ORG);
  const found = await buildContextPack(own.context, {
    envelope: ENVELOPE,
    candidates,
  });
  assertEquals(found.items.map((item) => item.itemId), ["kept", "theirs"]);
  const reads = own.queries.filter((entry) =>
    entry.sql.includes("from bakery.artifact_versions v")
  );
  assertEquals(reads.length, 1);
  assertEquals(reads[0].values[0], ORG);
  assertEquals(reads[0].values[1], VERSION);

  // A caller in another organization asks for the same version id: the lookup
  // is scoped to the caller's organization, finds nothing, and the rest of the
  // pack still builds.
  const OTHER_ORG = "99999999-9999-4999-8999-999999999999";
  const foreign = contextWith(identity, OTHER_ORG);
  const refused = await buildContextPack(foreign.context, {
    envelope: ENVELOPE,
    candidates,
  });
  assertEquals(refused.items.map((item) => item.itemId), ["kept"]);
  assertEquals(refused.omitted, [{ itemId: "theirs", reason: "not_found" }]);
  assertEquals(
    foreign.queries.filter((entry) =>
      entry.sql.includes("from bakery.artifact_versions v")
    ).every((entry) => entry.values[0] === OTHER_ORG),
    true,
  );
});
