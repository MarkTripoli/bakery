import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { installProblemErrorReporter } from "../../packages/contracts/src/http.ts";
import {
  sanitizeSentryError,
  sentryPrivacyOptions,
} from "../../packages/config/src/sentry-privacy.ts";
import { createWorkerScope } from "../helpers/worker-execution.ts";
import { previewFixture } from "../helpers/artifact-preview.ts";
import { createPreviewHostHandler } from "../../apps/server/src/modules/knowledge/previews/host.ts";
import {
  previewCookieName,
  previewSessionCookie,
} from "../../apps/server/src/modules/knowledge/previews/shared.ts";

Deno.test("another tenant can neither mint, close nor open a preview", async () => {
  const fixture = await previewFixture();
  try {
    const owned = await fixture.open();
    const other = await createWorkerScope(fixture, "preview-other", fixture);
    try {
      const mint = await fixture.appRequest(
        `/v1/artifact-versions/${fixture.versionId}/preview-grants`,
        { method: "POST", headers: { cookie: other.adminCookie } },
        other.organizationId,
      );
      assertEquals(mint.status, 404);
      const revoke = await fixture.appRequest(
        `/v1/artifact-preview-grants/${owned.grantId}`,
        {
          method: "DELETE",
          headers: {
            cookie: other.adminCookie,
            "idempotency-key": crypto.randomUUID(),
          },
        },
        other.organizationId,
      );
      assertEquals(revoke.status, 404);
      assertEquals((await owned.view()).status, 200);
    } finally {
      const { closeWorkerScope } = await import(
        "../helpers/worker-execution.ts"
      );
      await closeWorkerScope(fixture, other);
    }
  } finally {
    await fixture.closeRetention();
  }
});

Deno.test("only the grantor or an administrator closes a preview", async () => {
  const fixture = await previewFixture();
  const developer = await fixture.addDeveloper();
  try {
    const mint = await fixture.appRequest(
      `/v1/artifact-versions/${fixture.versionId}/preview-grants`,
      { method: "POST", headers: { cookie: developer.cookie } },
    );
    assertEquals(mint.status, 201);
    const { grantId, grant } = await mint.json();
    // A different developer cannot close it.
    const peer = await fixture.addDeveloper();
    try {
      const refused = await fixture.appRequest(
        `/v1/artifact-preview-grants/${grantId}`,
        {
          method: "DELETE",
          headers: {
            cookie: peer.cookie,
            "idempotency-key": crypto.randomUUID(),
          },
        },
      );
      assertEquals(refused.status, 403);
    } finally {
      await peer.remove();
    }
    const exchanged = await fixture.exchange(grant);
    assertEquals(exchanged.status, 303);
    const location = exchanged.headers.get("location")!;
    const cookie = exchanged.headers.get("set-cookie")!.split(";", 1)[0];
    const open = () => fixture.preview(location, { headers: { cookie } });
    assertEquals((await open()).status, 200);
    // The organization administrator closes someone else's preview.
    const closed = await fixture.revoke(grantId);
    assertEquals(closed.status, 204);
    assertEquals((await open()).status, 410);
    // Removing the grantor's membership also ends a fresh preview of theirs.
    const second = await (await fixture.appRequest(
      `/v1/artifact-versions/${fixture.versionId}/preview-grants`,
      { method: "POST", headers: { cookie: developer.cookie } },
    )).json();
    const again = await fixture.exchange(second.grant);
    const againCookie = again.headers.get("set-cookie")!.split(";", 1)[0];
    await fixture.pgDatabase.query(
      "delete from bakery.organization_memberships where principal_id = $1",
      [developer.principalId],
    );
    const lost = await fixture.preview(again.headers.get("location")!, {
      headers: { cookie: againCookie },
    });
    assertEquals(lost.status, 403);
  } finally {
    await developer.remove();
    await fixture.closeRetention();
  }
});

Deno.test("the preview host sends one exact header set and no CORS or cookie", async () => {
  const fixture = await previewFixture();
  try {
    const opened = await fixture.open();
    const view = await opened.view({ origin: "https://evil.example" });
    assertEquals(view.status, 200);
    const names = [...view.headers.keys()].sort();
    assertEquals(names, [
      "cache-control",
      "content-security-policy",
      "content-type",
      "cross-origin-opener-policy",
      "cross-origin-resource-policy",
      "link",
      "referrer-policy",
      "vary",
      "x-content-type-options",
    ]);
    assertEquals(view.headers.get("vary"), "Cookie");
    for (const name of names) assert(!name.startsWith("access-control-"), name);
    // The same set guards every notice page on the host.
    const notice = await fixture.preview("/artifact-preview/view/not-a-uuid");
    assertEquals(notice.status, 404);
    assertEquals(
      notice.headers.get("content-security-policy"),
      view.headers.get("content-security-policy"),
    );
    assertEquals(notice.headers.get("set-cookie"), null);
  } finally {
    await fixture.closeRetention();
  }
});

Deno.test("the preview origin is never a trusted or CORS origin of the app", async () => {
  const fixture = await previewFixture();
  try {
    const trusted = fixture.config.auth!.trustedOrigins;
    assert(!trusted.includes(fixture.previewOrigin));
    assertNotEquals(
      new URL(fixture.previewOrigin).hostname,
      new URL(fixture.appOrigin).hostname,
    );
    // The app's origin guard refuses a state change that claims the preview origin.
    const forged = await fixture.appRequest(
      `/v1/artifact-versions/${fixture.versionId}/preview-grants`,
      { method: "POST", headers: { origin: fixture.previewOrigin } },
    );
    assertEquals(forged.status, 403);
    const preflight = await fixture.appRequest("/v1/artifacts", {
      method: "OPTIONS",
      headers: {
        origin: fixture.previewOrigin,
        "access-control-request-method": "GET",
      },
    });
    assertEquals(preflight.headers.get("access-control-allow-origin"), null);
  } finally {
    await fixture.closeRetention();
  }
});

Deno.test("a session maps only to stored version bytes and offers no SSRF surface", async () => {
  const fixture = await previewFixture();
  try {
    const opened = await fixture.open();
    for (
      const suffix of [
        "?url=http://169.254.169.254/",
        "/..%2f..%2fv1%2fartifacts",
        "?version=" + crypto.randomUUID(),
      ]
    ) {
      const view = await fixture.preview(opened.viewPath + suffix, {
        headers: { cookie: opened.cookie },
      });
      if (suffix.startsWith("?")) {
        // Query parameters are ignored: the bytes are the session's version.
        assertEquals(view.status, 200, suffix);
        assertEquals(new Uint8Array(await view.arrayBuffer()), fixture.content);
      } else {
        assertEquals(view.status, 404, suffix);
      }
    }
    // A grant for one version never reads another, even in the same artifact.
    const other = await fixture.addVersion(
      "text/plain",
      new TextEncoder().encode("a second revision"),
    );
    const second = await fixture.open(other);
    const bytes = new Uint8Array(await (await second.view()).arrayBuffer());
    assertEquals(new TextDecoder().decode(bytes), "a second revision");
    const first = new Uint8Array(await (await opened.view()).arrayBuffer());
    assertEquals(first, fixture.content);
  } finally {
    await fixture.closeRetention();
  }
});

Deno.test("grants and session cookies never reach logs, reports or monitoring", async () => {
  const fixture = await previewFixture();
  const captured: string[] = [];
  const originals = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };
  const reported: unknown[] = [];
  const stopReporting = installProblemErrorReporter((error) =>
    reported.push(error)
  );
  for (const name of Object.keys(originals) as (keyof typeof originals)[]) {
    console[name] = (...args: unknown[]) => {
      captured.push(args.map((arg) => String(arg)).join(" "));
    };
  }
  try {
    const opened = await fixture.open();
    await opened.view();
    await fixture.exchange(opened.grant);
    await fixture.exchange("B".repeat(43));
    // Force the unexpected-failure path with a database that throws.
    const throwing = createPreviewHostHandler({
      database: {
        query: () =>
          Promise.reject(
            new Error(`boom ${opened.grant} ${opened.cookie}`),
          ),
      } as never,
      previewOrigin: fixture.previewOrigin,
      publicBaseUrl: fixture.appOrigin,
      authority: {} as never,
      contentAction: {} as never,
      readContent: () => Promise.reject(new Error("unused")),
    });
    const failed = await throwing(
      new Request(`${fixture.previewOrigin}${opened.viewPath}`, {
        headers: { cookie: opened.cookie },
      }),
    );
    assertEquals(failed.status, 500);
    assert(!(await failed.text()).includes(opened.grant));
    assertEquals(reported.length, 1);
    const sentryEvent = sanitizeSentryError(
      {
        type: undefined,
        exception: {
          values: [{
            type: "Error",
            value: String((reported[0] as Error).cause ?? reported[0]),
          }],
        },
        request: {
          url: `${fixture.previewOrigin}/artifact-preview/exchange`,
          data: `grant=${opened.grant}`,
          cookies: {
            [previewCookieName(fixture.previewOrigin)]: opened.cookie,
          },
          headers: { cookie: opened.cookie },
        },
      } as unknown as Parameters<typeof sanitizeSentryError>[0],
      "server",
    );
    const serialized = JSON.stringify(sentryEvent);
    const secrets = [opened.grant, opened.cookie.split("=")[1]];
    for (const secret of secrets) {
      assert(!serialized.includes(secret));
      assert(!captured.join("\n").includes(secret));
    }
    assertEquals(sentryEvent.request, undefined);
  } finally {
    stopReporting();
    Object.assign(console, originals);
    await fixture.closeRetention();
  }
});

Deno.test("monitoring keeps no cookies, headers or request bodies", () => {
  const options = sentryPrivacyOptions("server", {
    enabled: true,
    environment: "test",
    release: "test",
  } as never);
  assertEquals(options.dataCollection.cookies, false);
  assertEquals(options.dataCollection.httpHeaders, false);
  assertEquals(options.dataCollection.httpBodies, []);
  assertEquals(options.dataCollection.urlQueryParams, false);
});

Deno.test("the session cookie is HttpOnly, host only and bound to its own view path", () => {
  const id = crypto.randomUUID();
  for (
    const origin of ["https://preview.bakery.example", "http://localhost:8789"]
  ) {
    const cookie = previewSessionCookie(origin, id, "A".repeat(43));
    assert(cookie.includes("; HttpOnly"));
    assert(cookie.includes("; SameSite=Lax"));
    assert(cookie.includes(`; Path=/artifact-preview/view/${id}`));
    assert(!/domain=/i.test(cookie));
    assertEquals(cookie.includes("; Secure"), origin.startsWith("https:"));
  }
});

Deno.test("the exchange refuses a post that did not come from the app page", async () => {
  const fixture = await previewFixture();
  try {
    const planted = async (headers: Record<string, string>) => {
      const { grant, grantId } = await (await fixture.create()).json();
      const response = await fixture.exchange(grant, { headers });
      const sessions = await fixture.pgDatabase.query(
        "select count(*)::int as n from bakery.artifact_preview_sessions where grant_id = $1",
        [grantId],
      );
      return { response, sessions: sessions.rows[0].n as number, grant };
    };
    for (
      const origin of ["https://attacker.example", "null", "http://localhost"]
    ) {
      const { response, sessions } = await planted({ origin });
      assertEquals(response.status, 403, origin);
      assertEquals(response.headers.get("set-cookie"), null, origin);
      assertEquals(sessions, 0, origin);
    }
    // Without an Origin header only a same-site fetch is accepted.
    const bare = (grant: string, site?: string) =>
      fixture.preview("/artifact-preview/exchange", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          ...(site === undefined ? {} : { "sec-fetch-site": site }),
        },
        body: new URLSearchParams({ grant }).toString(),
      });
    const { grant } = await (await fixture.create()).json();
    assertEquals((await bare(grant)).status, 403);
    assertEquals((await bare(grant, "cross-site")).status, 403);
    assertEquals((await bare(grant, "none")).status, 403);
    // A refused post leaves the grant unconsumed, so the app page can still
    // use it.
    assertEquals((await bare(grant, "same-site")).status, 303);
    const accepted = await planted({ origin: fixture.appOrigin });
    assertEquals(accepted.response.status, 303);
    assertEquals(accepted.sessions, 1);
  } finally {
    await fixture.closeRetention();
  }
});
