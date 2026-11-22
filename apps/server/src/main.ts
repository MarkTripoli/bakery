import {
  assertRuntimeConfig,
  readDatabaseConfig,
  readRuntimeConfig,
  type RuntimeConfig,
  type TrustedProxies,
} from "@bakery/config";
import { boundedShutdown } from "@bakery/contracts/shutdown";
import { installProblemErrorReporter } from "@bakery/contracts/http";
import { initializeDenoMonitoring } from "@bakery/config/sentry-deno";
import { createReadyAuthProvider } from "./modules/auth/index.ts";
import { createPostgresAuthPersistence } from "./modules/auth/adapters/postgres.ts";
import { createBrowserSessionMiddleware } from "./modules/auth/middleware.ts";
import {
  createExecutionControlApp,
  createExecutionWorkerCleanupApp,
} from "./modules/execution/control.ts";
import { createApp } from "./app.ts";
import {
  createServerTelemetryFromConfig,
  SERVER_TELEMETRY_CLOSE_MS,
} from "./platform/telemetry.ts";
import { createAlertEvaluator } from "./modules/monitoring/alert-evaluator.ts";
import { createDestinationLoader } from "./modules/monitoring/destination-loader.ts";
import {
  createDestinationFanout,
  createPinnedFetch,
  createProviderRegistry,
  createPublicHttpsPolicy,
  otlpProvider,
} from "./platform/telemetry-destinations/index.ts";
import {
  startOperationalMetricSampling,
  stopSamplingThenCloseTelemetry,
} from "./platform/operational-metrics.ts";
import {
  isPreviewRequestHost,
  previewHostname,
} from "./modules/knowledge/previews/shared.ts";
import { resolveClientAddress } from "./platform/client-address.ts";

import { createPostgresInstallationSettingsReader } from "./modules/auth/adapters/installation-settings-postgres.ts";
import { createEventsSocketRegistry } from "./modules/work/events-socket.ts";
import {
  assertApplicationDatabase,
  closeDatabase,
  closePgDatabase,
  openDatabase,
  openPgDatabase,
  SERVER_POOL_MAX,
} from "./platform/database.ts";

export type MainRouteName = "cleanup" | "control" | "app";

export function selectMainRoute(pathname: string): MainRouteName {
  if (
    pathname.startsWith("/v1/worker/attempts/") &&
    pathname.endsWith("/cleanup")
  ) return "cleanup";
  if (pathname.startsWith("/v1/execution/attempts/")) return "control";
  return "app";
}

type MainFetchApp = {
  fetch(
    request: Request,
    options?: unknown,
  ): Response | Promise<Response>;
};

export function createSecretIdentityProviderFixtureFetch(
  config: RuntimeConfig,
): typeof fetch | undefined {
  const fixture = config.secretIdentityProviderFixture;
  if (!fixture) return undefined;
  if (config.environment === "production") {
    throw new Error("SECRET_IDENTITY_PROVIDER_FIXTURE_FORBIDDEN");
  }
  let calls = 0;
  return async (input, init) => {
    if (
      String(input) !== "https://api.github.com/user" ||
      init?.method !== "GET" || init?.redirect !== "error" ||
      !new Headers(init.headers).get("Authorization")?.startsWith("Bearer ")
    ) throw new Error("SECRET_IDENTITY_PROVIDER_FIXTURE_REQUEST_INVALID");
    const stat = await Deno.stat(fixture.file);
    if (!stat.isFile || stat.size < 2 || stat.size > 65_536) {
      throw new Error("SECRET_IDENTITY_PROVIDER_FIXTURE_FILE_INVALID");
    }
    const body = await Deno.readFile(fixture.file);
    calls += 1;
    console.log(JSON.stringify({
      event: "CONTROLLED_SECRET_IDENTITY_PROVIDER_IO",
      provider: "github-fixture-not-connected",
      call: calls,
    }));
    return new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

export function mainRouter(apps: {
  cleanup: MainFetchApp;
  control: MainFetchApp;
  app: MainFetchApp;
}, options: {
  trustedProxies?: TrustedProxies;
  /** Validated preview origin; its host never reaches control or cleanup. */
  previewOrigin?: string;
} = {}): (
  request: Request,
  info: { remoteAddr: Deno.Addr },
) => Response | Promise<Response> {
  const previewHost = options.previewOrigin
    ? previewHostname(options.previewOrigin)
    : undefined;
  return (request, info) => {
    const url = new URL(request.url);
    // The isolated preview host is dispatched before any path routing so the
    // control and cleanup APIs do not exist there. createApp answers it with
    // the two preview routes and a bare 404 for everything else.
    if (isPreviewRequestHost(url, previewHost)) {
      return apps.app.fetch(request);
    }
    const route = selectMainRoute(url.pathname);
    if (route === "cleanup") return apps.cleanup.fetch(request);
    if (route === "control") return apps.control.fetch(request);
    // Only the public app route keys per-client limits; the control and
    // cleanup routes never read a client address.
    const remoteAddr = info.remoteAddr.transport === "tcp"
      ? resolveClientAddress(
        info.remoteAddr,
        request.headers,
        options.trustedProxies,
      )
      : info.remoteAddr;
    return apps.app.fetch(request, { remoteAddr });
  };
}

async function main(): Promise<void> {
  const config = readRuntimeConfig(undefined, "server");
  assertRuntimeConfig(config);
  const monitoring = await initializeDenoMonitoring(
    config.sentry,
    "server",
    config.publicBaseUrl,
  );
  const stopReporting = installProblemErrorReporter(monitoring.capture);
  try {
    await runServer(config);
  } catch (error) {
    monitoring.capture(error);
    throw error;
  } finally {
    stopReporting();
    await monitoring.close();
  }
}

async function runServer(config: RuntimeConfig): Promise<void> {
  const databaseConfig = readDatabaseConfig();
  const database = openDatabase(databaseConfig.url);
  const pgDatabase = openPgDatabase(databaseConfig.url, SERVER_POOL_MAX);
  try {
    await assertApplicationDatabase(pgDatabase);
  } catch (error) {
    await Promise.all([closePgDatabase(pgDatabase), closeDatabase(database)]);
    throw error;
  }
  const authPersistence = createPostgresAuthPersistence(pgDatabase);
  const installationSettings = createPostgresInstallationSettingsReader(
    pgDatabase,
  );
  if (!config.auth) throw new Error("AUTH_CONFIG_REQUIRED");
  let auth: Awaited<ReturnType<typeof createReadyAuthProvider>>;
  try {
    await installationSettings.current();
    auth = await createReadyAuthProvider({
      pgDatabase,
      config: config.auth,
      persistence: authPersistence,
      installationSettings,
    });
  } catch (error) {
    await Promise.all([closePgDatabase(pgDatabase), closeDatabase(database)]);
    throw error;
  }
  const browserSession = createBrowserSessionMiddleware({
    auth,
    store: authPersistence,
    publicBaseUrl: config.publicBaseUrl,
    trustedOrigins: config.auth.trustedOrigins,
    secret: config.auth.secret,
  });
  const eventsSocketRegistry = createEventsSocketRegistry();
  const secretsFetch = createSecretIdentityProviderFixtureFetch(config);
  // The sink comes from configuration: rotated structured logs, an optional OTLP
  // destination, or neither. With neither, export stays disabled and an event
  // costs a counter and nothing is queued - the behaviour before this slice.
  // Read with the rest of the runtime configuration, so the app never reads the
  // environment itself (#306).
  // Destinations are saved in the app, so the fan-out starts empty and the loader
  // fills it from the database and keeps it current.
  const telemetryRegistry = createProviderRegistry([otlpProvider]);
  const telemetryDeliveryDependencies = {
    fetch: createPinnedFetch(),
    addressPolicy: createPublicHttpsPolicy(),
  };
  const destinationFanout = createDestinationFanout({
    registry: telemetryRegistry,
    dependencies: telemetryDeliveryDependencies,
  });
  const destinationLoader = createDestinationLoader({
    database: pgDatabase,
    secretsKey: config.secretsKey,
    fanout: destinationFanout,
  });
  const telemetry = createServerTelemetryFromConfig(config.telemetry, {
    destinations: destinationFanout.send,
  });
  destinationLoader.start();
  // The five alert rules are checked on a timer; what changes goes to the
  // enabled alert channels, signed.
  const alertEvaluator = createAlertEvaluator({
    database: pgDatabase,
    secretsKey: config.secretsKey,
    // The pinned fetch, so a name re-pointed after the address check cannot
    // send a signed alert to an internal address.
    fetch: telemetryDeliveryDependencies.fetch,
    addressPolicy: telemetryDeliveryDependencies.addressPolicy,
    fanout: destinationFanout,
  });
  alertEvaluator.start();
  // Sampling the ledger is what puts an application metric in the registry at
  // all; before this, the registry held zero series and nothing flushed.
  const operationalMetrics = startOperationalMetricSampling({
    // The Postgres pool, not the tagged-template client: the sample is one raw
    // aggregate, and it must not join a caller's transaction.
    database: pgDatabase,
    telemetry,
    // Per-destination export failures are counted by the sink and published from
    // here, because a metric write from inside the sink is refused as reentrant.
    sink: telemetry.sink,
  });
  const app = createApp({
    telemetryDestinations: {
      registry: telemetryRegistry,
      fanout: destinationFanout,
      providerDependencies: telemetryDeliveryDependencies,
      secretsKey: config.secretsKey,
      // Soon after a save, the running server picks the change up.
      refresh: () => {
        setTimeout(() => void destinationLoader.refresh(), 300);
      },
    },
    telemetry,
    config,
    database,
    pgDatabase,
    auth,
    authPersistence,
    installationSettings,
    secretsFetch,
    eventsSocket: { registry: eventsSocketRegistry },
  });
  const executionControlApp = createExecutionControlApp({
    database: pgDatabase,
    browserSession,
    publicBaseUrl: config.publicBaseUrl,
    secret: config.auth.secret,
  });
  const executionWorkerCleanupApp = createExecutionWorkerCleanupApp({
    database: pgDatabase,
    publicBaseUrl: config.publicBaseUrl,
    secret: config.auth.secret,
  });
  const server = Deno.serve(
    { hostname: config.host, port: config.port },
    mainRouter({
      cleanup: executionWorkerCleanupApp,
      control: executionControlApp,
      app,
    }, {
      trustedProxies: config.trustedProxies,
      previewOrigin: config.artifactPreviewOrigin,
    }),
  );

  let shutdownPromise: Promise<void> | undefined;
  function shutdown(): Promise<void> {
    return shutdownPromise ??= boundedShutdown(
      async () => {
        try {
          eventsSocketRegistry.closeAll(1001, "server shutdown");
          await server.shutdown();
        } finally {
          destinationLoader.stop();
          alertEvaluator.stop();
          // Stop sampling before the final flush, so the last metric record is
          // the last sample rather than a reading of a database already closing.
          await stopSamplingThenCloseTelemetry({
            sampling: operationalMetrics,
            closeTelemetry: () =>
              telemetry.close(SERVER_TELEMETRY_CLOSE_MS).catch(() => {}),
          });
          await destinationFanout.close(SERVER_TELEMETRY_CLOSE_MS).catch(
            () => {},
          );
          await Promise.all([
            closePgDatabase(pgDatabase),
            closeDatabase(database),
          ]);
        }
      },
      5_000,
      () => Deno.exit(1),
    );
  }
  const stop = () => {
    void shutdown();
  };
  Deno.addSignalListener("SIGTERM", stop);
  Deno.addSignalListener("SIGINT", stop);
  try {
    await server.finished;
  } finally {
    Deno.removeSignalListener("SIGTERM", stop);
    Deno.removeSignalListener("SIGINT", stop);
    await shutdown();
  }
}

if (import.meta.main) await main();
