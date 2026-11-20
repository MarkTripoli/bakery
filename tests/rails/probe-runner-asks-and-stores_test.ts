/**
 * The probe runner (#437 slice 4).
 *
 * Slice 2 built the probe and slice 3 built the readers, but nothing ran one. The
 * cases worth testing are the ones where a wrong runner is worse than no runner:
 * a host-side refusal stored as a fact about the file, an inline version sharing
 * an answer it does not share bytes with, and a request that is never cleared and
 * so is probed for ever.
 *
 * These run through a stub launcher, which spawns a process, so they live in the
 * rails lane: the unit lane's `--allow-run` grant is deliberately narrow and a
 * stub in a temporary directory is not on it.
 */
import { assert, assertEquals } from "@std/assert";
import { forgetSandboxPreflight } from "../../apps/server/src/modules/knowledge/probe.ts";
import {
  claimProbeRequests,
  enqueueProbeSubject,
  failProbeRequest,
  PROBE_MAX_ATTEMPTS,
  readArtifactVersionProbeSubjectBytes,
  readBlobProbeSubjectBytes,
  readInlineProbeSubjectBytes,
  runProbeTick,
} from "../../apps/server/src/modules/knowledge/probe-runner.ts";
import { readBlobProbe } from "../../apps/server/src/modules/knowledge/blob-probes.ts";
import {
  PNG_FRAME,
  READ_ONLY,
  SEALED,
  writeStub,
} from "../helpers/probe-stub-launcher.ts";

/** The bytes only have to exist; the stub is what says what they are. */
const PNG = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  0,
  0,
  0,
  13,
  0x49,
  0x48,
  0x44,
  0x52,
  0,
  0,
  0,
  2,
  0,
  0,
  0,
  2,
]);

const PNG_SHA256 = Array.from(
  new Uint8Array(
    await crypto.subtle.digest("SHA-256", PNG as unknown as BufferSource),
  ),
).map((byte) => byte.toString(16).padStart(2, "0")).join("");

type Statement = { readonly text: string; readonly values: readonly unknown[] };

/**
 * A database seam holding the two facts a runner reads and no more: the subject
 * row it resolves, and the answer it looks for before spending a sandbox unit.
 */
function fakeDatabase(options: {
  readonly subject: "blob" | "inline";
  readonly content: Uint8Array | null;
}):
  & Pick<
    { query: (text: string, values?: unknown[]) => Promise<unknown> },
    "query"
  >
  & {
    readonly statements: Statement[];
  } {
  const statements: Statement[] = [];
  const database = {
    statements,
    query: (text: string, values: unknown[] = []) => {
      statements.push({ text, values });
      if (text.includes("from bakery.blobs")) {
        return Promise.resolve({
          rows: options.subject === "blob"
            ? [{ sha256: PNG_SHA256, size_bytes: String(PNG.byteLength) }]
            : [],
        });
      }
      if (text.includes("from bakery.storage_file_versions")) {
        return Promise.resolve({ rows: [{ content: options.content }] });
      }
      // Nothing has answered yet, so the runner must actually probe.
      if (text.includes("from bakery.blob_probes")) {
        return Promise.resolve({ rows: [] });
      }
      if (text.includes("from bakery.probe_requests")) {
        return Promise.resolve({
          rows: [{
            id: "request-1",
            organization_id: "org-1",
            blob_id: options.subject === "blob" ? "blob-1" : null,
            entry_id: options.subject === "inline" ? "entry-1" : null,
            revision: options.subject === "inline" ? 3 : null,
            artifact_version_id: null,
            attempts: 0,
          }],
        });
      }
      return Promise.resolve({ rows: [] });
    },
  };
  return database;
}

function runnerFor(
  database: ReturnType<typeof fakeDatabase>,
  options: { readonly launcherPath: string; readonly spoolDir: string },
) {
  return {
    readBlobBytes: (organizationId: string, blobId: string) =>
      readBlobProbeSubjectBytes(
        database as never,
        { read: () => Promise.resolve(PNG) },
        organizationId,
        blobId,
      ),
    readInlineBytes: (
      organizationId: string,
      entryId: string,
      revision: number,
    ) =>
      readInlineProbeSubjectBytes(
        database as never,
        organizationId,
        entryId,
        revision,
      ),
    readArtifactVersionBytes: (
      organizationId: string,
      artifactVersionId: string,
    ) =>
      readArtifactVersionProbeSubjectBytes(
        database as never,
        organizationId,
        artifactVersionId,
      ),
    probeOptions: {
      launcherPath: options.launcherPath,
      spoolDir: options.spoolDir,
    },
  };
}

const stored = (database: ReturnType<typeof fakeDatabase>) =>
  database.statements.find((statement) =>
    statement.text.includes("insert into bakery.blob_probes")
  );

const cleared = (database: ReturnType<typeof fakeDatabase>) =>
  database.statements.some((statement) =>
    statement.text.startsWith("delete from bakery.probe_requests")
  );

Deno.test("a host with no sandbox claims nothing, so no request burns an attempt", async () => {
  forgetSandboxPreflight();
  const dir = await Deno.makeTempDir();
  const spoolDir = await Deno.makeTempDir();
  try {
    // The failure this guards against is subtle and permanent: a tick that
    // claimed anyway would spend one attempt per request per tick, abandon the
    // whole workspace after five, and leave it with no answers and nothing
    // queued -- on a host that might be fixed a minute later.
    const launcher = await writeStub(dir, "no-sandbox", {
      selfTest: "exit:226",
      probe: `printf '%s' '${PNG_FRAME}'`,
    });
    const database = fakeDatabase({ subject: "blob", content: null });
    const result = await runProbeTick(
      database as never,
      runnerFor(database, { launcherPath: launcher, spoolDir }),
      { limit: 1 },
    );
    assertEquals(result.sandboxUnavailable, true);
    assertEquals(result.claimed, 0);
    assertEquals(result.answered, 0);
    assertEquals(result.deferred, 0);
    assertEquals(result.abandoned, 0);
    // Nothing was read, written, counted or cleared.
    assertEquals(
      database.statements.some((statement) =>
        statement.text.includes("from bakery.probe_requests")
      ),
      false,
      "a host with no sandbox must not even look at the queue",
    );
    assertEquals(
      database.statements.some((statement) =>
        statement.text.includes("update bakery.probe_requests")
      ),
      false,
    );
    assertEquals(cleared(database), false);
  } finally {
    forgetSandboxPreflight();
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(spoolDir, { recursive: true });
  }
});

Deno.test("a sandbox that dies mid-tick stops the tick instead of spending attempts", async () => {
  forgetSandboxPreflight();
  const dir = await Deno.makeTempDir();
  const spoolDir = await Deno.makeTempDir();
  try {
    // The preflight passes -- the host looks healthy -- and then systemd fails to
    // build the unit for the real probe. Calling that "unreadable" would store a
    // host's bad moment as a property of a perfectly good file, and counting it
    // would abandon the request for the same reason.
    const launcher = await writeStub(dir, "dies-mid-tick", {
      selfTest: SEALED,
      filesystem: READ_ONLY,
      probe: "exit 226",
    });
    const database = fakeDatabase({ subject: "blob", content: null });
    const result = await runProbeTick(
      database as never,
      runnerFor(database, { launcherPath: launcher, spoolDir }),
      { limit: 1 },
    );
    assertEquals(result.sandboxUnavailable, true);
    assertEquals(result.answered, 0);
    assertEquals(result.abandoned, 0);
    assertEquals(stored(database), undefined, "a host answer is never stored");
    assertEquals(
      database.statements.some((statement) =>
        statement.text.includes("update bakery.probe_requests")
      ),
      false,
      "the request is left exactly as it was found",
    );
    assertEquals(cleared(database), false);
  } finally {
    forgetSandboxPreflight();
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(spoolDir, { recursive: true });
  }
});

Deno.test("a sealed sandbox's answer is stored against the blob and the request is cleared", async () => {
  forgetSandboxPreflight();
  const dir = await Deno.makeTempDir();
  const spoolDir = await Deno.makeTempDir();
  try {
    const launcher = await writeStub(dir, "sealed", {
      selfTest: SEALED,
      filesystem: READ_ONLY,
      probe: `printf '%s' '${PNG_FRAME}'`,
    });
    const database = fakeDatabase({ subject: "blob", content: null });
    const result = await runProbeTick(
      database as never,
      runnerFor(database, { launcherPath: launcher, spoolDir }),
      { limit: 1 },
    );
    assertEquals(result.answered, 1);
    const insert = stored(database);
    assert(insert !== undefined, "the answer is stored");
    // Keyed on the blob, so every version sharing those bytes shares the answer:
    // the row names the blob and no version at all.
    assertEquals(insert.values[1], "blob-1");
    assert(insert.text.includes("organization_id, blob_id"));
    assert(!insert.text.includes("entry_id"));
    assertEquals(insert.values[2], "described");
    assertEquals(cleared(database), true);
  } finally {
    forgetSandboxPreflight();
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(spoolDir, { recursive: true });
  }
});

Deno.test("an inline version is keyed on itself, because nothing shares its bytes", async () => {
  forgetSandboxPreflight();
  const dir = await Deno.makeTempDir();
  const spoolDir = await Deno.makeTempDir();
  try {
    const launcher = await writeStub(dir, "sealed-inline", {
      selfTest: SEALED,
      filesystem: READ_ONLY,
      probe: `printf '%s' '${PNG_FRAME}'`,
    });
    const database = fakeDatabase({ subject: "inline", content: PNG });
    const result = await runProbeTick(
      database as never,
      runnerFor(database, { launcherPath: launcher, spoolDir }),
      { limit: 1 },
    );
    assertEquals(result.answered, 1);
    const insert = stored(database);
    assert(insert !== undefined, "the answer is stored");
    // The subject is the version, not a blob: these bytes are that row's own and
    // nothing else's, so the answer cannot be shared the way a blob's is.
    assertEquals(insert.values[1], "entry-1");
    assertEquals(insert.values[2], 3);
    assert(insert.text.includes("organization_id, entry_id, revision"));
    assertEquals(insert.values[3], "described");
    assertEquals(cleared(database), true);
  } finally {
    forgetSandboxPreflight();
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(spoolDir, { recursive: true });
  }
});

Deno.test("an inline artifact version is its own subject, from backfill to stored answer", async () => {
  forgetSandboxPreflight();
  const dir = await Deno.makeTempDir();
  const spoolDir = await Deno.makeTempDir();
  try {
    const launcher = await writeStub(dir, "sealed-artifact", {
      selfTest: SEALED,
      filesystem: READ_ONLY,
      probe: `printf '%s' '${PNG_FRAME}'`,
    });
    const statements: Statement[] = [];
    // The page finds one unprobed inline artifact version; the queue then holds
    // it under artifact_version_id, and the claim hands it back the same way.
    const database = {
      statements,
      query: (text: string, values: unknown[] = []) => {
        statements.push({ text, values });
        // The page is matched before the content reader: both name the same
        // table, and answering the page with a content row would test nothing.
        if (text.includes("union all")) {
          return Promise.resolve({
            rows: [{
              id: "artifact-version-1",
              organization_id: "org-1",
              blob_id: null,
              entry_id: null,
              revision: null,
              artifact_version_id: "artifact-version-1",
            }],
          });
        }
        if (text.includes("select content from bakery.artifact_versions")) {
          return Promise.resolve({
            rows: [{ content: PNG, id: "artifact-version-1" }],
          });
        }
        if (text.includes("from bakery.blob_probes")) {
          return Promise.resolve({ rows: [] });
        }
        if (text.includes("from bakery.probe_requests")) {
          return Promise.resolve({
            rows: [{
              id: "request-4",
              organization_id: "org-1",
              blob_id: null,
              entry_id: null,
              revision: null,
              artifact_version_id: "artifact-version-1",
              attempts: 0,
            }],
          });
        }
        return Promise.resolve({ rows: [] });
      },
    };
    const result = await runProbeTick(
      database as never,
      {
        readBlobBytes: () => Promise.resolve(null),
        readInlineBytes: () => Promise.resolve(null),
        readArtifactVersionBytes: (organizationId, artifactVersionId) =>
          readArtifactVersionProbeSubjectBytes(
            database as never,
            organizationId,
            artifactVersionId,
          ),
        probeOptions: { launcherPath: launcher, spoolDir },
      },
      { limit: 1 },
    );
    // Queued from the page, then answered under the version itself.
    assertEquals(result.queued, 1);
    assertEquals(result.answered, 1);
    const enqueued = statements.find((statement) =>
      statement.text.includes("insert into bakery.probe_requests") &&
      statement.text.includes("artifact_version_id")
    );
    assert(enqueued !== undefined, "the page queues it as an artifact version");
    assert(
      enqueued.text.includes(
        "on conflict (organization_id, artifact_version_id)",
      ),
    );
    const insert = stored(database);
    assert(insert !== undefined, "the answer is stored");
    // Keyed on the version and on nothing else: these bytes are not a blob's and
    // not a storage entry's, so neither of the other two keys is written.
    assertEquals(insert.values[1], "artifact-version-1");
    assert(insert.text.includes("organization_id, artifact_version_id"));
    assertEquals(insert.text.includes("entry_id"), false);
    assertEquals(insert.values[2], "described");
    assertEquals(cleared(database), true);
  } finally {
    forgetSandboxPreflight();
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(spoolDir, { recursive: true });
  }
});

Deno.test("a request that keeps failing on the host is dropped, not retried for ever", async () => {
  const statements: Statement[] = [];
  const database = {
    query: (text: string, values: unknown[] = []) => {
      statements.push({ text, values });
      return Promise.resolve({ rows: [] });
    },
  };
  assertEquals(
    await failProbeRequest(database as never, {
      id: "request-3",
      attempts: PROBE_MAX_ATTEMPTS - 1,
      error: "sandbox-unavailable",
    }),
    "abandoned",
  );
  assertEquals(
    await failProbeRequest(database as never, {
      id: "request-3",
      attempts: 0,
      error: "sandbox-unavailable",
    }),
    "retry",
  );
});

Deno.test("enqueueing the same subject twice queues it once", async () => {
  const statements: Statement[] = [];
  const database = {
    query: (text: string, values: unknown[] = []) => {
      statements.push({ text, values });
      return Promise.resolve({ rows: [] });
    },
  };
  await enqueueProbeSubject(database as never, {
    organizationId: "org-1",
    blobId: "blob-1",
  });
  await enqueueProbeSubject(database as never, {
    organizationId: "org-1",
    entryId: "entry-1",
    revision: 2,
  });
  assertEquals(statements.length, 2);
  // Each subject shape has its own partial unique, so each needs its own target.
  assert(
    statements[0].text.includes("on conflict (organization_id, blob_id)"),
  );
  assert(
    statements[1].text.includes(
      "on conflict (organization_id, entry_id, revision)",
    ),
  );
  assertEquals(statements[1].values, ["org-1", "entry-1", 2]);
});

Deno.test("claiming requests reads them oldest first and lets a peer's rows go", async () => {
  const statements: string[] = [];
  const database = {
    query: (text: string) => {
      statements.push(text);
      return Promise.resolve({ rows: [] });
    },
  };
  await claimProbeRequests(database as never, 5);
  assertEquals(statements.length, 1);
  assert(statements[0].includes("order by requested_at, id"));
  assert(statements[0].includes("for update skip locked"));
});

Deno.test("a stored answer is readable for both subject shapes", async () => {
  const database = { query: () => Promise.resolve({ rows: [] }) };
  assertEquals(
    await readBlobProbe(database as never, {
      organizationId: "org-1",
      blobId: "blob-1",
    }),
    null,
  );
  assertEquals(
    await readBlobProbe(database as never, {
      organizationId: "org-1",
      entryId: "entry-1",
      revision: 1,
    }),
    null,
  );
});
