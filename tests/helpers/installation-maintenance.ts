import { assert, assertEquals } from "@std/assert";
import type { PgDatabase } from "../../apps/server/src/platform/database.ts";

/**
 * Test helpers for the installation maintenance switch (#64 slice B): hold it
 * directly in SQL, as a runner that entered would have, let go, and check the
 * 503 a held installation answers.
 */

export type HoldOptions = {
  state?: "draining" | "quiesced";
  leaseSeconds?: number;
  ownerRunId?: string | null;
  enteredSecondsAgo?: number;
};

/** Holds the installation. With no owner run the hold belongs to nobody. */
export async function holdInstallation(
  database: Pick<PgDatabase, "query">,
  options: HoldOptions = {},
): Promise<void> {
  await database.query(
    `insert into bakery.installation_maintenance
       (id, state, reason, owner_run_id, entered_at, lease_expires_at)
     values (true, $1, 'backup', $2,
             clock_timestamp() - make_interval(secs => $4),
             clock_timestamp() + make_interval(secs => $3))
     on conflict (id) do update
       set state = excluded.state, reason = excluded.reason,
           owner_run_id = excluded.owner_run_id,
           entered_at = excluded.entered_at,
           lease_expires_at = excluded.lease_expires_at,
           version = bakery.installation_maintenance.version + 1`,
    [
      options.state ?? "quiesced",
      options.ownerRunId ?? null,
      options.leaseSeconds ?? 300,
      options.enteredSecondsAgo ?? 0,
    ],
  );
}

/** Lets go: the switch is off, as a terminal report of the owning run leaves it. */
export async function letGoInstallation(
  database: Pick<PgDatabase, "query">,
): Promise<void> {
  await database.query(
    "update bakery.installation_maintenance set state = 'off'",
  );
}

/** Removes the switch row, so a test starts and ends with none. */
export async function clearInstallationMaintenance(
  database: Pick<PgDatabase, "query">,
): Promise<void> {
  await database.query("delete from bakery.installation_maintenance");
}

/** The 503 a held installation answers: retryable, with Retry-After, one code. */
export async function assertQuiesced(response: Response): Promise<void> {
  assertEquals(response.status, 503, await response.clone().text());
  const header = response.headers.get("retry-after");
  const seconds = Number(header);
  assert(
    Number.isInteger(seconds) && seconds >= 1 && seconds <= 30,
    `Retry-After was ${header}`,
  );
  const body = await response.json() as {
    code: string;
    retryable: boolean;
    retryAfterSeconds?: number;
  };
  assertEquals(body.code, "INSTALLATION_QUIESCED");
  assertEquals(body.retryable, true);
  assertEquals(body.retryAfterSeconds, seconds);
}
