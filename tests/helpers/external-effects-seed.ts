import type { PgDatabase } from "../../apps/server/src/platform/database.ts";

/**
 * Seeds external effects directly, as the effects module would have left them,
 * for tests that need an installation with unsettled effects in it (#64 slice
 * C: the cutoff's census). Every row carries the idempotency-key prefix below so
 * `removeSeededEffects` takes exactly those away again.
 */
const PREFIX = "cutoff-test-";

let counter = 0;

export async function seedEffect(
  database: Pick<PgDatabase, "query">,
  organizationId: string,
  status: string,
  operation: string,
): Promise<string> {
  const principal = (await database.query<{ id: string }>(
    "select id from bakery.principals limit 1",
  )).rows[0].id;
  const tag = `${Date.now()}-${++counter}`;
  const inserted = await database.query<{ id: string }>(
    `insert into bakery.external_effects
       (organization_id, operation, target, requesting_principal_id, actor_ref,
        idempotency_key, request_digest, adapter_version, status)
     values ($1, $2, $3, $4, 'actor:cutoff-test', $5, $6, 'v1', $7)
     returning id`,
    [
      organizationId,
      operation,
      `secret-target/${tag}`,
      principal,
      `${PREFIX}${tag}`,
      "d".repeat(64),
      status,
    ],
  );
  return inserted.rows[0].id;
}

export async function removeSeededEffects(
  database: Pick<PgDatabase, "query">,
): Promise<void> {
  await database.query(
    "delete from bakery.external_effects where idempotency_key like $1",
    [`${PREFIX}%`],
  );
}
