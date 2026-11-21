import type { SecretsKeyConfig } from "@bakery/config";
import type { PgDatabase } from "../../platform/database.ts";
import {
  type ConfiguredDestination,
  type DestinationFanout,
  isMeasurementKind,
} from "../../platform/telemetry-destinations/index.ts";
import { openInstallationSecret } from "../secrets/installation-secrets.ts";

/** How often the running server looks for changes made on this or another instance. */
export const DESTINATION_RELOAD_INTERVAL_MS = 5_000;

type StoredDestination = {
  id: string;
  kind: string;
  name: string;
  enabled: boolean;
  measurements: string[];
  settings: Record<string, string>;
  secret_id: string | null;
};

export type DestinationLoader = Readonly<{
  /** Reads the saved destinations and gives them to the fan-out. Never throws. */
  refresh(): Promise<void>;
  /** Starts the periodic reload and loads once now. */
  start(): void;
  stop(): void;
}>;

/**
 * Keeps the running fan-out in step with the saved destinations.
 *
 * It reads straight from the database rather than being told, so a change made
 * through another instance reaches this one as well. A destination whose secret
 * cannot be opened is still configured, without it: it then fails visibly with
 * the destination's own refusal instead of vanishing from the page.
 */
export function createDestinationLoader(options: {
  database: Pick<PgDatabase, "query">;
  secretsKey: SecretsKeyConfig | undefined;
  fanout: DestinationFanout;
  intervalMs?: number;
}): DestinationLoader {
  let running: Promise<void> | undefined;
  let again = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const load = async (): Promise<void> => {
    const rows = await options.database.query<StoredDestination>(
      `select id, kind, name, enabled, measurements, settings, secret_id
         from bakery.telemetry_destinations order by created_at, id`,
    );
    const destinations: ConfiguredDestination[] = [];
    for (const row of rows.rows) {
      let secrets: Record<string, string> = {};
      if (row.secret_id !== null) {
        try {
          secrets = JSON.parse(
            await openInstallationSecret(
              options.database,
              options.secretsKey,
              row.secret_id,
            ),
          ) as Record<string, string>;
        } catch {
          secrets = {};
        }
      }
      destinations.push({
        id: row.id,
        kind: row.kind,
        name: row.name,
        enabled: row.enabled,
        measurements: row.measurements.filter(isMeasurementKind),
        values: { ...row.settings, ...secrets },
      });
    }
    options.fanout.configure(destinations);
  };

  const refresh = (): Promise<void> => {
    if (running !== undefined) {
      // A change that landed while a reload was reading is picked up by one more.
      again = true;
      return running;
    }
    running = load().catch(() => undefined).finally(() => {
      running = undefined;
      if (again) {
        again = false;
        void refresh();
      }
    });
    return running;
  };

  return Object.freeze({
    refresh,
    start() {
      void refresh();
      timer ??= setInterval(
        () => void refresh(),
        options.intervalMs ?? DESTINATION_RELOAD_INTERVAL_MS,
      );
      // A reload timer must not keep a closing server alive.
      (timer as unknown as { unref?: () => void }).unref?.();
    },
    stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  });
}
