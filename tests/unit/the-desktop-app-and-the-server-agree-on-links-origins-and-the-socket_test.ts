import { assert, assertEquals } from "@std/assert";
import { DESKTOP_WEB_VIEW_ORIGINS } from "../../packages/config/src/env.ts";
import {
  DESKTOP_APP_LINK_REDIRECT,
  DESKTOP_CLIENT_ID,
  DESKTOP_SOCKET_PROTOCOL,
  desktopAuthorization,
} from "../../apps/server/src/modules/auth/domain/desktop-sign-in.ts";

// The desktop app is built outside this test's language, so its declared constants are read from
// its source. A change on either side without the other fails here, on any host.
const app = "infra/desktop-spike/app";
const rust = await Deno.readTextFile(`${app}/src-tauri/src/platform.rs`);
const conf = JSON.parse(
  await Deno.readTextFile(`${app}/src-tauri/tauri.conf.json`),
);
const web = await Deno.readTextFile(`${app}/web/app.js`);

function rustConst(name: string): string {
  const match = new RegExp(`pub const ${name}: &str = "([^"]+)";`).exec(rust);
  assert(match, `platform.rs declares ${name}`);
  return match[1];
}

Deno.test("the app asks the server for the app link and client it accepts", () => {
  assertEquals(rustConst("APP_LINK"), DESKTOP_APP_LINK_REDIRECT);
  assertEquals(rustConst("CLIENT_ID"), DESKTOP_CLIENT_ID);
});

Deno.test("the app registers the scheme of the link the server accepts", () => {
  const scheme = new URL(DESKTOP_APP_LINK_REDIRECT).protocol.replace(":", "");
  assertEquals(conf.plugins["deep-link"].desktop.schemes, [scheme]);
});

Deno.test("every origin a web view reports is one the server answers", () => {
  for (const name of ["ORIGIN_UNIX", "ORIGIN_WINDOWS"]) {
    assert(
      DESKTOP_WEB_VIEW_ORIGINS.includes(rustConst(name)),
      `${name} is in the server's desktop origins`,
    );
  }
});

Deno.test("the web view's socket offer is read as a credential by the server", () => {
  const protocol = /"(bakery\.desktop)"/.exec(web)?.[1];
  const carrier = /"(bakery\.credential\.)" \+ credential/.exec(web)?.[1];
  assertEquals(protocol, DESKTOP_SOCKET_PROTOCOL);
  assert(carrier, "the web view builds the carrier entry from the credential");
  const offer = `${protocol}, ${carrier}bkd_example`;
  const headers = new Headers({
    upgrade: "websocket",
    "sec-websocket-protocol": offer,
  });
  assertEquals(
    desktopAuthorization(headers, "/v1/events"),
    "Bearer bkd_example",
  );
  assertEquals(
    desktopAuthorization(headers, "/v1/collaboration"),
    "Bearer bkd_example",
  );
  // The carrier is read on the two socket routes and nowhere else.
  assertEquals(desktopAuthorization(headers, "/v1/me"), null);
  // ...and only on a real upgrade request.
  assertEquals(
    desktopAuthorization(
      new Headers({ "sec-websocket-protocol": offer }),
      "/v1/events",
    ),
    null,
  );
});

Deno.test("the web view names its organization in the socket address, since a socket has no headers", () => {
  assert(web.includes('"/v1/events?organizationId="'));
  assert(!/new WebSocket\([^)]*Bakery-Organization-Id/.test(web));
});
