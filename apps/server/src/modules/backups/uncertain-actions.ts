import { contractSchemas } from "@bakery/contracts/contracts";
import type { z } from "zod";
import type { PgTransactionClient } from "../../platform/database.ts";

/**
 * The outside actions whose outcome Bakery cannot tell (issue #59 ask 11, also
 * #64 ask 5). After a restore or an update an effect may or may not have
 * happened; the effect ledger holds those as `uncertain`, and they are only
 * ever reconciled by a read, never sent again. This is the one list of them,
 * for the Updates page, the Finish the restore page and the launcher's
 * `status --unsure`.
 *
 * Words, counts and a time only: the kind of action is a name, and nothing an
 * effect pointed at or carried (its target, its arguments) leaves the ledger.
 */

type View = z.output<typeof contractSchemas.InstallationUncertainActions>;
export type UncertainActionKind = View["kinds"][number];

/** The most kinds one read lists; `total` still counts every uncertain action. */
export const UNCERTAIN_KIND_LIMIT = 200;

export async function readUncertainActions(
  transaction: Pick<PgTransactionClient, "query">,
): Promise<View> {
  const kinds = await transaction.query<View["kinds"][number]>(
    `select operation, count(*)::integer as "count",
            to_char(min(updated_at) at time zone 'utc',
                    'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "since"
       from bakery.external_effects
      where status = 'uncertain'
      group by operation
      order by min(updated_at), operation
      limit $1`,
    [UNCERTAIN_KIND_LIMIT],
  );
  const total = await transaction.query<{ total: number }>(
    `select count(*)::integer as "total" from bakery.external_effects
      where status = 'uncertain'`,
  );
  return contractSchemas.InstallationUncertainActions.parse({
    kinds: kinds.rows,
    total: total.rows[0]?.total ?? 0,
  });
}
