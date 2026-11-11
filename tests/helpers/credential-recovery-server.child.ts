import process from "node:process";

// Better Auth reads NODE_ENV at module evaluation through node:process. Keep
// that compatibility hint in memory so the child retains its exact six-name
// Deno environment permission and receives no seventh ambient field.
Object.defineProperty(process, "env", {
  value: Object.freeze({ NODE_ENV: "test" }),
  configurable: true,
});

const [
  { createApp },
  { closeDatabase, closePgDatabase, openDatabase, openPgDatabase },
  { readRuntimeConfig },
] = await Promise.all([
  import("../../apps/server/src/app.ts"),
  import("../../apps/server/src/platform/database.ts"),
  import("../../packages/config/src/env.ts"),
]);

const TELEMETRY_PATH = "/__fixture/credential-recovery-telemetry";
const SHUTDOWN_PATH = "/__fixture/credential-recovery-shutdown";
const MAX_OBSERVED_BODY_BYTES = 65_536;

type SafeTelemetry = {
  targetAccepted: boolean;
  responseStatus: number | null;
  responseContentType: string | null;
  responseBodyBytes: number[];
  responseEof: boolean;
  upstreamCancelled: boolean;
  signalAborted: boolean;
};

function required(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`FIXTURE_ENV_REQUIRED:${name}`);
  return value;
}

const appDatabaseUrl = required("FIXTURE_APP_DATABASE_URL");
const providerUrl = required("FIXTURE_PROVIDER_URL");
const config = readRuntimeConfig({
  BAKERY_ENV: "test",
  BAKERY_APP_DATABASE_URL: appDatabaseUrl,
  BAKERY_PUBLIC_BASE_URL: required("FIXTURE_PUBLIC_BASE_URL"),
  BETTER_AUTH_SECRET: required("FIXTURE_BETTER_AUTH_SECRET"),
  BAKERY_SECRETS_KEY_FILE: required("FIXTURE_SECRETS_KEY_FILE"),
  BAKERY_SECRETS_KEY_ID: required("FIXTURE_SECRETS_KEY_ID"),
});
const database = openDatabase(appDatabaseUrl);
const pgDatabase = openPgDatabase(appDatabaseUrl);
let verifierSignal: AbortSignal | undefined;
const telemetry: Omit<SafeTelemetry, "signalAborted"> = {
  targetAccepted: false,
  responseStatus: null,
  responseContentType: null,
  responseBodyBytes: [],
  responseEof: false,
  upstreamCancelled: false,
};

async function forwardAndObserveControlledProviderResponse(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  verifierSignal = init?.signal ?? undefined;
  telemetry.targetAccepted = String(input) === "https://api.github.com/user" &&
    init?.method === "GET" && init.redirect === "error";
  if (!telemetry.targetAccepted) {
    throw new Error("CONTROLLED_PROVIDER_TARGET_INVALID");
  }
  const response = await fetch(providerUrl, {
    method: "GET",
    headers: init?.headers,
    redirect: "error",
    signal: init?.signal,
  });
  telemetry.responseStatus = response.status;
  telemetry.responseContentType = response.headers.get("content-type");
  if (!response.body) return response;
  const upstream = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const result = await upstream.read();
      if (result.done) {
        telemetry.responseEof = true;
        controller.close();
        upstream.releaseLock();
        return;
      }
      if (
        telemetry.responseBodyBytes.length + result.value.byteLength >
          MAX_OBSERVED_BODY_BYTES
      ) {
        controller.error(new Error("CONTROLLED_PROVIDER_BODY_TOO_LARGE"));
        await upstream.cancel();
        upstream.releaseLock();
        return;
      }
      telemetry.responseBodyBytes.push(...result.value);
      controller.enqueue(result.value);
    },
    async cancel(reason) {
      if (!telemetry.responseEof) telemetry.upstreamCancelled = true;
      await upstream.cancel(reason);
      upstream.releaseLock();
    },
  }, { highWaterMark: 0 });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

const app = createApp({
  config,
  database,
  pgDatabase,
  secretsFetch: forwardAndObserveControlledProviderResponse,
});
const server = Deno.serve({
  hostname: "127.0.0.1",
  port: 0,
  onListen: ({ port }) => {
    console.log(JSON.stringify({
      event: "CREDENTIAL_RECOVERY_SERVER_READY",
      port,
    }));
  },
}, (request) => {
  const path = new URL(request.url).pathname;
  if (path === TELEMETRY_PATH) {
    const safe: SafeTelemetry = {
      ...telemetry,
      signalAborted: verifierSignal?.aborted ?? false,
    };
    return Response.json(safe);
  }
  if (path === SHUTDOWN_PATH && request.method === "POST") {
    queueMicrotask(() => void server.shutdown());
    return new Response(null, { status: 204 });
  }
  return app.fetch(request);
});

try {
  await server.finished;
} finally {
  await Promise.all([
    closePgDatabase(pgDatabase),
    closeDatabase(database),
  ]);
}
