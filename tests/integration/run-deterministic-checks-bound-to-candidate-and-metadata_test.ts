import { assert, assertEquals, assertRejects } from "@std/assert";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";
import { collectArtifactVersion } from "../../apps/server/src/modules/knowledge/retention/collector.ts";
import {
  POSTGRES_UNIQUE_VIOLATION,
  postgresErrorCode,
} from "../../apps/server/src/platform/postgres-errors.ts";
import {
  assertRetained,
  retentionFixture,
} from "../helpers/artifact-retention.ts";
import { openChecksFixture } from "../helpers/deterministic-checks/checks-fixture.ts";
import {
  BASE_SHA,
  HEAD_SHA,
  SHA256_A,
  SHA256_B,
  SHA256_C,
} from "../helpers/deterministic-checks/observations.ts";
import {
  insertCheckRun,
  seedRun,
} from "../helpers/deterministic-checks/run-fixture.ts";
import { registerFinalizerDeliveryCases } from "../helpers/deterministic-checks/finalizer-delivery-cases.ts";
import { registerFinalizerIntegrationCases } from "../helpers/deterministic-checks/finalizer-integration-cases.ts";
import { registerServiceCases } from "../helpers/deterministic-checks/service-cases.ts";

// Phase 2: the delivery verdict and metadata rows against real Postgres rows.
registerServiceCases();
// Phase 4: the quality.check finalizer through the real worker result route.
registerFinalizerIntegrationCases();
registerFinalizerDeliveryCases();

const PG_INSUFFICIENT_PRIVILEGE = "42501";
const PG_FOREIGN_KEY_VIOLATION = "23503";

Deno.test("migration 0142 creates an insert-only check_runs table with named constraints", async () => {
  const checks = await openChecksFixture();
  try {
    const columns = await checks.owner.query<
      { column_name: string; is_nullable: string }
    >(
      `select column_name, is_nullable from information_schema.columns
        where table_schema = 'bakery' and table_name = 'check_runs'
        order by ordinal_position`,
    );
    const nullable = new Map(
      columns.rows.map((
        row,
      ) => [row.column_name, row.is_nullable === "YES"]),
    );
    for (
      const required of [
        "id",
        "organization_id",
        "run_id",
        "check_id",
        "kind",
        "result",
        "reason",
        "head_sha",
        "policy_digest",
        "subject_digest",
        "created_at",
      ]
    ) assertEquals(nullable.get(required), false, `${required} is required`);
    for (
      const optional of [
        "run_step_id",
        "job_id",
        "attempt_id",
        "fence",
        "rule_key",
        "exit_code",
        "duration_ms",
        "output_digest",
        "evidence_version_id",
        "provider_run_id",
        "base_sha",
        "profile_digest",
        "checker_digest",
        "title_digest",
        "body_digest",
        "merge_message_digest",
        "commit_selection_digest",
      ]
    ) assertEquals(nullable.get(optional), true, `${optional} is optional`);
    assertEquals(nullable.has("pull_request_id"), false);

    const constraints = await checks.owner.query<
      { conname: string; contype: string }
    >(
      `select conname, contype from pg_constraint
        where conrelid = 'bakery.check_runs'::regclass order by conname`,
    );
    assertEquals(constraints.rows.map((row) => row.conname), [
      "check_runs_evidence_version_fk",
      "check_runs_organization_id_unique",
      "check_runs_pkey",
      "check_runs_run_fk",
    ]);
    assertEquals(
      constraints.rows.filter((row) => row.contype === "c").length,
      0,
      "PostgreSQL holds structure only: no CHECK constraint",
    );
    const triggers = await checks.owner.query(
      `select 1 from pg_trigger
        where tgrelid = 'bakery.check_runs'::regclass and not tgisinternal`,
    );
    assertEquals(triggers.rows.length, 0);

    const partial = await checks.owner.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
        where schemaname = 'bakery' and tablename = 'check_runs'
          and indexname = 'check_runs_job_fence_check_unique'`,
    );
    assertEquals(partial.rows.length, 1);
    assert(partial.rows[0].indexdef.includes("UNIQUE"));
    assert(partial.rows[0].indexdef.includes("job_id IS NOT NULL"));

    const privileges = await checks.owner.query<
      Record<string, boolean>
    >(
      `select has_table_privilege('bakery_app', 'bakery.check_runs', 'select') as "select",
              has_table_privilege('bakery_app', 'bakery.check_runs', 'insert') as "insert",
              has_table_privilege('bakery_app', 'bakery.check_runs', 'update') as "update",
              has_table_privilege('bakery_app', 'bakery.check_runs', 'delete') as "delete"`,
    );
    assertEquals(privileges.rows[0], {
      select: true,
      insert: true,
      update: false,
      delete: false,
    });
  } finally {
    await checks.close();
  }
});

Deno.test("a job records each check id once per fence while metadata rows repeat", async () => {
  const checks = await openChecksFixture();
  try {
    const organizationId = checks.fixture.organizationId;
    const run = await seedRun(checks.owner, checks.scope(organizationId));
    const job = {
      organizationId,
      runId: run.runId,
      runStepId: run.stepId,
      jobId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      fence: "7",
    };
    await insertCheckRun(checks.owner, { ...job, checkId: "lint" });
    await insertCheckRun(checks.owner, { ...job, checkId: "unit" });
    // A new fence is a new attempt: the same check id is recorded again.
    await insertCheckRun(checks.owner, {
      ...job,
      attemptId: crypto.randomUUID(),
      fence: "8",
      checkId: "lint",
    });
    const duplicate = await assertRejects(() =>
      insertCheckRun(checks.owner, {
        ...job,
        attemptId: crypto.randomUUID(),
        checkId: "lint",
      })
    );
    assertEquals(postgresErrorCode(duplicate), POSTGRES_UNIQUE_VIOLATION);
    for (let evaluation = 0; evaluation < 3; evaluation++) {
      await insertCheckRun(checks.owner, {
        organizationId,
        runId: run.runId,
        checkId: "changeRequest.semanticTitle",
        kind: "title",
        ruleKey: "changeRequest.semanticTitle",
        titleDigest: SHA256_B,
      });
    }
    const count = await checks.owner.query<{ count: string }>(
      "select count(*) from bakery.check_runs where run_id = $1",
      [run.runId],
    );
    assertEquals(Number(count.rows[0].count), 6);

    // The artifact_versions foreign key refuses evidence that does not exist.
    const dangling = await assertRejects(() =>
      insertCheckRun(checks.owner, {
        organizationId,
        runId: run.runId,
        checkId: "e2e",
        evidenceVersionId: crypto.randomUUID(),
      })
    );
    assertEquals(postgresErrorCode(dangling), PG_FOREIGN_KEY_VIOLATION);

    // Deleting the run removes its evidence rows.
    await checks.owner.query("delete from bakery.run_steps where run_id = $1", [
      run.runId,
    ]);
    await checks.owner.query("delete from bakery.workflow_runs where id = $1", [
      run.runId,
    ]);
    const remaining = await checks.owner.query(
      "select 1 from bakery.check_runs where run_id = $1",
      [run.runId],
    );
    assertEquals(remaining.rows.length, 0);
  } finally {
    await checks.close();
  }
});

Deno.test("checks.list pages one run's rows and keeps failed and unavailable apart", async () => {
  const checks = await openChecksFixture();
  try {
    const organizationId = checks.fixture.organizationId;
    const run = await seedRun(checks.owner, checks.scope(organizationId));
    const other = await seedRun(checks.owner, checks.scope(organizationId));
    const at = (second: number) => new Date(`2026-10-31T12:00:0${second}.000Z`);
    const common = { organizationId, runId: run.runId, runStepId: run.stepId };
    const failedId = await insertCheckRun(checks.owner, {
      ...common,
      checkId: "lint",
      result: "failed",
      reason: "exit_nonzero",
      exitCode: 1,
      durationMs: 840,
      outputDigest: SHA256_A,
      createdAt: at(1),
    });
    const unavailableId = await insertCheckRun(checks.owner, {
      ...common,
      checkId: "e2e",
      result: "unavailable",
      reason: "tool_missing",
      createdAt: at(2),
    });
    // Same instant as the next row: the id breaks the tie deterministically.
    const tiedIds = [
      await insertCheckRun(checks.owner, {
        ...common,
        checkId: "unit",
        profileDigest: SHA256_B,
        checkerDigest: SHA256_C,
        exitCode: 0,
        durationMs: 3100,
        createdAt: at(3),
      }),
      await insertCheckRun(checks.owner, {
        ...common,
        checkId: "build",
        createdAt: at(3),
      }),
    ].sort();
    const titleId = await insertCheckRun(checks.owner, {
      organizationId,
      runId: run.runId,
      checkId: "changeRequest.semanticTitle",
      kind: "title",
      ruleKey: "changeRequest.semanticTitle",
      result: "unavailable",
      reason: "metadata_missing",
      titleDigest: SHA256_B,
      createdAt: at(4),
    });
    await insertCheckRun(checks.owner, {
      organizationId,
      runId: other.runId,
      checkId: "other-run-check",
      createdAt: at(1),
    });
    const expected = [failedId, unavailableId, ...tiedIds, titleId];

    const full = await checks.list(organizationId, run.runId);
    assertEquals(full.nextCursor, null);
    assertEquals(full.items.map((item) => item.id), expected);
    assert(contractSchemas["Page<CheckRun>"].safeParse(full).success);
    const byCheck = new Map(full.items.map((item) => [item.checkId, item]));
    const failed = byCheck.get("lint")!;
    const unavailable = byCheck.get("e2e")!;
    assertEquals(
      [failed.result, failed.reason, failed.exitCode, failed.durationMs],
      ["failed", "exit_nonzero", 1, 840],
    );
    assertEquals(
      [unavailable.result, unavailable.reason, unavailable.exitCode],
      ["unavailable", "tool_missing", null],
    );
    const unit = byCheck.get("unit")!;
    assertEquals(unit.profileDigest, SHA256_B);
    assertEquals(unit.checkerDigest, SHA256_C);
    assertEquals(unit.headSha, HEAD_SHA);
    assertEquals(unit.baseSha, BASE_SHA);
    assertEquals(unit.runStepId, run.stepId);
    assertEquals(unit.kind, "command");
    assertEquals(unit.pullRequestId, null);
    assertEquals(unit.version, 1);
    assertEquals(unit.updatedAt, unit.createdAt);
    const title = byCheck.get("changeRequest.semanticTitle")!;
    assertEquals(title.kind, "title");
    assertEquals(title.ruleKey, "changeRequest.semanticTitle");
    assertEquals(title.titleDigest, SHA256_B);
    assertEquals(title.runStepId, null);

    const seen: unknown[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await checks.list(organizationId, run.runId, {
        limit: 2,
        ...(cursor === undefined ? {} : { cursor }),
      });
      assert(page.items.length <= 2);
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor !== undefined);
    assertEquals(seen, expected);
    assertEquals(pages, 3);

    // A cursor is bound to the run it was issued for.
    const first = await checks.list(organizationId, run.runId, { limit: 1 });
    assert(first.nextCursor);
    const wrongRun = await assertRejects(
      () =>
        checks.list(organizationId, other.runId, { cursor: first.nextCursor! }),
      StandardError,
    );
    assertEquals((wrongRun as StandardError).code, "INVALID_CURSOR");
    assertEquals(
      (await checks.list(organizationId, other.runId)).items.map((item) =>
        item.checkId
      ),
      ["other-run-check"],
    );
  } finally {
    await checks.close();
  }
});

Deno.test("checks.list never crosses an organization boundary", async () => {
  const checks = await openChecksFixture();
  try {
    const organizationId = checks.fixture.organizationId;
    const mine = await seedRun(checks.owner, checks.scope(organizationId));
    const theirs = await seedRun(
      checks.owner,
      checks.scope(checks.otherOrganizationId),
    );
    await insertCheckRun(checks.owner, {
      organizationId,
      runId: mine.runId,
      checkId: "mine",
    });
    await insertCheckRun(checks.owner, {
      organizationId: checks.otherOrganizationId,
      runId: theirs.runId,
      checkId: "theirs",
    });
    assertEquals(
      (await checks.list(organizationId, mine.runId)).items.map((item) =>
        item.checkId
      ),
      ["mine"],
    );
    // A run id from another organization looks exactly like a missing run.
    const foreignRun = await assertRejects(
      () => checks.list(organizationId, theirs.runId),
      StandardError,
    );
    assertEquals((foreignRun as StandardError).code, "RESOURCE_NOT_FOUND");
    const unknownRun = await assertRejects(
      () => checks.list(organizationId, crypto.randomUUID()),
      StandardError,
    );
    assertEquals((unknownRun as StandardError).code, "RESOURCE_NOT_FOUND");
    // Naming an organization the caller does not belong to is refused.
    await assertRejects(
      () => checks.list(checks.otherOrganizationId, theirs.runId),
      StandardError,
    );
  } finally {
    await checks.close();
  }
});

Deno.test("the application role can record check rows but never rewrite them", async () => {
  const checks = await openChecksFixture();
  try {
    const organizationId = checks.fixture.organizationId;
    const run = await seedRun(checks.owner, checks.scope(organizationId));
    const id = crypto.randomUUID();
    await checks.fixture.appPg.query(
      `insert into bakery.check_runs
         (id, organization_id, run_id, check_id, kind, result, reason,
          head_sha, policy_digest, subject_digest)
       values ($1, $2, $3, 'unit', 'command', 'failed', 'exit_nonzero',
               $4, $5, $6)`,
      [id, organizationId, run.runId, HEAD_SHA, SHA256_C, SHA256_A],
    );
    const update = await assertRejects(() =>
      checks.fixture.appPg.query(
        "update bakery.check_runs set result = 'passed' where id = $1",
        [id],
      )
    );
    assertEquals(postgresErrorCode(update), PG_INSUFFICIENT_PRIVILEGE);
    const removal = await assertRejects(() =>
      checks.fixture.appPg.query(
        "delete from bakery.check_runs where id = $1",
        [id],
      )
    );
    assertEquals(postgresErrorCode(removal), PG_INSUFFICIENT_PRIVILEGE);
    const stored = await checks.owner.query<{ result: string }>(
      "select result from bakery.check_runs where id = $1",
      [id],
    );
    assertEquals(stored.rows[0].result, "failed");
  } finally {
    await checks.close();
  }
});

Deno.test("retained check evidence protects its artifact version from collection", async () => {
  const fixture = await retentionFixture();
  try {
    const database = fixture.pgDatabase;
    const checkRunId = await insertCheckRun(database, {
      organizationId: fixture.organizationId,
      runId: fixture.job.runId,
      runStepId: fixture.job.runStepId,
      checkId: "unit",
      evidenceVersionId: fixture.versionId,
      outputDigest: fixture.sha256,
    });
    // Expired, on a terminal task, with no other reference: only the check row
    // keeps the bytes.
    assertEquals(
      await collectArtifactVersion(database, fixture.versionId),
      false,
    );
    await assertRetained(fixture);
    await database.query("delete from bakery.check_runs where id = $1", [
      checkRunId,
    ]);
    assertEquals(
      await collectArtifactVersion(database, fixture.versionId),
      true,
    );
  } finally {
    await fixture.closeRetention();
  }
});
