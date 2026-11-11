import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  POSTGRES_UNIQUE_VIOLATION,
  postgresErrorCode,
} from "../../../apps/server/src/platform/postgres-errors.ts";
import { openChecksFixture } from "../deterministic-checks/checks-fixture.ts";
import { fingerprintOf } from "./fixtures.ts";
import {
  insertDeliveryDecision,
  insertReviewCycle,
  insertReviewFinding,
  seedReviewRun,
} from "./run-fixture.ts";

const PG_INSUFFICIENT_PRIVILEGE = "42501";
const PG_FOREIGN_KEY_VIOLATION = "23503";

type Columns = { required: string[]; optional: string[] };

const TABLES: Readonly<Record<string, Columns>> = {
  review_cycles: {
    required: [
      "id",
      "organization_id",
      "run_id",
      "run_step_id",
      "ordinal",
      "reviewer_session_id",
      "reviewer_principal_id",
      "implementer_session_id",
      "implementer_principal_id",
      "head_sha",
      "base_sha",
      "policy_digest",
      "status",
      "finding_count",
      "blocking_count",
      "created_at",
    ],
    optional: ["job_id", "attempt_id", "fence"],
  },
  review_findings: {
    required: [
      "id",
      "organization_id",
      "review_cycle_id",
      "fingerprint",
      "severity",
      "path",
      "body",
      "created_at",
    ],
    optional: ["line"],
  },
  delivery_decisions: {
    required: [
      "id",
      "organization_id",
      "run_id",
      "ordinal",
      "decision",
      "reason",
      "head_sha",
      "failed_checks",
      "blocking_fingerprints",
      "limits",
      "created_at",
    ],
    optional: ["review_cycle_id", "base_sha", "policy_digest"],
  },
};

const CONSTRAINTS: Readonly<Record<string, string[]>> = {
  review_cycles: [
    "review_cycles_implementer_session_fk",
    "review_cycles_organization_id_unique",
    "review_cycles_pkey",
    "review_cycles_reviewer_session_fk",
    "review_cycles_run_fk",
    "review_cycles_run_ordinal_unique",
  ],
  review_findings: [
    "review_findings_cycle_fingerprint_unique",
    "review_findings_cycle_fk",
    "review_findings_organization_id_unique",
    "review_findings_pkey",
  ],
  delivery_decisions: [
    "delivery_decisions_cycle_fk",
    "delivery_decisions_organization_id_unique",
    "delivery_decisions_pkey",
    "delivery_decisions_run_fk",
    "delivery_decisions_run_ordinal_unique",
  ],
};

/** Integration cases for migration 0147 against real Postgres. */
export function registerMigrationCases(): void {
  Deno.test("migration 0147 creates three insert-only evidence tables with named constraints", async () => {
    const checks = await openChecksFixture();
    try {
      for (const [table, columns] of Object.entries(TABLES)) {
        const found = await checks.owner.query<
          { column_name: string; is_nullable: string }
        >(
          `select column_name, is_nullable from information_schema.columns
            where table_schema = 'bakery' and table_name = $1
            order by ordinal_position`,
          [table],
        );
        const nullable = new Map(
          found.rows.map((
            row,
          ) => [row.column_name, row.is_nullable === "YES"]),
        );
        for (const required of columns.required) {
          assertEquals(
            nullable.get(required),
            false,
            `${table}.${required} is required`,
          );
        }
        for (const optional of columns.optional) {
          assertEquals(
            nullable.get(optional),
            true,
            `${table}.${optional} is optional`,
          );
        }
        assertEquals(
          nullable.size,
          columns.required.length + columns.optional.length,
          `${table} has no undeclared column`,
        );

        const constraints = await checks.owner.query<
          { conname: string; contype: string }
        >(
          `select conname, contype from pg_constraint
            where conrelid = $1::regclass and contype <> 'n'
            order by conname`,
          [`bakery.${table}`],
        );
        assertEquals(
          constraints.rows.map((row) => row.conname),
          CONSTRAINTS[table],
          table,
        );
        assertEquals(
          constraints.rows.filter((row) => row.contype === "c").length,
          0,
          `${table}: PostgreSQL holds structure only, no CHECK constraint`,
        );
        const triggers = await checks.owner.query(
          `select 1 from pg_trigger
            where tgrelid = $1::regclass and not tgisinternal`,
          [`bakery.${table}`],
        );
        assertEquals(triggers.rows.length, 0, `${table} has no trigger`);
        const policies = await checks.owner.query(
          "select 1 from pg_policies where schemaname = 'bakery' and tablename = $1",
          [table],
        );
        assertEquals(policies.rows.length, 0, `${table} has no policy`);

        const privileges = await checks.owner.query<Record<string, boolean>>(
          `select has_table_privilege('bakery_app', $1, 'select') as "select",
                  has_table_privilege('bakery_app', $1, 'insert') as "insert",
                  has_table_privilege('bakery_app', $1, 'update') as "update",
                  has_table_privilege('bakery_app', $1, 'delete') as "delete"`,
          [`bakery.${table}`],
        );
        assertEquals(privileges.rows[0], {
          select: true,
          insert: true,
          update: false,
          delete: false,
        }, table);
      }

      const partial = await checks.owner.query<{ indexdef: string }>(
        `select indexdef from pg_indexes
          where schemaname = 'bakery' and tablename = 'review_cycles'
            and indexname = 'review_cycles_job_fence_unique'`,
      );
      assertEquals(partial.rows.length, 1);
      assert(partial.rows[0].indexdef.includes("UNIQUE"));
      assert(partial.rows[0].indexdef.includes("job_id IS NOT NULL"));
    } finally {
      await checks.close();
    }
  });

  Deno.test("the application role records and reads evidence but cannot rewrite or remove it", async () => {
    const checks = await openChecksFixture();
    try {
      const scope = checks.scope();
      const run = await seedReviewRun(checks.owner, scope);
      const app = checks.fixture.appPg;
      const cycleId = await insertReviewCycle(app, {
        ...run,
        runStepId: run.reviewStepId,
        status: "changes_requested",
        findingCount: 1,
        blockingCount: 1,
      });
      const findingId = await insertReviewFinding(app, {
        organizationId: run.organizationId,
        reviewCycleId: cycleId,
      });
      const decisionId = await insertDeliveryDecision(app, {
        organizationId: run.organizationId,
        runId: run.runId,
        reviewCycleId: cycleId,
        decision: "repair",
        reason: "repair_selected",
        blockingFingerprints: [fingerprintOf(1)],
      });
      for (
        const [table, id] of [
          ["review_cycles", cycleId],
          ["review_findings", findingId],
          ["delivery_decisions", decisionId],
        ] as const
      ) {
        const read = await app.query(
          `select 1 from bakery.${table} where id = $1`,
          [id],
        );
        assertEquals(read.rows.length, 1, table);
        for (
          const statement of [
            `update bakery.${table} set created_at = now() where id = $1`,
            `delete from bakery.${table} where id = $1`,
          ]
        ) {
          const denied = await assertRejects(() => app.query(statement, [id]));
          assertEquals(
            postgresErrorCode(denied),
            PG_INSUFFICIENT_PRIVILEGE,
            statement,
          );
        }
      }
      // The decision keeps the typed evidence it was stored with.
      const stored = await app.query<{
        blocking_fingerprints: string[];
        limits: Record<string, number>;
      }>(
        "select blocking_fingerprints, limits from bakery.delivery_decisions where id = $1",
        [decisionId],
      );
      assertEquals(stored.rows[0].blocking_fingerprints, [fingerprintOf(1)]);
      assertEquals(stored.rows[0].limits.maxRepairCycles, 2);
      // checks.close() deletes the organization: the rows go with it.
    } finally {
      await checks.close();
    }
  });

  Deno.test("a run has one cycle and one decision per ordinal, one cycle per job fence and one finding per fingerprint", async () => {
    const checks = await openChecksFixture();
    try {
      const run = await seedReviewRun(checks.owner, checks.scope());
      const cycle = {
        ...run,
        runStepId: run.reviewStepId,
        jobId: crypto.randomUUID(),
        attemptId: crypto.randomUUID(),
        fence: "7",
      };
      const first = await insertReviewCycle(checks.owner, cycle);
      const sameOrdinal = await assertRejects(() =>
        insertReviewCycle(checks.owner, { ...cycle, jobId: null, fence: null })
      );
      assertEquals(postgresErrorCode(sameOrdinal), POSTGRES_UNIQUE_VIOLATION);
      const sameFence = await assertRejects(() =>
        insertReviewCycle(checks.owner, { ...cycle, ordinal: 1 })
      );
      assertEquals(postgresErrorCode(sameFence), POSTGRES_UNIQUE_VIOLATION);
      // A new fence is a new attempt; a cycle with no job repeats the null.
      await insertReviewCycle(checks.owner, {
        ...cycle,
        ordinal: 1,
        fence: "8",
      });
      await insertReviewCycle(checks.owner, {
        ...cycle,
        ordinal: 2,
        jobId: null,
        attemptId: null,
        fence: null,
      });
      await insertReviewCycle(checks.owner, {
        ...cycle,
        ordinal: 3,
        jobId: null,
        attemptId: null,
        fence: null,
      });

      await insertReviewFinding(checks.owner, {
        organizationId: run.organizationId,
        reviewCycleId: first,
      });
      const duplicate = await assertRejects(() =>
        insertReviewFinding(checks.owner, {
          organizationId: run.organizationId,
          reviewCycleId: first,
          path: "src/other.ts",
        })
      );
      assertEquals(postgresErrorCode(duplicate), POSTGRES_UNIQUE_VIOLATION);
      // The same fingerprint in a later cycle is a repeated finding, not a clash.
      const later = await insertReviewCycle(checks.owner, {
        ...run,
        runStepId: run.reviewStepId,
        ordinal: 4,
      });
      await insertReviewFinding(checks.owner, {
        organizationId: run.organizationId,
        reviewCycleId: later,
      });
      await insertReviewFinding(checks.owner, {
        organizationId: run.organizationId,
        reviewCycleId: later,
        fingerprint: fingerprintOf(2),
        line: null,
      });

      await insertDeliveryDecision(checks.owner, {
        organizationId: run.organizationId,
        runId: run.runId,
      });
      const decisionClash = await assertRejects(() =>
        insertDeliveryDecision(checks.owner, {
          organizationId: run.organizationId,
          runId: run.runId,
          decision: "stop",
          reason: "review_failed",
        })
      );
      assertEquals(postgresErrorCode(decisionClash), POSTGRES_UNIQUE_VIOLATION);
      // A stop with no cycle, base or policy is still a valid fact.
      await insertDeliveryDecision(checks.owner, {
        organizationId: run.organizationId,
        runId: run.runId,
        ordinal: 1,
        decision: "stop",
        reason: "reviewer_unavailable",
        baseSha: null,
        policyDigest: null,
      });
    } finally {
      await checks.close();
    }
  });

  Deno.test("composite organization keys refuse evidence that crosses organizations", async () => {
    const checks = await openChecksFixture();
    try {
      const run = await seedReviewRun(checks.owner, checks.scope());
      const other = checks.otherOrganizationId;
      const cycle = { ...run, runStepId: run.reviewStepId };
      // Another organization cannot attach a cycle to this run or its sessions.
      const foreignRun = await assertRejects(() =>
        insertReviewCycle(checks.owner, { ...cycle, organizationId: other })
      );
      assertEquals(postgresErrorCode(foreignRun), PG_FOREIGN_KEY_VIOLATION);
      // A session that does not exist is refused.
      const dangling = await assertRejects(() =>
        insertReviewCycle(checks.owner, {
          ...cycle,
          reviewerSessionId: crypto.randomUUID(),
        })
      );
      assertEquals(postgresErrorCode(dangling), PG_FOREIGN_KEY_VIOLATION);
      const cycleId = await insertReviewCycle(checks.owner, cycle);
      const foreignFinding = await assertRejects(() =>
        insertReviewFinding(checks.owner, {
          organizationId: other,
          reviewCycleId: cycleId,
        })
      );
      assertEquals(postgresErrorCode(foreignFinding), PG_FOREIGN_KEY_VIOLATION);
      const foreignDecision = await assertRejects(() =>
        insertDeliveryDecision(checks.owner, {
          organizationId: other,
          runId: run.runId,
        })
      );
      assertEquals(
        postgresErrorCode(foreignDecision),
        PG_FOREIGN_KEY_VIOLATION,
      );
      const foreignCycle = await assertRejects(() =>
        insertDeliveryDecision(checks.owner, {
          organizationId: other,
          runId: run.runId,
          reviewCycleId: cycleId,
        })
      );
      assertEquals(
        postgresErrorCode(foreignCycle),
        PG_FOREIGN_KEY_VIOLATION,
      );
    } finally {
      await checks.close();
    }
  });

  Deno.test("deleting a run removes its cycles, findings and decisions", async () => {
    const checks = await openChecksFixture();
    try {
      const run = await seedReviewRun(checks.owner, checks.scope());
      const cycleId = await insertReviewCycle(checks.owner, {
        ...run,
        runStepId: run.reviewStepId,
      });
      await insertReviewFinding(checks.owner, {
        organizationId: run.organizationId,
        reviewCycleId: cycleId,
      });
      await insertDeliveryDecision(checks.owner, {
        organizationId: run.organizationId,
        runId: run.runId,
        reviewCycleId: cycleId,
      });
      // One statement: the run's steps and sessions cascade away with it, and
      // the evidence rows that name those sessions cascade too, in any order.
      await checks.owner.query(
        "delete from bakery.workflow_runs where id = $1",
        [
          run.runId,
        ],
      );
      for (const table of Object.keys(TABLES)) {
        const remaining = await checks.owner.query(
          `select 1 from bakery.${table} where organization_id = $1`,
          [run.organizationId],
        );
        assertEquals(remaining.rows.length, 0, table);
      }
      const sessions = await checks.owner.query(
        "select 1 from bakery.agent_sessions where id = any($1::uuid[])",
        [[run.implementerSessionId, run.reviewerSessionId]],
      );
      assertEquals(sessions.rows.length, 0);
    } finally {
      await checks.close();
    }
  });
}
