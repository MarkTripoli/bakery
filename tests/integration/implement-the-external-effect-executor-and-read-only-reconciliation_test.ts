import { assert, assertEquals, assertRejects } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import {
  type PgDatabase,
  withPgTransaction,
} from "../../apps/server/src/platform/database.ts";
import { releaseWorkflowAction } from "../../apps/server/src/modules/work/budget.ts";
import { reconcileBudgetLedger } from "../../apps/server/src/modules/work/budget-recovery.ts";
import { claimEffect } from "../../apps/server/src/modules/effects/claim.ts";
import {
  type PrepareDeps,
  prepareEffect,
  ReconciliationEvidenceSchema,
} from "../../apps/server/src/modules/effects/index.ts";
import { recordOutcome } from "../../apps/server/src/modules/effects/dispatch.ts";
import { MAX_RECONCILIATION_EVIDENCE_BYTES } from "../../apps/server/src/modules/effects/schema.ts";
import {
  findEffectById,
  findEffectByKey,
} from "../../apps/server/src/modules/effects/repository.ts";
import {
  admitFundedModelRun as admit,
  seedAdmissibleRun as seedRun,
  seedProviderPricingSnapshot,
} from "../helpers/funded-model-job.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import {
  claimDepsFor,
  effectRegistry,
  effectRig,
  executorFor,
  fakeGithub,
  forceEffectStatus,
  GITHUB_ACTION,
  persistReleaseEvidence,
  seededEffectRig,
  seedPlanApproval,
} from "../helpers/external-effects.ts";
import type { WorkerFixture } from "../helpers/worker-execution.ts";

async function code(promise: Promise<unknown>): Promise<StandardError> {
  const error = await assertRejects(() => promise);
  assert(error instanceof StandardError, `unexpected ${String(error)}`);
  return error;
}

Deno.test("prepare records an idempotent effect and replays it", () =>
  withWorkerFixture(async (fixture) => {
    const db = fixture.pgDatabase;
    const rig = await seededEffectRig(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const deps: PrepareDeps = {
      database: db,
      registry: effectRegistry,
      snapshots: rig.port,
    };
    const base = {
      organizationId: fixture.organizationId,
      envelope: rig.envelope,
      input: rig.input(),
      idempotencyKey: "key-1",
    };

    const first = await prepareEffect(deps, base);
    assertEquals(first.status, "prepared");
    assertEquals(first.replayed, false);

    const row = await withPgTransaction(
      db,
      (tx) => findEffectById(tx, fixture.organizationId, first.effectId),
    );
    assert(row);
    assertEquals(row.operation, GITHUB_ACTION);
    assertEquals(row.target, `integration-resource:${rig.resourceId}`);
    assertEquals(row.actionVersion, 1);
    assertEquals(row.adapterVersion, "bakery.github@1.0.0");
    assertEquals(row.integrationConnectionId, rig.connectionId);
    assertEquals(row.integrationResourceId, rig.resourceId);
    assertEquals(row.integrationInstallId, "inst-1");
    assertEquals(row.externalAccountId, "987654");
    assertEquals(row.externalResourceId, "1234");
    assertEquals(row.authorizationRevision, 1);
    assertEquals(row.requestingPrincipalId, fixture.principalId);
    assertEquals(row.actorRef, fixture.principalId);
    assertEquals(row.dispatchGeneration, 0);
    assertEquals(row.leaseExpiresAt, null);
    assertEquals(row.budgetReservationId, null);
    assertEquals(row.safeArguments, { issueNumber: 7, body: "hello" });

    const replay = await prepareEffect(deps, base);
    assertEquals(replay, {
      effectId: first.effectId,
      status: "prepared",
      replayed: true,
    });
    const count = await db.query(
      `select count(*)::int as n from bakery.external_effects
        where organization_id = $1`,
      [fixture.organizationId],
    );
    assertEquals(count.rows[0].n, 1);

    // Different body under the same key: mismatch, row untouched.
    const before = await withPgTransaction(
      db,
      (tx) => findEffectById(tx, fixture.organizationId, first.effectId),
    );
    const error = await code(prepareEffect(deps, {
      ...base,
      input: rig.input({ issueNumber: 7, body: "changed" }),
    }));
    assertEquals(error.code, "IDEMPOTENCY_PAYLOAD_MISMATCH");
    const after = await withPgTransaction(
      db,
      (tx) => findEffectById(tx, fixture.organizationId, first.effectId),
    );
    assertEquals(after, before);

    // A different key is a different effect.
    const other = await prepareEffect(deps, {
      ...base,
      idempotencyKey: "key-2",
    });
    assert(other.effectId !== first.effectId);
    assertEquals(other.replayed, false);
  }));

Deno.test("replay survives a grant edit that only bumps the policy revision", () =>
  withWorkerFixture(async (fixture) => {
    const rig = await seededEffectRig(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const deps: PrepareDeps = {
      database: fixture.pgDatabase,
      registry: effectRegistry,
      snapshots: rig.port,
    };
    const args = {
      organizationId: fixture.organizationId,
      envelope: rig.envelope,
      input: rig.input(),
      idempotencyKey: "grant-edit",
    };
    const first = await prepareEffect(deps, args);

    const edited = rig.snapshot.current;
    rig.snapshot.current = {
      ...edited,
      policyRevision: 2,
      grants: edited.grants.map((g) => ({ ...g, policyRevision: 2 })),
    };
    const replay = await prepareEffect(deps, args);
    assertEquals(replay.replayed, true);
    assertEquals(replay.effectId, first.effectId);

    // The grant is removed entirely: the replay is still the same request.
    rig.snapshot.current = { ...edited, grants: [] };
    const afterRevoke = await prepareEffect(deps, args);
    assertEquals(afterRevoke.replayed, true);
    assertEquals(afterRevoke.effectId, first.effectId);

    // A first prepare with the revoked grant is refused and writes no row.
    const refused = await code(
      prepareEffect(deps, { ...args, idempotencyKey: "after-revoke" }),
    );
    assertEquals(refused.code, "AUTH_FORBIDDEN");
    const key = await withPgTransaction(
      fixture.pgDatabase,
      (tx) =>
        findEffectByKey(tx, {
          organizationId: fixture.organizationId,
          operation: GITHUB_ACTION,
          target: `integration-resource:${rig.resourceId}`,
          idempotencyKey: "after-revoke",
        }),
    );
    assertEquals(key, null);
  }));

Deno.test("prepare checks reservation ownership, state and expiry", () =>
  withWorkerFixture(async (fixture) => {
    const db = fixture.pgDatabase;
    await seedProviderPricingSnapshot(db);
    const mine = await admit(
      db,
      await seedRun(db, fixture.organizationId, fixture.principalId, {
        reservationUsd: "0.1",
        stepKey: "effects-mine",
      }),
    );
    const foreign = await admit(
      db,
      await seedRun(db, fixture.organizationId, fixture.principalId, {
        reservationUsd: "0.1",
        stepKey: "effects-foreign",
      }),
    );
    const rig = await seededEffectRig(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const deps: PrepareDeps = {
      database: db,
      registry: effectRegistry,
      snapshots: rig.port,
    };
    let n = 0;
    const args = (budgetReservationId: string, runStepId = mine.runStepId) => ({
      organizationId: fixture.organizationId,
      envelope: rig.envelope,
      input: rig.input(),
      idempotencyKey: `reservation-${n++}`,
      runStepId,
      budgetReservationId,
    });
    const rows = async () =>
      (await db.query(
        `select count(*)::int as n from bakery.external_effects
          where organization_id = $1`,
        [fixture.organizationId],
      )).rows[0].n as number;

    // A reservation of another run step.
    let error = await code(
      prepareEffect(deps, args(foreign.runReservationId)),
    );
    assertEquals(error.code, "UNPROCESSABLE");
    assertEquals(error.params?.reason, "budget_reservation_scope_mismatch");
    assertEquals(await rows(), 0);

    // A reservation without a run step (the coordinator path).
    await db.query(
      `update bakery.budget_reservations set run_step_id = null where id = $1`,
      [foreign.installationReservationId],
    );
    error = await code(
      prepareEffect(deps, args(foreign.installationReservationId)),
    );
    assertEquals(error.params?.reason, "budget_reservation_scope_mismatch");
    assertEquals(await rows(), 0);

    // An unknown reservation.
    error = await code(prepareEffect(deps, args(crypto.randomUUID())));
    assertEquals(error.code, "RESOURCE_NOT_FOUND");

    // A reservation that is no longer held.
    await db.query(
      `update bakery.budget_reservations set status = 'released' where id = $1`,
      [mine.installationReservationId],
    );
    error = await code(
      prepareEffect(deps, args(mine.installationReservationId)),
    );
    assertEquals(error.code, "STATE_CONFLICT");
    assertEquals(error.params?.reason, "budget_reservation_not_held");

    // An expired reservation.
    await db.query(
      `update bakery.budget_reservations
          set expires_at = clock_timestamp() - interval '1 minute'
        where id = $1`,
      [mine.runReservationId],
    );
    error = await code(prepareEffect(deps, args(mine.runReservationId)));
    assertEquals(error.params?.reason, "budget_reservation_expired");
    assertEquals(await rows(), 0);

    // Restore the run reservation: now it links.
    await db.query(
      `update bakery.budget_reservations
          set expires_at = clock_timestamp() + interval '1 hour'
        where id = $1`,
      [mine.runReservationId],
    );
    const ok = await prepareEffect(deps, args(mine.runReservationId));
    const row = await withPgTransaction(
      db,
      (tx) => findEffectById(tx, fixture.organizationId, ok.effectId),
    );
    assertEquals(row?.budgetReservationId, mine.runReservationId);
    assertEquals(row?.runStepId, mine.runStepId);

    // A reservation already linked to another effect.
    await db.query(
      `update bakery.budget_reservations set external_effect_id = $2
        where id = $1`,
      [mine.runReservationId, ok.effectId],
    );
    error = await code(prepareEffect(deps, args(mine.runReservationId)));
    assertEquals(error.params?.reason, "budget_reservation_scope_mismatch");

    // A reservation or an approval without a run step is refused.
    error = await code(prepareEffect(deps, {
      organizationId: fixture.organizationId,
      envelope: rig.envelope,
      input: rig.input(),
      idempotencyKey: "no-step",
      budgetReservationId: mine.runReservationId,
    }));
    assertEquals(error.params?.reason, "budget_reservation_requires_run_step");
    error = await code(prepareEffect(deps, {
      organizationId: fixture.organizationId,
      envelope: rig.envelope,
      input: rig.input(),
      idempotencyKey: "approval-no-step",
      approval: { id: crypto.randomUUID(), stage: "plan", policyDigest: "p" },
    }));
    assertEquals(error.params?.reason, "approval_requires_run_step");
    // An approval that does not exist in this organization.
    error = await code(prepareEffect(deps, {
      organizationId: fixture.organizationId,
      envelope: rig.envelope,
      input: rig.input(),
      idempotencyKey: "approval-missing",
      runStepId: mine.runStepId,
      approval: { id: crypto.randomUUID(), stage: "plan", policyDigest: "p" },
    }));
    assertEquals(error.code, "RESOURCE_NOT_FOUND");

    // An approval of another task, and a question that is not an approval,
    // are refused at prepare and write no row.
    const countBefore = await rows();
    const otherTask = await seedPlanApproval(db, foreign);
    const ownApproval = await seedPlanApproval(db, mine);
    const notApproval = await seedPlanApproval(db, mine, { revision: 2 });
    await db.query(
      `update bakery.questions set kind = 'question' where id = $1`,
      [notApproval.approvalId],
    );
    for (const seeded of [otherTask, notApproval]) {
      error = await code(prepareEffect(deps, {
        organizationId: fixture.organizationId,
        envelope: rig.envelope,
        input: rig.input(),
        idempotencyKey: `approval-scope-${seeded.approvalId}`,
        runStepId: mine.runStepId,
        approval: {
          id: seeded.approvalId,
          stage: seeded.stage,
          policyDigest: seeded.policyDigest,
        },
      }));
      assertEquals(error.code, "UNPROCESSABLE");
      assertEquals(error.params?.reason, "approval_scope_mismatch");
    }
    assertEquals(await rows(), countBefore);
    // The run's own approval still prepares.
    await prepareEffect(deps, {
      organizationId: fixture.organizationId,
      envelope: rig.envelope,
      input: rig.input(),
      idempotencyKey: "approval-scope-own",
      runStepId: mine.runStepId,
      approval: {
        id: ownApproval.approvalId,
        stage: ownApproval.stage,
        policyDigest: ownApproval.policyDigest,
      },
    });
    assertEquals(await rows(), countBefore + 1);
  }));

Deno.test("prepare and reads never cross organizations", () =>
  withWorkerFixture(async (fixture) => {
    const db = fixture.pgDatabase;
    await seedProviderPricingSnapshot(db);
    const mine = await admit(
      db,
      await seedRun(db, fixture.organizationId, fixture.principalId, {
        reservationUsd: "0.1",
        stepKey: "effects-org",
      }),
    );
    const rig = await seededEffectRig(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const deps: PrepareDeps = {
      database: db,
      registry: effectRegistry,
      snapshots: rig.port,
    };
    const prepared = await prepareEffect(deps, {
      organizationId: fixture.organizationId,
      envelope: rig.envelope,
      input: rig.input(),
      idempotencyKey: "org-a",
    });
    const stranger = crypto.randomUUID();
    assertEquals(
      await withPgTransaction(
        db,
        (tx) => findEffectById(tx, stranger, prepared.effectId),
      ),
      null,
    );

    // The same key and request from another organization never sees the row;
    // its authority snapshot belongs to the first organization, so it is refused.
    const error = await code(prepareEffect(deps, {
      organizationId: stranger,
      envelope: rig.envelope,
      input: rig.input(),
      idempotencyKey: "org-a",
    }));
    assertEquals(error.code, "RESOURCE_NOT_FOUND");

    // A reservation of another organization is not found.
    const otherRig = effectRig(stranger, fixture.principalId);
    const crossError = await code(prepareEffect(
      { database: db, registry: effectRegistry, snapshots: otherRig.port },
      {
        organizationId: stranger,
        envelope: otherRig.envelope,
        input: otherRig.input(),
        idempotencyKey: "cross",
        runStepId: mine.runStepId,
        budgetReservationId: mine.runReservationId,
      },
    ));
    assertEquals(crossError.code, "RESOURCE_NOT_FOUND");
    const count = await db.query(
      `select count(*)::int as n from bakery.external_effects
        where organization_id = $1`,
      [stranger],
    );
    assertEquals(count.rows[0].n, 0);
  }));

type Staged = Awaited<ReturnType<typeof stage>>;

/** Seeds a funded run and returns helpers to prepare and claim effects on it. */
async function stage(
  fixture: WorkerFixture,
  stepKey: string,
  ops: PgDatabase = fixture.pgDatabase,
) {
  const db = fixture.pgDatabase;
  await seedProviderPricingSnapshot(db);
  const run = await admit(
    db,
    await seedRun(db, fixture.organizationId, fixture.principalId, {
      reservationUsd: "0.1",
      stepKey,
    }),
  );
  const rig = await seededEffectRig(
    fixture.pgDatabase,
    fixture.organizationId,
    fixture.principalId,
  );
  const prepareDeps: PrepareDeps = {
    database: ops,
    registry: effectRegistry,
    snapshots: rig.port,
  };
  let n = 0;
  return {
    db,
    run,
    rig,
    organizationId: fixture.organizationId,
    foreignStepId: async () =>
      (await admit(
        db,
        await seedRun(db, fixture.organizationId, fixture.principalId, {
          reservationUsd: "0.1",
          stepKey: `${stepKey}-foreign`,
        }),
      )).runStepId,
    prepare: (extra: Record<string, unknown> = {}) =>
      prepareEffect(prepareDeps, {
        organizationId: fixture.organizationId,
        envelope: rig.envelope,
        input: rig.input(),
        idempotencyKey: `${stepKey}-${n++}`,
        runStepId: run.runStepId,
        budgetReservationId: run.runReservationId,
        ...extra,
      }),
    claim: (effectId: string, organizationId = fixture.organizationId) =>
      claimEffect(claimDepsFor(ops, rig), {
        organizationId,
        effectId,
        requestId: "request-1",
        traceId: "trace-1",
      }),
    row: (effectId: string) =>
      withPgTransaction(
        ops,
        (tx) => findEffectById(tx, fixture.organizationId, effectId),
      ),
  };
}

Deno.test("claim commits submitted, generation 1 and a lease before any provider call", () =>
  withWorkerFixture(async (fixture) => {
    const s = await stage(fixture, "claim-happy");
    const prepared = await s.prepare();
    const claim = await s.claim(prepared.effectId);
    assertEquals(claim.outcome, "claimed");
    if (claim.outcome !== "claimed") return;
    assertEquals(claim.effect.status, "submitted");
    assertEquals(claim.effect.dispatchGeneration, 1);
    assert(claim.effect.leaseExpiresAt !== null);
    assertEquals(claim.bound.effectId, prepared.effectId);

    // What a provider port sees on its first request: the committed row, read
    // from an independent connection, already says submitted.
    const seen = await fixture.runtimePgDatabase.query(
      `select status, dispatch_generation, lease_expires_at > clock_timestamp() as leased
         from bakery.external_effects where id = $1`,
      [prepared.effectId],
    );
    assertEquals(seen.rows[0].status, "submitted");
    assertEquals(seen.rows[0].dispatch_generation, 1);
    assertEquals(seen.rows[0].leased, true);

    // A second claim of the same effect performs nothing.
    const again = await s.claim(prepared.effectId);
    assertEquals(again.outcome, "not_claimable");
    assertEquals(again.effect.dispatchGeneration, 1);
  }));

Deno.test("concurrent claims of one effect produce exactly one claim", () =>
  withWorkerFixture(async (fixture) => {
    const s = await stage(fixture, "claim-race");
    const prepared = await s.prepare();
    const results = await Promise.all([
      s.claim(prepared.effectId),
      s.claim(prepared.effectId),
      s.claim(prepared.effectId),
    ]);
    assertEquals(
      results.filter((r) => r.outcome === "claimed").length,
      1,
    );
    assertEquals((await s.row(prepared.effectId))?.dispatchGeneration, 1);
  }));

Deno.test("claim of a retry that is not due, or of another organization, does nothing", () =>
  withWorkerFixture(async (fixture) => {
    const s = await stage(fixture, "claim-not-due");
    const prepared = await s.prepare();
    await s.db.query(
      `update bakery.external_effects
          set next_retry_at = clock_timestamp() + interval '1 hour'
        where id = $1`,
      [prepared.effectId],
    );
    const early = await s.claim(prepared.effectId);
    assertEquals(early.outcome, "not_claimable");
    if (early.outcome === "not_claimable") {
      assertEquals(early.reason, "not_due");
    }
    assertEquals((await s.row(prepared.effectId))?.status, "prepared");

    await s.db.query(
      `update bakery.external_effects
          set next_retry_at = clock_timestamp() - interval '1 second'
        where id = $1`,
      [prepared.effectId],
    );
    assertEquals((await s.claim(prepared.effectId)).outcome, "claimed");

    const error = await code(s.claim(prepared.effectId, crypto.randomUUID()));
    assertEquals(error.code, "RESOURCE_NOT_FOUND");
  }));

type BlockCase = Readonly<{
  name: string;
  expected: string;
  arrange(s: Staged): Promise<void>;
}>;

const sql = (s: Staged, text: string, params: unknown[]) =>
  s.db.query(text, params);

const blockCases: readonly BlockCase[] = [
  {
    name: "run terminal",
    expected: "run_terminal",
    arrange: async (s) => {
      await sql(
        s,
        `update bakery.workflow_runs set status = 'canceled' where id = $1`,
        [s.run.runId],
      );
    },
  },
  {
    name: "step terminal",
    expected: "run_terminal",
    arrange: async (s) => {
      await sql(
        s,
        `update bakery.run_steps set status = 'failed' where id = $1`,
        [s.run.runStepId],
      );
    },
  },
  {
    name: "job cancel requested",
    expected: "job_canceled",
    arrange: async (s) => {
      await sql(
        s,
        `update bakery.jobs set cancel_requested_at = now() where id = $1`,
        [s.run.jobId],
      );
    },
  },
  {
    name: "job canceled",
    expected: "job_canceled",
    arrange: async (s) => {
      await sql(
        s,
        `update bakery.jobs set status = 'canceled' where id = $1`,
        [s.run.jobId],
      );
    },
  },
  {
    name: "all jobs terminal",
    expected: "job_terminal",
    arrange: async (s) => {
      await sql(
        s,
        `update bakery.jobs set status = 'completed' where id = $1`,
        [s.run.jobId],
      );
    },
  },
  {
    name: "reservation released",
    expected: "budget_reservation_not_held",
    arrange: async (s) => {
      await sql(
        s,
        `update bakery.budget_reservations set status = 'released' where id = $1`,
        [s.run.runReservationId],
      );
    },
  },
  {
    name: "reservation expired",
    expected: "budget_reservation_expired",
    arrange: async (s) => {
      await sql(
        s,
        `update bakery.budget_reservations
            set expires_at = clock_timestamp() - interval '1 minute'
          where id = $1`,
        [s.run.runReservationId],
      );
    },
  },
  {
    name: "reservation moved to a foreign step",
    expected: "budget_reservation_scope_mismatch",
    arrange: async (s) => {
      await sql(
        s,
        `update bakery.budget_reservations set run_step_id = $2 where id = $1`,
        [s.run.runReservationId, await s.foreignStepId()],
      );
    },
  },
  {
    name: "reservation linked to another effect",
    expected: "budget_reservation_scope_mismatch",
    arrange: async (s) => {
      const other = await s.prepare();
      await sql(
        s,
        `update bakery.budget_reservations set external_effect_id = $2 where id = $1`,
        [s.run.runReservationId, other.effectId],
      );
    },
  },
  {
    name: "authority denied",
    expected: "authorization_denied",
    arrange: (s) => {
      s.rig.snapshot.current = { ...s.rig.snapshot.current, grants: [] };
      return Promise.resolve();
    },
  },
  {
    name: "install changed",
    expected: "integration_reinstalled",
    arrange: (s) => {
      const current = s.rig.snapshot.current;
      s.rig.snapshot.current = {
        ...current,
        install: { ...current.install, id: "inst-2" },
        connection: { ...current.connection, installId: "inst-2" },
      };
      return Promise.resolve();
    },
  },
  {
    name: "resource identity changed",
    expected: "resource_identity_changed",
    arrange: (s) => {
      const current = s.rig.snapshot.current;
      s.rig.snapshot.current = {
        ...current,
        resource: {
          ...current.resource,
          binding: { ...current.resource.binding, repositoryId: 9999 },
        },
      };
      return Promise.resolve();
    },
  },
];

for (const blockCase of blockCases) {
  Deno.test(`claim blocked: ${blockCase.name} fails the effect with no send`, () =>
    withWorkerFixture(async (fixture) => {
      const s = await stage(fixture, `block-${blockCase.expected}`);
      const prepared = await s.prepare();
      await blockCase.arrange(s);
      const claim = await s.claim(prepared.effectId);
      assertEquals(claim.outcome, "blocked");
      if (claim.outcome !== "blocked") return;
      assertEquals(claim.failureCode, blockCase.expected);
      const row = await s.row(prepared.effectId);
      assertEquals(row?.status, "failed");
      assertEquals(row?.failureCode, blockCase.expected);
      assertEquals(row?.dispatchGeneration, 0);
      assertEquals(row?.leaseExpiresAt, null);
    }));
}

Deno.test("claim blocked: adapter manifest drift fails the effect", () =>
  withWorkerFixture(async (fixture) => {
    const s = await stage(fixture, "block-adapter");
    const prepared = await s.prepare();
    await s.db.query(
      `update bakery.external_effects set adapter_manifest_digest = 'older'
        where id = $1`,
      [prepared.effectId],
    );
    const claim = await s.claim(prepared.effectId);
    assertEquals(claim.outcome, "blocked");
    assertEquals(
      (await s.row(prepared.effectId))?.failureCode,
      "adapter_changed",
    );
  }));

Deno.test("claim of a prepared effect on an expired reservation fails it", () =>
  withWorkerFixture(async (fixture) => {
    const s = await stage(fixture, "prepared-expired");
    const prepared = await s.prepare();
    assertEquals((await s.row(prepared.effectId))?.status, "prepared");
    await s.db.query(
      `update bakery.budget_reservations
          set expires_at = clock_timestamp() - interval '1 second'
        where id = $1`,
      [s.run.runReservationId],
    );
    const claim = await s.claim(prepared.effectId);
    assertEquals(claim.outcome, "blocked");
    assertEquals(
      (await s.row(prepared.effectId))?.failureCode,
      "budget_reservation_expired",
    );
  }));

Deno.test("approval consumed by this run satisfies the claim; a newer plan revision makes it stale", () =>
  withWorkerFixture(async (fixture) => {
    const s = await stage(fixture, "approval-primary");
    const approval = await seedPlanApproval(s.db, s.run, { consumed: true });
    const ref = {
      id: approval.approvalId,
      stage: approval.stage,
      policyDigest: approval.policyDigest,
    };
    const fresh = await s.prepare({ approval: ref });
    const ok = await s.claim(fresh.effectId);
    assertEquals(ok.outcome, "claimed");

    // Not a second consume: the question keeps its single consumption.
    const events = await s.db.query(
      `select count(*)::int as n from bakery.domain_events
        where event_type = 'approval.consumed' and aggregate_id = $1`,
      [approval.approvalId],
    );
    assertEquals(events.rows[0].n, 0);

    const stale = await s.prepare({ approval: ref });
    await seedPlanApproval(s.db, s.run, { revision: 2 });
    const refused = await s.claim(stale.effectId);
    assertEquals(refused.outcome, "blocked");
    assertEquals((await s.row(stale.effectId))?.failureCode, "approval_stale");
  }));

Deno.test("an unconsumed approval of another stage blocks the claim", () =>
  withWorkerFixture(async (fixture) => {
    const s = await stage(fixture, "approval-foreign");
    const approval = await seedPlanApproval(s.db, s.run, { consumed: true });
    await s.db.query(
      `update bakery.questions set consumed_by_run_id = null, status = 'answered'
        where id = $1`,
      [approval.approvalId],
    );
    // An unconsumed answered approval of the wrong stage is not consumable.
    const wrongStage = await s.prepare({
      approval: {
        id: approval.approvalId,
        stage: "other",
        policyDigest: approval.policyDigest,
      },
    });
    assertEquals((await s.claim(wrongStage.effectId)).outcome, "blocked");
    assertEquals(
      (await s.row(wrongStage.effectId))?.failureCode,
      "approval_unavailable",
    );
  }));

Deno.test("SYNTHETIC: an unconsumed approval is consumed once and reused by generation 2", () =>
  withWorkerFixture(async (fixture) => {
    const s = await stage(fixture, "approval-synthetic");
    const approval = await seedPlanApproval(s.db, s.run);
    const prepared = await s.prepare({
      approval: {
        id: approval.approvalId,
        stage: approval.stage,
        policyDigest: approval.policyDigest,
      },
    });
    const first = await s.claim(prepared.effectId);
    assertEquals(first.outcome, "claimed");

    const consumed = await s.db.query(
      `select status, consumed_by_run_id from bakery.questions where id = $1`,
      [approval.approvalId],
    );
    assertEquals(consumed.rows[0].status, "consumed");
    assertEquals(consumed.rows[0].consumed_by_run_id, s.run.runId);
    const count = async () => ({
      events: (await s.db.query(
        `select count(*)::int as n from bakery.domain_events
          where event_type = 'approval.consumed' and aggregate_id = $1`,
        [approval.approvalId],
      )).rows[0].n as number,
      audits: (await s.db.query(
        `select count(*)::int as n from bakery.audit_events
          where operation = 'approvals.consume' and resource_id = $1`,
        [approval.approvalId],
      )).rows[0].n as number,
    });
    assertEquals(await count(), { events: 1, audits: 1 });

    // A rejected attempt returns the effect to prepared; the retry claim
    // takes the consumed-by-this-run path and never consumes again.
    await s.db.query(
      `update bakery.external_effects
          set status = 'prepared', lease_expires_at = null
        where id = $1`,
      [prepared.effectId],
    );
    const second = await s.claim(prepared.effectId);
    assertEquals(second.outcome, "claimed");
    assertEquals(second.effect.dispatchGeneration, 2);
    assertEquals(await count(), { events: 1, audits: 1 });
  }));

Deno.test("SYNTHETIC: a revoked approval, or one with a newer plan revision, blocks the claim", () =>
  withWorkerFixture(async (fixture) => {
    const s = await stage(fixture, "approval-revoked");
    const revoked = await seedPlanApproval(s.db, s.run);
    await s.db.query(
      `update bakery.questions set revoked_at = now(), status = 'revoked'
        where id = $1`,
      [revoked.approvalId],
    );
    const a = await s.prepare({
      approval: {
        id: revoked.approvalId,
        stage: revoked.stage,
        policyDigest: revoked.policyDigest,
      },
    });
    assertEquals((await s.claim(a.effectId)).outcome, "blocked");
    assertEquals(
      (await s.row(a.effectId))?.failureCode,
      "approval_unavailable",
    );

    const older = await seedPlanApproval(s.db, s.run, { revision: 2 });
    await seedPlanApproval(s.db, s.run, { revision: 3 });
    const b = await s.prepare({
      approval: {
        id: older.approvalId,
        stage: older.stage,
        policyDigest: older.policyDigest,
      },
    });
    assertEquals((await s.claim(b.effectId)).outcome, "blocked");
    assertEquals((await s.row(b.effectId))?.failureCode, "approval_stale");
    const still = await s.db.query(
      `select status from bakery.questions where id = $1`,
      [older.approvalId],
    );
    assertEquals(still.rows[0].status, "answered");
  }));

Deno.test("a transport error loading authority rolls the claim back and leaves the effect prepared", () =>
  withWorkerFixture(async (fixture) => {
    const s = await stage(fixture, "claim-transport");
    const prepared = await s.prepare();
    const original = s.rig.port.load;
    s.rig.port.load = () => Promise.reject(new Error("authority store down"));
    const error = await assertRejects(() => s.claim(prepared.effectId));
    assert(!(error instanceof StandardError));
    const row = await s.row(prepared.effectId);
    assertEquals(row?.status, "prepared");
    assertEquals(row?.dispatchGeneration, 0);
    s.rig.port.load = original;
    assertEquals((await s.claim(prepared.effectId)).outcome, "claimed");
  }));

Deno.test("a transient StandardError loading authority is not a denial: the claim rolls back and the effect stays prepared", () =>
  withWorkerFixture(async (fixture) => {
    const s = await stage(fixture, "claim-transient-standard");
    const prepared = await s.prepare();
    const original = s.rig.port.load;
    for (const transient of ["INTERNAL", "SERVICE_UNAVAILABLE", "TIMEOUT"]) {
      s.rig.port.load = () =>
        Promise.reject(
          new StandardError({ code: transient as StandardError["code"] }),
        );
      const error = await code(s.claim(prepared.effectId));
      assertEquals(error.code, transient);
      const row = await s.row(prepared.effectId);
      assertEquals(row?.status, "prepared", transient);
      assertEquals(row?.failureCode, null, transient);
      assertEquals(row?.dispatchGeneration, 0, transient);
    }
    s.rig.port.load = original;
    assertEquals((await s.claim(prepared.effectId)).outcome, "claimed");
  }));

Deno.test("SYNTHETIC: a revoked grant blocks the claim before an unconsumed approval is spent", () =>
  withWorkerFixture(async (fixture) => {
    const s = await stage(fixture, "approval-after-authority");
    const approval = await seedPlanApproval(s.db, s.run);
    const prepared = await s.prepare({
      approval: {
        id: approval.approvalId,
        stage: approval.stage,
        policyDigest: approval.policyDigest,
      },
    });
    s.rig.snapshot.current = { ...s.rig.snapshot.current, grants: [] };
    const claim = await s.claim(prepared.effectId);
    assertEquals(claim.outcome, "blocked");
    const row = await s.row(prepared.effectId);
    assertEquals(row?.status, "failed");
    assertEquals(row?.failureCode, "authorization_denied");
    const question = await s.db.query(
      `select status, consumed_at from bakery.questions where id = $1`,
      [approval.approvalId],
    );
    assertEquals(question.rows[0].status, "answered");
    assertEquals(question.rows[0].consumed_at, null);
    const events = (await s.db.query(
      `select count(*)::int as n from bakery.domain_events
        where event_type = 'approval.consumed' and aggregate_id = $1`,
      [approval.approvalId],
    )).rows[0].n;
    const audits = (await s.db.query(
      `select count(*)::int as n from bakery.audit_events
        where operation = 'approvals.consume' and resource_id = $1`,
      [approval.approvalId],
    )).rows[0].n;
    assertEquals({ events, audits }, { events: 0, audits: 0 });
  }));

Deno.test("prepare refuses a non-UUID automation definition id before touching the database", () =>
  withWorkerFixture(async (fixture) => {
    const s = await stage(fixture, "prepare-automation-id");
    s.rig.snapshot.current = {
      ...s.rig.snapshot.current,
      actor: {
        ...s.rig.snapshot.current.actor,
        automationDefinitionId: "not-a-uuid",
      },
    };
    const error = await code(s.prepare());
    assertEquals(error.code, "UNPROCESSABLE");
    assertEquals(error.params?.reason, "integration_ids_must_be_uuids");
  }));

// ---- the production role (bakery_app): column grants and row-lock privileges ----

Deno.test("runtime role: prepare, claim and dispatch confirm a comment", () =>
  withWorkerFixture(async (fixture) => {
    const d = await dispatchStage(
      fixture,
      "runtime-happy",
      {},
      fixture.runtimePgDatabase,
    );
    const result = await d.run();
    assertEquals(result.outcome, "confirmed");
    assertEquals(result.dispatched, true);
    assertEquals(result.effect.dispatchGeneration, 1);
    assertEquals(d.github.posts(), 1);
    assertEquals(await d.reservation(), "held");
  }));

Deno.test("runtime role: a blocked claim fails the effect without a send", () =>
  withWorkerFixture(async (fixture) => {
    const s = await stage(
      fixture,
      "runtime-blocked",
      fixture.runtimePgDatabase,
    );
    const prepared = await s.prepare();
    s.rig.snapshot.current = { ...s.rig.snapshot.current, grants: [] };
    const claim = await s.claim(prepared.effectId);
    assertEquals(claim.outcome, "blocked");
    const row = await s.row(prepared.effectId);
    assertEquals(row?.status, "failed");
    assertEquals(row?.failureCode, "authorization_denied");
  }));

Deno.test("runtime role: SYNTHETIC approval consume at claim, then reuse by generation 2", () =>
  withWorkerFixture(async (fixture) => {
    const s = await stage(
      fixture,
      "runtime-approval",
      fixture.runtimePgDatabase,
    );
    const approval = await seedPlanApproval(s.db, s.run);
    const prepared = await s.prepare({
      approval: {
        id: approval.approvalId,
        stage: approval.stage,
        policyDigest: approval.policyDigest,
      },
    });
    assertEquals((await s.claim(prepared.effectId)).outcome, "claimed");
    const consumed = await s.db.query(
      `select status, consumed_by_run_id from bakery.questions where id = $1`,
      [approval.approvalId],
    );
    assertEquals(consumed.rows[0].status, "consumed");
    assertEquals(consumed.rows[0].consumed_by_run_id, s.run.runId);
  }));

Deno.test("runtime role: an uncertain write is reconciled read-only and confirmed", () =>
  withWorkerFixture(async (fixture) => {
    const d = await dispatchStage(
      fixture,
      "runtime-reconcile",
      {},
      fixture.runtimePgDatabase,
    );
    d.github.post = "stored_then_500";
    assertEquals((await d.run()).outcome, "uncertain");
    const second = await d.run();
    assertEquals(second.outcome, "confirmed");
    assertEquals(second.effect.remoteId, String(d.github.comments[0]!.id));
    assertEquals(d.github.posts(), 1);
  }));

// ---- dispatch, outcomes and reconciliation (phase 3c) ----

const REQ = { requestId: "request-run", traceId: "trace-run" };

/** Staged run plus an executor over the fake GitHub; `run` drives one effect. */
async function dispatchStage(
  fixture: WorkerFixture,
  key: string,
  options: Parameters<typeof executorFor>[3] = {},
  ops: PgDatabase = fixture.pgDatabase,
) {
  const s = await stage(fixture, key, ops);
  const github = fakeGithub();
  const executor = executorFor(ops, s.rig, github, options);
  const prepared = await s.prepare();
  return {
    s,
    github,
    executor,
    effectId: prepared.effectId,
    run: () =>
      executor.runEffect({
        organizationId: s.organizationId,
        effectId: prepared.effectId,
        ...REQ,
      }),
    reservation: async () =>
      (await s.db.query(
        `select status from bakery.budget_reservations where id = $1`,
        [s.run.runReservationId],
      )).rows[0].status as string,
  };
}

Deno.test("executor: prepare, claim, POST and confirm a comment", () =>
  withWorkerFixture(async (fixture) => {
    const d = await dispatchStage(fixture, "exec-happy");
    const result = await d.run();
    assertEquals(result.outcome, "confirmed");
    assertEquals(result.dispatched, true);
    const row = result.effect;
    assertEquals(row.status, "confirmed");
    assertEquals(row.dispatchGeneration, 1);
    assertEquals(row.leaseExpiresAt, null);
    assertEquals(row.remoteId, String(d.github.comments[0]!.id));
    assertEquals(row.safeResult, { remoteId: row.remoteId });
    assertEquals(d.github.posts(), 1);
    assert(
      d.github.comments[0]!.body!.split("\n").includes(
        `<!-- bakery-effect:${d.effectId} -->`,
      ),
    );
    // The executor never releases or settles the reservation.
    assertEquals(await d.reservation(), "held");
    // A second run of a confirmed effect performs nothing.
    const again = await d.run();
    assertEquals(again.outcome, "confirmed");
    assertEquals(again.dispatched, false);
    assertEquals(d.github.posts(), 1);
  }));

Deno.test("executor: a 429 returns the effect to prepared, then a due retry is generation 2", () =>
  withWorkerFixture(async (fixture) => {
    const d = await dispatchStage(fixture, "exec-429");
    d.github.post = { status: 429, headers: { "retry-after": "30" } };
    const first = await d.run();
    assertEquals(first.outcome, "retry_scheduled");
    assertEquals(first.effect.status, "prepared");
    assertEquals(first.effect.dispatchGeneration, 1);
    assertEquals(first.effect.failureCode, null);
    assertEquals(first.effect.leaseExpiresAt, null);
    assert(first.effect.nextRetryAt !== null);
    assert(first.effect.nextRetryAt.getTime() > Date.now());
    assertEquals(d.github.posts(), 1);

    const notDue = await d.run();
    assertEquals(notDue.outcome, "retry_scheduled");
    assertEquals(notDue.dispatched, false);
    assertEquals(d.github.posts(), 1);

    await d.s.db.query(
      `update bakery.external_effects
          set next_retry_at = clock_timestamp() - interval '1 second'
        where id = $1`,
      [d.effectId],
    );
    d.github.post = "ok";
    const retried = await d.run();
    assertEquals(retried.outcome, "confirmed");
    assertEquals(retried.effect.dispatchGeneration, 2);
    assertEquals(d.github.posts(), 2);
    assertEquals(await d.reservation(), "held");
  }));

Deno.test("executor: retry exhaustion fails the effect", () =>
  withWorkerFixture(async (fixture) => {
    const d = await dispatchStage(fixture, "exec-exhaust", {
      maxDispatchGenerations: 1,
    });
    d.github.post = { status: 429, headers: { "retry-after": "1" } };
    const result = await d.run();
    assertEquals(result.outcome, "failed");
    assertEquals(result.effect.failureCode, "retry_exhausted");
    assertEquals(d.github.posts(), 1);
  }));

Deno.test("executor: a 422 is an authoritative refusal and fails the effect", () =>
  withWorkerFixture(async (fixture) => {
    const d = await dispatchStage(fixture, "exec-422");
    d.github.post = { status: 422 };
    const result = await d.run();
    assertEquals(result.outcome, "failed");
    assertEquals(result.effect.failureCode, "provider_rejected");
    assertEquals(result.effect.leaseExpiresAt, null);
    assertEquals(d.github.posts(), 1);
    const again = await d.run();
    assertEquals(again.outcome, "failed");
    assertEquals(d.github.posts(), 1);
  }));

Deno.test("executor: a timeout is uncertain and the next run only lists, then confirms", () =>
  withWorkerFixture(async (fixture) => {
    const d = await dispatchStage(fixture, "exec-timeout", { deadlineMs: 150 });
    d.github.post = "hang";
    const first = await d.run();
    assertEquals(first.outcome, "uncertain");
    assertEquals(first.effect.status, "uncertain");
    assertEquals(first.effect.leaseExpiresAt, null);
    assertEquals(d.github.posts(), 1);

    // The provider had accepted the write after all.
    d.github.comments.push({
      id: 9001,
      body: `hello\n\n<!-- bakery-effect:${d.effectId} -->`,
      user: { id: 4242, type: "Bot" },
    });
    const second = await d.run();
    assertEquals(second.outcome, "confirmed");
    assertEquals(second.dispatched, false);
    assertEquals(second.effect.remoteId, "9001");
    assertEquals(second.effect.reconciliationAttempts, 1);
    assert(second.effect.lastCheckedAt !== null);
    assertEquals(d.github.posts(), 1);
    assertEquals(d.github.lists(), 1);
    assertEquals(await d.reservation(), "held");
  }));

Deno.test("executor: a post-send 500 is uncertain and reconcile confirms by marker", () =>
  withWorkerFixture(async (fixture) => {
    const d = await dispatchStage(fixture, "exec-500");
    d.github.post = "stored_then_500";
    const first = await d.run();
    assertEquals(first.outcome, "uncertain");
    assertEquals(await d.reservation(), "held");
    const second = await d.run();
    assertEquals(second.outcome, "confirmed");
    assertEquals(second.effect.remoteId, String(d.github.comments[0]!.id));
    assertEquals(d.github.posts(), 1);
  }));

Deno.test("executor: an unparseable success is uncertain", () =>
  withWorkerFixture(async (fixture) => {
    const d = await dispatchStage(fixture, "exec-unparseable");
    d.github.post = "unparseable";
    const result = await d.run();
    assertEquals(result.outcome, "uncertain");
    assertEquals(d.github.posts(), 1);
  }));

Deno.test("executor: a malformed reconcile page keeps the effect uncertain and records evidence", () =>
  withWorkerFixture(async (fixture) => {
    const d = await dispatchStage(fixture, "exec-malformed");
    d.github.post = "stored_then_500";
    await d.run();
    d.github.list = "malformed";
    const checked = await d.run();
    assertEquals(checked.outcome, "uncertain");
    const row = checked.effect;
    assertEquals(row.status, "uncertain");
    assertEquals(row.reconciliationAttempts, 1);
    assert(row.lastCheckedAt !== null);
    assertEquals(row.leaseExpiresAt, null);
    const evidence = ReconciliationEvidenceSchema.parse(
      row.reconciliationEvidence,
    );
    assertEquals(evidence.outcome, "threw");
    assertEquals(evidence.attempt, 1);
    assertEquals(evidence.requestCount, 1);
    assert(
      new TextEncoder().encode(JSON.stringify(evidence)).length <=
        MAX_RECONCILIATION_EVIDENCE_BYTES,
    );
    assertEquals(d.github.posts(), 1);

    // A second check increments the attempt again and never posts.
    const again = await d.run();
    assertEquals(again.effect.reconciliationAttempts, 2);
    assertEquals(d.github.posts(), 1);
    assertEquals(await d.reservation(), "held");
  }));

Deno.test("executor: a live submitted lease is in flight and sends nothing", () =>
  withWorkerFixture(async (fixture) => {
    const d = await dispatchStage(fixture, "exec-inflight");
    const claim = await d.s.claim(d.effectId);
    assertEquals(claim.outcome, "claimed");
    const result = await d.run();
    assertEquals(result.outcome, "in_flight");
    assertEquals(result.dispatched, false);
    assertEquals(d.github.calls.length, 0);
    assertEquals(result.effect.dispatchGeneration, 1);
  }));

Deno.test("executor: an expired submitted lease is reconciled, never re-posted", () =>
  withWorkerFixture(async (fixture) => {
    const d = await dispatchStage(fixture, "exec-expired-lease");
    const claim = await d.s.claim(d.effectId);
    assertEquals(claim.outcome, "claimed");
    await d.s.db.query(
      `update bakery.external_effects
          set lease_expires_at = clock_timestamp() - interval '1 second'
        where id = $1`,
      [d.effectId],
    );
    const result = await d.run();
    assertEquals(result.outcome, "uncertain");
    assertEquals(result.effect.dispatchGeneration, 1);
    assertEquals(d.github.posts(), 0);
    assertEquals(d.github.lists(), 1);
  }));

Deno.test("executor: entry points refuse another organization", () =>
  withWorkerFixture(async (fixture) => {
    const d = await dispatchStage(fixture, "exec-cross-org");
    const stranger = crypto.randomUUID();
    const error = await code(d.executor.runEffect({
      organizationId: stranger,
      effectId: d.effectId,
      ...REQ,
    }));
    assertEquals(error.code, "RESOURCE_NOT_FOUND");
    const reconcile = await code(d.executor.reconcileEffect({
      organizationId: stranger,
      effectId: d.effectId,
    }));
    assertEquals(reconcile.code, "RESOURCE_NOT_FOUND");
    const outcome = await code(recordOutcome({ database: fixture.pgDatabase }, {
      organizationId: stranger,
      effectId: d.effectId,
      dispatchGeneration: 1,
      outcome: { kind: "uncertain" },
    }));
    assertEquals(outcome.code, "RESOURCE_NOT_FOUND");
    assertEquals(d.github.calls.length, 0);
  }));

Deno.test("executor: a lost fence writes nothing", () =>
  withWorkerFixture(async (fixture) => {
    const d = await dispatchStage(fixture, "exec-fence");
    const claim = await d.s.claim(d.effectId);
    assertEquals(claim.outcome, "claimed");
    const stale = await recordOutcome({ database: fixture.pgDatabase }, {
      organizationId: d.s.organizationId,
      effectId: d.effectId,
      dispatchGeneration: 7,
      outcome: { kind: "failed", failureCode: "provider_rejected" },
    });
    assertEquals(stale.applied, false);
    assertEquals(stale.effect.status, "submitted");
    const real = await recordOutcome({ database: fixture.pgDatabase }, {
      organizationId: d.s.organizationId,
      effectId: d.effectId,
      dispatchGeneration: 1,
      outcome: { kind: "uncertain" },
    });
    assertEquals(real.applied, true);
    assertEquals(real.effect.status, "uncertain");
    // A second write at the same generation loses the fence: no longer submitted.
    const late = await recordOutcome({ database: fixture.pgDatabase }, {
      organizationId: d.s.organizationId,
      effectId: d.effectId,
      dispatchGeneration: 1,
      outcome: { kind: "failed", failureCode: "provider_rejected" },
    });
    assertEquals(late.applied, false);
    assertEquals(late.effect.status, "uncertain");
    // A late confirmed may land on uncertain with the same generation.
    const confirmed = await recordOutcome({ database: fixture.pgDatabase }, {
      organizationId: d.s.organizationId,
      effectId: d.effectId,
      dispatchGeneration: 1,
      outcome: { kind: "confirmed", remoteId: "77", safeResult: { a: 1 } },
    });
    assertEquals(confirmed.applied, true);
    assertEquals(confirmed.effect.remoteId, "77");
  }));

async function reservationStatuses(
  db: PgDatabase,
  ids: readonly string[],
): Promise<string[]> {
  const result = await db.query<{ status: string }>(
    `select status from bakery.budget_reservations
      where id = any($1::uuid[]) order by id`,
    [[...ids].sort()],
  );
  return result.rows.map((row) => row.status);
}

async function recoveryFailures(
  db: PgDatabase,
  organizationId: string,
): Promise<number> {
  const result = await db.query<{ n: number }>(
    `select count(*)::int as n from bakery.budget_reconciliation_failures
      where organization_id = $1`,
    [organizationId],
  );
  return result.rows[0].n;
}

async function expireReservations(
  db: PgDatabase,
  ids: readonly string[],
): Promise<void> {
  await db.query(
    `update bakery.budget_reservations
        set expires_at = clock_timestamp() - interval '1 second'
      where id = any($1::uuid[])`,
    [ids],
  );
}

for (
  const which of ["runReservationId", "installationReservationId"] as const
) {
  Deno.test(`a live effect on the ${which} keeps both reservations held through recovery`, () =>
    withWorkerFixture(async (fixture) => {
      const s = await stage(fixture, `hold-${which}`);
      const ids = [s.run.installationReservationId, s.run.runReservationId];
      const prepared = await s.prepare({ budgetReservationId: s.run[which] });
      const claim = await s.claim(prepared.effectId);
      assertEquals(claim.outcome, "claimed");
      const evidenceId = await persistReleaseEvidence(s.db, s.run);
      await expireReservations(s.db, ids);

      // Direct release is refused while the effect is live.
      const refused = await code(withPgTransaction(
        s.db,
        (tx) =>
          releaseWorkflowAction(tx, {
            organizationId: fixture.organizationId,
            installationReservationId: s.run.installationReservationId,
            evidenceId,
          }),
      ));
      assertEquals(refused.code, "STATE_CONFLICT");
      assertEquals(refused.params?.reason, "external_effect_in_flight");

      for (const status of ["submitted", "uncertain"] as const) {
        await forceEffectStatus(
          s.db,
          fixture.organizationId,
          prepared.effectId,
          status,
        );
        const result = await reconcileBudgetLedger(s.db);
        assertEquals(result.releases, 0, status);
        assertEquals(await recoveryFailures(s.db, fixture.organizationId), 0);
        assertEquals(await reservationStatuses(s.db, ids), ["held", "held"]);
      }

      await forceEffectStatus(
        s.db,
        fixture.organizationId,
        prepared.effectId,
        "failed",
      );
      const released = await reconcileBudgetLedger(s.db);
      assertEquals(released.releases, 1);
      assertEquals(await reservationStatuses(s.db, ids), [
        "released",
        "released",
      ]);
      assertEquals(await recoveryFailures(s.db, fixture.organizationId), 0);
    }));
}

Deno.test("a prepared effect on an expired reservation does not pin it", () =>
  withWorkerFixture(async (fixture) => {
    const s = await stage(fixture, "hold-prepared-expired");
    const ids = [s.run.installationReservationId, s.run.runReservationId];
    const prepared = await s.prepare();
    await persistReleaseEvidence(s.db, s.run);
    await expireReservations(s.db, ids);
    const result = await reconcileBudgetLedger(s.db);
    assertEquals(result.releases, 1);
    assertEquals(await reservationStatuses(s.db, ids), [
      "released",
      "released",
    ]);
    assertEquals(await recoveryFailures(s.db, fixture.organizationId), 0);
    const claim = await s.claim(prepared.effectId);
    assertEquals(claim.outcome, "blocked");
    const row = await s.row(prepared.effectId);
    assertEquals(row?.status, "failed");
    // A release needs failed-job evidence, so the claim fails on the job,
    // ahead of the released reservation. Nothing is sent either way.
    assertEquals(row?.failureCode, "job_terminal");
    assertEquals(await reservationStatuses(s.db, ids), [
      "released",
      "released",
    ]);
  }));
