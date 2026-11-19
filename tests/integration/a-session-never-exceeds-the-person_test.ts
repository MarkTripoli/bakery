import { assert, assertEquals } from "@std/assert";
import {
  registeredWorker,
  workerRequest,
} from "../helpers/worker-execution.ts";
import { seedEligibleNonmodelJob } from "../helpers/worker-execution/nonmodel-job.ts";
import {
  claimAssignment,
  withWorkerFixture,
} from "../helpers/worker-execution/scenarios.ts";
import {
  SESSION_CREDENTIAL_HEADER,
  SESSION_TOOLS_PATH,
} from "../../apps/server/src/modules/execution/session-routes.ts";

/**
 * The tool gateway, mounted, through the real app.
 *
 * The routes were built and unit-tested before they were mounted, which meant
 * they were unreachable - the exact defect this issue exists to fix. This goes
 * through `createApp`, so a route that is missing from the composition, or a
 * registry the app never supplies, fails here rather than in production.
 */
Deno.test("a claimed session can ask what it may call", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, { slots: 1 });
    const seeded = await seedEligibleNonmodelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const assignment = await claimAssignment(fixture, worker) as unknown as {
      attemptId?: string;
      sessionCredential?: string;
    };

    assert(
      typeof assignment.sessionCredential === "string",
      "the claim issued no session credential",
    );
    assert(typeof assignment.attemptId === "string", "no attempt id");

    // `workerRequest` carries the protocol-version header the worker routes
    // require; a bare fetch gets 426 and would look like a missing route.
    const response = await workerRequest(
      fixture,
      worker.credential,
      SESSION_TOOLS_PATH.replace(":id", assignment.attemptId),
      undefined,
      {
        method: "GET",
        headers: { [SESSION_CREDENTIAL_HEADER]: assignment.sessionCredential },
      },
    );

    // 200 is the whole point: a 404 here means the gateway is not mounted, and
    // an unmounted gateway is indistinguishable from a product that has none.
    if (response.status !== 200) {
      // The detail is what makes an unmounted route, a missing registry entry
      // and a policy refusal distinguishable; a bare code comparison is not.
      throw new Error(`STATUS ${response.status}: ${await response.text()}`);
    }
    assertEquals(response.status, 200);
    const body = await response.json() as {
      tools?: readonly { name: string }[];
    };
    assert(Array.isArray(body.tools), "no tool list was returned");
    const offered = body.tools.map((tool) => tool.name);
    // The run-reading tools are the ones a nonmodel quality check needs.
    assert(offered.includes("runs.get"), `offered ${offered.join(", ")}`);
    // The catalog operations live in a different module's registry, so their
    // presence is the proof the composition reaches past the task registry. A
    // gateway that offered only what one module owned would look complete and
    // silently withhold half the tools an agent is meant to have.
    assert(
      offered.includes("skills.list") && offered.includes("agents.list"),
      `catalog tools missing from ${offered.join(", ")}`,
    );
    // Seeded for clarity: the job is real work, not a fixture convention.
    assertEquals(typeof seeded.runId, "string");
  }));

Deno.test("a call without the session credential is refused, not served", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, { slots: 1 });
    await seedEligibleNonmodelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const assignment = await claimAssignment(fixture, worker) as unknown as {
      attemptId?: string;
    };
    const response = await workerRequest(
      fixture,
      worker.credential,
      SESSION_TOOLS_PATH.replace(":id", assignment.attemptId ?? ""),
      undefined,
      { method: "GET" },
    );
    // The worker host credential alone must not reach a session's tools.
    assert(
      response.status >= 400,
      `expected a refusal, got ${response.status}`,
    );
  }));
