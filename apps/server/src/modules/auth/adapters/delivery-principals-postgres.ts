import { StandardError } from "@bakery/contracts/http";
import type { PgTransactionClient } from "../../../platform/database.ts";

export async function isDeliveryPrincipal(
  client: PgTransactionClient,
  principalId: string,
): Promise<boolean> {
  const found = await client.query<{ delivery: boolean }>(
    `select exists (
       select 1 from bakery.delivery_principals where principal_id = $1
     ) as delivery`,
    [principalId],
  );
  return found.rows[0]?.delivery === true;
}

export async function refuseDeliveryPrincipal(
  client: PgTransactionClient,
  principalId: string,
): Promise<void> {
  if (await isDeliveryPrincipal(client, principalId)) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
}
