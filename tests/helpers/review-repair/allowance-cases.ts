import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type ActionContext,
  normalizeRegisteredRouteTarget,
} from "../../../packages/contracts/src/action-registry.ts";
import { StandardError } from "../../../packages/contracts/src/http.ts";
import { DeliveryImplementedAction } from "../../../packages/contracts/src/implemented-actions.ts";
import { appendAudit } from "../../../packages/persistence/src/event-audit.ts";
import {
  createDeliveryActionRegistry,
  createDeliveryHandlers,
} from "../../../apps/server/src/modules/delivery/index.ts";
import { withPgTransaction } from "../../../apps/server/src/platform/database.ts";
import { mergeDispatchStub, registrationStub } from "../merge-dispatch-stub.ts";
import { allowMoreRepairTries } from "../../../apps/server/src/modules/delivery/repair-allowance.ts";
import { apiCall, expectJson } from "../fixed-coding-preset.ts";
import { finding, fingerprintOf } from "./fixtures.ts";
import {
  HEADS,
  loopTest,
  type LoopWorld,
  withReviewedRun,
} from "./loop-world.ts";

// #62. A review and repair loop that ran out of tries can be allowed more, by a
// person, through the same engine: the allowance is recorded next to the frozen
// policy, the stop is answered with the repair it buys, the repeat's bound is
// raised by it, and the run the engine ended is asked again. Each case drives a
// real plan run through the production engine and the real worker result route.

const PLAN = { repairs: 2 } as const;

async function accept(
  turn: { post(result: unknown): Promise<Response> },
  report: unknown,
) {
  const response = await turn.post(report);
  assertEquals(response.status, 200, await response.clone().text());
}

/** A blocker with its own fingerprint, so no round repeats the one before. */
const blocker = (n: number) =>
  finding({
    fingerprint: fingerprintOf(n),
    severity: "blocker",
    path: "src/upload.ts",
    line: 10 + n,
  });

/** Runs the loop until the third review stops it: two repairs used, a blocker left. */
async function runOutOfTries(world: LoopWorld): Promise<void> {
  const first = await world.review(0);
  await accept(first, first.report([blocker(1)]));
  await world.repair(1, HEADS[1]);
  await world.check(1, HEADS[1]);
  const second = await world.review(1);
  await accept(second, second.report([blocker(2)]));
  await world.repair(2, HEADS[2]);
  await world.check(2, HEADS[2]);
  const third = await world.review(2);
  await accept(third, third.report([blocker(3)]));
  assertEquals(await world.runStatus(), "failed");
}

function allow(world: LoopWorld, tries: number, requestId = "allow-1") {
  return withPgTransaction(
    world.fixture.pgDatabase,
    (transaction) =>
      allowMoreRepairTries(transaction, {
        organizationId: world.fixture.organizationId,
        principalId: world.fixture.principalId,
        runId: world.runId,
        tries,
        requestId,
        traceId: "allow-trace",
      }),
  );
}

/** Rows the allowance writes, to prove a refusal wrote none of them. */
async function allowanceRows(world: LoopWorld): Promise<number> {
  const rows = await world.fixture.pgDatabase.query<{ count: string }>(
    `select count(*)::text as count from bakery.repair_allowances
      where organization_id = $1 and run_id = $2`,
    [world.fixture.organizationId, world.runId],
  );
  return Number(rows.rows[0].count);
}

/** A member of the fixture's organization with this role, as a service principal. */
async function addMember(world: LoopWorld, role: string): Promise<string> {
  const principalId = crypto.randomUUID();
  const { pgDatabase, organizationId } = world.fixture;
  await pgDatabase.query(
    `insert into bakery.principals
       (id, provider_user_id, display_name, principal_type)
     values ($1, null, 'Allowance caller', 'service')`,
    [principalId],
  );
  await pgDatabase.query(
    `insert into bakery.organization_memberships
       (id, organization_id, principal_id, role, status, joined_at,
        created_at, updated_at, version)
     values ($1, $2, $3, $4, 'active', now(), now(), now(), 1)`,
    [crypto.randomUUID(), organizationId, principalId, role],
  );
  return principalId;
}

/**
 * Calls `runRepairAllowances.create` through the real registry and authority
 * runner as `principalId`, or as an agent session acting for it.
 */
function allowAs(
  world: LoopWorld,
  principalId: string,
  options: { agent?: boolean; tries?: number } = {},
): Promise<unknown> {
  const registry = createDeliveryActionRegistry(
    world.fixture.runtimePgDatabase,
    createDeliveryHandlers(
      "allowance-cursor-secret",
      mergeDispatchStub("allow"),
    ),
    registrationStub("allow", world.fixture.runtimePgDatabase),
  );
  const path = `/v1/runs/${world.runId}/repair-allowances`;
  const context: ActionContext = {
    request: new Request(`http://test${path}`, {
      headers: { "Bakery-Organization-Id": world.fixture.organizationId },
    }),
    params: { id: world.runId },
    requestId: crypto.randomUUID(),
    traceId: crypto.randomUUID(),
    signal: new AbortController().signal,
    principal: {
      principalId,
      principalType: "service",
      displayName: "Allowance caller",
    },
    ...(options.agent
      ? { agentSession: { attemptId: crypto.randomUUID() } }
      : {}),
  };
  return registry.execute(
    DeliveryImplementedAction.RunRepairAllowancesCreate,
    context,
    { tries: options.tries ?? 1 },
    {
      operation: DeliveryImplementedAction.RunRepairAllowancesCreate,
      idempotencyKey: crypto.randomUUID(),
      target: normalizeRegisteredRouteTarget(
        "/v1/runs/:id/repair-allowances",
        { id: world.runId },
      ),
    },
  );
}

/**
 * Makes the run's task a child lane of a coordination plan, as the planner does.
 * Returns the cleanup that removes what it made: a lane holds its task, so the
 * shared fixture could not delete the task at the end of the file without it.
 */
async function makeCoordinationLane(
  world: LoopWorld,
): Promise<() => Promise<void>> {
  const { pgDatabase, organizationId, principalId } = world.fixture;
  const task = (await pgDatabase.query<
    { application_id: string; repository_id: string }
  >(
    `select application_id, repository_id from bakery.tasks
      where organization_id = $1 and id = $2`,
    [organizationId, world.taskId],
  )).rows[0];
  const conversationId = crypto.randomUUID();
  const parentId = crypto.randomUUID();
  const planId = crypto.randomUUID();
  await pgDatabase.query(
    `insert into bakery.conversations
       (id, organization_id, application_id, title, created_by)
     values ($1, $2, $3, 'plan parent', $4)`,
    [conversationId, organizationId, task.application_id, principalId],
  );
  await pgDatabase.query(
    `insert into bakery.tasks (
       id, organization_id, application_id, conversation_id, title,
       description, task_type, status, priority, created_by
     ) values ($1, $2, $3, $4, 'plan parent', '', 'epic', 'draft', 50, $5)`,
    [
      parentId,
      organizationId,
      task.application_id,
      conversationId,
      principalId,
    ],
  );
  await pgDatabase.query(
    `insert into bakery.coordination_plans (
       id, organization_id, application_id, parent_task_id, revision, spec,
       digest, budget_limit_usd, status, created_by
     ) values ($1, $2, $3, $4, 1, '{}'::jsonb, $5, null, 'materialized', $6)`,
    [
      planId,
      organizationId,
      task.application_id,
      parentId,
      "c".repeat(64),
      principalId,
    ],
  );
  await pgDatabase.query(
    `insert into bakery.coordination_lanes (
       organization_id, application_id, plan_id, lane_key, position,
       repository_id, child_task_id, lane_digest, status
     ) values ($1, $2, $3, 'lane-0', 0, $4, $5, $6, 'ready')`,
    [
      organizationId,
      task.application_id,
      planId,
      task.repository_id,
      world.taskId,
      "d".repeat(64),
    ],
  );
  return async () => {
    await pgDatabase.query(
      `delete from bakery.coordination_lanes
        where organization_id = $1 and plan_id = $2`,
      [organizationId, planId],
    );
    await pgDatabase.query(
      `delete from bakery.coordination_plans
        where organization_id = $1 and id = $2`,
      [organizationId, planId],
    );
    await pgDatabase.query(
      `delete from bakery.tasks where organization_id = $1 and id = $2`,
      [organizationId, parentId],
    );
    await pgDatabase.query(
      `delete from bakery.conversations where organization_id = $1 and id = $2`,
      [organizationId, conversationId],
    );
  };
}

async function conflictReason(promise: Promise<unknown>): Promise<unknown> {
  const error = await assertRejects(() => promise, StandardError);
  assertEquals(error.code, "STATE_CONFLICT");
  return (error.params as { reason?: unknown } | undefined)?.reason;
}

export function registerAllowanceCases(): void {
  loopTest(
    "allowing one more try reopens the stopped run, which repairs once more and finishes clean",
    () =>
      withReviewedRun(async (world) => {
        await runOutOfTries(world);
        assertEquals(
          (await world.decisions()).map((d) => [d.ordinal, d.reason]),
          [
            [0, "repair_selected"],
            [1, "repair_selected"],
            [2, "repair_cycles_exhausted"],
          ],
        );

        const allowance = await allow(world, 1);
        assertEquals(allowance.addedTries, 1);
        assertEquals(allowance.maxRepairCycles, 3);
        assertEquals(allowance.answersDecisionOrdinal, 2);
        assertEquals(allowance.requestedBy, world.fixture.principalId);

        // The stop is answered with the repair it buys; the stop stays on record.
        assertEquals(
          (await world.decisions()).map((d) => [d.ordinal, d.decision]),
          [
            [0, "repair"],
            [1, "repair"],
            [2, "stop"],
            [3, "repair"],
          ],
        );
        assertEquals(await world.runStatus(), "queued");
        assertEquals(await world.taskStatus(), "queued");
        assertEquals((await world.audits("runs.reopen")).length, 1);
        assertEquals(
          (await world.audits("runRepairAllowances.create")).length,
          1,
        );

        // The engine asks the pinned plan again: a third repair is next.
        await world.resumeEngine();
        assertEquals(await world.nextKey(), "repair@3.repair_implement");
        await world.repair(3, HEADS[3]);
        await world.check(3, HEADS[3]);
        const fourth = await world.review(3);
        await accept(fourth, fourth.report([]));
        assertEquals(await world.nextKey(), undefined);
        assertEquals(await world.runStatus(), "completed");
        assertEquals(
          (await world.decisions()).map((d) => d.decision).at(-1),
          "proceed",
        );
      }, { plan: PLAN }),
  );

  loopTest(
    "the bound allowed is the bound held: a fourth repair still ends the loop at the raised limit",
    () =>
      withReviewedRun(async (world) => {
        await runOutOfTries(world);
        await allow(world, 1);
        await world.resumeEngine();
        await world.nextKey();
        await world.repair(3, HEADS[3]);
        await world.check(3, HEADS[3]);
        const fourth = await world.review(3);
        await accept(fourth, fourth.report([blocker(4)]));
        // Three repairs are used and three are allowed: the loop stops again.
        assertEquals(
          (await world.decisions()).at(-1)?.reason,
          "repair_cycles_exhausted",
        );
        assertEquals(await world.runStatus(), "failed");
      }, { plan: PLAN }),
  );

  loopTest(
    "allowing the same stop twice records one allowance and reopens once",
    () =>
      withReviewedRun(async (world) => {
        await runOutOfTries(world);
        const first = await allow(world, 1, "allow-1");
        const second = await allow(world, 1, "allow-2");
        assertEquals(second.id, first.id);
        assertEquals((await world.audits("runs.reopen")).length, 1);
        assertEquals(
          (await world.audits("runRepairAllowances.create")).length,
          1,
        );
        assertEquals((await world.decisions()).length, 4);
        assertEquals(await world.runStatus(), "queued");
      }, { plan: PLAN }),
  );

  loopTest(
    "a run that stopped for any other reason cannot be reopened this way",
    () =>
      withReviewedRun(async (world) => {
        // The same blocker twice is a repeated blocker, not a lack of tries.
        const first = await world.review(0);
        await accept(first, first.report([blocker(1)]));
        await world.repair(1, HEADS[1]);
        await world.check(1, HEADS[1]);
        const second = await world.review(1);
        await accept(second, second.report([blocker(1)]));
        assertEquals(await world.runStatus(), "failed");
        assertEquals(
          (await world.decisions()).at(-1)?.reason,
          "repeated_blocker",
        );
        assertEquals(
          await conflictReason(allow(world, 1)),
          "repair_not_exhausted",
        );
        assertEquals(await world.runStatus(), "failed");
        assertEquals((await world.audits("runs.reopen")).length, 0);
      }, { plan: PLAN }),
  );

  loopTest(
    "a run that ran out of tries but was ended some other way cannot be reopened",
    () =>
      withReviewedRun(async (world) => {
        await runOutOfTries(world);
        await world.fixture.pgDatabase.query(
          `update bakery.workflow_runs set status = 'canceled'
            where organization_id = $1 and id = $2`,
          [world.fixture.organizationId, world.runId],
        );
        assertEquals(
          await conflictReason(allow(world, 1)),
          "run_not_stopped_by_loop",
        );
        assertEquals((await world.audits("runs.reopen")).length, 0);
        assertEquals((await world.decisions()).length, 3);
      }, { plan: PLAN }),
  );

  loopTest(
    "more tries than the workflow can ever hold are refused and nothing is written",
    () =>
      withReviewedRun(async (world) => {
        await runOutOfTries(world);
        // Two are allowed by the plan; eight is the most any workflow holds.
        assertEquals(
          await conflictReason(allow(world, 7)),
          "allowance_exceeds_workflow_maximum",
        );
        const error = await assertRejects(() => allow(world, 0), StandardError);
        assertEquals(error.code, "UNPROCESSABLE");
        assertEquals((await world.decisions()).length, 3);
        assertEquals(await world.runStatus(), "failed");
        const largest = await allow(world, 6);
        assertEquals(largest.maxRepairCycles, 8);
        assert(largest.id.length > 0);
      }, { plan: PLAN }),
  );
  loopTest(
    "the allow operation answers with the repair decision it bought, once per stop, and refuses what a run cannot take",
    () =>
      withReviewedRun(async (world) => {
        await runOutOfTries(world);
        const path = `/v1/runs/${world.runId}/repair-allowances`;
        const refused = await apiCall(
          world.fixture,
          world.fixture,
          "POST",
          path,
          {
            body: { tries: 0 },
          },
        );
        assert(
          refused.status >= 400 && refused.status < 500,
          String(refused.status),
        );
        await refused.body?.cancel();
        assertEquals(await world.runStatus(), "failed");

        const response = await apiCall(
          world.fixture,
          world.fixture,
          "POST",
          path,
          {
            body: { tries: 1 },
          },
        );
        assert(response.ok, await response.clone().text());
        const allowed = await response.json() as {
          runId: string;
          kind: string;
          addedTries: number;
          decisionId: string;
          repeatKey: string | null;
        };
        assertEquals(
          [allowed.runId, allowed.kind, allowed.addedTries, allowed.repeatKey],
          [world.runId, "repair_loop", 1, null],
        );
        const decision = (await world.decisions()).find((row) =>
          row.id === allowed.decisionId
        )!;
        assertEquals(decision.ordinal, 3);
        assertEquals([decision.decision, decision.reason], [
          "repair",
          "repair_selected",
        ]);
        assertEquals(decision.limits.maxRepairCycles, 3);
        assertEquals(await world.runStatus(), "queued");

        // Asked again with a new key for the same stop: the same decision.
        const again = await expectJson<{ decisionId: string }>(
          await apiCall(world.fixture, world.fixture, "POST", path, {
            body: { tries: 1 },
          }),
          response.status,
        );
        assertEquals(again.decisionId, allowed.decisionId);
        assertEquals((await world.audits("runs.reopen")).length, 1);

        // A run that is not stopped for lack of tries is a conflict.
        const missing = await apiCall(
          world.fixture,
          world.fixture,
          "POST",
          `/v1/runs/${crypto.randomUUID()}/repair-allowances`,
          { body: { tries: 1 } },
        );
        assertEquals(missing.status, 404);
        await missing.body?.cancel();
      }, { plan: PLAN }),
  );
  loopTest(
    "a developer and an agent are refused, and nothing is recorded or reopened",
    () =>
      withReviewedRun(async (world) => {
        await runOutOfTries(world);
        const developer = await addMember(world, "developer");
        const forbidden = async (work: Promise<unknown>) =>
          assertEquals(
            (await assertRejects(() => work, StandardError)).code,
            "AUTH_FORBIDDEN",
          );
        await forbidden(allowAs(world, developer));
        // An agent never overrules a stopped loop, whoever it acts for: the
        // organization's own administrator, acting through an agent session.
        await forbidden(
          allowAs(world, world.fixture.principalId, { agent: true }),
        );
        assertEquals(await allowanceRows(world), 0);
        assertEquals((await world.audits("runs.reopen")).length, 0);
        assertEquals((await world.decisions()).length, 3);
        assertEquals(await world.runStatus(), "failed");

        // The same administrator, as a person, is allowed: the refusals above
        // were about who asked, not about the run.
        await allowAs(world, world.fixture.principalId);
        assertEquals(await allowanceRows(world), 1);
        assertEquals(await world.runStatus(), "queued");
      }, { plan: PLAN }),
  );

  loopTest(
    "a run that is a lane of a coordination plan is refused, and the allowance rolls back with it",
    () =>
      withReviewedRun(async (world) => {
        await runOutOfTries(world);
        const removeLane = await makeCoordinationLane(world);
        try {
          assertEquals(
            await conflictReason(allow(world, 1)),
            "run_in_coordination_plan",
          );
          // The refusal comes after the allowance is written, in the same
          // transaction, so none of it may remain.
          assertEquals(await allowanceRows(world), 0);
          assertEquals((await world.decisions()).length, 3);
          assertEquals((await world.audits("runs.reopen")).length, 0);
          assertEquals(
            (await world.audits("runRepairAllowances.create")).length,
            0,
          );
          assertEquals(await world.runStatus(), "failed");
          assertEquals(await world.taskStatus(), "failed");
        } finally {
          await removeLane();
        }
      }, { plan: PLAN }),
  );

  loopTest(
    "a failed run whose latest failure was not the loop's halt is not reopened, even after a stop for tries",
    () =>
      withReviewedRun(async (world) => {
        await runOutOfTries(world);
        // The run failed again afterwards for another reason: the run is still
        // `failed` and the last decision is still the stop, but the loop is no
        // longer why it ended.
        await withPgTransaction(world.fixture.pgDatabase, (transaction) =>
          appendAudit(transaction, {
            organizationId: world.fixture.organizationId,
            principalId: world.fixture.principalId,
            operation: "workflow.plan_failed",
            resourceType: "workflow_run",
            resourceId: world.runId,
            requestId: "other-failure",
            traceId: "other-failure",
            details: { code: "step_failed" },
          }));
        assertEquals(await world.runStatus(), "failed");
        assertEquals(
          await conflictReason(allow(world, 1)),
          "run_not_stopped_by_loop",
        );
        assertEquals(await allowanceRows(world), 0);
        assertEquals((await world.audits("runs.reopen")).length, 0);
      }, { plan: PLAN }),
  );

  loopTest(
    "the per-try read says what each try fixed, what is new, and why the loop stopped",
    () =>
      withReviewedRun(async (world) => {
        await runOutOfTries(world);
        const path = `/v1/runs/${world.runId}/repair-tries`;
        const page = await expectJson<{
          items: Array<Record<string, unknown>>;
          nextCursor: string | null;
        }>(await apiCall(world.fixture, world.fixture, "GET", path), 200);
        assertEquals(page.nextCursor, null);
        assertEquals(
          page.items.map((t) => [t.number, t.decision, t.reason]),
          [
            [1, "repair", "repair_selected"],
            [2, "stop", "repair_cycles_exhausted"],
          ],
        );
        // Each round reported a blocker of its own: the earlier one was fixed,
        // a new one appeared, nothing came back.
        assertEquals(
          page.items.map((
            t,
          ) => [t.fixedFindings, t.cameBackFindings, t.newFindings]),
          [[1, 0, 1], [1, 0, 1]],
        );
        assertEquals(page.items.map((t) => t.blockingFindings), [1, 1]);
        assert(page.items.every((t) => t.runId === world.runId));

        const first = await expectJson<{
          items: Array<{ number: number }>;
          nextCursor: string | null;
        }>(
          await apiCall(world.fixture, world.fixture, "GET", `${path}?limit=1`),
          200,
        );
        assertEquals(first.items.map((t) => t.number), [1]);
        assert(first.nextCursor !== null);
        const rest = await expectJson<{ items: Array<{ number: number }> }>(
          await apiCall(
            world.fixture,
            world.fixture,
            "GET",
            `${path}?limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`,
          ),
          200,
        );
        assertEquals(rest.items.map((t) => t.number), [2]);
      }, { plan: PLAN }),
  );
}
