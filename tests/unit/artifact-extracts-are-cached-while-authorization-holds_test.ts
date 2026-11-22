import { assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import type { PgTransactionClient } from "../../apps/server/src/platform/database.ts";
import {
  evictExtractCacheBeyondCap,
  extractScope,
  findCachedExtract,
  reusableCachedExtract,
  storeCachedExtract,
} from "../../apps/server/src/modules/knowledge/extract-cache.ts";
import {
  cachedExtractWindow,
  CONTEXT_EXTRACTOR_VERSION,
  EXTRACT_CACHE_CHUNK_BYTES,
  EXTRACT_CACHE_ROWS_PER_VERSION,
  extractCacheKey,
} from "../../apps/server/src/modules/knowledge/context-projection.ts";
import { extractArtifactVersion } from "../../apps/server/src/modules/knowledge/extraction.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";

// Issue #14, checklist item 3: a bounded immutable extract may be cached, but
// only while the live authorization that permitted it still holds. The cache is
// the second half - #172 already provides verifyCitation, extractCacheKey and
// the projections, and nothing here re-implements them.

const ORG = "11111111-1111-4111-8111-111111111111";
const VERSION = "22222222-2222-4222-8222-222222222222";
const ARTIFACT = "33333333-3333-4333-8333-333333333333";
const SHA = "a".repeat(64);

type Query = { sql: string; values: readonly unknown[] };

function stubTransaction(
  handler: (sql: string, values: readonly unknown[]) => unknown[],
) {
  const queries: Query[] = [];
  const transaction = {
    query: (sql: string, values: readonly unknown[] = []) => {
      queries.push({ sql, values });
      return Promise.resolve({ rows: handler(sql, values), rowCount: 1 });
    },
  } as unknown as PgTransactionClient;
  return { transaction, queries };
}

const citation = {
  artifactId: ARTIFACT,
  versionId: VERSION,
  sha256: SHA,
  mediaType: "text/plain",
  location: { startByte: 0, endByteExclusive: 10 },
  extractorVersion: CONTEXT_EXTRACTOR_VERSION,
};

Deno.test("the cache scope names the principal and how far its access reached", () => {
  assertEquals(
    extractScope({ principalId: "p1", accessScope: undefined } as never),
    "p1|org",
  );
  assertEquals(
    extractScope({ principalId: "p1", accessScope: "task:t1" } as never),
    "p1|task:t1",
  );
  // A different principal or a narrower scope is a different key, so one
  // caller's cached extract is never served to another.
  assertEquals(
    extractScope({ principalId: "p2", accessScope: "task:t1" } as never) ===
      extractScope({ principalId: "p1", accessScope: "task:t1" } as never),
    false,
  );
});

Deno.test("a cached extract is reusable only while digest and extractor still hold", () => {
  const cached = {
    citation: { ...citation },
    text: "hello",
    hasMore: false,
  };
  assertEquals(
    reusableCachedExtract(cached, { authorized: true, currentSha256: SHA }),
    true,
  );
  // The version moved on: the pinned digest no longer describes it.
  assertEquals(
    reusableCachedExtract(cached, {
      authorized: true,
      currentSha256: "b".repeat(64),
    }),
    false,
  );
  // Access was withdrawn: the row is not reused, and the caller learns nothing.
  assertEquals(
    reusableCachedExtract(cached, { authorized: false, currentSha256: SHA }),
    false,
  );
  // The version is gone.
  assertEquals(
    reusableCachedExtract(cached, { authorized: true, currentSha256: null }),
    false,
  );
  // A citation produced by another extractor version is not reused as though it
  // were this one's output.
  assertEquals(
    reusableCachedExtract(
      {
        ...cached,
        citation: { ...citation, extractorVersion: "bakery.text-window@0" },
      },
      { authorized: true, currentSha256: SHA },
    ),
    false,
  );
});

Deno.test("a lookup asks for the request it can name, within one scope and digest", async () => {
  const { transaction, queries } = stubTransaction(() => []);
  const found = await findCachedExtract(transaction, {
    organizationId: ORG,
    versionId: VERSION,
    sha256: SHA,
    startByte: 0,
    maxBytes: 4096,
    scope: "p1|org",
  });
  assertEquals(found, null);
  const [query] = queries;
  assertEquals(query!.sql.includes("bakery.artifact_extracts"), true);
  assertEquals(query!.values, [
    ORG,
    VERSION,
    SHA,
    0,
    4096,
    CONTEXT_EXTRACTOR_VERSION,
    "p1|org",
  ]);
});

Deno.test("a malformed cache row is ignored rather than trusted", async () => {
  // A stored citation that does not describe what the row claims (here: a range
  // that ends before it starts) is not served.
  const { transaction } = stubTransaction(() => [{
    artifact_id: ARTIFACT,
    start_byte: 10,
    end_byte_exclusive: 2,
    text: "nope",
    has_more: false,
    media_type: "text/plain",
    digest: SHA,
    extractor_version: CONTEXT_EXTRACTOR_VERSION,
  }]);
  const found = await findCachedExtract(transaction, {
    organizationId: ORG,
    versionId: VERSION,
    sha256: SHA,
    startByte: 10,
    maxBytes: 8,
    scope: "p1|org",
  });
  assertEquals(found, null);
});

Deno.test("storing an extract writes the key verifyCitation recomputes", async () => {
  const { transaction, queries } = stubTransaction(() => []);
  await storeCachedExtract(transaction, {
    organizationId: ORG,
    scope: "p1|org",
    citation: { ...citation },
    text: "hello",
    hasMore: false,
    maxBytes: 4096,
  });
  const [query] = queries;
  assertEquals(query!.sql.includes("on conflict do nothing"), true);
  const values = query!.values;
  assertEquals(values[0], ORG);
  assertEquals(values[1], VERSION);
  assertEquals(values[2], SHA);
  assertEquals(values[3], 0);
  assertEquals(values[4], 10);
  assertEquals(values[5], "p1|org");
  assertEquals(values[9], 5, "text bytes are counted, not trusted");
  assertEquals(
    values[12],
    await extractCacheKey(ORG, { ...citation }, "p1|org"),
    "the stored key is the one the projection module computes, scope included",
  );
  assertEquals(
    String(values[12]).includes("p1|org"),
    false,
    "the key holds a digest of the scope, not the scope's own text",
  );
});

Deno.test("two scopes for the same window are two rows, not one lost insert", async () => {
  // The scope used to be outside the key, so the second scope's insert hit the
  // primary key and `on conflict do nothing` dropped it silently: that scope was
  // never cached and every read of it re-read the bytes.
  const { transaction, queries } = stubTransaction(() => []);
  for (const scope of ["p1|org", "p2|narrower"]) {
    await storeCachedExtract(transaction, {
      organizationId: ORG,
      scope,
      citation: { ...citation },
      text: "hello",
      hasMore: false,
      maxBytes: 4096,
    });
  }
  assertEquals(queries.length, 2);
  const keys = queries.map((query) => String(query.values[12]));
  assertEquals(keys[0] === keys[1], false);
  assertNotEquals(keys[0], keys[1]);
});

Deno.test("a window carrying a NUL byte is not written to the cache", async () => {
  // Postgres text cannot hold a NUL. The sniff only looks at the first 4 KB, so
  // a NUL later in the window reached the insert and failed the whole request.
  const { transaction, queries } = stubTransaction(() => []);
  await storeCachedExtract(transaction, {
    organizationId: ORG,
    scope: "p1|org",
    citation: { ...citation },
    text: `${"a".repeat(5000)}\u0000tail`,
    hasMore: false,
    maxBytes: 8192,
  });
  assertEquals(queries.length, 0, "nothing is inserted for unstorable text");
});

Deno.test("an extraction reuses a cached window without reading content", async () => {
  const { transaction, queries } = stubTransaction((sql) => {
    if (sql.includes("from bakery.artifact_versions v")) {
      if (sql.includes("v.artifact_id")) {
        return [{
          id: VERSION,
          purged_at: null,
          artifact_id: ARTIFACT,
          media_type: "text/plain",
          size_bytes: 10,
          sha256: SHA,
        }];
      }
    }
    if (sql.includes("from bakery.artifact_extracts e")) {
      return [{
        artifact_id: ARTIFACT,
        start_byte: 0,
        end_byte_exclusive: 10,
        text: "hello worl",
        has_more: false,
        media_type: "text/plain",
        digest: SHA,
        extractor_version: CONTEXT_EXTRACTOR_VERSION,
      }];
    }
    throw new Error(`unexpected query: ${sql}`);
  });
  const result = await extractArtifactVersion(
    {
      params: { id: VERSION },
      authority: { organizationId: ORG, subject: { principalId: "p1" } },
      transaction,
    } as never,
    {},
  );
  assertEquals(result.text, "hello worl");
  assertEquals(result.endByteExclusive, 10);
  // The content column was never read on the hit path.
  assertEquals(
    queries.some((query) => query.sql.includes("sha256(v.content)")),
    false,
  );
});

Deno.test("a digest change on the version refuses the cached row and reads content again", async () => {
  let contentRead = 0;
  const { transaction } = stubTransaction((sql) => {
    if (sql.includes("sha256(v.content)")) {
      contentRead += 1;
      // The stale row was not served, so the content read happens and finds
      // nothing in this stub.
      return [];
    }
    if (sql.includes("from bakery.artifact_versions v")) {
      return [{
        id: VERSION,
        purged_at: null,
        artifact_id: ARTIFACT,
        media_type: "text/plain",
        size_bytes: 10,
        sha256: "b".repeat(64),
      }];
    }
    if (sql.includes("from bakery.artifact_extracts e")) {
      return [{
        artifact_id: ARTIFACT,
        start_byte: 0,
        end_byte_exclusive: 10,
        text: "stale text",
        has_more: false,
        media_type: "text/plain",
        digest: SHA,
        extractor_version: CONTEXT_EXTRACTOR_VERSION,
      }];
    }
    throw new Error(`unexpected query: ${sql}`);
  });
  await assertRejects(
    () =>
      extractArtifactVersion(
        {
          params: { id: VERSION },
          authority: { organizationId: ORG, subject: { principalId: "p1" } },
          transaction,
        } as never,
        {},
      ),
    StandardError,
  );
  assertEquals(contentRead > 0, true, "the stale cache row was not served");
});

Deno.test("arbitrary offsets cannot mint a row each: windows are keyed by chunk", async () => {
  // The reviewer's Medium on #634. The extract is a pure function of its window,
  // so without chunking every distinct startByte a reader names would be a new
  // row: a read endpoint anyone can call would be an unbounded write. One chunk
  // of stride means a thousand offsets inside it are one key.
  const keys = new Set<string>();
  for (let startByte = 0; startByte < 4096; startByte += 37) {
    const window = cachedExtractWindow(startByte);
    assertEquals(window.startByte, 0);
    assertEquals(window.maxBytes, EXTRACT_CACHE_CHUNK_BYTES);
    keys.add(
      await extractCacheKey(ORG, {
        ...citation,
        location: {
          startByte: window.startByte,
          endByteExclusive: window.maxBytes,
        },
      }),
    );
  }
  assertEquals(keys.size, 1, "one chunk, one row");

  // Across the whole range a request may name, the distinct rows are the chunks,
  // never the offsets.
  const everywhere = new Set<number>();
  for (let startByte = 0; startByte <= 10_485_760; startByte += 1013) {
    everywhere.add(cachedExtractWindow(startByte).startByte);
  }
  assertEquals(
    everywhere.size,
    Math.ceil(10_485_760 / EXTRACT_CACHE_CHUNK_BYTES),
    "one row per chunk, whatever offsets the reader names",
  );
});

Deno.test("the cache keeps at most the capped number of rows per version", async () => {
  // Eviction is the second half of the bound: a version read all the way through
  // would otherwise keep growing. The statement keeps the newest rows and deletes
  // the rest of that version only, in the transaction that inserted the newest.
  const { transaction, queries } = stubTransaction(() => []);
  await evictExtractCacheBeyondCap(transaction, {
    organizationId: ORG,
    versionId: VERSION,
  });
  const [query] = queries;
  assertEquals(
    query!.sql.includes("delete from bakery.artifact_extracts"),
    true,
  );
  assertEquals(query!.values, [ORG, VERSION, EXTRACT_CACHE_ROWS_PER_VERSION]);
});

// The identity read is the live authorization gate. A cache row that would
// answer the request must never be consulted when that read finds nothing for
// the caller, or finds the version purged.
const CACHE_ROW = {
  artifact_id: ARTIFACT,
  start_byte: 0,
  end_byte_exclusive: 10,
  text: "hello worl",
  has_more: false,
  media_type: "text/plain",
  digest: SHA,
  extractor_version: CONTEXT_EXTRACTOR_VERSION,
};

function extractWithIdentity(identityRows: unknown[]) {
  const { transaction, queries } = stubTransaction((sql) => {
    if (sql.includes("from bakery.artifact_extracts e")) return [CACHE_ROW];
    if (sql.includes("from bakery.artifact_versions v")) return identityRows;
    throw new Error(`unexpected query: ${sql}`);
  });
  const call = () =>
    extractArtifactVersion(
      {
        params: { id: VERSION },
        authority: { organizationId: ORG, subject: { principalId: "p1" } },
        transaction,
      } as never,
      {},
    );
  return { queries, call };
}

Deno.test("withdrawn access is refused even with a valid cache row, and the cache is never read", async () => {
  const { queries, call } = extractWithIdentity([]);
  const error = await assertRejects(call, StandardError);
  assertEquals((error as StandardError).code, "RESOURCE_NOT_FOUND");
  assertEquals(
    queries.some((query) => query.sql.includes("artifact_extracts")),
    false,
  );
});

Deno.test("a purged version is refused even with a valid cache row, and the cache is never read", async () => {
  const { queries, call } = extractWithIdentity([{
    id: VERSION,
    purged_at: "2026-11-20T00:00:00Z",
    artifact_id: ARTIFACT,
    media_type: "text/plain",
    size_bytes: 10,
    sha256: SHA,
  }]);
  const error = await assertRejects(call, StandardError);
  assertEquals((error as StandardError).code, "ARTIFACT_CONTENT_EXPIRED");
  assertEquals(
    queries.some((query) => query.sql.includes("artifact_extracts")),
    false,
  );
});
