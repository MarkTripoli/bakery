import { assert, assertEquals, assertRejects } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import { readTestDatabaseConfig } from "../../packages/config/src/env.ts";
import {
  closePgDatabase,
  openPgDatabase,
  type PgDatabase,
  withPgTransaction,
} from "../../apps/server/src/platform/database.ts";
import { claimEffect } from "../../apps/server/src/modules/effects/claim.ts";
import {
  type EffectExecutor,
  prepareEffect,
  ReconciliationEvidenceSchema,
} from "../../apps/server/src/modules/effects/index.ts";
import { recordOutcome } from "../../apps/server/src/modules/effects/dispatch.ts";
import { findEffectById } from "../../apps/server/src/modules/effects/repository.ts";
import type { ExternalEffectRow } from "../../apps/server/src/modules/effects/index.ts";
import {
  cancelRunWithoutAttempt,
  enqueueWorkerControlCommand,
} from "../../apps/server/src/modules/execution/coordination.ts";
import type { AuthoritySnapshot } from "../../apps/server/src/modules/catalog/integration-gate.ts";
import {
  adminRequest,
  registeredWorker,
  type WorkerFixture,
} from "../helpers/worker-execution.ts";
import {
  claimAssignment,
  withWorkerFixture,
} from "../helpers/worker-execution/scenarios.ts";
import {
  claimDepsFor,
  effectRegistry,
  type EffectRig,
  effectRig,
  executorFor,
  type FakeGithub,
  fakeGithub,
  GITHUB_ACTION,
  GITHUB_ARGS,
  GITHUB_BINDING,
  seededEffectRig,
  seedPlanApproval,
  stageEffectRun,
} from "../helpers/external-effects.ts";
import { assertNoDeadlock, holdRow, raceClaim } from "../helpers/lock-race.ts";

const REQ = { requestId: "security-request", traceId: "security-trace" };

async function code(promise: Promise<unknown>): Promise<StandardError> {
  const error = await assertRejects(() => promise);
  assert(error instanceof StandardError, `unexpected ${String(error)}`);
  return error;
}

type Staged = Awaited<ReturnType<typeof stageEffectRun>>;

function rowOf(
  db: PgDatabase,
  organizationId: string,
  effectId: string,
): Promise<ExternalEffectRow> {
  return withPgTransaction(
    db,
    (tx) => findEffectById(tx, organizationId, effectId),
  ).then((row) => {
    assert(row, "effect row exists");
    return row;
  });
}

function claimOf(
  db: PgDatabase,
  rig: EffectRig,
  organizationId: string,
  effectId: string,
) {
  return claimEffect(claimDepsFor(db, rig), {
    organizationId,
    effectId,
    ...REQ,
  });
}

async function expireLease(db: PgDatabase, effectId: string): Promise<void> {
  await db.query(
    `update bakery.external_effects
        set lease_expires_at = clock_timestamp() - interval '1 second'
      where id = $1`,
    [effectId],
  );
}

function run(
  executor: EffectExecutor,
  organizationId: string,
  effectId: string,
) {
  return executor.runEffect({ organizationId, effectId, ...REQ });
}

/** A rig-less effect (no run step): authority and provider checks only. */
async function bareEffect(
  fixture: WorkerFixture,
  rig: EffectRig,
  key: string,
  args: Record<string, unknown> = { ...GITHUB_ARGS },
): Promise<string> {
  const prepared = await prepareEffect({
    database: fixture.pgDatabase,
    registry: effectRegistry,
    snapshots: rig.port,
  }, {
    organizationId: fixture.organizationId,
    envelope: rig.envelope,
    input: rig.input(args),
    idempotencyKey: key,
  });
  return prepared.effectId;
}

function revoked(snapshot: AuthoritySnapshot): AuthoritySnapshot {
  return { ...snapshot, grants: [] };
}

// 1. Revocation ---------------------------------------------------------------

Deno.test("revocation before the claim abandons the effect with no request", () =>
  withWorkerFixture(async (fixture) => {
    const rig = await seededEffectRig(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const github = fakeGithub();
    const executor = executorFor(fixture.pgDatabase, rig, github);
    const effectId = await bareEffect(fixture, rig, "revoke-before");
    rig.snapshot.current = revoked(rig.snapshot.current);

    const result = await run(executor, fixture.organizationId, effectId);
    assertEquals(result.outcome, "failed");
    assertEquals(result.effect.failureCode, "authorization_denied");
    assertEquals(result.effect.dispatchGeneration, 0);
    assertEquals(github.calls.length, 0);
  }));

Deno.test("revocation after the claim commits is never a second write and reconcile is denied before any send", () =>
  withWorkerFixture(async (fixture) => {
    const rig = await seededEffectRig(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const github = fakeGithub();
    const executor = executorFor(fixture.pgDatabase, rig, github);
    const effectId = await bareEffect(fixture, rig, "revoke-after");
    const claim = await claimOf(
      fixture.pgDatabase,
      rig,
      fixture.organizationId,
      effectId,
    );
    assertEquals(claim.outcome, "claimed");
    rig.snapshot.current = revoked(rig.snapshot.current);
    await expireLease(fixture.pgDatabase, effectId);

    for (let i = 0; i < 3; i++) {
      const result = await run(executor, fixture.organizationId, effectId);
      assertEquals(result.outcome, "uncertain");
      assertEquals(result.dispatched, false);
      assertEquals(result.effect.dispatchGeneration, 1);
    }
    assertEquals(github.calls.length, 0);
    const evidence = ReconciliationEvidenceSchema.parse(
      (await rowOf(fixture.pgDatabase, fixture.organizationId, effectId))
        .reconciliationEvidence,
    );
    assertEquals(evidence.outcome, "denied");
  }));

Deno.test("reconcile: a grant revoked between the executor's admission and the broker's own re-check sends nothing", () =>
  withWorkerFixture(async (fixture) => {
    const rig = await seededEffectRig(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const github = fakeGithub();
    const effectId = await bareEffect(fixture, rig, "revoke-mid");
    const claim = await claimOf(
      fixture.pgDatabase,
      rig,
      fixture.organizationId,
      effectId,
    );
    assertEquals(claim.outcome, "claimed");
    await expireLease(fixture.pgDatabase, effectId);

    // The executor's admission passes (first load); the broker re-loads the
    // authority before the request and finds the grant gone.
    const live = rig.snapshot.current;
    let loads = 0;
    const flipping: EffectRig = {
      ...rig,
      port: Object.assign({
        load: () => {
          loads++;
          return Promise.resolve(loads === 1 ? live : revoked(live));
        },
      }, { loads: 0 }),
    };
    const executor = executorFor(fixture.pgDatabase, flipping, github);
    const result = await run(executor, fixture.organizationId, effectId);
    assert(loads >= 2, "the broker re-checked authority");
    assertEquals(result.outcome, "uncertain");
    assertEquals(github.calls.length, 0);
  }));

Deno.test("dispatch: a grant revoked between the executor's admission and the broker's pre-send re-check fails the effect with zero POST", () =>
  withWorkerFixture(async (fixture) => {
    const rig = await seededEffectRig(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const github = fakeGithub();
    const effectId = await bareEffect(fixture, rig, "revoke-mid-dispatch");

    // The claim's admission passes (first load); the broker re-loads the
    // authority before the request and finds the grant gone.
    const live = rig.snapshot.current;
    let loads = 0;
    const flipping: EffectRig = {
      ...rig,
      port: Object.assign({
        load: () => {
          loads++;
          return Promise.resolve(loads === 1 ? live : revoked(live));
        },
      }, { loads: 0 }),
    };
    const executor = executorFor(fixture.pgDatabase, flipping, github);
    const result = await run(executor, fixture.organizationId, effectId);
    assert(loads >= 2, "the broker re-checked authority");
    assertEquals(result.dispatched, true);
    assertEquals(result.outcome, "failed");
    assertEquals(result.effect.failureCode, "provider_not_sent");
    assertEquals(result.effect.dispatchGeneration, 1);
    assertEquals(github.posts(), 0);
    assertEquals(github.calls.length, 0);
  }));

// 2. Run cancellation races ---------------------------------------------------

const CANCEL_ORDERS = ["cancel-first", "claim-first"] as const;

async function withSide<T>(work: (side: PgDatabase) => Promise<T>): Promise<T> {
  const side = openPgDatabase(readTestDatabaseConfig().databaseUrl, 6);
  try {
    return await work(side);
  } finally {
    await closePgDatabase(side);
  }
}

/** After a claim that won the race: the effect is reconcilable and is never written again. */
async function assertOnlyReconcilable(
  staged: Staged,
  organizationId: string,
): Promise<void> {
  const github = fakeGithub();
  const executor = executorFor(staged.db, staged.rig, github);
  await expireLease(staged.db, staged.effectId);
  for (let i = 0; i < 3; i++) {
    const result = await run(executor, organizationId, staged.effectId);
    assertEquals(result.outcome, "uncertain");
    assertEquals(result.dispatched, false);
  }
  assertEquals(github.posts(), 0);
  assert(github.lists() >= 1);
}

for (const order of CANCEL_ORDERS) {
  Deno.test(`live-attempt cancel (${order}): the claim and the cancel never deadlock and agree on one outcome`, () =>
    withWorkerFixture((fixture) =>
      withSide(async (side) => {
        const worker = await registeredWorker(fixture, {
          name: `effect-cancel-live-${order}`,
          slots: 4,
        });
        const staged = await stageEffectRun(fixture, `cancel-live-${order}`);
        const assignment = await claimAssignment(fixture, worker);
        assertEquals(assignment.jobId, staged.run.jobId);

        const claim = () =>
          claimOf(side, staged.rig, fixture.organizationId, staged.effectId);
        const cancel = () =>
          withPgTransaction(side, (tx) =>
            enqueueWorkerControlCommand(tx, {
              organizationId: fixture.organizationId,
              attemptId: assignment.attemptId,
              action: "cancel",
              idempotencyKey: `cancel-${order}`,
              requestDigest: `digest-${order}`,
              traceId: crypto.randomUUID(),
            }));
        const hold = await holdRow(
          side,
          `select id from bakery.jobs where id = $1 for update`,
          [staged.run.jobId],
        );
        const [claimOutcome, cancelOutcome] = await raceClaim(
          side,
          hold,
          order === "claim-first" ? "claim-first" : "other-first",
          claim,
          cancel,
        );
        assertNoDeadlock(claimOutcome);
        assertNoDeadlock(cancelOutcome);
        if (claimOutcome.status === "rejected") throw claimOutcome.reason;

        const row = await rowOf(
          staged.db,
          fixture.organizationId,
          staged.effectId,
        );
        if (order === "cancel-first") {
          assert(cancelOutcome.status === "fulfilled", "the cancel applied");
          assertEquals(claimOutcome.value.outcome, "blocked");
          assertEquals(row.status, "failed");
          // The live-attempt cancel ends the whole run, and a terminal run is
          // the first admission check (the job_canceled check is covered in
          // the integration lane).
          assertEquals(row.failureCode, "run_terminal");
          assertEquals(row.dispatchGeneration, 0);
          const github = fakeGithub();
          const executor = executorFor(staged.db, staged.rig, github);
          assertEquals(
            (await run(executor, fixture.organizationId, staged.effectId))
              .outcome,
            "failed",
          );
          assertEquals(github.calls.length, 0);
        } else {
          // The claim held the job lock first: the cancel waited, then applied.
          assertEquals(claimOutcome.value.outcome, "claimed");
          assert(cancelOutcome.status === "fulfilled", "the cancel applied");
          assertEquals(row.status, "submitted");
          assertEquals(row.dispatchGeneration, 1);
          const job = await staged.db.query(
            `select status from bakery.jobs where id = $1`,
            [staged.run.jobId],
          );
          assertEquals(job.rows[0].status, "canceled");
          await assertOnlyReconcilable(staged, fixture.organizationId);
        }
      })
    ));
}

for (const order of CANCEL_ORDERS) {
  Deno.test(`queued-run cancel (${order}): the direct cancel and the claim never deadlock`, () =>
    withWorkerFixture((fixture) =>
      withSide(async (side) => {
        const staged = await stageEffectRun(fixture, `cancel-queued-${order}`);
        const claim = () =>
          claimOf(side, staged.rig, fixture.organizationId, staged.effectId);
        const cancel = () =>
          withPgTransaction(side, (tx) =>
            cancelRunWithoutAttempt(tx, {
              organizationId: fixture.organizationId,
              runId: staged.run.runId,
              traceId: crypto.randomUUID(),
            }));
        const hold = await holdRow(
          side,
          `select id from bakery.jobs where id = $1 for update`,
          [staged.run.jobId],
        );
        const [claimOutcome, cancelOutcome] = await raceClaim(
          side,
          hold,
          order === "claim-first" ? "claim-first" : "other-first",
          claim,
          cancel,
        );
        assertNoDeadlock(claimOutcome);
        assertNoDeadlock(cancelOutcome);
        if (claimOutcome.status === "rejected") throw claimOutcome.reason;
        const row = await rowOf(
          staged.db,
          fixture.organizationId,
          staged.effectId,
        );
        if (order === "cancel-first") {
          assert(cancelOutcome.status === "fulfilled", "the cancel applied");
          assertEquals(claimOutcome.value.outcome, "blocked");
          assertEquals(row.status, "failed");
          assertEquals(row.failureCode, "run_terminal");
          const github = fakeGithub();
          const executor = executorFor(staged.db, staged.rig, github);
          await run(executor, fixture.organizationId, staged.effectId);
          assertEquals(github.calls.length, 0);
        } else {
          assertEquals(claimOutcome.value.outcome, "claimed");
          assertEquals(row.status, "submitted");
          assertEquals(row.dispatchGeneration, 1);
          // The claim held the job lock first; the cancel waited, then
          // applied: the run and job end canceled while the claimed write is
          // still pinned as submitted.
          assert(cancelOutcome.status === "fulfilled", "the cancel applied");
          const ended = await staged.db.query(
            `select (select status from bakery.workflow_runs where id = $1) as run,
                    (select status from bakery.jobs where id = $2) as job`,
            [staged.run.runId, staged.run.jobId],
          );
          assertEquals(ended.rows[0], { run: "canceled", job: "canceled" });
          // The canceled run never dispatches again: the claimed write is only reconciled.
          await assertOnlyReconcilable(staged, fixture.organizationId);
        }
      })
    ));
}

// 3. Approvals ----------------------------------------------------------------

Deno.test("an approval superseded by a newer plan revision is stale and nothing is sent", () =>
  withWorkerFixture(async (fixture) => {
    const staged = await stageEffectRun(fixture, "approval-stale");
    const approval = await seedPlanApproval(staged.db, staged.run, {
      consumed: true,
    });
    const prepared = await staged.prepare({
      approval: {
        id: approval.approvalId,
        stage: approval.stage,
        policyDigest: approval.policyDigest,
      },
    });
    await seedPlanApproval(staged.db, staged.run, { revision: 2 });
    const github = fakeGithub();
    const executor = executorFor(staged.db, staged.rig, github);
    const result = await run(
      executor,
      fixture.organizationId,
      prepared.effectId,
    );
    assertEquals(result.outcome, "failed");
    assertEquals(result.effect.failureCode, "approval_stale");
    assertEquals(github.calls.length, 0);
  }));

for (const order of ["revoke-first", "claim-first"] as const) {
  Deno.test(`SYNTHETIC approval revoke race (${order}): exactly one of revoke and consume wins`, () =>
    withWorkerFixture((fixture) =>
      withSide(async (side) => {
        const staged = await stageEffectRun(fixture, `approval-race-${order}`);
        const approval = await seedPlanApproval(staged.db, staged.run);
        const prepared = await staged.prepare({
          approval: {
            id: approval.approvalId,
            stage: approval.stage,
            policyDigest: approval.policyDigest,
          },
        });
        const claim = () =>
          claimOf(side, staged.rig, fixture.organizationId, prepared.effectId);
        const revoke = () =>
          adminRequest(
            fixture,
            `/v1/approvals/${approval.approvalId}/revoke`,
            {},
            { idempotencyKey: `revoke-${order}` },
          );
        const hold = await holdRow(
          side,
          `select id from bakery.questions where id = $1 for update`,
          [approval.approvalId],
        );
        const [claimOutcome, revokeOutcome] = await raceClaim(
          side,
          hold,
          order === "claim-first" ? "claim-first" : "other-first",
          claim,
          revoke,
        );
        assertNoDeadlock(claimOutcome);
        assertNoDeadlock(revokeOutcome);
        if (claimOutcome.status === "rejected") throw claimOutcome.reason;
        if (revokeOutcome.status === "rejected") throw revokeOutcome.reason;
        const response = revokeOutcome.value;
        const body = await response.text();
        const question = await staged.db.query(
          `select status from bakery.questions where id = $1`,
          [approval.approvalId],
        );
        const row = await rowOf(
          staged.db,
          fixture.organizationId,
          prepared.effectId,
        );
        if (order === "revoke-first") {
          assertEquals(response.status, 200, body);
          assertEquals(question.rows[0].status, "revoked");
          assertEquals(claimOutcome.value.outcome, "blocked");
          assertEquals(row.status, "failed");
          assertEquals(row.failureCode, "approval_unavailable");
        } else {
          assertEquals(claimOutcome.value.outcome, "claimed");
          assertEquals(response.status, 409, body);
          assert(body.includes("approval_consumed"), body);
          assertEquals(question.rows[0].status, "consumed");
          assertEquals(row.status, "submitted");
        }
      })
    ));
}

// 4. Adversarial reconciliation pages -----------------------------------------

type Item = {
  id: number;
  body: string | null;
  user: { id: number; type: string } | null;
};
const markerOf = (effectId: string) => `<!-- bakery-effect:${effectId} -->`;
const bot = GITHUB_BINDING.botUserId;
const filler = (n: number): Item[] =>
  Array.from({ length: n }, (_, i) => ({
    id: 100 + i,
    body: "unrelated",
    user: { id: 1, type: "User" },
  }));

type PageCase = {
  name: string;
  pages: (effectId: string) => Item[][];
  expected: "uncertain" | "confirmed";
};

const pageCases: PageCase[] = [
  {
    name: "a human copied the marker",
    pages: (id) => [[{
      id: 1,
      body: `quoted\n${markerOf(id)}`,
      user: { id: bot, type: "User" },
    }]],
    expected: "uncertain",
  },
  {
    name: "another bot carries the marker",
    pages: (id) => [[{
      id: 1,
      body: markerOf(id),
      user: { id: bot + 1, type: "Bot" },
    }]],
    expected: "uncertain",
  },
  {
    name: "null body and null author",
    pages: () => [[
      { id: 1, body: null, user: { id: bot, type: "Bot" } },
      { id: 2, body: "x", user: null },
    ]],
    expected: "uncertain",
  },
  {
    name: "two bot comments match",
    pages: (id) => [[
      { id: 1, body: markerOf(id), user: { id: bot, type: "Bot" } },
      { id: 2, body: `again\n${markerOf(id)}`, user: { id: bot, type: "Bot" } },
    ]],
    expected: "uncertain",
  },
  {
    name: "twenty full pages hide a match on page twenty-one",
    pages: (id) => [
      ...Array.from({ length: 20 }, () => filler(100)),
      [{ id: 9, body: markerOf(id), user: { id: bot, type: "Bot" } }],
    ],
    expected: "uncertain",
  },
  {
    name: "the marker is absent",
    pages: () => [filler(3)],
    expected: "uncertain",
  },
  {
    name: "the marker was edited",
    pages: (id) => [[{
      id: 1,
      body: `${markerOf(id)} edited`,
      user: { id: bot, type: "Bot" },
    }, {
      id: 2,
      body: markerOf(crypto.randomUUID()),
      user: { id: bot, type: "Bot" },
    }]],
    expected: "uncertain",
  },
  {
    name: "control: exactly one genuine bot marker",
    pages: (id) => [[{
      id: 77,
      body: `text\n${markerOf(id)}`,
      user: { id: bot, type: "Bot" },
    }]],
    expected: "confirmed",
  },
];

for (const pageCase of pageCases) {
  Deno.test(`reconcile page adversary: ${pageCase.name}`, () =>
    withWorkerFixture(async (fixture) => {
      const rig = await seededEffectRig(
        fixture.pgDatabase,
        fixture.organizationId,
        fixture.principalId,
      );
      const github: FakeGithub = fakeGithub();
      const effectId = await bareEffect(fixture, rig, `pages-${pageCase.name}`);
      const pages = pageCase.pages(effectId);
      github.fetch = ((input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(
          typeof input === "string"
            ? input
            : input instanceof URL
            ? input.href
            : input.url,
        );
        github.calls.push({
          method: init?.method ?? "GET",
          path: url.pathname,
        });
        const page = Number(url.searchParams.get("page") ?? "1");
        return Promise.resolve(Response.json(pages[page - 1] ?? []));
      }) as typeof fetch;
      const executor = executorFor(fixture.pgDatabase, rig, github);
      const claim = await claimOf(
        fixture.pgDatabase,
        rig,
        fixture.organizationId,
        effectId,
      );
      assertEquals(claim.outcome, "claimed");
      await expireLease(fixture.pgDatabase, effectId);

      const first = await run(executor, fixture.organizationId, effectId);
      assertEquals(first.outcome, pageCase.expected);
      for (let i = 0; i < 2; i++) {
        assertEquals(
          (await run(executor, fixture.organizationId, effectId)).outcome,
          pageCase.expected,
        );
      }
      assertEquals(github.posts(), 0);
      assertEquals(first.effect.dispatchGeneration, 1);
    }));
}

// 5. Column grants and tenant isolation ---------------------------------------

Deno.test("the application role cannot rewrite an effect's identity or delete it", () =>
  withWorkerFixture(async (fixture) => {
    const rig = await seededEffectRig(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const effectId = await bareEffect(fixture, rig, "grants");
    const app = fixture.runtimePgDatabase;
    const identityColumns: [string, string][] = [
      ["id", "gen_random_uuid()"],
      ["organization_id", "gen_random_uuid()"],
      ["operation", "'other.action'"],
      ["target", "'integration-resource:x'"],
      ["idempotency_key", "'rewritten'"],
      ["request_digest", "'rewritten'"],
      ["safe_arguments", "'{}'::jsonb"],
      ["integration_resource_id", "gen_random_uuid()"],
      ["integration_connection_id", "gen_random_uuid()"],
      ["external_resource_id", "'9999'"],
      ["external_account_id", "'9999'"],
      ["adapter_manifest_digest", "'rewritten'"],
      ["requesting_principal_id", "gen_random_uuid()"],
      ["actor_ref", "'rewritten'"],
      ["budget_reservation_id", "gen_random_uuid()"],
      ["approval_id", "gen_random_uuid()"],
      ["created_at", "now()"],
    ];
    for (const [column, value] of identityColumns) {
      const error = await assertRejects(() =>
        app.query(
          `update bakery.external_effects set ${column} = ${value}
            where organization_id = $1 and id = $2`,
          [fixture.organizationId, effectId],
        )
      );
      assert(
        /permission denied/i.test(String(error)) ||
          /permission denied/i.test(String((error as Error).cause)),
        `${column}: ${String(error)}`,
      );
    }
    const deleteError = await assertRejects(() =>
      app.query(`delete from bakery.external_effects where id = $1`, [
        effectId,
      ])
    );
    assert(/permission denied/i.test(String(deleteError)), String(deleteError));
    // The outcome columns stay writable.
    await app.query(
      `update bakery.external_effects set failure_code = null, version = version
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, effectId],
    );
    const row = await rowOf(
      fixture.pgDatabase,
      fixture.organizationId,
      effectId,
    );
    assertEquals(row.operation, GITHUB_ACTION);
  }));

Deno.test("every executor entry point treats another organization's effect as not found", () =>
  withWorkerFixture(async (fixture) => {
    const rig = await seededEffectRig(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const github = fakeGithub();
    const executor = executorFor(fixture.pgDatabase, rig, github);
    const effectId = await bareEffect(fixture, rig, "cross-org");
    const stranger = crypto.randomUUID();
    const strangerRig = effectRig(stranger, fixture.principalId);
    const attempts: Record<string, () => Promise<unknown>> = {
      prepare: () =>
        prepareEffect({
          database: fixture.pgDatabase,
          registry: effectRegistry,
          snapshots: strangerRig.port,
        }, {
          organizationId: stranger,
          envelope: strangerRig.envelope,
          input: strangerRig.input(),
          idempotencyKey: "cross-org",
          runStepId: crypto.randomUUID(),
        }),
      claim: () => claimOf(fixture.pgDatabase, rig, stranger, effectId),
      reconcile: () =>
        executor.reconcileEffect({ organizationId: stranger, effectId }),
      run: () => run(executor, stranger, effectId),
      outcome: () =>
        recordOutcome({ database: fixture.pgDatabase }, {
          organizationId: stranger,
          effectId,
          dispatchGeneration: 1,
          outcome: { kind: "uncertain" },
        }),
    };
    for (const [name, attempt] of Object.entries(attempts)) {
      assertEquals((await code(attempt())).code, "RESOURCE_NOT_FOUND", name);
    }
    assertEquals(github.calls.length, 0);
    const row = await rowOf(
      fixture.pgDatabase,
      fixture.organizationId,
      effectId,
    );
    assertEquals(row.status, "prepared");
    assertEquals(row.dispatchGeneration, 0);
  }));

// 6. Marker injection and oversize arguments ----------------------------------

Deno.test("marker injection and oversize arguments are refused at prepare and write no row", () =>
  withWorkerFixture(async (fixture) => {
    const rig = await seededEffectRig(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const hostile = [
      `hi\n${markerOf(crypto.randomUUID())}`,
      "<!--bakery-effect:00000000-0000-4000-8000-000000000000-->",
      "<!--   BAKERY-EFFECT: forged -->",
      "x".repeat(16_001),
    ];
    for (const [index, body] of hostile.entries()) {
      const error = await code(
        prepareEffect({
          database: fixture.pgDatabase,
          registry: effectRegistry,
          snapshots: rig.port,
        }, {
          organizationId: fixture.organizationId,
          envelope: rig.envelope,
          input: rig.input({ issueNumber: 7, body }),
          idempotencyKey: `hostile-${index}`,
        }),
      );
      assert(
        error.code === "UNPROCESSABLE" || error.code === "VALIDATION_FAILED",
        `${index}: ${error.code}`,
      );
    }
    const rows = await fixture.pgDatabase.query(
      `select count(*)::int as n from bakery.external_effects
        where organization_id = $1`,
      [fixture.organizationId],
    );
    assertEquals(rows.rows[0].n, 0);
  }));

// 7. Identity drift -----------------------------------------------------------

Deno.test("a repository or installation swapped under the effect blocks the claim and the reconcile sends nothing", () =>
  withWorkerFixture(async (fixture) => {
    for (const drift of ["repositoryId", "installationId"] as const) {
      const rig = await seededEffectRig(
        fixture.pgDatabase,
        fixture.organizationId,
        fixture.principalId,
      );
      const github = fakeGithub();
      const executor = executorFor(fixture.pgDatabase, rig, github);
      const before = await bareEffect(fixture, rig, `drift-claim-${drift}`);
      const after = await bareEffect(fixture, rig, `drift-reconcile-${drift}`, {
        issueNumber: 8,
        body: "second",
      });
      const claimed = await claimOf(
        fixture.pgDatabase,
        rig,
        fixture.organizationId,
        after,
      );
      assertEquals(claimed.outcome, "claimed");
      await expireLease(fixture.pgDatabase, after);

      const current = rig.snapshot.current;
      rig.snapshot.current = {
        ...current,
        resource: {
          ...current.resource,
          binding: { ...current.resource.binding, [drift]: 424242 },
        },
      };

      const blocked = await run(executor, fixture.organizationId, before);
      assertEquals(blocked.outcome, "failed", drift);
      assertEquals(blocked.effect.failureCode, "resource_identity_changed");
      const checked = await run(executor, fixture.organizationId, after);
      assertEquals(checked.outcome, "uncertain", drift);
      assertEquals(
        ReconciliationEvidenceSchema.parse(
          checked.effect.reconciliationEvidence,
        )
          .outcome,
        "identity_drift",
      );
      assertEquals(github.calls.length, 0, drift);
    }
  }));

// 8. Reservation ownership ----------------------------------------------------

Deno.test("another run's or a run-less reservation never backs an effect", () =>
  withWorkerFixture(async (fixture) => {
    const mine = await stageEffectRun(fixture, "ownership-mine");
    const foreign = await stageEffectRun(fixture, "ownership-foreign");
    const github = fakeGithub();
    const executor = executorFor(mine.db, mine.rig, github);
    try {
      // Refused at prepare.
      const crossRun = await code(
        mine.prepare({ budgetReservationId: foreign.run.runReservationId }),
      );
      assertEquals(
        crossRun.params?.reason,
        "budget_reservation_scope_mismatch",
      );
      await mine.db.query(
        `update bakery.budget_reservations set run_step_id = null where id = $1`,
        [foreign.run.installationReservationId],
      );
      const runLess = await code(
        mine.prepare({
          budgetReservationId: foreign.run.installationReservationId,
        }),
      );
      assertEquals(runLess.params?.reason, "budget_reservation_scope_mismatch");

      // A forged link made after prepare is refused at claim.
      const forgedToForeign = await mine.prepare();
      await mine.db.query(
        `update bakery.external_effects set budget_reservation_id = $2
        where id = $1`,
        [forgedToForeign.effectId, foreign.run.runReservationId],
      );
      const forgedRunLess = await mine.prepare();
      await mine.db.query(
        `update bakery.budget_reservations set run_step_id = null where id = $1`,
        [mine.run.runReservationId],
      );
      for (
        const effectId of [forgedToForeign.effectId, forgedRunLess.effectId]
      ) {
        // The first effect still names the original step, so it is checked against the foreign step.
        const result = await run(executor, fixture.organizationId, effectId);
        assertEquals(result.outcome, "failed");
        assertEquals(
          result.effect.failureCode,
          "budget_reservation_scope_mismatch",
        );
      }
      assertEquals(github.calls.length, 0);
    } finally {
      // Put the forged links back so the fixture can delete its steps.
      await mine.db.query(
        `update bakery.budget_reservations set run_step_id = $2 where id = $1`,
        [mine.run.runReservationId, mine.run.runStepId],
      );
      await mine.db.query(
        `update bakery.budget_reservations set run_step_id = $2 where id = $1`,
        [foreign.run.installationReservationId, foreign.run.runStepId],
      );
    }
  }));
