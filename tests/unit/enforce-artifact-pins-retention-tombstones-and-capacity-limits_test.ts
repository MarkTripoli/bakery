import {
  closePgDatabase,
  openPgDatabase,
} from "../../packages/persistence/src/postgres.ts";
import { collectArtifactVersion } from "../../apps/server/src/modules/knowledge/retention/collector.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
async function* walk(path: string): AsyncGenerator<{ path: string }> {
  for await (const entry of Deno.readDir(path)) {
    const child = `${path}/${entry.name}`;
    if (entry.isDirectory) yield* walk(child);
    else if (entry.isFile && entry.name.endsWith(".sql")) yield { path: child };
  }
}
import {
  publicationRetention,
  retentionExpiry,
} from "../../apps/server/src/modules/knowledge/retention/policy.ts";
import {
  assertArtifactWriteCapacity,
  capacityFromBlocks,
  readStorageCapacity,
} from "../../apps/server/src/platform/storage-capacity.ts";
import { readArtifactStorageConfig } from "../../packages/config/src/env.ts";
import { isClassifiedArtifactForeignKey } from "../../apps/server/src/modules/knowledge/retention/references.ts";
import { assertStructuralMigration } from "../../scripts/lib/postgresql-boundary.ts";

Deno.test("publication source determines expiry independently of submitted metadata", () => {
  const published = new Date("2026-01-01T00:00:00Z");
  assertEquals(
    retentionExpiry(publicationRetention("worker", "log"), published)
      .toISOString(),
    "2026-01-31T00:00:00.000Z",
  );
  assertEquals(
    retentionExpiry(publicationRetention("import", "log"), published)
      .toISOString(),
    "2026-06-30T00:00:00.000Z",
  );
  assertEquals(publicationRetention("archive", "plan"), "transient");
  assertEquals(publicationRetention("worker", "plan"), "evidence");
});
Deno.test("capacity thresholds include reserved blocks and reject unavailable measurements", () => {
  const config = readArtifactStorageConfig({});
  assertEquals(config.collectionEnabled, false);
  assertEquals(capacityFromBlocks(100, 26, 4096, config).state, "normal");
  assertEquals(capacityFromBlocks(100, 25, 4096, config).state, "warning");
  assertEquals(capacityFromBlocks(100, 10, 4096, config).state, "paused");
  assertThrows(() =>
    assertArtifactWriteCapacity(capacityFromBlocks(100, 10, 4096, config))
  );
  assertThrows(() =>
    assertArtifactWriteCapacity(capacityFromBlocks(0, 0, 4096, config))
  );
  assertThrows(() =>
    readArtifactStorageConfig({ BAKERY_ARTIFACT_CAPACITY_WARN_PERCENT: "91" })
  );
});
Deno.test("all migration roots classify every artifact-version foreign key", async () => {
  let found = 0;
  for await (const entry of walk("apps/server/src")) {
    if (!entry.path.includes("migrations/")) continue;
    const sql = await Deno.readTextFile(entry.path);
    for (const statement of sql.split(";")) {
      if (!/references\s+bakery\.artifact_versions\s*\(/i.test(statement)) {
        continue;
      }
      const table = /(?:create|alter)\s+table\s+bakery\.(\w+)/i.exec(statement)
        ?.[1];
      let classified = 0;
      for (
        const match of statement.matchAll(
          /constraint\s+(\w+)\s+foreign\s+key\s*\([^)]*\)\s+references\s+bakery\.artifact_versions/gi,
        )
      ) {
        found++;
        classified++;
        assert(
          table && isClassifiedArtifactForeignKey(table, match[1]),
          `Unclassified artifact reference: ${entry.path} ${table}.${match[1]}`,
        );
      }
      assertEquals(
        classified,
        [...statement.matchAll(/references\s+bakery\.artifact_versions\s*\(/gi)]
          .length,
        "Every FK syntax must be classified",
      );
    }
  }
  assert(found >= 2);
  assertEquals(isClassifiedArtifactForeignKey("new_evidence", "new_fk"), false);
  assertStructuralMigration(
    "0074_artifact_retention.sql",
    await Deno.readTextFile(
      "apps/server/src/modules/work/migrations/bakery/0074_artifact_retention.sql",
    ),
  );
});

Deno.test("expired-content and retryable-capacity problems preserve machine semantics", async () => {
  const { StandardError, toProblem } = await import(
    "../../packages/contracts/src/http.ts"
  );
  const options = {
    requestId: "request",
    traceId: "trace",
    publicBaseUrl: "http://localhost",
  };
  const expired = toProblem(
    new StandardError({ code: "ARTIFACT_CONTENT_EXPIRED" }),
    options,
  );
  assertEquals(expired.status, 410);
  assertEquals(expired.retryable, false);
  const paused = toProblem(
    new StandardError({
      code: "DEPENDENCY_UNAVAILABLE",
      params: { retryAfterSeconds: 60 },
    }),
    options,
  );
  assertEquals(paused.status, 503);
  assertEquals(paused.retryable, true);
  assertEquals(Reflect.get(paused, "retryAfterSeconds"), 60);
});

Deno.test("unset capacity path allows publication as unmonitored", async () => {
  const config = readArtifactStorageConfig({});
  assertEquals(config.dataDirectory, undefined);
  const capacity = await readStorageCapacity(config);
  assertEquals(capacity, {
    state: "unmonitored",
    totalBytes: 0,
    availableBytes: 0,
    usedPercent: 0,
  });
  assertArtifactWriteCapacity(capacity);
});

Deno.test("configured missing capacity path fails closed", async () => {
  const capacity = await readStorageCapacity(readArtifactStorageConfig({
    BAKERY_ARTIFACT_DATA_DIRECTORY:
      `${Deno.cwd()}/missing-capacity-${crypto.randomUUID()}`,
  }));
  assertEquals(capacity.state, "unavailable");
  assertThrows(() => assertArtifactWriteCapacity(capacity));
});

for (const code of ["40P01", "55P03", "XX000"]) {
  Deno.test(`collector maps PostgreSQL ${code} without hiding unrelated failures`, async () => {
    const database = openPgDatabase(
      "postgres://unused:unused@127.0.0.1:1/unused",
    );
    const failure = Object.assign(new Error("maintenance database failure"), {
      code,
    });
    database.connect = () => {
      throw failure;
    };
    try {
      const error = await assertRejects(() =>
        collectArtifactVersion(database, crypto.randomUUID())
      );
      if (code === "XX000") {
        assertEquals(error, failure);
      } else {
        assert(error instanceof StandardError);
        assertEquals(error.code, "DEPENDENCY_UNAVAILABLE");
        assertEquals(error.params?.retryAfterSeconds, 60);
      }
    } finally {
      await closePgDatabase(database);
    }
  });
}
