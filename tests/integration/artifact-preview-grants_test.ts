import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import { previewFixture } from "../helpers/artifact-preview.ts";
import { mainRouter } from "../../apps/server/src/main.ts";
import { sweepExecutionRetention } from "../../packages/persistence/src/coordination.ts";
import { withPgTransaction } from "../../packages/persistence/src/postgres.ts";
import { collectArtifactVersion } from "../../apps/server/src/modules/knowledge/retention/collector.ts";

const htmlBytes = new TextEncoder().encode(
  "<!doctype html><h1>Hello</h1><script>document.title='x'</script>",
);

Deno.test("a posted one-use grant opens a sandboxed preview of the stored bytes", async () => {
  const fixture = await previewFixture();
  try {
    const opened = await fixture.open();
    assertEquals(opened.grant.length, 43);
    assertEquals(
      opened.exchangeUrl,
      `${fixture.previewOrigin}/artifact-preview/exchange`,
    );
    assertEquals(
      opened.revisionPath,
      `/tasks/${fixture.job.taskId}/artifacts/${fixture.artifactId}?version=${fixture.versionId}`,
    );
    const created = await fixture.create();
    assertEquals(created.headers.get("cache-control"), "no-store");
    assertEquals(
      opened.setCookie.startsWith("bakery_artifact_preview="),
      true,
    );
    assertEquals(opened.viewPath.startsWith("/artifact-preview/view/"), true);
    assertEquals(opened.viewPath.includes(opened.grant), false);
    assertEquals(opened.setCookie.includes(`Path=${opened.viewPath}`), true);
    const view = await opened.view();
    assertEquals(view.status, 200);
    assertEquals(new Uint8Array(await view.arrayBuffer()), fixture.content);
    assertEquals(
      view.headers.get("content-security-policy"),
      "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'",
    );
    assertEquals(view.headers.get("x-content-type-options"), "nosniff");
    assertEquals(
      view.headers.get("cross-origin-resource-policy"),
      "same-origin",
    );
    assertEquals(view.headers.get("cross-origin-opener-policy"), "same-origin");
    assertEquals(view.headers.get("referrer-policy"), "no-referrer");
    assertEquals(view.headers.get("cache-control"), "no-store");
    assertEquals(
      view.headers.get("link"),
      `<${fixture.appOrigin}${opened.revisionPath}>; rel="canonical"`,
    );
    assertEquals(view.headers.get("access-control-allow-origin"), null);
    assertEquals(view.headers.get("set-cookie"), null);
  } finally {
    await fixture.closeRetention();
  }
});

Deno.test("HTML and SVG render only under the script-less sandbox policy", async () => {
  const fixture = await previewFixture();
  try {
    const html = await fixture.addVersion("text/html", htmlBytes);
    const opened = await fixture.open(html);
    const view = await opened.view();
    assertEquals(view.status, 200);
    assertEquals(
      view.headers.get("content-type"),
      "text/html; charset=utf-8",
    );
    assertEquals(new Uint8Array(await view.arrayBuffer()), htmlBytes);
    assert(view.headers.get("content-security-policy")?.startsWith("sandbox;"));
    assert(
      !view.headers.get("content-security-policy")?.includes("script-src"),
    );
    const script = await fixture.addVersion(
      "application/javascript",
      new TextEncoder().encode("alert(1)"),
    );
    const refused = await fixture.create(script);
    assertEquals(refused.status, 415);
    assertEquals((await refused.json()).code, "UNSUPPORTED_MEDIA_TYPE");
  } finally {
    await fixture.closeRetention();
  }
});

Deno.test("a grant is consumed once and replays, expiry and bad shapes open nothing", async () => {
  const fixture = await previewFixture();
  try {
    const first = await fixture.create();
    const { grant, grantId } = await first.json();
    assertEquals((await fixture.exchange(grant)).status, 303);
    const replay = await fixture.exchange(grant);
    assertEquals(replay.status, 404);
    assertEquals(replay.headers.get("set-cookie"), null);
    const sessions = await fixture.pgDatabase.query(
      "select count(*)::int as n from bakery.artifact_preview_sessions where grant_id = $1",
      [grantId],
    );
    assertEquals(sessions.rows[0].n, 1);

    const expired = await (await fixture.create()).json();
    await fixture.pgDatabase.query(
      "update bakery.artifact_preview_grants set expires_at = now() - interval '1 second' where id = $1",
      [expired.grantId],
    );
    assertEquals((await fixture.exchange(expired.grant)).status, 404);

    const unknown = await fixture.exchange("A".repeat(43));
    assertEquals(unknown.status, 404);
    const malformed = await fixture.exchange("short");
    assertEquals(malformed.status, 404);
  } finally {
    await fixture.closeRetention();
  }
});

Deno.test("a grant never travels in a URL and never matches a JSON body", async () => {
  const fixture = await previewFixture();
  try {
    const { grant, grantId } = await (await fixture.create()).json();
    const query = await fixture.preview(
      `/artifact-preview/exchange?grant=${grant}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: fixture.appOrigin,
        },
        body: new URLSearchParams({ grant }).toString(),
      },
    );
    assertEquals(query.status, 404);
    const path = await fixture.preview(`/artifact-preview/exchange/${grant}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant }).toString(),
    });
    assertEquals(path.status, 404);
    const viewPath = await fixture.preview(`/artifact-preview/view/${grant}`);
    assertEquals(viewPath.status, 404);
    const json = await fixture.preview("/artifact-preview/exchange", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: fixture.appOrigin,
      },
      body: JSON.stringify({ grant }),
    });
    assertEquals(json.status, 415);
    const state = await fixture.pgDatabase.query(
      "select consumed_at from bakery.artifact_preview_grants where id = $1",
      [grantId],
    );
    assertEquals(state.rows[0].consumed_at, null);
    // The untouched grant still works in a form body.
    assertEquals((await fixture.exchange(grant)).status, 303);
  } finally {
    await fixture.closeRetention();
  }
});

Deno.test("a missing, wrong or foreign cookie discloses nothing", async () => {
  const fixture = await previewFixture();
  try {
    const first = await fixture.open();
    const second = await fixture.open();
    assertEquals((await fixture.preview(first.viewPath)).status, 404);
    // Each cookie opens only its own view path.
    const cross = await fixture.preview(first.viewPath, {
      headers: { cookie: second.cookie },
    });
    assertEquals(cross.status, 404);
    assertEquals((await first.view()).status, 200);
    assertEquals((await second.view()).status, 200);
    assertNotEquals(first.viewPath, second.viewPath);
    assertNotEquals(
      first.setCookie.split(";")[0],
      second.setCookie.split(";")[0],
    );
    // Bakery's own session cookie is ignored on the preview host.
    const bakery = await fixture.preview(first.viewPath, {
      headers: { cookie: fixture.adminCookie },
    });
    assertEquals(bakery.status, 404);
  } finally {
    await fixture.closeRetention();
  }
});

Deno.test("revoking closes the preview, and an expired session says so", async () => {
  const fixture = await previewFixture();
  try {
    const opened = await fixture.open();
    assertEquals((await opened.view()).status, 200);
    const revoked = await fixture.revoke(opened.grantId);
    assertEquals(revoked.status, 204);
    const closed = await opened.view();
    assertEquals(closed.status, 410);
    assert((await closed.text()).includes("Preview closed"));
    assertEquals((await fixture.revoke(opened.grantId)).status, 204);
    const audits = await fixture.pgDatabase.query(
      "select count(*)::int as n from bakery.audit_events where operation = 'artifactPreviews.revoke' and resource_id = $1",
      [opened.grantId],
    );
    assertEquals(audits.rows[0].n, 1);

    const other = await fixture.open();
    await fixture.pgDatabase.query(
      "update bakery.artifact_preview_sessions set expires_at = now() - interval '1 second' where grant_id = $1",
      [other.grantId],
    );
    const expired = await other.view();
    assertEquals(expired.status, 410);
    assert((await expired.text()).includes("Preview expired"));
  } finally {
    await fixture.closeRetention();
  }
});

Deno.test("losing read authority or the bytes ends an open preview", async () => {
  const fixture = await previewFixture();
  try {
    const lost = await fixture.open();
    assertEquals((await lost.view()).status, 200);
    await fixture.pgDatabase.query(
      "update bakery.organization_memberships set status = 'inactive' where organization_id = $1 and principal_id = $2",
      [fixture.organizationId, fixture.principalId],
    );
    const denied = await lost.view();
    assertEquals(denied.status, 403);
    assert((await denied.text()).includes("Access ended"));
    await fixture.pgDatabase.query(
      "update bakery.organization_memberships set status = 'active' where organization_id = $1 and principal_id = $2",
      [fixture.organizationId, fixture.principalId],
    );
    assertEquals((await lost.view()).status, 200);
  } finally {
    await fixture.closeRetention();
  }
});

Deno.test("a tombstoned version answers 410 on create and on an open preview", async () => {
  const fixture = await previewFixture();
  try {
    const opened = await fixture.open();
    await fixture.pgDatabase.query(
      "update bakery.artifact_versions set expires_at = now() - interval '1 day' where id = $1",
      [fixture.versionId],
    );
    assertEquals(
      await collectArtifactVersion(fixture.pgDatabase, fixture.versionId),
      true,
    );
    const tombstone = await opened.view();
    assertEquals(tombstone.status, 410);
    assert((await tombstone.text()).includes("Content expired"));
    const create = await fixture.create();
    assertEquals(create.status, 410);
    assertEquals((await create.json()).code, "ARTIFACT_CONTENT_EXPIRED");
  } finally {
    await fixture.closeRetention();
  }
});

Deno.test("preview routes exist only on the preview host and nothing else does", async () => {
  const fixture = await previewFixture();
  try {
    const opened = await fixture.open();
    const onApp = await fixture.appRequest("/artifact-preview/exchange", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant: opened.grant }).toString(),
    });
    assertEquals(onApp.status, 404);
    assertEquals(
      (await fixture.appRequest(opened.viewPath)).status,
      404,
    );
    for (
      const path of [
        "/",
        "/livez",
        "/v1/artifacts",
        "/v1/artifact-versions/" + fixture.versionId + "/content",
        "/api/auth/get-session",
        "/artifact-preview",
        "/artifact-preview/exchange",
      ]
    ) {
      const response = await fixture.preview(path, {
        headers: { cookie: fixture.adminCookie, origin: fixture.appOrigin },
      });
      assertEquals(response.status, 404, path);
      assertEquals(response.headers.get("access-control-allow-origin"), null);
      assertEquals(response.headers.get("set-cookie"), null);
    }
    const options = await fixture.preview(opened.viewPath, {
      method: "OPTIONS",
      headers: {
        origin: fixture.appOrigin,
        "access-control-request-method": "GET",
      },
    });
    assertEquals(options.status, 404);
    assertEquals(options.headers.get("access-control-allow-origin"), null);
  } finally {
    await fixture.closeRetention();
  }
});

Deno.test("the grant secret is stored only as a hash and never replayable", async () => {
  const fixture = await previewFixture();
  try {
    const created = await fixture.create();
    const body = await created.json();
    const rows = await fixture.pgDatabase.query(
      "select token_hash from bakery.artifact_preview_grants where id = $1",
      [body.grantId],
    );
    assertEquals(rows.rows[0].token_hash.length, 64);
    assertNotEquals(rows.rows[0].token_hash, body.grant);
    assertEquals(
      (await fixture.create()).headers.get("idempotent-replayed"),
      null,
    );
    const secrets = await fixture.pgDatabase.query<{ n: number }>(
      `select (
         (select count(*) from bakery.idempotency_records where response_body like '%' || $1 || '%' or response_headers::text like '%' || $1 || '%') +
         (select count(*) from bakery.audit_events where details::text like '%' || $1 || '%') +
         (select count(*) from bakery.artifact_preview_grants where token_hash = $1)
       )::int as n`,
      [body.grant],
    );
    assertEquals(secrets.rows[0].n, 0);
    const opened = await fixture.open();
    const sessionSecrets = await fixture.pgDatabase.query<{ n: number }>(
      "select count(*)::int as n from bakery.artifact_preview_sessions where session_hash = $1",
      [opened.cookie.split("=")[1]],
    );
    assertEquals(sessionSecrets.rows[0].n, 0);
  } finally {
    await fixture.closeRetention();
  }
});

Deno.test("an unconfigured deployment fails every preview operation closed", async () => {
  const fixture = await previewFixture({ configured: false });
  try {
    const availability = await fixture.appRequest(
      "/v1/artifact-preview-availability",
    );
    assertEquals(availability.status, 200);
    assertEquals(await availability.json(), { available: false });
    const create = await fixture.create();
    assertEquals(create.status, 409);
    const problem = await create.json();
    assertEquals(problem.code, "STATE_CONFLICT");
    assertEquals(problem.reason, "preview_origin_not_configured");
    const exchange = await fixture.preview("/artifact-preview/exchange", {
      method: "POST",
    });
    assertEquals(exchange.status, 404);
    const rows = await fixture.pgDatabase.query(
      "select count(*)::int as n from bakery.artifact_preview_grants",
    );
    assertEquals(rows.rows[0].n, 0);
  } finally {
    await fixture.closeRetention();
  }
});

Deno.test("availability reports a configured preview origin", async () => {
  const fixture = await previewFixture();
  try {
    const availability = await fixture.appRequest(
      "/v1/artifact-preview-availability",
    );
    assertEquals(await availability.json(), { available: true });
  } finally {
    await fixture.closeRetention();
  }
});

Deno.test("the listener dispatches the preview host before path routing", async () => {
  const fixture = await previewFixture();
  try {
    const sentinel = (route: string) => ({
      fetch: () => Response.json({ route }, { status: 200 }),
    });
    const router = mainRouter(
      {
        cleanup: sentinel("cleanup"),
        control: sentinel("control"),
        app: fixture.app,
      },
      { previewOrigin: fixture.previewOrigin },
    );
    const info = {
      remoteAddr: { transport: "tcp", hostname: "127.0.0.1", port: 1 },
    } as { remoteAddr: Deno.Addr };
    const send = (origin: string, path: string, init: RequestInit = {}) =>
      Promise.resolve(router(new Request(`${origin}${path}`, init), info));
    // Sanity: on the app host the path routes still reach control and cleanup.
    assertEquals(
      (await (await send(
        fixture.appOrigin,
        "/v1/execution/attempts/x/heartbeat",
      )).json()).route,
      "control",
    );
    assertEquals(
      (await (await send(
        fixture.appOrigin,
        "/v1/worker/attempts/x/cleanup",
        { method: "POST" },
      )).json()).route,
      "cleanup",
    );
    for (
      const path of [
        "/v1/execution/attempts/x/heartbeat",
        "/v1/worker/attempts/x/cleanup",
        "/v1/health",
        "/livez",
        "/v1/artifacts",
      ]
    ) {
      for (const method of ["GET", "POST"]) {
        const response = await send(fixture.previewOrigin, path, {
          method,
          headers: { cookie: fixture.adminCookie },
        });
        assertEquals(response.status, 404, `${method} ${path}`);
        assertEquals(response.headers.get("set-cookie"), null);
      }
    }
    // The preview routes themselves still work through the router.
    const { grant } = await (await fixture.create()).json();
    const exchanged = await send(
      fixture.previewOrigin,
      "/artifact-preview/exchange",
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: fixture.appOrigin,
        },
        body: new URLSearchParams({ grant }).toString(),
      },
    );
    assertEquals(exchanged.status, 303);
    const cookie = (exchanged.headers.get("set-cookie") ?? "").split(";", 1)[0];
    const view = await send(
      fixture.previewOrigin,
      exchanged.headers.get("location") ?? "",
      { headers: { cookie } },
    );
    assertEquals(view.status, 200);
    assertEquals(new Uint8Array(await view.arrayBuffer()), fixture.content);
  } finally {
    await fixture.closeRetention();
  }
});

Deno.test("expired grants and sessions are swept after the grace period", async () => {
  const fixture = await previewFixture();
  try {
    const sweep = () =>
      withPgTransaction(
        fixture.runtimePgDatabase,
        (transaction) => sweepExecutionRetention(transaction),
      );
    const count = async (table: string, id: string, column = "id") =>
      (await fixture.pgDatabase.query(
        `select count(*)::int as n from bakery.${table} where ${column} = $1`,
        [id],
      )).rows[0].n as number;
    const stale = await fixture.open();
    const fresh = await fixture.open();
    const sessionOf = async (grantId: string) =>
      (await fixture.pgDatabase.query(
        "select id from bakery.artifact_preview_sessions where grant_id = $1",
        [grantId],
      )).rows[0].id as string;
    const staleSession = await sessionOf(stale.grantId);
    const freshSession = await sessionOf(fresh.grantId);
    // Expired a minute ago: inside the grace period, so nothing is deleted.
    await fixture.pgDatabase.query(
      `update bakery.artifact_preview_grants set expires_at = now() - interval '1 minute' where id = $1`,
      [stale.grantId],
    );
    await fixture.pgDatabase.query(
      `update bakery.artifact_preview_sessions set expires_at = now() - interval '1 minute' where id = $1`,
      [staleSession],
    );
    await sweep();
    assertEquals(await count("artifact_preview_grants", stale.grantId), 1);
    assertEquals(await count("artifact_preview_sessions", staleSession), 1);
    // Past the grace period: both rows go, the live ones stay.
    await fixture.pgDatabase.query(
      `update bakery.artifact_preview_grants set expires_at = now() - interval '2 days' where id = $1`,
      [stale.grantId],
    );
    await fixture.pgDatabase.query(
      `update bakery.artifact_preview_sessions set expires_at = now() - interval '2 days' where id = $1`,
      [staleSession],
    );
    await sweep();
    assertEquals(await count("artifact_preview_sessions", staleSession), 0);
    assertEquals(await count("artifact_preview_grants", stale.grantId), 0);
    assertEquals(await count("artifact_preview_grants", fresh.grantId), 1);
    assertEquals(await count("artifact_preview_sessions", freshSession), 1);
    assertEquals((await fresh.view()).status, 200);
  } finally {
    await fixture.closeRetention();
  }
});

Deno.test("grants reference their task and artifact with organization-scoped foreign keys", async () => {
  const fixture = await previewFixture();
  try {
    const constraints = await fixture.pgDatabase.query<{
      conname: string;
      def: string;
    }>(
      `select conname, pg_get_constraintdef(oid) as def
         from pg_constraint
        where conrelid = 'bakery.artifact_preview_grants'::regclass
          and contype = 'f'`,
    );
    const byName = new Map(constraints.rows.map((r) => [r.conname, r.def]));
    assert(
      byName.get("artifact_preview_grants_task_fk")?.includes(
        "(organization_id, task_id) REFERENCES bakery.tasks(organization_id, id)",
      ),
    );
    assert(
      byName.get("artifact_preview_grants_artifact_fk")?.includes(
        "(organization_id, artifact_id) REFERENCES bakery.artifacts(organization_id, id)",
      ),
    );
    await assertRejects(
      () =>
        fixture.pgDatabase.query(
          `insert into bakery.artifact_preview_grants
             (organization_id, task_id, artifact_id, artifact_version_id,
              principal_id, token_hash, expires_at)
           select v.organization_id, gen_random_uuid(), v.artifact_id, v.id,
                  (select id from bakery.principals limit 1), 'fk-probe',
                  now() + interval '30 seconds'
             from bakery.artifact_versions v where v.id = $1`,
          [fixture.versionId],
        ),
      Error,
      "artifact_preview_grants_task_fk",
    );
  } finally {
    await fixture.closeRetention();
  }
});
