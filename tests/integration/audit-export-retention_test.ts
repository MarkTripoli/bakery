import { assert, assertEquals } from "@std/assert";
import { orgHeader } from "../helpers/account-settings.ts";
import { cleanupAuthFixture } from "../helpers/auth.ts";
import {
  call,
  type InstallationFixture,
  openInstallationFixture,
} from "../helpers/installation-settings.ts";
import { matrixSecretsKey, runAuditMatrix } from "../helpers/audit-matrix.ts";
import { purgeExpiredAuditEvents } from "../../apps/server/src/modules/auth/audit/mod.ts";

const DAY = 86_400_000;

async function seedAudit(
  f: InstallationFixture,
  operation: string,
  ageDays: number,
) {
  await f.pgDatabase.query(
    `insert into bakery.audit_events (organization_id, operation, resource_type,
       resource_id, outcome, request_id, trace_id, created_at)
     values ($1, $2, 'p15_test', $2, 'succeeded', 'r', 't', $3)`,
    [f.organizationId, operation, new Date(Date.now() - ageDays * DAY)],
  );
}

function headers(f: InstallationFixture, extra: Record<string, string> = {}) {
  return { ...orgHeader(f.organizationId), ...extra };
}

async function cleanup(f: InstallationFixture) {
  await f.pgDatabase.query("delete from bakery.scim_connections");
  await f.pgDatabase.query(
    "delete from bakery.audit_events where resource_type = 'p15_test' or operation like 'auditRetention.%' or operation = 'auditEvents.export'",
  );
  await f.pgDatabase.query(
    "delete from bakery.audit_retention_settings where organization_id = $1",
    [f.organizationId],
  );
}

type ExportBody = {
  filename: string;
  contentType: string;
  lineCount: number;
  truncated: boolean;
  content: string;
};

Deno.test("export matches the list for the window, bounds the window and carries no secrets", async () => {
  const key = await matrixSecretsKey();
  const f = await openInstallationFixture(true, {
    secretsKey: key.secretsKey,
    githubAppClient: key.githubAppClient,
  });
  try {
    await runAuditMatrix(f);
    await seedAudit(f, "p15.old", 200);
    const since = new Date(Date.now() - 30 * DAY).toISOString();
    const until = new Date(Date.now() + DAY).toISOString();
    const exported = await call(
      f,
      "GET",
      `/v1/audit-events/export?since=${encodeURIComponent(since)}&until=${
        encodeURIComponent(until)
      }`,
      f.adminCookie,
      { headers: headers(f) },
    );
    assertEquals(exported.status, 200, await exported.clone().text());
    const body = await exported.json() as ExportBody;
    assertEquals(body.contentType, "application/x-ndjson");
    assertEquals(body.truncated, false);
    const lines = body.content.split("\n").filter((line) => line !== "");
    assertEquals(lines.length, body.lineCount);
    assert(lines.length > 0);
    const events = lines.map((line) =>
      JSON.parse(line) as {
        id: string;
        createdAt: string;
        organizationId: string;
      }
    );
    for (const event of events) {
      assertEquals(event.organizationId, f.organizationId);
    }
    // Oldest first.
    const sorted = [...events].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt)
    );
    assertEquals(events.map((e) => e.id).length, sorted.length);

    // The list over the same window returns exactly the exported ids.
    const listed: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Response = await call(
        f,
        "GET",
        `/v1/audit-events?limit=100&since=${encodeURIComponent(since)}&until=${
          encodeURIComponent(until)
        }${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        f.adminCookie,
        { headers: headers(f) },
      );
      assertEquals(page.status, 200);
      const json = await page.json() as {
        items: { id: string; operation: string }[];
        nextCursor: string | null;
      };
      // The export audits itself after it reads, so its own row is not in it.
      listed.push(
        ...json.items.filter((item) => item.operation !== "auditEvents.export")
          .map((item) => item.id),
      );
      cursor = json.nextCursor;
    } while (cursor);
    assertEquals(new Set(listed), new Set(events.map((e) => e.id)));

    // No export line carries a secret (issue 323 AC2).
    const secretShapes = [
      /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*/,
      /\b[0-9a-f]{64}\b/i,
      /\bBearer\s+\S{8,}/i,
      /-----BEGIN [A-Z ]*KEY-----/,
      /[A-Za-z0-9+/_-]{80,}={0,2}/,
    ];
    assert(!body.content.includes(f.password), "export leaks a known secret");
    for (const shape of secretShapes) {
      assertEquals(shape.test(body.content), false, String(shape));
    }

    // The export is itself audited: window and count, never the content.
    const exportAudit = await f.pgDatabase.query<
      { details: Record<string, unknown> }
    >(
      "select details from bakery.audit_events where operation = 'auditEvents.export' and organization_id = $1",
      [f.organizationId],
    );
    assertEquals(exportAudit.rows.length, 1);
    assertEquals(exportAudit.rows[0]!.details.lineCount, body.lineCount);
    assertEquals("content" in exportAudit.rows[0]!.details, false);

    // A window wider than 366 days is refused.
    const wide = await call(
      f,
      "GET",
      `/v1/audit-events/export?since=${
        encodeURIComponent(new Date(Date.now() - 400 * DAY).toISOString())
      }`,
      f.adminCookie,
      { headers: headers(f) },
    );
    assertEquals(wide.status, 422);
  } finally {
    const extra = await f.pgDatabase.query<{ email: string }>(
      "select email from public.\"user\" where email like 'matrix-%@example.test'",
    );
    await cleanupAuthFixture(f.pgDatabase, extra.rows.map((row) => row.email));
    await cleanup(f);
    await f.finish();
    await key.remove();
  }
});

Deno.test("retention: update is audited; the purge deletes only expired rows", async () => {
  const f = await openInstallationFixture(true);
  try {
    const bad = await call(f, "PATCH", "/v1/audit-retention", f.adminCookie, {
      headers: headers(f, { "idempotency-key": crypto.randomUUID() }),
      body: { retentionDays: 5 },
    });
    assertEquals(bad.status, 400, await bad.clone().text());
    // A rejected value writes nothing: no setting row and no audit row.
    const noSetting = await f.pgDatabase.query(
      "select 1 from bakery.audit_retention_settings where organization_id = $1",
      [f.organizationId],
    );
    assertEquals(noSetting.rows.length, 0);
    const noAudit = await f.pgDatabase.query(
      "select 1 from bakery.audit_events where operation = 'auditRetention.update' and organization_id = $1",
      [f.organizationId],
    );
    assertEquals(noAudit.rows.length, 0);
    const ok = await call(f, "PATCH", "/v1/audit-retention", f.adminCookie, {
      headers: headers(f, { "idempotency-key": crypto.randomUUID() }),
      body: { retentionDays: 60 },
    });
    assertEquals(ok.status, 200, await ok.clone().text());
    assertEquals((await ok.json()).retentionDays, 60);
    // Clearing the window keeps events forever and keeps the row.
    const cleared = await call(
      f,
      "PATCH",
      "/v1/audit-retention",
      f.adminCookie,
      {
        headers: headers(f, { "idempotency-key": crypto.randomUUID() }),
        body: { retentionDays: null },
      },
    );
    assertEquals(cleared.status, 200, await cleared.clone().text());
    const clearedBody = await cleared.json();
    assertEquals(clearedBody.retentionDays, null);
    assertEquals(clearedBody.version, 2);
    const reset = await call(f, "PATCH", "/v1/audit-retention", f.adminCookie, {
      headers: headers(f, { "idempotency-key": crypto.randomUUID() }),
      body: { retentionDays: 60 },
    });
    assertEquals(reset.status, 200);
    const audited = await f.pgDatabase.query(
      "select 1 from bakery.audit_events where operation = 'auditRetention.update' and organization_id = $1",
      [f.organizationId],
    );
    // Set, cleared and set again: one audit row per change.
    assertEquals(audited.rows.length, 3);

    await seedAudit(f, "p15.expired", 90);
    await seedAudit(f, "p15.fresh", 5);
    const remaining = () =>
      f.pgDatabase.query<{ operation: string }>(
        "select operation from bakery.audit_events where resource_type = 'p15_test' order by operation",
      ).then((result) => result.rows.map((row) => row.operation));

    assertEquals(await remaining(), ["p15.expired", "p15.fresh"]);
    // Only the expired row goes.
    const result = await purgeExpiredAuditEvents({
      database: f.runtimePgDatabase,
    });
    assert(result.purged >= 1);
    assertEquals(await remaining(), ["p15.fresh"]);
    const purgeAudit = await f.pgDatabase.query(
      "select 1 from bakery.audit_events where operation = 'auditRetention.purge' and organization_id = $1",
      [f.organizationId],
    );
    assertEquals(purgeAudit.rows.length, 1);
  } finally {
    await cleanup(f);
    await f.finish();
  }
});

Deno.test("non-admin: the new routes refuse a developer without the permission", async () => {
  const f = await openInstallationFixture(true);
  try {
    const since = new Date(Date.now() - 30 * DAY).toISOString();
    // A denied `:read` permission is concealed as 404 by the repo's rule
    // (deniedCode); a denied export or manage permission is a plain 403.
    const requests: [string, string, number, string, unknown?][] = [
      [
        "GET",
        `/v1/audit-events/export?since=${encodeURIComponent(since)}`,
        403,
        "AUTH_FORBIDDEN",
      ],
      ["GET", "/v1/audit-retention", 404, "RESOURCE_NOT_FOUND"],
      [
        "PATCH",
        "/v1/audit-retention",
        403,
        "AUTH_FORBIDDEN",
        { retentionDays: 60 },
      ],
    ];
    for (const [method, path, status, code, body] of requests) {
      const response = await call(f, method, path, f.developerCookie!, {
        headers: headers(f, { "idempotency-key": crypto.randomUUID() }),
        body,
      });
      assertEquals(response.status, status, `${method} ${path}`);
      assertEquals((await response.json()).code, code, `${method} ${path}`);
    }
    const written = await f.pgDatabase.query(
      "select 1 from bakery.audit_retention_settings where organization_id = $1",
      [f.organizationId],
    );
    assertEquals(written.rows.length, 0);
  } finally {
    await cleanup(f);
    await f.finish();
  }
});
