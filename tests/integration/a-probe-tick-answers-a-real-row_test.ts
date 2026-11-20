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
  readInlineProbeSubjectBytes,
  runProbeTick,
} from "../../apps/server/src/modules/knowledge/probe-runner.ts";
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
