import type { z } from "zod";
import type { ActionContext } from "@bakery/contracts/action-registry";
import { StandardError } from "@bakery/contracts/http";
import type { contractSchemas } from "@bakery/contracts/contracts";
import type { PgDatabase } from "../../../../../platform/database.ts";
import {
  exchangeDesktopSignIn,
  startDesktopSignIn,
} from "../../../adapters/desktop-sign-in-postgres.ts";

/** `desktopSignIns.start`: opens a browser sign-in request for the desktop app. */
export async function desktopSignInsStart(
  context: ActionContext,
  input: z.output<typeof contractSchemas.DesktopSignInStart>,
  dependencies: { database: PgDatabase; publicBaseUrl: string | undefined },
) {
  if (!dependencies.publicBaseUrl) {
    throw new StandardError({ code: "INTERNAL" });
  }
  return await startDesktopSignIn(dependencies.database, input, {
    publicBaseUrl: dependencies.publicBaseUrl,
    clientAddress: context.clientAddress,
  });
}

/** `desktopSignIns.exchange`: trades a confirmed request for the desktop credential. */
export async function desktopSignInsExchange(
  context: ActionContext,
  input: z.output<typeof contractSchemas.DesktopSignInExchange>,
  dependencies: { database: PgDatabase },
) {
  return await exchangeDesktopSignIn(dependencies.database, input, {
    clientAddress: context.clientAddress,
    correlation: context,
  });
}
