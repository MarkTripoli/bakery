/**
 * Seeds the usage rows the Usage page stills need.
 *
 *   deno run -A scripts/evidence/usage-page/seed.ts usage
 *   deno run -A scripts/evidence/usage-page/seed.ts clear
 *
 * `usage` writes one installation budget account for the current period, one
 * settled reservation and two usage records: one whose cost the provider
 * reported but no receipt confirms, and one whose measurement is unknown. That
 * is the state the design cares about most - a number a person might otherwise
 * read as a settled bill - and it needs no fabricated run tree.
 *
 * `clear` removes exactly what `usage` wrote, so the empty state can be
 * captured on the same stack before it is seeded.
 *
 * Not seeded, deliberately: a provider-authoritative receipt, because the
 * receipt needs a provider call intent, which needs a run, a run step and a
 * pricing snapshot. A still that shows confirmed costs would be a still of a
 * fabricated run; this evidence does not claim one.
 *
 * Environment: the stack's env file (DATABASE_URL and the rest of the server's
 * auth environment). Source it first: `set -a; . ./.env.<project>; set +a`.
 */
import { readDatabaseConfig, readEnvironmentSnapshot } from "@bakery/config";
import {
  closePgDatabase,
  openPgDatabase,
} from "../../../apps/server/src/platform/database.ts";

/** Markers, so `clear` removes this seed's rows and nobody else's. */
const MARKER = "usage-page-evidence";

const mode = Deno.args[0] ?? "usage";
if (mode !== "usage" && mode !== "clear") {
  throw new Error(`unknown seed mode ${mode}`);
}

const databaseConfig = readDatabaseConfig(
  readEnvironmentSnapshot(["DATABASE_URL"]),
  "owner",
);
const pg = openPgDatabase(databaseConfig.url);

async function q<T = Record<string, unknown>>(
  sql: string,
  values: unknown[] = [],
): Promise<T[]> {
  const result = await pg.query<T>(sql, values);
  return result.rows;
}

try {
  await q(
    `delete from bakery.usage_records where dedupe_key like $1`,
    [`${MARKER}%`],
  );
  await q(
    `delete from bakery.budget_reservations where dedupe_key like $1`,
    [`${MARKER}%`],
  );
  await q(
    `delete from bakery.budget_accounts
      where scope = 'installation' and organization_id is null`,
  );

  const organization = await q<{ id: string }>(
    `select m.organization_id as id
       from bakery.principals p
       join bakery.organization_memberships m on m.principal_id = p.id
      where p.display_name = 'Sam Lee' limit 1`,
  );
  if (organization.length === 0) throw new Error("seed the owner first");
  const organizationId = organization[0]!.id;

  if (mode === "clear") {
    console.log("cleared usage-page evidence rows");
  } else {
    const account = await q<{ id: string }>(
      `insert into bakery.budget_accounts (
         id, scope, period_start, period_end, limit_usd, reserved_usd,
         settled_usd
       ) values (gen_random_uuid(), 'installation',
                 date_trunc('month', now()),
                 date_trunc('month', now()) + interval '1 month',
                 500, 3.25, 41.5)
       returning id`,
    );
    const accountId = account[0]!.id;
    const reservation = await q<{ id: string }>(
      `insert into bakery.budget_reservations (
         id, organization_id, budget_account_id, dedupe_key, reserved_usd,
         settled_usd, status, expires_at
       ) values (gen_random_uuid(), $1, $2, $3, 12, 41.5, 'settled',
                 now() + interval '1 day')
       returning id`,
      [organizationId, accountId, `${MARKER}-reservation`],
    );
    const reservationId = reservation[0]!.id;

    const rows: Array<
      [
        string,
        string,
        string,
        string,
        number | null,
        number | null,
        number | null,
        string,
      ]
    > = [
      // provider, model, billingType, providerCallId, in, out, cost, measurement
      [
        "anthropic",
        "claude-sonnet-4-5",
        "api",
        `${MARKER}-call-1`,
        128_400,
        51_200,
        12.75,
        "reported",
      ],
      [
        "openai",
        "gpt-5-codex",
        "subscription",
        `${MARKER}-call-2`,
        64_000,
        28_800,
        null,
        "unknown",
      ],
    ];
    for (
      const [
        provider,
        model,
        billingType,
        providerCallId,
        inputTokens,
        outputTokens,
        costUsd,
        measurement,
      ] of rows
    ) {
      await q(
        `insert into bakery.usage_records (
           id, organization_id, run_id, run_step_id, attempt_id,
           worker_host_id, worker_session_id, worker_session_generation, fence,
           result_event_id, usage_fact_id, canonical_digest,
           provider, billing_account_id, model, billing_type,
           input_tokens, output_tokens, cost_usd, measurement,
           provider_call_id, pricing_metadata_snapshot, dedupe_key,
           occurred_at, budget_reservation_id, reconciled_canonical_digest,
           original_input_tokens, original_output_tokens, original_cost_usd,
           original_measurement, original_occurred_at
         ) values (
           gen_random_uuid(), $1, gen_random_uuid(), gen_random_uuid(),
           gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1, 1,
           gen_random_uuid(), $2, encode(sha256($3::bytea), 'hex'),
           $4, $5, $6, $7, $8, $9, $10, $11,
           $12, $13, $14, now() - interval '2 hours', $15,
           encode(sha256($3::bytea), 'hex'),
           $8, $9, null, 'unknown', now() - interval '2 hours'
         )`,
        [
          organizationId,
          `${MARKER}-fact-${providerCallId}`,
          providerCallId,
          provider,
          `${MARKER}-account`,
          model,
          billingType,
          inputTokens,
          outputTokens,
          costUsd,
          measurement,
          providerCallId,
          `${MARKER}-pricing`,
          `${MARKER}-${providerCallId}`,
          reservationId,
        ],
      );
    }
    console.log(`seeded usage-page evidence rows for ${organizationId}`);
  }
} finally {
  await closePgDatabase(pg);
}
