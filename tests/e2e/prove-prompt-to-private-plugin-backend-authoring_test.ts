import { assert, assertEquals } from "@std/assert";
import { PLUGIN_AUTHORING_KIT_DIGEST } from "@bakery/contracts/plugin-authoring-kit";
import {
  createDockerRuntime,
  DEFAULT_JOB_IMAGE,
  DOCKER_FLAG,
} from "../../apps/worker/src/plugin-job-docker.ts";
import { PLUGIN_PACKAGE_CHECK_IDS } from "../../apps/server/src/modules/workflows/plugin-authoring/checks.ts";
import {
  authored,
  count,
  COUNTER_V2_JOB,
  COUNTER_V2_MANIFEST,
  counterPackage,
  localDenoRuntime,
  manifest,
  PREVIEW_DENO_FLAGS,
  previewRunner,
  scriptedGenerator,
  startRun,
  stateOf,
  TYPE_ERROR_JOB,
  withAuthoringFixture,
} from "../helpers/plugin-authoring-fixture.ts";

/**
 * Prompt-to-private-plugin backend authoring end to end (#45, B14.04).
 *
 * Real Postgres, the real routes, the real deno check and the worker's real job
 * protocol. The generator is scripted, never a model. A counter plugin is
 * authored, published privately, installed for its author only, and run in a
 * preview that reaches state through state.read and state.write alone; then it
 * is revised with a state migration. A package that does not type-check is
 * repaired on the next attempt, and a generator that keeps asking for authority
 * it was not given is stopped with nothing published.
 */

async function versionRow(
  fixture: Parameters<Parameters<typeof withAuthoringFixture>[1]>[0]["fixture"],
  id: string,
) {
  const result = await fixture.pgDatabase.query<{
    build_evidence: Record<string, unknown>;
    source_evidence: Record<string, unknown>;
    published_at: Date | null;
  }>(
    `select build_evidence, source_evidence, published_at
       from bakery.plugin_versions where organization_id = $1 and id = $2`,
    [fixture.organizationId, id],
  );
  return result.rows[0];
}

Deno.test("AC1: a counter plugin is authored, published privately, installed for its author and revised with its state", () => {
  const generator = scriptedGenerator([
    counterPackage(),
    counterPackage({
      "manifest.json": COUNTER_V2_MANIFEST,
      "job.ts": COUNTER_V2_JOB,
    }),
  ]);
  const preview = previewRunner(localDenoRuntime());
  return withAuthoringFixture({ generator, preview }, async ({ fixture }) => {
    const run = await authored(fixture);
    assertEquals(run.status, "succeeded", JSON.stringify(run));
    assertEquals(run.kitDigest, PLUGIN_AUTHORING_KIT_DIGEST);
    assertEquals(run.sdkVersion, "1.0.0");
    assertEquals(run.modelId, "scripted-test-generator");
    assertEquals(run.budgetUsd, "1");
    assertEquals(run.spentUsd, "0.01");
    assertEquals(run.attempts.length, 1);
    assertEquals(run.attempts[0].outcome, "passed");
    // The job ran once in the preview, through the broker operations only.
    assertEquals(run.attempts[0].previewResult, { count: 1 });

    const version = await versionRow(fixture, run.pluginVersionId);
    assert(version.published_at !== null);
    assertEquals(version.build_evidence.kitDigest, PLUGIN_AUTHORING_KIT_DIGEST);
    assertEquals(version.build_evidence.runId, run.id);
    assertEquals(
      (version.build_evidence.checks as { checks: { id: string }[] }).checks
        .map((check) => check.id),
      [...PLUGIN_PACKAGE_CHECK_IDS],
    );
    assertEquals(version.source_evidence.requestDigest, run.requestDigest);

    const installs = await fixture.pgDatabase.query<{
      scope: string;
      owner_principal_id: string;
      plugin_version_id: string;
      status: string;
    }>(
      `select scope, owner_principal_id, plugin_version_id, status
         from bakery.plugin_installs where organization_id = $1 and id = $2`,
      [fixture.organizationId, run.pluginInstallId],
    );
    assertEquals(installs.rows[0].scope, "personal");
    assertEquals(installs.rows[0].owner_principal_id, run.actorPrincipalId);
    assertEquals(installs.rows[0].plugin_version_id, run.pluginVersionId);
    assertEquals(installs.rows[0].status, "enabled");
    const state = await stateOf(fixture, run.pluginInstallId);
    assertEquals(state.length, 1);
    assertEquals(state[0].namespace, "counter");
    assertEquals(state[0].value, 1);
    assertEquals(state[0].owner_principal_id, run.actorPrincipalId);

    // Revision: version 2 stores {n}, migrates what version 1 saved, then
    // counts on from it.
    const revised = await authored(fixture, {
      installId: run.pluginInstallId,
    });
    assertEquals(revised.status, "succeeded", JSON.stringify(revised));
    assertEquals(revised.basePluginInstallId, run.pluginInstallId);
    assertEquals(revised.pluginInstallId, run.pluginInstallId);
    assertEquals(revised.pluginPackageId, run.pluginPackageId);
    assertEquals(revised.attempts[0].previewResult, { count: 2, version: 2 });
    // The generator saw the package it was revising.
    assertEquals(
      generator.inputs[1].current?.["job.ts"],
      counterPackage()["job.ts"],
    );
    const after = await stateOf(fixture, run.pluginInstallId);
    assertEquals(after.length, 1);
    assertEquals(after[0].value, { n: 2 });
    assertEquals(after[0].schema_version, 2);
    const pinned = await fixture.pgDatabase.query<
      { plugin_version_id: string }
    >(
      `select plugin_version_id from bakery.plugin_installs
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, run.pluginInstallId],
    );
    assertEquals(pinned.rows[0].plugin_version_id, revised.pluginVersionId);
    assertEquals(preview.results, [
      { count: 1 },
      { migrated: true },
      { count: 2, version: 2 },
    ]);

    const read = await fixture.app.fetch(
      new Request(
        `${fixture.config.publicBaseUrl}/v1/plugin-authoring-runs/${revised.id}`,
        {
          headers: {
            Origin: fixture.config.publicBaseUrl,
            Cookie: fixture.adminCookie,
            "Bakery-Organization-Id": fixture.organizationId,
          },
        },
      ),
    );
    assertEquals(read.status, 200);
    assertEquals((await read.json()).status, "succeeded");
  });
});

Deno.test("AC2: a package that does not type-check is repaired on the next attempt", () => {
  const generator = scriptedGenerator([
    counterPackage({ "job.ts": TYPE_ERROR_JOB }),
    counterPackage(),
  ]);
  const preview = previewRunner(localDenoRuntime());
  return withAuthoringFixture({ generator, preview }, async ({ fixture }) => {
    const run = await authored(fixture);
    assertEquals(run.status, "succeeded", JSON.stringify(run));
    assertEquals(run.attempts.map((a: { outcome: string }) => a.outcome), [
      "failed",
      "passed",
    ]);
    const first = run.attempts[0];
    assertEquals(first.pluginVersionId, null);
    assert(
      first.diagnostics.some((d: { code: string; message: string }) =>
        d.code === "TYPECHECK_FAILED" && d.message.includes("TS2322")
      ),
      JSON.stringify(first.diagnostics),
    );
    // The repair attempt was shown exactly what was wrong.
    assertEquals(generator.inputs[1].previous?.diagnostics, first.diagnostics);
    // The same checks, in the same order, decided both attempts.
    for (const attempt of run.attempts) {
      assertEquals(
        attempt.checkReport.checks.map((c: { id: string }) => c.id),
        [...PLUGIN_PACKAGE_CHECK_IDS],
      );
    }
    assertEquals(run.spentUsd, "0.02");
  });
});

Deno.test("a generator that keeps asking for authority is blocked after maxAttempts with nothing published", () => {
  const generator = scriptedGenerator([
    counterPackage({
      "manifest.json": manifest({
        requestedCapabilities: ["state.read", "state.write", "jobs.schedule"],
      }),
    }),
  ]);
  const preview = previewRunner(localDenoRuntime());
  return withAuthoringFixture({ generator, preview }, async ({ fixture }) => {
    const before = {
      packages: await count(fixture, "plugin_packages"),
      versions: await count(fixture, "plugin_versions"),
      installs: await count(fixture, "plugin_installs"),
    };
    const run = await authored(fixture, { maxAttempts: 3 });
    assertEquals(run.status, "blocked");
    assertEquals(run.failure, { reason: "attempts_exhausted", attempts: 3 });
    assertEquals(run.attempts.length, 3);
    for (const attempt of run.attempts) {
      assertEquals(
        attempt.diagnostics.map((d: { code: string }) => d.code),
        ["AUTHORITY_EXCEEDED"],
      );
    }
    assertEquals(run.pluginVersionId, null);
    assertEquals(run.pluginInstallId, null);
    assertEquals(preview.results, []);
    assertEquals({
      packages: await count(fixture, "plugin_packages"),
      versions: await count(fixture, "plugin_versions"),
      installs: await count(fixture, "plugin_installs"),
    }, before);
  });
});

Deno.test("a run that would go over its budget stops before the attempt", () => {
  const generator = scriptedGenerator([
    counterPackage({ "job.ts": TYPE_ERROR_JOB }),
    counterPackage(),
  ], 0.01);
  const preview = previewRunner(localDenoRuntime());
  return withAuthoringFixture({ generator, preview }, async ({ fixture }) => {
    const run = await authored(fixture, { budgetUsd: "0.015" });
    assertEquals(run.status, "budget_exhausted");
    assertEquals(run.attempts.length, 1);
    assertEquals(generator.inputs.length, 1);
    assertEquals(run.spentUsd, "0.01");
    assertEquals(run.pluginVersionId, null);
  });
});

Deno.test("without a generator a run is refused as unavailable, not faked", () =>
  withAuthoringFixture({}, async ({ fixture }) => {
    const before = await count(fixture, "plugin_authoring_runs");
    const response = await startRun(fixture, {});
    assertEquals(response.status, 503);
    assertEquals(
      (await response.json()).reason,
      "plugin_authoring_unavailable",
    );
    assertEquals(await count(fixture, "plugin_authoring_runs"), before);
  }));

async function dockerReady(): Promise<boolean> {
  try {
    const out = await new Deno.Command("docker", {
      args: ["image", "inspect", DEFAULT_JOB_IMAGE],
      stdout: "null",
      stderr: "null",
    }).output();
    return out.code === 0;
  } catch {
    return false;
  }
}

Deno.test({
  name:
    "AC1 in the Docker job runtime: the authored job runs contained and reaches state only through the host",
  ignore: !(await dockerReady()),
  fn: () => {
    const generator = scriptedGenerator([counterPackage()]);
    const preview = previewRunner(
      createDockerRuntime({ env: { [DOCKER_FLAG]: "1" } }),
      (mode) => [
        "env",
        "DENO_DIR=/tmp/deno",
        "HOME=/tmp",
        "deno",
        ...PREVIEW_DENO_FLAGS,
        "/code/runner.ts",
        mode,
      ],
    );
    return withAuthoringFixture({ generator, preview }, async ({ fixture }) => {
      const run = await authored(fixture);
      assertEquals(run.status, "succeeded", JSON.stringify(run));
      assertEquals(run.attempts[0].previewResult, { count: 1 });
      const state = await stateOf(fixture, run.pluginInstallId);
      assertEquals(state[0].value, 1);
    });
  },
});
