import type { Inngest } from "inngest";
import { StandardError } from "@bakery/contracts/http";
import {
  connectionsAwaitingRevalidation,
  dueInstallations,
  type ReconcileDependencies,
  reconcileInstallation,
  revalidateConnection,
} from "./reconcile.ts";

const SWEEP_FUNCTION_ID = "bakery-integration-installation-sweep";
const SWEEP_EVENT = "bakery/integration-installations.reconcile.v1";

/**
 * Reconciles one due installation; a provider failure is logged with its
 * code only and leaves the row for the next sweep.
 */
async function reconcileQuietly(
  dependencies: ReconcileDependencies,
  installationId: string,
): Promise<string> {
  try {
    const outcome = await reconcileInstallation(
      dependencies,
      installationId,
      new AbortController().signal,
    );
    return outcome.kind;
  } catch (error) {
    const code = error instanceof StandardError ? error.code : "INTERNAL";
    console.warn(JSON.stringify({
      component: "integrations",
      event: "installation_reconcile_failed",
      installationId,
      code,
    }));
    return "failed";
  }
}

/**
 * Every five minutes (or on demand), reconciles a bounded batch of
 * installations not checked within the interval, one installation per
 * step so a retry repeats only the unfinished ones, then probes a bounded
 * batch of enabled connections whose health is still unknown (an unsuspend
 * revalidation that failed or never ran). One sweep runs at a time.
 */
export function createIntegrationLifecycleSweep(
  options: ReconcileDependencies & { client: Inngest },
) {
  const { client, ...dependencies } = options;
  return client.createFunction(
    {
      id: SWEEP_FUNCTION_ID,
      retries: 3,
      concurrency: [{ limit: 1 }],
      triggers: [{ cron: "*/5 * * * *" }, { event: SWEEP_EVENT }],
    },
    async ({ step }) => {
      const due = await step.run(
        "due-installations",
        () => dueInstallations(dependencies.database),
      );
      const outcomes: Record<string, number> = {};
      for (const installationId of due) {
        const kind = await step.run(
          `reconcile-installation-${installationId}`,
          () => reconcileQuietly(dependencies, installationId),
        );
        outcomes[kind] = (outcomes[kind] ?? 0) + 1;
      }
      const awaiting = await step.run(
        "connections-awaiting-revalidation",
        () => connectionsAwaitingRevalidation(dependencies.database),
      );
      let revalidated = 0;
      for (const connectionId of awaiting) {
        const recorded = await step.run(
          `revalidate-connection-${connectionId}`,
          () =>
            revalidateConnection(
              dependencies,
              connectionId,
              new AbortController().signal,
            ),
        );
        if (recorded) revalidated += 1;
      }
      return { reconciled: due.length, outcomes, revalidated };
    },
  );
}
