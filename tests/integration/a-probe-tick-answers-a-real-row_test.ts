/**
 * #437 slice 4: one tick, end to end, against real Postgres.
 *
 * The rails tests stub the database, which is why a query naming a column that
 * does not exist (`storage_file_versions.purged_at`) passed nine tests and then
 * killed the task on its first tick on mini1. A stub cannot catch that: only a
 * real server can say whether a statement is a statement. So this test runs the
 * whole path -- backfill page, claim, sandbox answer, stored row, cleared
 * request -- against the fixture's database, with a stub launcher standing in for
 * the sandbox because the sandbox itself is proven elsewhere.
 *
 * The subject is an inline storage version on purpose: that is the arm whose
 * purge filter was wrong, and it is the arm a small file actually takes.
 */
import { assert, assertEquals } from "@std/assert";
import { readRuntimeConfig } from "@bakery/config";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import { forgetSandboxPreflight } from "../../apps/server/src/modules/knowledge/probe.ts";
import {
  enqueueUnprobedPage,
  PROBE_MAX_ATTEMPTS,
  readInlineProbeSubjectBytes,
  runProbeTick,
} from "../../apps/server/src/modules/knowledge/probe-runner.ts";
import { sha256Bytes } from "../../apps/server/src/modules/knowledge/bytes.ts";
import { probeRunnerDeps } from "../../apps/server/src/platform/probe-runner-task.ts";
import {
  PNG_FRAME,
  READ_ONLY,
  SEALED,
  writeStub,
} from "../helpers/probe-stub-launcher.ts";

type Fixture = Parameters<Parameters<typeof withWorkerFixture>[0]>[0];

function put(fixture: Fixture, path: string, content: string) {
  return fixture.app.fetch(
    new Request(fixture.config.publicBaseUrl + "/v1/storage/files", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Origin: fixture.config.publicBaseUrl,
        "Bakery-Organization-Id": fixture.organizationId,
        Cookie: fixture.adminCookie,
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        path,
        content: btoa(content),
        mediaType: "text/plain",
      }),
    }),
  );
}

Deno.test("one tick answers a real inline version and clears its request", () =>
  withWorkerFixture(async (fixture) => {
    const response = await put(fixture, "/shared/ticked.txt", "tick me");
    assertEquals(response.status, 200);
    const file = await response.json() as { id: string };

    // Start from a known queue: the write already queued this version, and the
    // backfill is what this test is about, so the queue is emptied first and the
    // page has to find the version on its own.
    await fixture.pgDatabase.query(
      "delete from bakery.probe_requests where organization_id = $1",
      [fixture.organizationId],
    );
    const page = await enqueueUnprobedPage(fixture.pgDatabase, {
      afterId: null,
      limit: 10,
    });
    assert(page.queued >= 1, "the backfill page finds the unprobed version");
    const queued = await fixture.pgDatabase.query<
      { entry_id: string | null; revision: number | null }
    >(
      `select entry_id, revision from bakery.probe_requests
        where organization_id = $1 and entry_id = $2`,
      [fixture.organizationId, file.id],
    );
    assertEquals(queued.rows.length, 1);
    const revision = Number(queued.rows[0].revision);

    // The bytes are readable through the same query the runner uses, which is the
    // one that named a column that does not exist.
    const bytes = await readInlineProbeSubjectBytes(
      fixture.pgDatabase,
      fixture.organizationId,
      file.id,
      revision,
    );
    assert(bytes !== null, "an inline version's bytes are readable");
    assertEquals(new TextDecoder().decode(bytes.bytes), "tick me");

    const dir = await Deno.makeTempDir();
    const spoolDir = await Deno.makeTempDir();
    // The task's own dependency builder, from a real RuntimeConfig: only the
    // launcher path is swapped, because the sandbox is proven elsewhere.
    const deps = (launcherPath: string) => {
      const config = readRuntimeConfig(
        {
          BAKERY_ENV: "test",
          BAKERY_PROBE_SPOOL_DIR: spoolDir,
          BAKERY_PUBLIC_BASE_URL: fixture.config.publicBaseUrl,
        },
        "server",
      );
      const built = probeRunnerDeps(config, fixture.pgDatabase);
      return {
        ...built,
        probeOptions: { ...built.probeOptions, launcherPath },
      };
    };
    try {
      const launcher = await writeStub(dir, "sealed", {
        selfTest: SEALED,
        filesystem: READ_ONLY,
        probe: `printf '%s' '${PNG_FRAME}'`,
      });
      forgetSandboxPreflight();
      const result = await runProbeTick(
        fixture.pgDatabase,
        deps(launcher),
        { limit: 10 },
      );
      // The spool directory comes from the runtime config, through the same
      // factory the entrypoint uses. A runner assembled here by hand would pass
      // this test while the shipped one refused every subject, which is exactly
      // the defect this asserts against.
      assertEquals(result.spoolDirMissing, false);
      assertEquals(result.sandboxUnavailable, false);
      assert(result.answered >= 1, "the tick stored an answer");

      const stored = await fixture.pgDatabase.query<
        { status: string; kind: string | null; entry_id: string | null }
      >(
        `select status, kind, entry_id from bakery.blob_probes
          where organization_id = $1 and entry_id = $2 and revision = $3`,
        [fixture.organizationId, file.id, revision],
      );
      assertEquals(stored.rows.length, 1);
      assertEquals(stored.rows[0].status, "described");
      assertEquals(stored.rows[0].kind, "image");
      // The answer is keyed on the version and on nothing else.
      assertEquals(stored.rows[0].entry_id, file.id);

      const left = await fixture.pgDatabase.query<{ count: string }>(
        `select count(*)::text as count from bakery.probe_requests
          where organization_id = $1 and entry_id = $2`,
        [fixture.organizationId, file.id],
      );
      assertEquals(left.rows[0].count, "0", "the request is cleared");

      // A second tick has nothing to do: the answer is stored, so the page finds
      // no unprobed subject and the queue is empty.
      const again = await runProbeTick(
        fixture.pgDatabase,
        deps(launcher),
        { limit: 10 },
      );
      assertEquals(again.answered, 0);
      assertEquals(again.claimed, 0);
    } finally {
      forgetSandboxPreflight();
      await Deno.remove(dir, { recursive: true });
      await Deno.remove(spoolDir, { recursive: true });
    }
  }));

/**
 * The class qa3 found on mini1: the runner wrote answers nothing could read.
 *
 * The three subject kinds are keyed differently -- a blob, a storage version, an
 * artifact version -- and each `/probe` route resolved only the first. The tick
 * stored three answers and every read came back null, so the facts line stayed empty
 * for every inline file and every store-less artifact version while the database
 * held the answer. A test that stops at the stored row cannot see that, so this one
 * asks the same routes the app asks, once per subject kind.
 */
Deno.test("a tick's answer is readable through the probe route for all three subjects", async () => {
  const skillFileRoot = await Deno.makeTempDir();
  // The app and the task must share one store, or the upload writes bytes the
  // runner cannot read and the blob arm fails for the wrong reason.
  await withWorkerFixture(async (fixture) => {
    const call = (method: string, path: string, body?: unknown) =>
      fixture.app.fetch(
        new Request(fixture.config.publicBaseUrl + path, {
          method,
          headers: {
            "Content-Type": "application/json",
            Origin: fixture.config.publicBaseUrl,
            "Bakery-Organization-Id": fixture.organizationId,
            Cookie: fixture.adminCookie,
            ...(method === "GET"
              ? {}
              : { "Idempotency-Key": crypto.randomUUID() }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );

    // 1. Inline storage bytes: a small file the entry keeps itself.
    const inline = await call("PUT", "/v1/storage/files", {
      path: "/shared/inline.txt",
      content: btoa("one\ntwo\nthree"),
      mediaType: "text/plain",
    });
    assertEquals(inline.status, 200);
    const inlineFile = await inline.json() as { id: string };

    // 2. Blob-backed storage bytes: an upload, completed, then put at a path.
    const bytes = new TextEncoder().encode("blob-backed\ntext\nhere");
    const digest = await sha256Bytes(bytes);
    const started = await call("POST", "/v1/blobs/uploads", {
      sha256: digest,
      sizeBytes: bytes.byteLength,
      mediaType: "text/plain",
    });
    assertEquals(started.status, 201, await started.clone().text());
    const session = await started.json() as { id: string };
    const part = await call(
      "PUT",
      `/v1/blobs/uploads/${session.id}/parts/1`,
      { sha256: digest, content: base64Bytes(bytes) },
    );
    assertEquals(part.status, 200, await part.clone().text());
    const completed = await call(
      "POST",
      `/v1/blobs/uploads/${session.id}/complete`,
      {},
    );
    assertEquals(completed.status, 201, await completed.clone().text());
    const blob = await completed.json() as { id: string };
    const uploaded = await call("PUT", "/v1/storage/files", {
      path: "/shared/blob.txt",
      mediaType: "text/plain",
      blobId: blob.id,
    });
    assertEquals(uploaded.status, 200, await uploaded.clone().text());
    const blobFile = await uploaded.json() as { id: string };

    // 3. Store-less artifact version: content on the version, no blob.
    const seeded = await seedInlineArtifact(fixture);

    // Start from a known queue: the writes queued two versions, and the backfill is
    // what must find the third, so every request is dropped and the page re-finds all.
    await fixture.pgDatabase.query(
      "delete from bakery.probe_requests where organization_id = $1",
      [fixture.organizationId],
    );
    await enqueueUnprobedPage(fixture.pgDatabase, { afterId: null, limit: 50 });

    const dir = await Deno.makeTempDir();
    const spoolDir = await Deno.makeTempDir();
    try {
      const launcher = await writeStub(dir, "sealed", {
        selfTest: SEALED,
        filesystem: READ_ONLY,
        probe: `printf '%s' '${PNG_FRAME}'`,
      });
      const config = readRuntimeConfig(
        {
          BAKERY_ENV: "test",
          BAKERY_PROBE_SPOOL_DIR: spoolDir,
          BAKERY_SKILL_FILE_ROOT: skillFileRoot,
          BAKERY_PUBLIC_BASE_URL: fixture.config.publicBaseUrl,
        },
        "server",
      );
      const built = probeRunnerDeps(config, fixture.pgDatabase);
      forgetSandboxPreflight();
      const result = await runProbeTick(
        fixture.pgDatabase,
        {
          ...built,
          probeOptions: { ...built.probeOptions, launcherPath: launcher },
        },
        { limit: 25 },
      );
      assertEquals(result.sandboxUnavailable, false);
      assertEquals(result.claimed, 3, JSON.stringify(result));
      assertEquals(result.answered, 3, JSON.stringify(result));

      const read = async (path: string) => {
        const response = await call("GET", path);
        assertEquals(response.status, 200, await response.clone().text());
        return await response.json() as {
          status: string | null;
          kind: string | null;
          width: number | null;
          height: number | null;
        };
      };

      // The inline storage version: keyed (entry_id, revision), which is the arm
      // that used to stop at a null blob_id.
      const inlineAnswer = await read(
        `/v1/storage/files/${inlineFile.id}/probe`,
      );
      assertEquals(
        inlineAnswer.status,
        "described",
        JSON.stringify(inlineAnswer),
      );
      assertEquals(inlineAnswer.kind, "image", JSON.stringify(inlineAnswer));
      assertEquals(inlineAnswer.width, 2, JSON.stringify(inlineAnswer));
      assertEquals(inlineAnswer.height, 2);

      // The blob-backed version: keyed on the blob, the arm that always worked.
      const blobAnswer = await read(`/v1/storage/files/${blobFile.id}/probe`);
      assertEquals(blobAnswer.status, "described", JSON.stringify(blobAnswer));
      assertEquals(blobAnswer.kind, "image", JSON.stringify(blobAnswer));
      assertEquals(blobAnswer.width, 2, JSON.stringify(blobAnswer));
      assertEquals(blobAnswer.height, 2);

      // The store-less artifact version: keyed on the version itself.
      const artifactAnswer = await read(
        `/v1/artifact-versions/${seeded.versionId}/probe`,
      );
      assertEquals(
        artifactAnswer.status,
        "described",
        JSON.stringify(artifactAnswer),
      );
      assertEquals(
        artifactAnswer.kind,
        "image",
        JSON.stringify(artifactAnswer),
      );
      assertEquals(artifactAnswer.width, 2, JSON.stringify(artifactAnswer));
      assertEquals(artifactAnswer.height, 2);
    } finally {
      forgetSandboxPreflight();
      await Deno.remove(dir, { recursive: true });
      await Deno.remove(spoolDir, { recursive: true });
    }
  }, { skillFileRoot });
  await Deno.remove(skillFileRoot, { recursive: true });
});

const base64Bytes = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** One artifact whose only version keeps its content on the row, not in a blob. */
async function seedInlineArtifact(fixture: Fixture) {
  const application = await fixture.pgDatabase.query<{ id: string }>(
    `insert into bakery.applications (organization_id, name, slug)
     values ($1, $2, $3) returning id`,
    [
      fixture.organizationId,
      `probe-${crypto.randomUUID()}`,
      `probe-${crypto.randomUUID()}`,
    ],
  );
  const conversation = await fixture.pgDatabase.query<{ id: string }>(
    `insert into bakery.conversations
       (organization_id, application_id, title, created_by)
     values ($1, $2, 'probe subjects', $3) returning id`,
    [fixture.organizationId, application.rows[0].id, fixture.principalId],
  );
  const task = await fixture.pgDatabase.query<{ id: string }>(
    `insert into bakery.tasks
       (organization_id, application_id, conversation_id, title, task_type,
        status, created_by)
     values ($1, $2, $3, 'probe subjects', 'feature', 'completed', $4)
     returning id`,
    [
      fixture.organizationId,
      application.rows[0].id,
      conversation.rows[0].id,
      fixture.principalId,
    ],
  );
  const artifact = await fixture.pgDatabase.query<{ id: string }>(
    `insert into bakery.artifacts
       (organization_id, task_id, artifact_type, name)
     values ($1, $2, 'plan', 'Inline version') returning id`,
    [fixture.organizationId, task.rows[0].id],
  );
  const content = new TextEncoder().encode("kept on the row");
  const version = await fixture.pgDatabase.query<{ id: string }>(
    `insert into bakery.artifact_versions
       (organization_id, artifact_id, task_id, revision, author_id, metadata,
        content, sha256, size_bytes, media_type, retention_class)
     values ($1, $2, $3, 1, $4, '{}'::jsonb, $5, $6, $7, 'text/plain',
             'transient')
     returning id`,
    [
      fixture.organizationId,
      artifact.rows[0].id,
      task.rows[0].id,
      fixture.principalId,
      content,
      await sha256Bytes(content),
      content.byteLength,
    ],
  );
  await fixture.pgDatabase.query(
    `update bakery.artifacts set current_version_id = $1, revision = 2
      where organization_id = $2 and id = $3`,
    [version.rows[0].id, fixture.organizationId, artifact.rows[0].id],
  );
  return { versionId: version.rows[0].id };
}

/**
 * The class the #759 reviewer found: a retry ceiling that resets itself.
 *
 * An abandoned request used to be deleted, and a deleted request is
 * indistinguishable from a subject that was never asked, so the next tick's
 * backfill queued it again with `attempts = 0`. A subject nobody can answer was
 * therefore probed five times per tick, for ever, and a page of such subjects
 * starved every version behind it. This runs the real ticks and asserts the
 * ceiling holds across them, which a stubbed database cannot show.
 */
Deno.test("a subject that fails five times is not queued again by the next tick", () =>
  withWorkerFixture(async (fixture) => {
    const response = await put(
      fixture,
      "/shared/cursed.txt",
      "never answer me",
    );
    assertEquals(response.status, 200);
    const file = await response.json() as { id: string };
    // Start from nothing rather than from the write's own request, so the ticks
    // below are the only reason a row exists.
    await fixture.pgDatabase.query(
      "delete from bakery.probe_requests where organization_id = $1",
      [fixture.organizationId],
    );

    const dir = await Deno.makeTempDir();
    const spoolDir = await Deno.makeTempDir();
    const config = readRuntimeConfig(
      {
        BAKERY_ENV: "test",
        BAKERY_PROBE_SPOOL_DIR: spoolDir,
        BAKERY_PUBLIC_BASE_URL: fixture.config.publicBaseUrl,
      },
      "server",
    );
    const built = probeRunnerDeps(config, fixture.pgDatabase);
    try {
      const launcher = await writeStub(dir, "sealed", {
        selfTest: SEALED,
        filesystem: READ_ONLY,
        probe: `printf '%s' '${PNG_FRAME}'`,
      });
      // The read itself fails every time: what is under test is the ceiling, not
      // how a particular fault is spelled.
      const deps = {
        ...built,
        readInlineBytes: () => Promise.reject(new Error("unreadable-spool")),
        probeOptions: { ...built.probeOptions, launcherPath: launcher },
      };
      forgetSandboxPreflight();
      for (let tick = 1; tick <= PROBE_MAX_ATTEMPTS; tick += 1) {
        const result = await runProbeTick(fixture.pgDatabase, deps, {
          limit: 10,
        });
        assertEquals(result.spoolDirMissing, false);
        assertEquals(result.sandboxUnavailable, false);
      }

      const after = await fixture.pgDatabase.query<
        { attempts: number; last_error: string | null }
      >(
        `select attempts, last_error from bakery.probe_requests
          where organization_id = $1 and entry_id = $2`,
        [fixture.organizationId, file.id],
      );
      assertEquals(after.rows.length, 1, "the request is kept, not deleted");
      assertEquals(after.rows[0].attempts, PROBE_MAX_ATTEMPTS);

      // The tick that used to undo all of it.
      const next = await runProbeTick(fixture.pgDatabase, deps, { limit: 10 });
      assertEquals(next.claimed, 0, "a terminal row is not work");
      assertEquals(next.queued, 0, "the backfill does not ask again");

      const still = await fixture.pgDatabase.query<
        { count: string; attempts: number }
      >(
        `select count(*)::text as count, min(attempts) as attempts
           from bakery.probe_requests
          where organization_id = $1 and entry_id = $2`,
        [fixture.organizationId, file.id],
      );
      assertEquals(still.rows[0].count, "1");
      assertEquals(still.rows[0].attempts, PROBE_MAX_ATTEMPTS);
    } finally {
      forgetSandboxPreflight();
      await Deno.remove(dir, { recursive: true });
      await Deno.remove(spoolDir, { recursive: true });
    }
  }));
