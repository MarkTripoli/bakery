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
  createServerTelemetry,
  SERVER_TELEMETRY_CLOSE_MS,
} from "./platform/telemetry.ts";
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
  const pgDatabase = openPgDatabase(databaseConfig.url);
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
  // No sink yet: events cost a counter and nothing is queued. A sink is wired
  // by the slice that adds one, and nothing here depends on it.
  const telemetry = createServerTelemetry();
  const app = createApp({
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
          await telemetry.close(SERVER_TELEMETRY_CLOSE_MS).catch(() => {});
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
