import {
  integrationTests,
  replayHarnessTests,
} from "../helpers/output-ingestion.ts";
import { transcriptIntegrationTests } from "../helpers/output-transcript.ts";
import { type WorkerFixture } from "../helpers/worker-execution.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import { upPostgresStack } from "./helpers/stack.ts";

async function withOutputFixture<T>(
  callback: (fixture: WorkerFixture) => Promise<T>,
): Promise<T> {
  const stack = await upPostgresStack("output-ingestion");
  const names = ["DATABASE_URL", "BAKERY_APP_DATABASE_URL"] as const;
  const previous: Record<string, string | undefined> = {};
  const values = {
    DATABASE_URL: stack.ownerDatabaseUrl,
    BAKERY_APP_DATABASE_URL: stack.appDatabaseUrl,
  };
  let result: T | undefined;
  let callbackFailed = false;
  let callbackError: unknown;
  let cleanupError: unknown;
  try {
    for (const name of names) {
      previous[name] = Deno.env.get(name);
      Deno.env.set(name, values[name]);
    }
    result = await withWorkerFixture(callback);
  } catch (error) {
    callbackFailed = true;
    callbackError = error;
  } finally {
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
    try {
      await stack.down();
    } catch (error) {
      cleanupError = error;
    }
  }
  if (callbackFailed) {
    if (cleanupError !== undefined) {
      throw new AggregateError(
        [callbackError, cleanupError],
        "OUTPUT_FIXTURE_CLEANUP_FAILED",
      );
    }
    throw callbackError;
  }
  if (cleanupError !== undefined) throw cleanupError;
  return result as T;
}

integrationTests(withOutputFixture);
replayHarnessTests(withOutputFixture);
transcriptIntegrationTests(withOutputFixture);
