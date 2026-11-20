import type { PgTransactionClient } from "../../apps/server/src/platform/database.ts";
import { extractArtifactVersion } from "../../apps/server/src/modules/knowledge/extraction.ts";
import { assertEquals } from "@std/assert";

/**
 * #14 AC2, from qa3's probe on the closed #634: a cache hit must answer exactly
 * what the first (cold) read of the same request answered, for any window, not
 * only the chunk-aligned one. The database is a stateful in-memory stand-in
 * that serves the queries the real one would.
 */
const ORG = "11111111-1111-4111-8111-111111111111";
const VERSION = "22222222-2222-4222-8222-222222222222";
const ARTIFACT = "33333333-3333-4333-8333-333333333333";
const SIZE = 200_000;
// Byte i of line k is the 8-digit offset of the line start, then a newline: every 9 bytes.
const content = new TextEncoder().encode(
  Array.from(
    { length: Math.ceil(SIZE / 9) },
    (_, k) => String(k * 9).padStart(8, "0") + "\n",
  ).join("").slice(0, SIZE),
);
const sha = Array.from(
  new Uint8Array(await crypto.subtle.digest("SHA-256", content)),
  (b) => b.toString(16).padStart(2, "0"),
).join("");

function database() {
  const rows = new Map<string, Record<string, unknown>>();
  const transaction = {
    query: (sql: string, v: readonly unknown[] = []) => {
      if (sql.includes("sha256(v.content)")) {
        const [, , probe, windowStart, windowLength] = v as number[];
        const ws = Number(windowStart) - 1;
        return Promise.resolve({
          rowCount: 1,
          rows: [{
            id: VERSION,
            purged_at: null,
            media_type: "text/plain",
            size_bytes: SIZE,
            content_size_bytes: SIZE,
            validated_text_size: SIZE,
            content_sha256: sha,
            sha256: sha,
            media_probe: content.subarray(0, Number(probe)),
            window: content.subarray(ws, ws + Number(windowLength)),
          }],
        });
      }
      if (sql.includes("from bakery.artifact_extracts e")) {
        const [, , digest, start, max, , scope] = v as unknown[];
        const hit = [...rows.values()].find((r) =>
          r.digest === digest && r.start_byte === start &&
          r.max_bytes === max && r.scope === scope
        );
        return Promise.resolve({
          rowCount: hit ? 1 : 0,
          rows: hit
            ? [{
              artifact_id: ARTIFACT,
              start_byte: hit.start_byte,
              end_byte_exclusive: hit.end_byte_exclusive,
              text: hit.text,
              has_more: hit.has_more,
              media_type: hit.media_type,
              digest: hit.digest,
              extractor_version: hit.extractor_version,
            }]
            : [],
        });
      }
      if (sql.includes("insert into bakery.artifact_extracts")) {
        const [
          ,
          ,
          digest,
          start,
          end,
          scope,
          ext,
          media,
          text,
          ,
          max,
          hasMore,
          key,
        ] = v as unknown[];
        if (!rows.has(String(key))) {
          rows.set(String(key), {
            digest,
            start_byte: start,
            end_byte_exclusive: end,
            scope,
            extractor_version: ext,
            media_type: media,
            text,
            max_bytes: max,
            has_more: hasMore,
          });
        }
        return Promise.resolve({ rowCount: 1, rows: [] });
      }
      if (sql.includes("delete from bakery.artifact_extracts")) {
        return Promise.resolve({ rowCount: 0, rows: [] });
      }
      if (sql.includes("from bakery.artifact_versions v")) {
        return Promise.resolve({
          rowCount: 1,
          rows: [{
            id: VERSION,
            purged_at: null,
            artifact_id: ARTIFACT,
            media_type: "text/plain",
            size_bytes: SIZE,
            sha256: sha,
          }],
        });
      }
      throw new Error("unexpected query: " + sql.slice(0, 80));
    },
  } as unknown as PgTransactionClient;
  return { transaction, rows };
}

const REQUESTS: Array<[number, number]> = [
  [0, 10],
  [100, 10],
  [65_536, 20],
  [70_000, 10],
  [0, 65_536],
  [65_536, 65_536],
  [131_072, 65_536],
];

for (const [startByte, maxBytes] of REQUESTS) {
  Deno.test(
    `a repeated extract of start=${startByte} max=${maxBytes} answers exactly what the first one did`,
    async () => {
      const { transaction } = database();
      const context = {
        params: { id: VERSION },
        authority: {
          organizationId: ORG,
          subject: { principalId: "p1" },
        },
        transaction,
      } as never;
      const first = await extractArtifactVersion(context, {
        startByte,
        maxBytes,
      });
      const second = await extractArtifactVersion(context, {
        startByte,
        maxBytes,
      });
      assertEquals(second, first);
    },
  );
}

Deno.test("only the chunk-aligned full window is written to the cache", async () => {
  const { transaction, rows } = database();
  const context = {
    params: { id: VERSION },
    authority: { organizationId: ORG, subject: { principalId: "p1" } },
    transaction,
  } as never;
  for (const [startByte, maxBytes] of REQUESTS.slice(0, 4)) {
    await extractArtifactVersion(context, { startByte, maxBytes });
  }
  assertEquals(rows.size, 0, "a partial window must not mint a row");
  await extractArtifactVersion(context, {
    startByte: 65_536,
    maxBytes: 65_536,
  });
  await extractArtifactVersion(context, {
    startByte: 65_536,
    maxBytes: 65_536,
  });
  assertEquals(rows.size, 1, "one row per chunk, however often it is read");
});

// A request that is not the chunk-aligned full window must read cold even after
// its chunk is cached: the cached row holds the whole chunk's text, and serving
// it would label that text with the window the caller asked for.
for (
  const [startByte, maxBytes] of [
    [100, 10],
    [70_000, 10],
    [65_536, 20],
    [0, 10],
  ] as Array<[number, number]>
) {
  Deno.test(
    `after the chunk is cached, start=${startByte} max=${maxBytes} still answers like a cold read`,
    async () => {
      const authority = {
        organizationId: ORG,
        subject: { principalId: "p1" },
      };
      const cold = await extractArtifactVersion(
        {
          params: { id: VERSION },
          authority,
          transaction: database().transaction,
        } as never,
        { startByte, maxBytes },
      );
      const warm = database();
      const context = {
        params: { id: VERSION },
        authority,
        transaction: warm.transaction,
      } as never;
      const chunk = Math.floor(startByte / 65_536) * 65_536;
      await extractArtifactVersion(context, {
        startByte: chunk,
        maxBytes: 65_536,
      });
      assertEquals(warm.rows.size, 1, "the aligned read cached its chunk");
      assertEquals(
        await extractArtifactVersion(context, { startByte, maxBytes }),
        cold,
      );
      assertEquals(warm.rows.size, 1, "the non-aligned read wrote nothing");
    },
  );
}
