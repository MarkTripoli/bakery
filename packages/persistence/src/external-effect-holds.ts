import { StandardError } from "@bakery/contracts/http";
import type { PgTransactionClient } from "./postgres.ts";

/**
 * One definition of "an external effect still pins its budget reservation".
 * An effect pins when it may have reached the provider (submitted, uncertain),
 * or when it is prepared and its reservation has not expired. A prepared
 * effect on an expired reservation never dispatches (claim fails it), so it
 * does not pin. Aliases: `effect` is external_effects, `effect_reservation`
 * is the reservation the effect names in budget_reservation_id.
 */
export const LIVE_EFFECT_PREDICATE_SQL = `(
  effect.status in ('submitted', 'uncertain')
  or (effect.status = 'prepared'
      and effect_reservation.expires_at > clock_timestamp())
)`;

/**
 * SQL `not exists` filter for candidate queries. Arguments are SQL
 * expressions (column references) naming the organization and the reservation
 * ids to check, never user input.
 */
export function noLiveEffectOnReservationsSql(
  organizationIdSql: string,
  reservationIdsSql: readonly string[],
): string {
  return `not exists (
    select 1
      from bakery.external_effects effect
      join bakery.budget_reservations effect_reservation
        on effect_reservation.organization_id = effect.organization_id
       and effect_reservation.id = effect.budget_reservation_id
     where effect.organization_id = ${organizationIdSql}
       and effect.budget_reservation_id in (${reservationIdsSql.join(", ")})
       and ${LIVE_EFFECT_PREDICATE_SQL}
  )`;
}

/**
 * True when a live effect names any of the reservations. Takes a share lock
 * on the matching effect rows so a concurrent claim (effect update lock)
 * serializes with the caller.
 */
export async function liveEffectsHoldReservations(
  transaction: PgTransactionClient,
  organizationId: string,
  reservationIds: readonly (string | null)[],
): Promise<boolean> {
  const ids = reservationIds.filter((id): id is string => id !== null);
  if (ids.length === 0) return false;
  const result = await transaction.query(
    `select effect.id
       from bakery.external_effects effect
       join bakery.budget_reservations effect_reservation
         on effect_reservation.organization_id = effect.organization_id
        and effect_reservation.id = effect.budget_reservation_id
      where effect.organization_id = $1
        and effect.budget_reservation_id = any($2::uuid[])
        and ${LIVE_EFFECT_PREDICATE_SQL}
      for share of effect`,
    [organizationId, ids],
  );
  return result.rows.length > 0;
}

export const EXTERNAL_EFFECT_IN_FLIGHT = "external_effect_in_flight";

/** Throws STATE_CONFLICT `external_effect_in_flight` when a live effect pins any reservation. */
export async function assertReservationsFreeOfLiveEffects(
  transaction: PgTransactionClient,
  organizationId: string,
  reservationIds: readonly (string | null)[],
): Promise<void> {
  if (
    await liveEffectsHoldReservations(
      transaction,
      organizationId,
      reservationIds,
    )
  ) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: EXTERNAL_EFFECT_IN_FLIGHT },
    });
  }
}
