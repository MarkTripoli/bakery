import { assert, assertEquals } from "@std/assert";
import { Hono } from "hono";
import { readRuntimeConfig } from "../../packages/config/src/env.ts";
import { mainRouter } from "../../apps/server/src/main.ts";
import { createPreviewHostDispatch } from "../../apps/server/src/modules/knowledge/previews/index.ts";
import {
  isPreviewableMediaType,
  PREVIEW_SESSION_TTL_SECONDS,
  previewCookieName,
  previewSessionCookie,
  randomPreviewSecret,
  readPreviewCookie,
} from "../../apps/server/src/modules/knowledge/previews/shared.ts";

const sessionId = "0b8d6a8e-5f3a-4a2e-9d0e-6c1f3b1b6f11";
const secret = randomPreviewSecret();

function config(env: Record<string, string>) {
  return readRuntimeConfig({
    BAKERY_ENV: "test",
    BAKERY_APP_DATABASE_URL: "postgres://u:p@127.0.0.1:5432/bakery",
    BETTER_AUTH_SECRET: "unit-secret-0123456789abcdef0123456789",
    ...env,
  });
}

Deno.test("a preview origin must not share a host with the app or its trusted origins", () => {
  const base = { BAKERY_PUBLIC_BASE_URL: "https://bakery.example" };
  assertEquals(config(base).artifactPreviewOrigin, undefined);
  assertEquals(
    config({
      ...base,
      BAKERY_ARTIFACT_PREVIEW_ORIGIN: "https://preview.bakery.example",
    }).artifactPreviewOrigin,
    "https://preview.bakery.example",
  );
  for (
    const [name, env] of Object.entries<Record<string, string>>({
      "the public origin": {
        BAKERY_ARTIFACT_PREVIEW_ORIGIN: "https://bakery.example",
      },
      "the public host on another port": {
        BAKERY_ARTIFACT_PREVIEW_ORIGIN: "https://bakery.example:8443",
      },
      "the public host with a trailing dot": {
        BAKERY_ARTIFACT_PREVIEW_ORIGIN: "https://bakery.example.",
      },
      "the public host in another case": {
        BAKERY_ARTIFACT_PREVIEW_ORIGIN: "https://BAKERY.example",
      },
      "a trusted host with a trailing dot": {
        BETTER_AUTH_TRUSTED_ORIGINS:
          "https://bakery.example,https://other.example",
        BAKERY_ARTIFACT_PREVIEW_ORIGIN: "https://other.example.",
      },
      "a trusted origin": {
        BETTER_AUTH_TRUSTED_ORIGINS:
          "https://bakery.example,https://other.example",
        BAKERY_ARTIFACT_PREVIEW_ORIGIN: "https://other.example",
      },
      "a trusted host on another port": {
        BETTER_AUTH_TRUSTED_ORIGINS:
          "https://bakery.example,https://other.example",
        BAKERY_ARTIFACT_PREVIEW_ORIGIN: "https://other.example:9443",
      },
      "plain http off loopback": {
        BAKERY_ARTIFACT_PREVIEW_ORIGIN: "http://preview.bakery.example",
      },
      "a path": {
        BAKERY_ARTIFACT_PREVIEW_ORIGIN: "https://preview.bakery.example/x",
      },
      "a wildcard": {
        BAKERY_ARTIFACT_PREVIEW_ORIGIN: "https://*.bakery.example",
      },
    })
  ) {
    const result = config({ ...base, ...env });
    assert(
      result.invalidConfig.includes("BAKERY_ARTIFACT_PREVIEW_ORIGIN"),
      name,
    );
    assertEquals(result.artifactPreviewOrigin, undefined, name);
  }
  assertEquals(
    config({
      BAKERY_PUBLIC_BASE_URL: "http://127.0.0.1:8000",
      BAKERY_ARTIFACT_PREVIEW_ORIGIN: "http://localhost:8000",
    }).artifactPreviewOrigin,
    "http://localhost:8000",
  );
});

Deno.test("a same-site subdomain preview cookie is host only, view scoped and secure", () => {
  const origin = "https://preview.bakery.example";
  assertEquals(previewCookieName(origin), "__Secure-bakery_artifact_preview");
  const cookie = previewSessionCookie(origin, sessionId, secret);
  const attributes = cookie.split("; ");
  assertEquals(
    attributes[0],
    `__Secure-bakery_artifact_preview=${secret}`,
  );
  for (
    const required of [
      "HttpOnly",
      "Secure",
      "SameSite=Lax",
      `Path=/artifact-preview/view/${sessionId}`,
      `Max-Age=${PREVIEW_SESSION_TTL_SECONDS}`,
    ]
  ) assert(attributes.includes(required), required);
  // Host only: a Domain attribute would hand the cookie to sibling hosts.
  assert(!/domain=/i.test(cookie));
  assert(!cookie.startsWith("__Host-"));
  assertEquals(PREVIEW_SESSION_TTL_SECONDS <= 300, true);
});

Deno.test("loopback http uses the plain cookie name without Secure", () => {
  const origin = "http://localhost:8789";
  assertEquals(previewCookieName(origin), "bakery_artifact_preview");
  const attributes = previewSessionCookie(origin, sessionId, secret).split(
    "; ",
  );
  assert(!attributes.includes("Secure"));
  assert(attributes.includes("HttpOnly"));
  assert(attributes.includes("SameSite=Lax"));
});

Deno.test("only the preview cookie is read, once, and only in its exact shape", () => {
  const origin = "https://preview.bakery.example";
  const name = previewCookieName(origin);
  assertEquals(
    readPreviewCookie(origin, `bakery_session=abc; ${name}=${secret}; x=y`),
    secret,
  );
  assertEquals(readPreviewCookie(origin, "bakery_session=abc"), null);
  assertEquals(readPreviewCookie(origin, null), null);
  assertEquals(
    readPreviewCookie(origin, `${name}=${secret}; ${name}=${secret}`),
    null,
  );
  assertEquals(readPreviewCookie(origin, `${name}=short`), null);
  assertEquals(
    readPreviewCookie(origin, `bakery_artifact_preview=${secret}`),
    null,
  );
});

function dispatchApp(previewOrigin: string | undefined) {
  const app = new Hono();
  app.use(
    "*",
    createPreviewHostDispatch(
      previewOrigin,
      previewOrigin
        ? () => Promise.resolve(new Response("preview", { status: 200 }))
        : undefined,
    ),
  );
  app.all("*", (context) => context.text("app"));
  return app;
}

Deno.test("host dispatch sends the preview host to the preview handler and nowhere else", async () => {
  const app = dispatchApp("https://preview.bakery.example");
  const get = async (url: string) => {
    const response = await app.fetch(new Request(url));
    return [response.status, await response.text()] as const;
  };
  assertEquals(
    await get("https://preview.bakery.example/artifact-preview/exchange"),
    [200, "preview"],
  );
  // Everything on the preview host is the preview handler's, including paths
  // it will answer 404 itself: no application route is reachable there.
  assertEquals(await get("https://preview.bakery.example/v1/artifacts"), [
    200,
    "preview",
  ]);
  // The sibling application host serves the app but not the preview routes.
  assertEquals(await get("https://bakery.example/v1/artifacts"), [200, "app"]);
  assertEquals(
    (await get("https://bakery.example/artifact-preview/exchange"))[0],
    404,
  );
  assertEquals(
    (await get(`https://bakery.example/artifact-preview/view/${sessionId}`))[0],
    404,
  );
  // The hostname names the isolated origin; a proxy-presented port does not
  // move a request off it.
  assertEquals(
    (await get("https://preview.bakery.example:8443/v1/artifacts"))[1],
    "preview",
  );
  // Host matching is case-insensitive through URL normalization.
  assertEquals(
    (await get("https://PREVIEW.bakery.example/x"))[1],
    "preview",
  );
});

Deno.test("without a preview origin the preview paths do not exist on any host", async () => {
  const app = dispatchApp(undefined);
  for (
    const url of [
      "https://bakery.example/artifact-preview/exchange",
      "https://preview.bakery.example/artifact-preview/exchange",
      `https://preview.bakery.example/artifact-preview/view/${sessionId}`,
    ]
  ) {
    assertEquals((await app.fetch(new Request(url))).status, 404, url);
  }
  assertEquals(
    await (await app.fetch(new Request("https://bakery.example/x"))).text(),
    "app",
  );
});

Deno.test("only inert media types are previewable", () => {
  for (
    const type of [
      "text/html",
      "text/html; charset=utf-8",
      "image/svg+xml",
      "image/png",
      "text/plain",
      "text/markdown",
      "application/json",
    ]
  ) assert(isPreviewableMediaType(type), type);
  for (
    const type of [
      "application/javascript",
      "text/javascript",
      "application/wasm",
      "application/xhtml+xml",
      "application/pdf",
      "application/octet-stream",
    ]
  ) assert(!isPreviewableMediaType(type), type);
});

Deno.test("preview host match ignores case, port and a trailing dot", async () => {
  const app = dispatchApp("https://preview.example.test");
  const hits = async (url: string) =>
    await (await app.fetch(new Request(url))).text();
  for (
    const url of [
      "https://preview.example.test/x",
      "http://preview.example.test:443/x",
      "http://PREVIEW.example.test./x",
      "https://preview.example.test:8443/x",
    ]
  ) assertEquals(await hits(url), "preview", url);
  assertEquals(await hits("https://bakery.example/x"), "app");
  // A sibling or look-alike name is not the preview host.
  assertEquals(await hits("https://evil-preview.example.test/x"), "app");
  assertEquals(await hits("https://preview.example.test.evil.test/x"), "app");
});

Deno.test("the listener router normalizes the preview host the same way", async () => {
  const stub = (name: string) => ({
    fetch: () => Promise.resolve(new Response(name)),
  });
  const router = mainRouter(
    { cleanup: stub("cleanup"), control: stub("control"), app: stub("app") },
    { previewOrigin: "https://preview.example.test" },
  );
  const info = {
    remoteAddr: { transport: "tcp", hostname: "127.0.0.1", port: 1 },
  } as { remoteAddr: Deno.Addr };
  const routed = async (url: string) =>
    await (await router(new Request(url), info)).text();
  // Execution control and worker cleanup paths would leave the app route on
  // any other host; on the preview host, in any spelling, they stay on the app
  // whose preview dispatch answers 404.
  for (
    const url of [
      "https://preview.example.test/v1/execution/attempts/x/heartbeat",
      "http://preview.example.test:443/v1/execution/attempts/x",
      "http://PREVIEW.example.test./v1/worker/attempts/x/cleanup",
      "https://preview.example.test:8443/v1/worker/attempts/x/cleanup",
    ]
  ) assertEquals(await routed(url), "app", url);
  assertEquals(
    await routed("https://bakery.example/v1/execution/attempts/x/heartbeat"),
    "control",
  );
  assertEquals(
    await routed("https://bakery.example/v1/worker/attempts/x/cleanup"),
    "cleanup",
  );
  assertEquals(
    await routed(
      "https://preview.example.test.evil.test/v1/execution/attempts/x",
    ),
    "control",
  );
});
