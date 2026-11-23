import { assertEquals, assertThrows } from "@std/assert";
import { ActionRegistry } from "../../packages/contracts/src/action-registry.ts";
import { createApiRouter } from "../../packages/contracts/src/http.ts";
import {
  compareSemver,
  type DesktopUpdateFeed,
  readDesktopUpdateFeed,
} from "../../packages/config/src/desktop-update-feed.ts";
import { readRuntimeConfig } from "../../packages/config/src/env.ts";
import { desktopUpdatesGetAction } from "../../apps/server/src/modules/auth/transport/http/v1/desktop-update-handler.ts";
import { createApp } from "../../apps/server/src/app.ts";
import { signSessionCookie } from "../helpers/auth.ts";

const PRINCIPAL_ID = "00000000-0000-4000-8000-000000000077";

const release = {
  version: "1.4.0",
  pub_date: "2026-11-20T09:00:00Z",
  url: "https://releases.example.test/bakery_1.4.0_amd64.deb",
  signature: "untrusted comment: signature from minisign secret key\nRWQ=",
  notes: "Faster start.",
};
const feed: DesktopUpdateFeed = { "linux-x86_64": release };

function app(configured: DesktopUpdateFeed | undefined, signedIn = true) {
  const registry = new ActionRegistry();
  registry.register(desktopUpdatesGetAction(configured));
  return createApiRouter({
    registry,
    createContext: () =>
      signedIn
        ? {
          principal: {
            principalId: PRINCIPAL_ID,
            principalType: "human",
            displayName: "Ana",
          },
          transport: "http",
        } as never
        : {} as never,
  });
}

function ask(
  configured: DesktopUpdateFeed | undefined,
  query: string,
  signedIn = true,
) {
  return app(configured, signedIn).fetch(
    new Request(`http://server.test/v1/desktop/update?${query}`),
  );
}

Deno.test("a newer build for the caller's target is offered with 200", async () => {
  const response = await ask(
    feed,
    "target=linux&arch=x86_64&current_version=1.3.2",
  );
  assertEquals(response.status, 200);
  assertEquals(await response.json(), release);
});

Deno.test("the same version answers 204 with no body", async () => {
  const response = await ask(
    feed,
    "target=linux&arch=x86_64&current_version=1.4.0",
  );
  assertEquals(response.status, 204);
  assertEquals(await response.text(), "");
});

Deno.test("a newer app than the feed answers 204, never a downgrade", async () => {
  const response = await ask(
    feed,
    "target=linux&arch=x86_64&current_version=1.5.0",
  );
  assertEquals(response.status, 204);
  await response.body?.cancel();
});

Deno.test("a prerelease of the offered version is offered the release", async () => {
  const response = await ask(
    feed,
    "target=linux&arch=x86_64&current_version=1.4.0-beta.2",
  );
  assertEquals(response.status, 200);
  await response.body?.cancel();
});

Deno.test("a target or arch without a build answers 204", async () => {
  for (
    const query of [
      "target=darwin&arch=aarch64&current_version=1.0.0",
      "target=linux&arch=aarch64&current_version=1.0.0",
    ]
  ) {
    const response = await ask(feed, query);
    assertEquals(response.status, 204, query);
    await response.body?.cancel();
  }
});

Deno.test("an unknown platform or malformed version is refused", async () => {
  for (
    const query of [
      "target=solaris&arch=x86_64&current_version=1.0.0",
      "target=linux&arch=mips&current_version=1.0.0",
      "target=linux&arch=x86_64&current_version=1.0",
      "target=linux&arch=x86_64&current_version=v1.0.0",
      "target=linux&arch=x86_64",
    ]
  ) {
    const response = await ask(feed, query);
    const body = await response.json() as { code?: string };
    assertEquals(response.status, 400, query);
    assertEquals(body.code, "MALFORMED_REQUEST", query);
  }
});

Deno.test("a server without a feed answers 404", async () => {
  const response = await ask(
    undefined,
    "target=linux&arch=x86_64&current_version=1.0.0",
  );
  assertEquals(response.status, 404);
  assertEquals(
    (await response.json() as { code?: string }).code,
    "RESOURCE_NOT_FOUND",
  );
});

// In the app the session middleware answers 401 before the action runs; the
// action's own guard still refuses a request that reaches it unresolved.
Deno.test("an anonymous caller is refused", async () => {
  const response = await ask(
    feed,
    "target=linux&arch=x86_64&current_version=1.0.0",
    false,
  );
  assertEquals(response.status, 403);
  await response.body?.cancel();
});

Deno.test("semver precedence follows the specification", () => {
  const ordered = [
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "1.0.0-beta",
    "1.0.0-beta.2",
    "1.0.0-beta.11",
    "1.0.0-rc.1",
    "1.0.0",
    "1.0.1",
    "1.10.0",
    "2.0.0",
  ];
  for (let index = 1; index < ordered.length; index += 1) {
    assertEquals(compareSemver(ordered[index - 1], ordered[index]), -1);
    assertEquals(compareSemver(ordered[index], ordered[index - 1]), 1);
  }
  assertEquals(compareSemver("1.0.0+build.1", "1.0.0+build.2"), 0);
  assertThrows(() => compareSemver("1.0", "1.0.0"), Error, "SEMVER_INVALID");
});

Deno.test("the feed file is validated when it is read", () => {
  const read = (text: string) => () => text;
  assertEquals(readDesktopUpdateFeed(undefined), undefined);
  assertEquals(readDesktopUpdateFeed("  "), undefined);
  assertEquals(
    readDesktopUpdateFeed("/feed.json", read(JSON.stringify(feed))),
    feed,
  );
  for (
    const bad of [
      "{not json",
      JSON.stringify({
        "linux-x86_64": { ...release, url: "http://insecure.test/b.deb" },
      }),
      JSON.stringify({ "linux-mips": release }),
      JSON.stringify({ "linux-x86_64": { ...release, version: "1.4" } }),
      JSON.stringify({ "linux-x86_64": { ...release, extra: true } }),
    ]
  ) {
    assertThrows(
      () => readDesktopUpdateFeed("/feed.json", read(bad)),
      Error,
      "DESKTOP_UPDATE_FEED_INVALID",
    );
  }
});

Deno.test("RuntimeConfig carries the feed and refuses a bad one at start-up", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const good = `${directory}/good.json`;
    const bad = `${directory}/bad.json`;
    await Deno.writeTextFile(good, JSON.stringify(feed));
    await Deno.writeTextFile(
      bad,
      JSON.stringify({ "linux-x86_64": { ...release, url: "http://x.test" } }),
    );
    const base = {
      BETTER_AUTH_SECRET: "x".repeat(32),
      DATABASE_URL: "postgres://bakery@localhost/bakery",
    };
    const configured = readRuntimeConfig({
      ...base,
      BAKERY_DESKTOP_UPDATE_FEED_FILE: good,
    }, "server");
    assertEquals(configured.desktopUpdateFeed, feed);
    assertEquals(
      configured.invalidConfig.includes("BAKERY_DESKTOP_UPDATE_FEED_FILE"),
      false,
    );
    const refused = readRuntimeConfig({
      ...base,
      BAKERY_DESKTOP_UPDATE_FEED_FILE: bad,
    }, "server");
    assertEquals(refused.desktopUpdateFeed, undefined);
    assertEquals(
      refused.invalidConfig.includes("BAKERY_DESKTOP_UPDATE_FEED_FILE"),
      true,
    );
    assertEquals(
      readRuntimeConfig(base, "server").desktopUpdateFeed,
      undefined,
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

// The tests above build the route by hand. This one goes through the app the
// server runs: the feed comes from RuntimeConfig, and the caller is known only
// through the session middleware. Dropping either hand-off fails it.
Deno.test("the running app serves the configured feed to a signed-in caller only", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const feedFile = `${directory}/feed.json`;
    await Deno.writeTextFile(feedFile, JSON.stringify(feed));
    const secret = "d".repeat(32);
    const token = "desktop-update-session";
    const expiresAt = new Date(Date.now() + 60_000);
    const noDatabase = () =>
      Promise.reject(new Error("no database in this test"));
    const runningApp = (env: Record<string, string>) =>
      createApp({
        config: readRuntimeConfig({
          BAKERY_APP_DATABASE_URL: "postgres://app@127.0.0.1:5432/bakery",
          BETTER_AUTH_SECRET: secret,
          ...env,
        }, "server"),
        database: {} as never,
        pgDatabase: { query: noDatabase, connect: noDatabase } as never,
        auth: {
          api: {
            getSession: ({ headers }: { headers: Headers }) =>
              Promise.resolve(
                headers.has("cookie")
                  ? {
                    session: { expiresAt },
                    user: {
                      id: "u-77",
                      name: "Ana",
                      email: "ana@example.test",
                    },
                  }
                  : null,
              ),
          },
          handler: () => new Response(null, { status: 404 }),
        } as never,
        authPersistence: {
          findSessionState: () =>
            Promise.resolve({
              id: token,
              expiresAt,
              twoFactorEnabled: false,
              factorVerifiedAt: null,
            }),
          loadEnabledPrincipal: () =>
            Promise.resolve({
              principalId: PRINCIPAL_ID,
              principalType: "human",
              displayName: "Ana",
            }),
        } as never,
        installationSettings: { current: noDatabase } as never,
      });
    const url =
      "http://localhost:8000/v1/desktop/update?target=linux&arch=x86_64&current_version=1.3.2";
    const cookie = await signSessionCookie(token, secret);

    const configured = runningApp({
      BAKERY_DESKTOP_UPDATE_FEED_FILE: feedFile,
    });
    const signedIn = await configured.fetch(
      new Request(url, { headers: { cookie } }),
    );
    assertEquals(signedIn.status, 200);
    assertEquals(await signedIn.json(), release);

    const anonymous = await configured.fetch(new Request(url));
    assertEquals(anonymous.status, 401);
    await anonymous.body?.cancel();

    const unconfigured = await runningApp({}).fetch(
      new Request(url, { headers: { cookie } }),
    );
    assertEquals(unconfigured.status, 404);
    await unconfigured.body?.cancel();
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
