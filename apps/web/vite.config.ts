import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { defineConfig, loadEnv, type ProxyOptions } from "vite";
import { readSentryConfig } from "@bakery/config/sentry";
import { readSentrySourcemapUpload } from "@bakery/config/sentry-build";
import { sentryVitePlugin } from "@sentry/vite-plugin";

const appRoot = fileURLToPath(new URL(".", import.meta.url));

function proxyConfiguration(target: string): Record<string, ProxyOptions> {
  return Object.fromEntries(
    [
      "/health",
      "/livez",
      "/readyz",
      "/v1",
      "/api",
      "/mcp",
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-authorization-server",
    ].map((path) => [
      path,
      { target, ws: path === "/v1" },
    ]),
  );
}

export default defineConfig(({ mode, command }) => {
  const env = { ...loadEnv(mode, appRoot, ""), ...process.env };
  const host = env.BAKERY_WEB_HOST || "127.0.0.1";
  const port = Number(env.BAKERY_WEB_PORT || "5173");
  const serverHost = env.BAKERY_SERVER_HOST || "127.0.0.1";
  const serverPort = env.BAKERY_SERVER_PORT || "8000";
  const proxy = proxyConfiguration(`http://${serverHost}:${serverPort}`);
  const telemetry = readSentryConfig(
    env,
    "web",
    env.BAKERY_ENV === "test" || mode === "test"
      ? "test"
      : command === "build"
      ? "production"
      : "development",
  );
  // Reporting and upload are separate decisions. Telemetry on says the bundle
  // calls Sentry.init; SENTRY_UPLOAD_SOURCEMAPS says whether this build also
  // uploads maps, and an instrumented build must declare one way or the other
  // (packages/config/src/sentry-build.ts).
  const upload = readSentrySourcemapUpload(
    env,
    command === "build" && telemetry.enabled,
  );

  return {
    define: {
      "import.meta.env.BAKERY_ENV": JSON.stringify(
        env.BAKERY_ENV === "test" || mode === "test"
          ? "test"
          : command === "build"
          ? "production"
          : "development",
      ),
    },
    plugins: [
      react(),
      // `telemetry.enabled` is implied by upload; repeating it narrows the
      // config union so `telemetry.release` is readable below.
      ...(upload && telemetry.enabled
        ? [sentryVitePlugin({
          org: env.SENTRY_ORG,
          project: env.SENTRY_PROJECT,
          authToken: env.SENTRY_AUTH_TOKEN,
          telemetry: false,
          release: { name: telemetry.release, inject: false },
          sourcemaps: {
            assets: `${appRoot}dist/**`,
            filesToDeleteAfterUpload: [`${appRoot}dist/**/*.map`],
          },
        })]
        : []),
    ],
    build: { sourcemap: upload ? "hidden" : false },
    resolve: {
      alias: {
        "@bakery/ui": fileURLToPath(
          new URL("../../packages/ui/src/index.ts", import.meta.url),
        ),
      },
    },
    server: { host, port, strictPort: true, proxy },
    preview: { host, port, strictPort: true, proxy },
  };
});
