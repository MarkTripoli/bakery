import { assertEquals } from "@std/assert";
import {
  clearGitHubConnectHandoff,
  saveGitHubConnectHandoff,
  takeGitHubConnectUrl,
} from "../../apps/web/src/app/github-connect-handoff.ts";

const KEY = "bakery.githubConnect";
const ORGANIZATION = "00000000-0000-4000-8000-000000000001";
const NOW = Date.parse("2026-10-28T12:00:00.000Z");
const AUTHORIZE = "https://github.com/login/oauth/authorize?state=s";
const INSTALL = "https://github.com/apps/bakery/installations/new?state=s";

function hold(overrides: Record<string, unknown> = {}) {
  clearGitHubConnectHandoff();
  sessionStorage.setItem(
    KEY,
    JSON.stringify({
      organizationId: ORGANIZATION,
      expiresAt: "2026-10-28T12:10:00.000Z",
      authorizationUrl: AUTHORIZE,
      installationUrl: INSTALL,
      ...overrides,
    }),
  );
}

Deno.test("a continuation returns its link once and forgets the whole attempt", () => {
  hold();
  assertEquals(
    takeGitHubConnectUrl(ORGANIZATION, "authorizationUrl", NOW),
    AUTHORIZE,
  );
  assertEquals(sessionStorage.getItem(KEY), null);
  assertEquals(
    takeGitHubConnectUrl(ORGANIZATION, "installationUrl", NOW),
    null,
  );
  hold();
  assertEquals(
    takeGitHubConnectUrl(ORGANIZATION, "installationUrl", NOW),
    INSTALL,
  );
  assertEquals(sessionStorage.getItem(KEY), null);
});

Deno.test("an expired attempt yields nothing and is removed", () => {
  hold({ expiresAt: "2026-10-28T11:59:59.000Z" });
  assertEquals(
    takeGitHubConnectUrl(ORGANIZATION, "authorizationUrl", NOW),
    null,
  );
  assertEquals(sessionStorage.getItem(KEY), null);
  hold({ expiresAt: "not a date" });
  assertEquals(
    takeGitHubConnectUrl(ORGANIZATION, "authorizationUrl", NOW),
    null,
  );
});

Deno.test("another organization's attempt yields nothing and is removed", () => {
  hold();
  assertEquals(
    takeGitHubConnectUrl(
      "00000000-0000-4000-8000-000000000002",
      "authorizationUrl",
      NOW,
    ),
    null,
  );
  assertEquals(sessionStorage.getItem(KEY), null);
});

Deno.test("a stored link that does not point at github.com is never followed", () => {
  hold({ authorizationUrl: "https://evil.example/login/oauth/authorize" });
  assertEquals(
    takeGitHubConnectUrl(ORGANIZATION, "authorizationUrl", NOW),
    null,
  );
  hold({ installationUrl: "javascript:alert(1)" });
  assertEquals(
    takeGitHubConnectUrl(ORGANIZATION, "installationUrl", NOW),
    null,
  );
  sessionStorage.setItem(KEY, "{not json");
  assertEquals(
    takeGitHubConnectUrl(ORGANIZATION, "authorizationUrl", NOW),
    null,
  );
  assertEquals(sessionStorage.getItem(KEY), null);
});

Deno.test("saving keeps the attempt for this tab only", () => {
  clearGitHubConnectHandoff();
  assertEquals(
    saveGitHubConnectHandoff({
      organizationId: ORGANIZATION,
      expiresAt: "2026-10-28T12:10:00.000Z",
      authorizationUrl: AUTHORIZE,
      installationUrl: INSTALL,
    }),
    true,
  );
  assertEquals(
    JSON.parse(sessionStorage.getItem(KEY)!).installationUrl,
    INSTALL,
  );
  assertEquals(localStorage.length, 0);
  clearGitHubConnectHandoff();
});
