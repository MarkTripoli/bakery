import {
  readDatabaseConfig,
  readEnvironmentSnapshot,
  readInngestEventConfig,
} from "@bakery/config";
import {
  assertApplicationDatabase,
  closePgDatabase,
  openPgDatabase,
} from "./database.ts";
import { createOutboxDispatcher } from "./outbox-dispatcher.ts";
import { createInngestEventClient } from "./inngest-event-client.ts";

const IDLE_POLL_MILLISECONDS = 500;
const applicationDatabaseEnvironmentNames = [
  "BAKERY_APP_DATABASE_URL",
] as const;
const inngestEnvironmentNames = [
  "BAKERY_ENV",
  "INNGEST_URL",
  "INNGEST_EVENT_KEY",
  "BAKERY_INNGEST_LOCAL_COMPOSE",
  "BAKERY_INNGEST_PRIVATE_HOST_SUFFIX",
] as const;

function waitForNextPoll(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(finish, IDLE_POLL_MILLISECONDS);
    signal.addEventListener("abort", finish, { once: true });
    function finish() {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}

export async function runOutboxDispatchTask(): Promise<void> {
  const databaseConfig = readDatabaseConfig(
    readEnvironmentSnapshot(applicationDatabaseEnvironmentNames),
    "application",
  );
  const inngestConfig = readInngestEventConfig(
    readEnvironmentSnapshot(inngestEnvironmentNames),
  );
  const database = openPgDatabase(databaseConfig.url);
  const controller = new AbortController();
  const stop = () => controller.abort();
  Deno.addSignalListener("SIGINT", stop);
  Deno.addSignalListener("SIGTERM", stop);
  try {
    await assertApplicationDatabase(database);
    const dispatcher = createOutboxDispatcher({
      database,
      engine: createInngestEventClient({
        baseUrl: inngestConfig.url,
        eventKey: inngestConfig.eventKey,
        privateHostSuffix: inngestConfig.privateHostSuffix,
      }),
    });
    while (!controller.signal.aborted) {
      const result = await dispatcher.dispatchBatch(25, controller.signal);
      if (result.claimed === 0) await waitForNextPoll(controller.signal);
    }
  } finally {
    Deno.removeSignalListener("SIGINT", stop);
    Deno.removeSignalListener("SIGTERM", stop);
    await closePgDatabase(database);
  }
}
