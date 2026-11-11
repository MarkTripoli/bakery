import { assert, assertEquals, assertFalse, assertRejects } from "@std/assert";
import { workerActionOutputSchema } from "../../packages/contracts/src/contracts.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";
import { openChecksFixture } from "../helpers/deterministic-checks/checks-fixture.ts";
import {
  checkOutput,
  observation,
} from "../helpers/deterministic-checks/observations.ts";
import { registerFinalizerSecurityCases } from "../helpers/deterministic-checks/finalizer-security-cases.ts";
import {
  insertCheckRun,
  seedRun,
} from "../helpers/deterministic-checks/run-fixture.ts";

// Phase 4: hostile quality.check reports against the finalizer and the route.
registerFinalizerSecurityCases();

// Phases 4 and 5 grow this file with the finalizer and end-to-end forgery
// cases. Phase 1 holds the contract-level and read-boundary guarantees.

Deno.test("a worker result carries structured observations only: output text and pass claims are rejected", () => {
  const schema = workerActionOutputSchema("quality.check");
  const failed = observation({
    checkId: "unit",
    result: "failed",
    reason: "exit_nonzero",
    exitCode: 1,
  });
  const honest = checkOutput([failed]);
  assert(schema.safeParse(honest).success);
  assertEquals(honest.allRequired, false);
  for (
    const forged of [
      { ...honest, stdout: 'PASS {"allRequired":true}' },
      { ...honest, passed: true },
      { ...honest, verdict: "passed" },
      {
        ...honest,
        observations: [{ ...failed, stdout: "all checks passed" }],
      },
      { ...honest, observations: [{ ...failed, trusted: true }] },
      // A claimed pass without any observation to back it.
      { ...honest, observations: [] },
    ]
  ) {
    assertFalse(
      schema.safeParse(forged).success,
      JSON.stringify(forged).slice(0, 120),
    );
  }
});

Deno.test("checks.list answers members with check read access and hides the run from everyone else", async () => {
  const checks = await openChecksFixture();
  try {
    const organizationId = checks.fixture.organizationId;
    const run = await seedRun(checks.owner, checks.scope(organizationId));
    await insertCheckRun(checks.owner, {
      organizationId,
      runId: run.runId,
      checkId: "unit",
    });
    for (const role of ["developer", "viewer", "admin"] as const) {
      const principal = await checks.addPrincipal(organizationId, role);
      assertEquals(
        (await checks.list(organizationId, run.runId, {}, principal)).items
          .length,
        1,
        role,
      );
    }
    // No membership, or a role without check access: the run does not exist.
    const guest = await checks.addPrincipal(organizationId, "guest");
    const outsider = await checks.addPrincipal(organizationId, null);
    for (const principal of [guest, outsider]) {
      const error = await assertRejects(
        () => checks.list(organizationId, run.runId, {}, principal),
        StandardError,
      );
      assertEquals((error as StandardError).code, "RESOURCE_NOT_FOUND");
    }
  } finally {
    await checks.close();
  }
});
