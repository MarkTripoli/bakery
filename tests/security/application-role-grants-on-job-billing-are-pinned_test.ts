import { assertEquals } from "@std/assert";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";

/**
 * The exact column grants the application role holds on the tables that decide what a
 * job is billed to. One database role serves the worker routes and the admission, so
 * these grants are the whole database-level boundary on that path; they are pinned
 * exactly, so that adding a column, or a table-level grant, fails here and has to be
 * argued in the open (the way 0234 and 0265 are in the journal test's forbidden list).
 *
 * `jobs.billing` and `jobs.agent_config` are writable since 0265 (route continuations,
 * #26), and so are the identity columns of the two budget intents. What stands behind
 * that is behaviour, not a grant: the claim refuses a job whose configuration left the
 * run's frozen one unless a continuation recorded for that job targeted that route, and
 * the funding check compares the job's pin with its intents.
 */

type Privilege = "INSERT" | "UPDATE";

const EXPECTED: Record<string, Record<Privilege, readonly string[]>> = {
  jobs: {
    INSERT: [
      "action",
      "agent_config",
      "agent_version_id",
      "application_id",
      "available_at",
      "base_sha",
      "billing",
      "conversation_turn_id",
      "id",
      "input",
      "installation_reservation_id",
      "max_attempts",
      "observation_digest",
      "observation_id",
      "organization_id",
      "priority",
      "repository_id",
      "repository_profile_digest",
      "repository_profile_id",
      "repository_profile_revision",
      "requirements",
      "run_step_id",
      "skill_refs",
      "status",
    ],
    UPDATE: [
      "agent_config",
      "available_at",
      "billing",
      "cancel_requested_at",
      "current_checkpoints",
      "current_fence",
      "input",
      "max_attempts",
      "status",
      "updated_at",
      "version",
    ],
  },
  budget_action_intents: {
    INSERT: [
      "action",
      "action_version",
      "agent_version_id",
      "billing_account_id",
      "billing_route",
      "content_digest",
      "dedupe_key",
      "id",
      "model",
      "organization_id",
      "pricing_metadata_snapshot",
      "provider",
      "provider_call_intent_id",
      "reserved_usd",
      "run_id",
      "run_step_id",
      "status",
    ],
    UPDATE: [
      "billing_account_id",
      "billing_route",
      "installation_reservation_id",
      "model",
      "pricing_metadata_snapshot",
      "provider",
      "provider_call_intent_id",
      "run_reservation_id",
      "status",
      "updated_at",
      "version",
    ],
  },
  provider_call_intents: {
    INSERT: [
      "billing_account_id",
      "billing_type",
      "id",
      "installation_reservation_id",
      "max_tokens",
      "max_usd_reservation",
      "model",
      "organization_id",
      "pricing_metadata_snapshot",
      "pricing_snapshot_id",
      "provider",
      "run_id",
      "run_step_id",
      "status",
      "version",
    ],
    UPDATE: [
      "attempt_fence",
      "attempt_id",
      "billing_account_id",
      "billing_type",
      "model",
      "pricing_metadata_snapshot",
      "pricing_snapshot_id",
      "provider",
      "provider_call_id",
      "status",
      "updated_at",
      "version",
      "worker_host_id",
      "worker_session_generation",
      "worker_session_id",
    ],
  },
};

Deno.test("the application role's column grants on job billing and the budget intents are exactly these", () =>
  withWorkerFixture(async (fixture) => {
    const db = fixture.pgDatabase;
    for (const [table, expected] of Object.entries(EXPECTED)) {
      for (const privilege of ["INSERT", "UPDATE"] as const) {
        const granted = (await db.query<{ column: string }>(
          `select column_name as "column"
             from information_schema.columns
            where table_schema = 'bakery' and table_name = $1
              and has_column_privilege('bakery_app', format('bakery.%I', table_name),
                                       column_name, $2)
            order by column_name`,
          [table, privilege],
        )).rows.map((row) => row.column);
        assertEquals(
          granted,
          [...expected[privilege]].sort(),
          `bakery_app ${privilege} columns on bakery.${table}`,
        );
      }
      // Nothing is deletable or truncatable by the role, and no table-level write.
      const table_level = (await db.query<{ privilege: string }>(
        `select p.privilege
           from unnest(array['DELETE', 'TRUNCATE']) as p(privilege)
          where has_table_privilege('bakery_app', format('bakery.%I', $1::text),
                                    p.privilege)`,
        [table],
      )).rows;
      assertEquals(table_level, [], `bakery_app DELETE/TRUNCATE on ${table}`);
    }

    // A continuation is recorded and read, never changed or removed.
    const continuation = (await db.query<{ privilege: string }>(
      `select p.privilege
         from unnest(array['UPDATE', 'DELETE', 'TRUNCATE']) as p(privilege)
        where has_table_privilege('bakery_app', 'bakery.route_continuations',
                                  p.privilege)`,
    )).rows;
    assertEquals(continuation, [], "bakery_app writes on route_continuations");
    const columnLevel = (await db.query<{ column: string }>(
      `select column_name as "column" from information_schema.columns
        where table_schema = 'bakery' and table_name = 'route_continuations'
          and has_column_privilege('bakery_app', 'bakery.route_continuations',
                                   column_name, 'UPDATE')`,
    )).rows;
    assertEquals(
      columnLevel,
      [],
      "bakery_app UPDATE columns on route_continuations",
    );
  }));
