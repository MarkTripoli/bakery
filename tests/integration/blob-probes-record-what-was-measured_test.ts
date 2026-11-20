/**
 * The probe's record survives, and it says only what was measured (#437 slice
 * 2).
 *
 * Real database, real constraints. The interesting cases are the ones the
 * schema has to referee rather than the module: a described row must be
 * complete, a refused one must not describe anything, and the same bytes must
 * not acquire two answers.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import type { WorkerFixture } from "../helpers/worker-execution.ts";
import {
  probeFromRow,
  readBlobProbe,
  writeBlobProbe,
} from "../../apps/server/src/modules/knowledge/blob-probes.ts";
import {
  forgetSandboxPreflight,
  probeBlob,
} from "../../apps/server/src/modules/knowledge/probe.ts";
import {
  PNG_FRAME,
  UNSEALED,
  writeStub,
} from "../helpers/probe-stub-launcher.ts";
import { sha256Bytes } from "../../apps/server/src/modules/knowledge/bytes.ts";

/** A blob row owned by the fixture's organization. */
async function seedBlob(
  fixture: WorkerFixture,
  content: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const digest = await sha256Bytes(bytes);
  const { rows } = await fixture.pgDatabase.query<{ id: string }>(
    `insert into bakery.blobs
       (organization_id, sha256, size_bytes, media_type, created_by_id)
     values ($1, $2, $3, 'text/plain', $4)
     on conflict (organization_id, sha256) do update set
       size_bytes = excluded.size_bytes
     returning id`,
    [fixture.organizationId, digest, bytes.byteLength, fixture.principalId],
  );
  return rows[0].id;
}

Deno.test("a probe's answer is read back as it was recorded", async () => {
  await withWorkerFixture(async (fixture) => {
    const blobId = await seedBlob(fixture, "probe round trip");
    await writeBlobProbe(fixture.pgDatabase, {
      organizationId: fixture.organizationId,
      blobId,
      result: {
        status: "described",
        kind: "text",
        mediaType: "text/plain",
        byteLength: 16,
        lineCount: 1,
        utf8: true,
      },
    });
    const stored = await readBlobProbe(fixture.pgDatabase, {
      organizationId: fixture.organizationId,
      blobId,
    });
    assertEquals(stored?.result, {
      status: "described",
      kind: "text",
      mediaType: "text/plain",
      byteLength: 16,
      lineCount: 1,
      utf8: true,
    });
    assert(stored?.probedAt instanceof Date, "the probe's time is kept");
  });
});

Deno.test("a refusal about the file is kept, limit and all", async () => {
  await withWorkerFixture(async (fixture) => {
    const blobId = await seedBlob(fixture, "probe too large");
    await writeBlobProbe(fixture.pgDatabase, {
      organizationId: fixture.organizationId,
      blobId,
      result: { status: "refused", code: "too-large", limit: 67_108_864 },
    });
    assertEquals(
      (await readBlobProbe(fixture.pgDatabase, {
        organizationId: fixture.organizationId,
        blobId,
      }))?.result,
      { status: "refused", code: "too-large", limit: 67_108_864 },
    );
  });
});

Deno.test("a host's bad afternoon is not written as a property of the file", async () => {
  await withWorkerFixture(async (fixture) => {
    const blobId = await seedBlob(fixture, "probe unavailable");
    await writeBlobProbe(fixture.pgDatabase, {
      organizationId: fixture.organizationId,
      blobId,
      result: { status: "refused", code: "sandbox-unavailable" },
    });
    assertEquals(
      await readBlobProbe(fixture.pgDatabase, {
        organizationId: fixture.organizationId,
        blobId,
      }),
      null,
    );
    // And nothing is left behind that a later reader could find.
    const { rows } = await fixture.pgDatabase.query<{ count: number }>(
      `select count(*)::int as count from bakery.blob_probes
        where organization_id = $1 and blob_id = $2`,
      [fixture.organizationId, blobId],
    );
    assertEquals(rows[0].count, 0);
  });
});

Deno.test("a timeout or a launcher exit is not stored as a fact about the file", async () => {
  // The reviewer's finding: a probe that timed out, or a launcher that exited
  // without answering, was written to blob_probes as `unreadable` -- a permanent
  // verdict on a healthy file, produced by one bad minute on the host. Only a
  // refusal about the FILE is stored; a host-side answer is this attempt's.
  await withWorkerFixture(async (fixture) => {
    const blobId = await seedBlob(fixture, "host fault");
    const dir = await Deno.makeTempDir({ prefix: "bakery-host-fault-" });
    const cases: Array<[string, string, number]> = [
      // A launcher that never answers: the server's own budget expires.
      ["slow", "sleep 30", 200],
      // A launcher that exits non-zero without a frame.
      ["exit", "exit 3", 5_000],
      // A launcher that exits zero with nothing on stdout.
      ["silent", ":", 5_000],
    ];
    for (const [name, body, timeoutMs] of cases) {
      forgetSandboxPreflight();
      const launcher = await writeStub(dir, name, {
        probe: body,
      });
      const result = await probeBlob(fixture.pgDatabase, {
        organizationId: fixture.organizationId,
        blobId,
        path: `${dir}/blob.bin`,
        sizeBytes: 16,
      }, { launcherPath: launcher, timeoutMs });
      assertEquals(result.status, "refused", name);
      assertEquals(
        await readBlobProbe(fixture.pgDatabase, {
          organizationId: fixture.organizationId,
          blobId,
        }),
        null,
        `${name}: a host fault must not be stored`,
      );
    }
    // And a refusal about the file still is, so the rule is not "store nothing".
    forgetSandboxPreflight();
    const unreadable = await writeStub(dir, "unreadable", {
      probe:
        `printf '%s' '{"result":{"status":"refused","code":"unreadable"}}'`,
    });
    const stored = await probeBlob(fixture.pgDatabase, {
      organizationId: fixture.organizationId,
      blobId,
      path: `${dir}/blob.bin`,
      sizeBytes: 16,
    }, { launcherPath: unreadable });
    assertEquals(stored, { status: "refused", code: "unreadable" });
    assertEquals(
      (await readBlobProbe(fixture.pgDatabase, {
        organizationId: fixture.organizationId,
        blobId,
      }))?.result,
      { status: "refused", code: "unreadable" },
    );
    await Deno.remove(dir, { recursive: true });
  });
});

Deno.test("one blob has one answer, and the second write replaces the first", async () => {
  await withWorkerFixture(async (fixture) => {
    const blobId = await seedBlob(fixture, "probe twice");
    const input = { organizationId: fixture.organizationId, blobId };
    await writeBlobProbe(fixture.pgDatabase, {
      ...input,
      result: { status: "refused", code: "malformed" },
    });
    await writeBlobProbe(fixture.pgDatabase, {
      ...input,
      result: {
        status: "described",
        kind: "text",
        mediaType: "text/plain",
        byteLength: 11,
      },
    });
    const { rows } = await fixture.pgDatabase.query<{ count: number }>(
      `select count(*)::int as count from bakery.blob_probes
        where organization_id = $1 and blob_id = $2`,
      [fixture.organizationId, blobId],
    );
    assertEquals(rows[0].count, 1, "a second write is not a second row");
    assertEquals(
      (await readBlobProbe(fixture.pgDatabase, input))?.result.status,
      "described",
    );
  });
});

Deno.test("the schema refuses a row that describes nothing or claims both", async () => {
  await withWorkerFixture(async (fixture) => {
    const blobId = await seedBlob(fixture, "probe shape");
    // A refused row that carries a description.
    await assertRejects(
      () =>
        fixture.pgDatabase.query(
          `insert into bakery.blob_probes
             (organization_id, blob_id, status, kind, media_type, byte_length,
              failure_code)
           values ($1, $2, 'refused', 'image', 'image/png', 4, 'malformed')`,
          [fixture.organizationId, blobId],
        ),
      Error,
      "shape",
    );
    // A described row with no kind.
    await assertRejects(
      () =>
        fixture.pgDatabase.query(
          `insert into bakery.blob_probes
             (organization_id, blob_id, status, media_type, byte_length)
           values ($1, $2, 'described', 'image/png', 4)`,
          [fixture.organizationId, blobId],
        ),
      Error,
      "shape",
    );
  });
});

Deno.test("a probe cannot describe another organization's blob", async () => {
  await withWorkerFixture(async (fixture) => {
    const blobId = await seedBlob(fixture, "probe cross tenant");
    // A made-up organization id: the foreign key carries the organization, so
    // the pair (organization, blob) is what the row must match.
    await assertRejects(
      () =>
        fixture.pgDatabase.query(
          `insert into bakery.blob_probes
             (organization_id, blob_id, status, failure_code)
           values ($1, $2, 'refused', 'malformed')`,
          [crypto.randomUUID(), blobId],
        ),
      Error,
    );
  });
});

Deno.test("re-reading a stored row yields the same result the probe produced", async () => {
  await withWorkerFixture(async (fixture) => {
    const blobId = await seedBlob(fixture, "probe stable");
    const written = {
      status: "described",
      kind: "image",
      mediaType: "image/png",
      byteLength: 8,
      width: 1,
      height: 1,
    } as const;
    await writeBlobProbe(fixture.pgDatabase, {
      organizationId: fixture.organizationId,
      blobId,
      result: written,
    });
    const { rows } = await fixture.pgDatabase.query(
      `select status, kind, media_type, byte_length, width, height,
              duration_ms, line_count, utf8, failure_code, failure_limit,
              probed_at
         from bakery.blob_probes
        where organization_id = $1 and blob_id = $2`,
      [fixture.organizationId, blobId],
    );
    assertEquals(probeFromRow(rows[0] as never).result, written);
  });
});

Deno.test("a host whose sandbox is not sealed leaves no row behind", async () => {
  await withWorkerFixture(async (fixture) => {
    const blobId = await seedBlob(fixture, "probe unsealed host");
    const dir = await Deno.makeTempDir({ prefix: "bakery-probe-unsealed-" });
    // The self-test says a connect succeeded inside the unit, so there is no
    // sandbox; the probe branch would have answered happily, and the answer must
    // not be taken or recorded.
    const launcher = await writeStub(dir, "unsealed", {
      selfTest: UNSEALED,
      probe: `printf '%s' '${PNG_FRAME}'`,
    });
    forgetSandboxPreflight();
    const result = await probeBlob(fixture.pgDatabase, {
      organizationId: fixture.organizationId,
      blobId,
      path: "/tmp/whatever",
      sizeBytes: 16,
    }, { launcherPath: launcher });
    assertEquals(result, { status: "refused", code: "sandbox-unavailable" });
    assertEquals(
      await readBlobProbe(fixture.pgDatabase, {
        organizationId: fixture.organizationId,
        blobId,
      }),
      null,
      "a sandbox that was not sealed is not a fact about the file",
    );
  });
});
