import type { Inngest } from "inngest";
import { INNGEST_EVENT_DEFINITIONS } from "@bakery/contracts/events";
import { executeDiscovery, staleDiscoveries } from "./discoveries.ts";
import type { ReconcileDependencies } from "./reconcile.ts";

const DISCOVERY_FUNCTION_ID = "bakery-integration-discovery";
const DISCOVERY_RECOVERY_FUNCTION_ID = "bakery-integration-discovery-recovery";
const DISCOVERY_EVENT =
  INNGEST_EVENT_DEFINITIONS["integration.discovery_requested"].name;
/** Pacing waits one discovery may take before it gives up to recovery. */
const MAX_PACING_WAITS = 5;

function eventDiscoveryId(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const data = (event as { data?: unknown }).data;
  if (!data || typeof data !== "object") return undefined;
  const payload = (data as { payload?: unknown }).payload;
  if (!payload || typeof payload !== "object") return undefined;
  const id = (payload as { resourceId?: unknown }).resourceId;
  return typeof id === "string" && id.trim() ? id : undefined;
}

/**
 * Runs the discovery the event names: sleeps until its Postgres pacing time
 * (`not_before`), then claims and scans it. One run per discovery at a time.
 */
export function createIntegrationDiscoveryWorkflow(
  options: ReconcileDependencies & {
    client: Inngest;
    /** The discovery run; tests replace it to drive the pacing loop. */
    execute?: typeof executeDiscovery;
  },
) {
  const { client, execute = executeDiscovery, ...dependencies } = options;
  return client.createFunction(
    {
      id: DISCOVERY_FUNCTION_ID,
      retries: 3,
      concurrency: [{ key: "event.data.payload.resourceId", limit: 1 }],
      triggers: [{ event: DISCOVERY_EVENT }],
    },
    async ({ event, step }) => {
      const discoveryId = eventDiscoveryId(event);
      if (!discoveryId) throw new Error("INTEGRATION_DISCOVERY_EVENT_INVALID");
      for (let attempt = 0; attempt <= MAX_PACING_WAITS; attempt++) {
        const result = await step.run(
          `discover-${discoveryId}-${attempt}`,
          () =>
            execute(
              dependencies,
              discoveryId,
              new AbortController().signal,
            ),
        );
        if (result.kind !== "waiting") return result;
        await step.sleepUntil(
          `pace-${discoveryId}-${attempt}`,
          new Date(result.until),
        );
      }
      return { kind: "deferred" as const };
    },
  );
}

/**
 * Every minute, sends the event again for discoveries left queued or
 * running (a lost event, a crashed run, a pacing deferral).
 */
export function createIntegrationDiscoveryRecovery(
  options: Pick<ReconcileDependencies, "database"> & { client: Inngest },
) {
  return options.client.createFunction(
    {
      id: DISCOVERY_RECOVERY_FUNCTION_ID,
      retries: 3,
      concurrency: [{ limit: 1 }],
      triggers: [{ cron: "* * * * *" }],
    },
    async ({ step }) => {
      const stale = await step.run(
        "stale-integration-discoveries",
        () => staleDiscoveries(options.database),
      );
      for (const discovery of stale) {
        await step.sendEvent(
          `rearm-integration-discovery-${discovery.id}-${discovery.version}`,
          {
            name: DISCOVERY_EVENT,
            data: {
              payload: {
                resourceId: discovery.id,
                resourceVersion: discovery.version,
              },
            },
          },
        );
      }
      return { rearmed: stale.length };
    },
  );
}
