import { assert, assertEquals } from "@std/assert";
import { bakeryDataMigrations } from "../../apps/server/src/data-migrations.ts";
import {
  defaultTicketSourcePolicy,
  type TicketSourcePolicy,
} from "../../packages/contracts/src/ticket-admission.ts";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import { installBuiltInWorkflow } from "../../apps/server/src/modules/work/ticket-workflow.ts";
import { withTicketFixture } from "../helpers/ticket-admission/fixtures.ts";

const MIGRATION_VERSION = "0373_ticket_policy_names_a_workflow";

function legacyPolicy(preset?: string): TicketSourcePolicy {
  const { workflow: _workflow, ...rest } = defaultTicketSourcePolicy();
  return {
    ...rest,
    version: 1,
    ...(preset === undefined ? {} : { preset }),
  } as unknown as TicketSourcePolicy;
}

Deno.test("issue 407: the backfill names each v1 source's built-in workflow by id and leaves a source with none unset", () =>
  withTicketFixture(async (fx) => {
    const reviewed = await fx.insertSource({
      policy: legacyPolicy("fixed-coding-reviewed"),
    });
    const none = await fx.insertSource({
      policy: legacyPolicy(),
      externalContainerId: "acme/none",
    });
    const removed = fx.builtInWorkflow("fixed-coding-reviewed").workflowId;
    await fx.owner.query(
      `delete from bakery.workflow_versions
        where organization_id = $1 and workflow_id = $2`,
      [fx.organizationId, removed],
    );
    await fx.owner.query(
      `delete from bakery.workflow_definitions
        where organization_id = $1 and id = $2`,
      [fx.organizationId, removed],
    );
    const migration = bakeryDataMigrations.find((candidate) =>
      candidate.version === MIGRATION_VERSION
    );
    assert(migration);
    const connection = await fx.f.database.reserve();
    try {
      assertEquals(await migration.run(connection, { maxBatches: 5 }), true);
      assertEquals(await migration.run(connection, { maxBatches: 1 }), true);
    } finally {
      connection.release();
    }
    const policies = await fx.owner.query<{ id: string; policy: unknown }>(
      `select id, policy from bakery.ticket_sources
        where organization_id = $1 and id = any($2::uuid[])`,
      [fx.organizationId, [reviewed, none]],
    );
    const byId = new Map(policies.rows.map((row) => [row.id, row.policy]));
    const installed = await withPgTransaction(
      fx.owner,
      (transaction) =>
        installBuiltInWorkflow(
          transaction,
          fx.organizationId,
          fx.adminId,
          "fixed-coding-reviewed",
        ),
    );
    assert(installed !== removed, "the backfill installed the workflow again");
    assertEquals(byId.get(reviewed), {
      ...legacyPolicy(),
      version: 2,
      workflow: { workflowId: installed, builtIn: "fixed-coding-reviewed" },
    });
    assertEquals(byId.get(none), { ...legacyPolicy(), version: 2 });
    fx.reader.setIssue({ number: 1, labels: [] });
    const admitted = await fx.admit(reviewed, { number: 1, intent: "start" });
    assertEquals(
      admitted.report.preset?.workflowId,
      installed,
      "the migrated policy is read and judged with the built-in workflow",
    );
  }));
