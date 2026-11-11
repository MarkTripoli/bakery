import { runExecutionCoordinatorTask } from "./modules/execution/coordination.ts";
import { runOutboxDispatchTask } from "./platform/outbox-dispatch-task.ts";
import { readEnvironmentSnapshot } from "@bakery/config";
import {
  readSentryConfig,
  SENTRY_SERVER_ENVIRONMENT_NAMES,
} from "@bakery/config/sentry";
import { initializeDenoMonitoring } from "@bakery/config/sentry-deno";

const environment = readEnvironmentSnapshot([
  ...SENTRY_SERVER_ENVIRONMENT_NAMES,
  "BAKERY_ENV",
  "BAKERY_PUBLIC_BASE_URL",
]);
const monitoring = await initializeDenoMonitoring(
  readSentryConfig(
    environment,
    "server",
    environment.BAKERY_ENV ?? "development",
  ),
  "server",
  environment.BAKERY_PUBLIC_BASE_URL ?? "http://127.0.0.1:8000",
);
try {
  await Promise.all([
    runOutboxDispatchTask(),
    runExecutionCoordinatorTask(),
  ]);
} catch (error) {
  monitoring.capture(error);
  throw error;
} finally {
  await monitoring.close();
}
