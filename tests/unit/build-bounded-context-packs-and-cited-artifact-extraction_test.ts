import {
  assert,
  assertEquals,
  assertNotEquals,
  assertThrows,
} from "@std/assert";
import {
  allocateContext,
  ContextDecision,
  type ContextEnvelopeInput,
  resolveContextEnvelope,
} from "../../apps/server/src/modules/knowledge/context-budget.ts";
import {
  CONTEXT_EXTRACTOR_VERSION,
  ContextCitationSchema,
  extractCacheKey,
  MAX_PROJECTION_BYTES,
  projectArtifactVersion,
  REFERENCE_TOKENS,
  unboundedItem,
  verifyCitation,
} from "../../apps/server/src/modules/knowledge/context-projection.ts";

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

// ---------------------------------------------------------------------------
// Slice 2: index-first projections with exact citations.
// ---------------------------------------------------------------------------

const DIGEST = "a".repeat(64);
const entry = (mediaType: string, sizeBytes: number | null = 1_000) => ({
  artifactId: "11111111-1111-4111-8111-111111111111",
  versionId: "22222222-2222-4222-8222-222222222222",
  sha256: DIGEST,
  mediaType,
  sizeBytes,
});

Deno.test("text and log windows carry an exact byte-range citation and an estimated count", () => {
  const text = "line one\nline two ✓\n";
  const bytes = new TextEncoder().encode(text).byteLength;
  for (
    const [mediaType, kind] of [
      ["text/markdown", "text_window"],
      ["text/x-log", "log_window"],
      ["application/x-ndjson", "log_window"],
    ] as const
  ) {
    const projection = projectArtifactVersion(entry(mediaType), {
      startByte: 100,
      endByteExclusive: 100 + bytes,
      text,
      hasMore: true,
    });
    assertEquals(projection.kind, kind);
    assertEquals(projection.text, text);
    assertEquals(projection.truncated, true);
    assertEquals(projection.citation, {
      artifactId: entry(mediaType).artifactId,
      versionId: entry(mediaType).versionId,
      sha256: DIGEST,
      mediaType,
      location: { startByte: 100, endByteExclusive: 100 + bytes },
      extractorVersion: CONTEXT_EXTRACTOR_VERSION,
    });
    assertEquals(projection.item.count, { state: "estimated", tokens: bytes });
  }
});

Deno.test("images, PDFs and unknown binaries are references: no bytes enter context (AC3)", () => {
  for (
    const [mediaType, kind] of [
      ["image/png", "image_reference"],
      ["application/pdf", "pdf_reference"],
      ["application/octet-stream", "binary_reference"],
      ["application/zip", "binary_reference"],
    ] as const
  ) {
    // Even when a caller hands over a window, binary content is never text.
    const projection = projectArtifactVersion(entry(mediaType), {
      startByte: 0,
      endByteExclusive: 4,
      text: "AAAA",
      hasMore: false,
    });
    assertEquals(projection.kind, kind);
    assertEquals(projection.text, null);
    assertEquals(projection.citation.location, null);
    assertEquals(projection.citation.extractorVersion, null);
    assertEquals(projection.item.count, {
      state: "estimated",
      tokens: REFERENCE_TOKENS,
    });
  }
});

Deno.test("text with no extracted window falls back to a reference, never to whole content (AC3)", () => {
  const projection = projectArtifactVersion(
    entry("text/plain", 9_000_000),
    null,
  );
  assertEquals(projection.text, null);
  assertEquals(projection.citation.location, null);
});

Deno.test("an oversized or inconsistent window is refused", () => {
  const big = "x".repeat(MAX_PROJECTION_BYTES + 1);
  assertThrows(() =>
    projectArtifactVersion(entry("text/plain"), {
      startByte: 0,
      endByteExclusive: big.length,
      text: big,
      hasMore: false,
    })
  );
  // The declared range must equal the text's real byte length.
  assertThrows(() =>
    projectArtifactVersion(entry("text/plain"), {
      startByte: 0,
      endByteExclusive: 3,
      text: "✓✓",
      hasMore: false,
    })
  );
});

Deno.test("unindexed content is unknown and unbounded, so allocation omits it instead of counting zero (AC1)", () => {
  const allocation = allocateContext({
    envelope: envelope({}),
    items: [
      projectArtifactVersion(entry("text/plain"), {
        startByte: 0,
        endByteExclusive: 5,
        text: "hello",
        hasMore: false,
      }).item,
      unboundedItem("unindexed-log"),
    ],
  });
  assertEquals(allocation.decision, ContextDecision.Ready);
  assertEquals(allocation.omitted, [
    { id: "unindexed-log", reason: "unbounded_unknown" },
  ]);
  assertEquals(allocation.selectedTokens, 5);
});

Deno.test("a citation or cached extract is reused only while digest, extractor and live access hold (AC2)", () => {
  const citation = projectArtifactVersion(entry("text/plain"), {
    startByte: 0,
    endByteExclusive: 5,
    text: "hello",
    hasMore: false,
  }).citation;
  assertEquals(verifyCitation(citation, { authorized: true, sha256: DIGEST }), {
    valid: true,
  });
  assertEquals(
    verifyCitation(citation, { authorized: false, sha256: DIGEST }),
    { valid: false, reason: "not_authorized" },
  );
  assertEquals(verifyCitation(citation, { authorized: true, sha256: null }), {
    valid: false,
    reason: "version_missing",
  });
  assertEquals(
    verifyCitation(citation, { authorized: true, sha256: "b".repeat(64) }),
    { valid: false, reason: "digest_mismatch" },
  );
  assertEquals(
    verifyCitation({ ...citation, extractorVersion: "bakery.text-window@0" }, {
      authorized: true,
      sha256: DIGEST,
    }),
    { valid: false, reason: "extractor_changed" },
  );
  // The cache key binds organization, version, digest, range and extractor,
  // and carries no authorization decision.
  assertEquals(
    extractCacheKey("org", citation),
    `org|${citation.versionId}|${DIGEST}|0-5|${CONTEXT_EXTRACTOR_VERSION}`,
  );
  assertNotEquals(
    extractCacheKey("org", citation),
    extractCacheKey("other-org", citation),
  );
});

Deno.test("inconsistent citations are refused at the schema and by verifyCitation (AC2)", () => {
  const ranged = {
    artifactId: entry("text/plain").artifactId,
    versionId: entry("text/plain").versionId,
    sha256: DIGEST,
    mediaType: "text/plain",
    location: { startByte: 0, endByteExclusive: 5 },
    extractorVersion: CONTEXT_EXTRACTOR_VERSION,
  };
  const live = { authorized: true, sha256: DIGEST };
  const bad = [
    { ...ranged, extractorVersion: null },
    { ...ranged, location: { startByte: 10, endByteExclusive: 2 } },
    { ...ranged, location: null },
  ];
  for (const citation of bad) {
    assertEquals(
      ContextCitationSchema.safeParse(citation).success,
      false,
      JSON.stringify(citation),
    );
    // A value that bypassed the schema is still not trusted.
    assertEquals(
      verifyCitation(citation as never, live),
      { valid: false, reason: "extractor_changed" },
      JSON.stringify(citation),
    );
  }
  assertEquals(ContextCitationSchema.safeParse(ranged).success, true);
  assertEquals(verifyCitation(ranged, live), { valid: true });
});

Deno.test("an unauthorized caller learns nothing about the version", () => {
  const citation = projectArtifactVersion(entry("text/plain"), {
    startByte: 0,
    endByteExclusive: 5,
    text: "hello",
    hasMore: false,
  }).citation;
  for (const sha256 of [null, DIGEST, "b".repeat(64)]) {
    assertEquals(verifyCitation(citation, { authorized: false, sha256 }), {
      valid: false,
      reason: "not_authorized",
    });
  }
});

Deno.test("a required unindexed item blocks dispatch instead of being omitted (AC1)", () => {
  const allocation = allocateContext({
    envelope: envelope({}),
    items: [unboundedItem("u", { required: true })],
  });
  assertEquals(allocation.decision, ContextDecision.BoundMoreBeforeDispatch);
  assertEquals(allocation.selected, []);
});

Deno.test("references are never free and media types normalize", () => {
  assert(REFERENCE_TOKENS > 0);
  const window = (text: string) => ({
    startByte: 0,
    endByteExclusive: new TextEncoder().encode(text).byteLength,
    text,
    hasMore: false,
  });
  for (
    const [mediaType, kind] of [
      ["application/json", "text_window"],
      ["application/xml", "text_window"],
      ["TEXT/PLAIN; charset=utf-8", "text_window"],
      ["application/pdf; version=1.7", "pdf_reference"],
      ["IMAGE/PNG", "image_reference"],
    ] as const
  ) {
    assertEquals(
      projectArtifactVersion(entry(mediaType), window("{}")).kind,
      kind,
      mediaType,
    );
  }
});

Deno.test("a window of exactly the maximum size is accepted", () => {
  const text = "x".repeat(MAX_PROJECTION_BYTES);
  const projection = projectArtifactVersion(entry("text/plain"), {
    startByte: 0,
    endByteExclusive: MAX_PROJECTION_BYTES,
    text,
    hasMore: false,
  });
  assertEquals(projection.text?.length, MAX_PROJECTION_BYTES);
  assertThrows(() =>
    projectArtifactVersion(entry("text/plain"), {
      startByte: -1,
      endByteExclusive: 4,
      text: "abcde",
      hasMore: false,
    })
  );
});
