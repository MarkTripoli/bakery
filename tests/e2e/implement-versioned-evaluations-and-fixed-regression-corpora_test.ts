/**
 * #41 end to end: one journey on the real routes against a fresh database.
 * AC1: the same pins give the same digest, the runs are listed by it, and a
 * fixed corpus gives the same outcomes. AC2: a model scorer that cannot run is
 * skipped and never replaces a check. AC3: unknown and unrun stay apart from
 * zero and a concurrent run settles each result once.
 */

import { assertEquals } from "@std/assert";
import { withOwnedPostgresEnv } from "./helpers/stack.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import {
  call,
  definition,
  type Json,
  ok,
  results,
  runBatch,
  world,
} from "../helpers/evaluation-corpus.ts";

const PIN = {
  kind: "agentVersion",
  id: "6f1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f7",
  version: 2,
};

Deno.test("a fixed corpus is admitted, run and read back on the shipped routes", () =>
  withOwnedPostgresEnv(
    "evaluation-corpus",
    () =>
      withWorkerFixture(async (fixture) => {
        const w = await world(fixture);
        const check = await definition(fixture, "e2e-has-hi", "deterministic", {
          kind: "contains",
          config: { substring: "hi" },
        });
        const admit = async (body: Json) =>
          await ok(
            await call(fixture, "POST", "/v1/evaluation-batches", {
              body: { datasetId: w.dataset.id, candidate: PIN, ...body },
            }),
            201,
          );
        const scorerIds = [check.id, w.rubric.id];
        const optionalScorerIds = [w.rubric.id];
        const a = await admit({ scorerIds, optionalScorerIds });
        const b = await admit({ scorerIds, optionalScorerIds });
        const strict = await admit({ scorerIds });

        // AC1: the same pins, the same digest, and the runs are listed by it.
        assertEquals(a.pinDigest, b.pinDigest);
        assertEquals(strict.pinDigest === a.pinDigest, false);
        const listed = ((await ok(
          await call(
            fixture,
            "GET",
            "/v1/evaluation-batches?pinDigest=" + a.pinDigest,
          ),
        )).items as Json[]).map((x) => x.id).sort();
        assertEquals(listed, [a.id, b.id].sort());

        // AC3: two runs at once settle each result once.
        const both = await Promise.all([a.id, a.id].map((id) =>
          call(fixture, "POST", "/v1/evaluation-batches/" + id + "/run", {
            body: {},
          })
        ));
        for (const response of both) {
          await ok(response, 200);
        }
        await runBatch(fixture, b.id);
        await runBatch(fixture, strict.id);
        const rows = await results(fixture, a.id);
        const checks = rows.filter((r) =>
          r.scorerId === check.id
        );
        assertEquals(checks.map((r) => [r.state, r.attemptCount]), [[
          "passed",
          1,
        ], ["passed", 1]]);
        // AC1: the same corpus on the same pins gives the same outcomes.
        const outcomes = async (id: unknown) =>
          (await results(fixture, id)).map((
            r,
          ) => [r.caseName, r.scorerId, r.state, r.reason])
            .sort((x, y) => JSON.stringify(x) < JSON.stringify(y) ? -1 : 1);
        assertEquals(await outcomes(b.id), await outcomes(a.id));

        // AC2: the model scorer was skipped, not replaced; the optional one does not block the gate.
        const read = async (id: unknown) =>
          await ok(await call(fixture, "GET", "/v1/evaluation-batches/" + id));
        const batchA = await read(a.id);
        assertEquals((batchA.gate as Json).decision, "met");
        const optional = batchA.optionalReport as Json;
        assertEquals([optional.total, optional.unrun, optional.attempted], [
          2,
          2,
          0,
        ]);
        // The same scorer as a required one keeps the gate from judging.
        const batchStrict = await read(strict.id);
        assertEquals((batchStrict.gate as Json).decision, "cannot_be_judged");
        // AC3: unrun is not zero and not unknown.
        const report = batchStrict.report as Json;
        assertEquals([
          report.passed,
          report.failed,
          report.unknown,
          report.unrun,
        ], [2, 0, 0, 2]);
      }),
  ));
