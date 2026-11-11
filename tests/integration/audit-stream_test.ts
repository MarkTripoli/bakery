import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { orgHeader } from "../helpers/account-settings.ts";
import { cleanupAuthFixture } from "../helpers/auth.ts";
import {
  call,
  type InstallationFixture,
  openInstallationFixture,
} from "../helpers/installation-settings.ts";
import { matrixSecretsKey, runAuditMatrix } from "../helpers/audit-matrix.ts";

const DAY = 86_400_000;

type StreamBatch = {
  contentType: string;
  lineCount: number;
  content: string;
  nextCursor: string | null;
  caughtUp: boolean;
  settledBefore: string;
};

function headers(f: InstallationFixture) {
  return orgHeader(f.organizationId);
}

async function seed(f: InstallationFixture, operation: string, ageMs: number) {
  await f.pgDatabase.query(
    `insert into bakery.audit_events (organization_id, operation, resource_type,
       resource_id, outcome, request_id, trace_id, created_at)
     values ($1, $2, 'stream_test', $2, 'succeeded', 'r', 't', $3)`,
    [f.organizationId, operation, new Date(Date.now() - ageMs)],
  );
}

async function read(
  f: InstallationFixture,
  params: Record<string, string>,
  cookie = f.adminCookie,
) {
  const query = new URLSearchParams(params).toString();
  return await call(
    f,
    "GET",
    `/v1/audit-events/stream${query ? `?${query}` : ""}`,
    cookie,
    { headers: headers(f) },
  );
}

async function batch(f: InstallationFixture, params: Record<string, string>) {
  const response = await read(f, params);
  assertEquals(response.status, 200, await response.clone().text());
  return await response.json() as StreamBatch;
}

async function cleanup(f: InstallationFixture) {
  await f.pgDatabase.query(
    "delete from bakery.audit_events where resource_type = 'stream_test' or operation = 'auditEvents.stream'",
  );
}

Deno.test("stream delivers every settled event once, oldest first, redacted and resumable", async () => {
  const key = await matrixSecretsKey();
  const f = await openInstallationFixture(true, {
    secretsKey: key.secretsKey,
    githubAppClient: key.githubAppClient,
  });
  try {
    await runAuditMatrix(f);
    // Age the matrix rows past the settle lag so the redaction check covers
    // the secret-bearing operations, not just seeded rows.
    await f.pgDatabase.query(
      "update bakery.audit_events set created_at = created_at - interval '1 hour' where organization_id = $1",
      [f.organizationId],
    );
    await seed(f, "stream.old", 2 * DAY);
    await seed(f, "stream.settled", 60_000);
    await seed(f, "stream.unsettled", 0);

    // Expected: every organization event older than the 30 s settle lag.
    const expected = await f.pgDatabase.query<{ id: string }>(
      `select id from bakery.audit_events where organization_id = $1
         and created_at <= now() - interval '30 seconds'
       order by created_at, id`,
      [f.organizationId],
    );
    assert(expected.rows.length > 3);

    const delivered: { id: string; createdAt: string; operation: string }[] =
      [];
    let content = "";
    let cursor: string | null = null;
    let reads = 0;
    for (;;) {
      const params: Record<string, string> = { limit: "2" };
      if (cursor) params.cursor = cursor;
      const body = await batch(f, params);
      reads += 1;
      assertEquals(body.contentType, "application/x-ndjson");
      assert(body.lineCount <= 2);
      const lines = body.content.split("\n").filter((line) => line !== "");
      assertEquals(lines.length, body.lineCount);
      content += body.content;
      delivered.push(...lines.map((line) => JSON.parse(line)));
      assertNotEquals(body.nextCursor, null);
      cursor = body.nextCursor;
      if (body.caughtUp) break;
      assert(reads < 500, "stream never caught up");
    }

    // The stream opening row is written after the first read, so it is too
    // young to be delivered in this run; everything settled arrives once.
    assertEquals(
      delivered.map((event) => event.id),
      expected.rows.map((row) => row.id),
    );
    assertEquals(
      delivered.some((event) => event.operation === "stream.unsettled"),
      false,
    );
    const sorted = [...delivered].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt)
    );
    assertEquals(delivered.map((e) => e.id), sorted.map((e) => e.id));

    // No stream line carries secret material.
    assert(!content.includes(f.password), "stream leaks a known secret");
    for (
      const shape of [
        /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*/,
        /\b[0-9a-f]{64}\b/i,
        /\bBearer\s+\S{8,}/i,
        /-----BEGIN [A-Z ]*KEY-----/,
        /[A-Za-z0-9+/_-]{80,}={0,2}/,
      ]
    ) {
      assertEquals(shape.test(content), false, String(shape));
    }

    // Resuming at the head returns nothing and hands back the same cursor.
    const idle = await batch(f, { cursor: cursor! });
    assertEquals(idle.lineCount, 0);
    assertEquals(idle.content, "");
    assertEquals(idle.caughtUp, true);
    assertEquals(idle.nextCursor, cursor);

    // Only the opening read is audited, with filters and count, never content.
    const audit = await f.pgDatabase.query<
      { details: Record<string, unknown> }
    >(
      "select details from bakery.audit_events where operation = 'auditEvents.stream' and organization_id = $1",
      [f.organizationId],
    );
    assertEquals(audit.rows.length, 1);
    assertEquals(audit.rows[0]!.details.lineCount, 2);
    assertEquals("content" in audit.rows[0]!.details, false);

    // Filters narrow the stream.
    const filtered = await batch(f, { operation: "stream.old" });
    assertEquals(filtered.lineCount, 1);
    assertEquals(JSON.parse(filtered.content).operation, "stream.old");
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

Deno.test("stream refuses forged, foreign-filter and oversized requests without leaking", async () => {
  const f = await openInstallationFixture(true);
  try {
    await seed(f, "stream.a", DAY);
    await seed(f, "stream.b", DAY - 1000);
    const first = await batch(f, { limit: "1" });
    assertEquals(first.caughtUp, false);
    const cursor = first.nextCursor!;

    const forged = await read(f, { cursor: `${cursor.slice(0, -2)}AA` });
    assertEquals(forged.status, 400);
    assertEquals((await forged.json()).code, "INVALID_CURSOR");

    // A cursor is bound to its filter set.
    const foreign = await read(f, { cursor, operation: "stream.a" });
    assertEquals(foreign.status, 400);
    const foreignBody = await foreign.text();
    assertEquals(JSON.parse(foreignBody).code, "INVALID_CURSOR");
    assertEquals(foreignBody.includes(cursor), false);

    const oversized = await read(f, { limit: "1001" });
    assertEquals(oversized.status, 400);

    // The free in-app list is unaffected by the stream.
    const list = await call(f, "GET", "/v1/audit-events", f.adminCookie, {
      headers: headers(f),
    });
    assertEquals(list.status, 200);
  } finally {
    await cleanup(f);
    await f.finish();
  }
});

Deno.test("non-admin: the stream refuses a developer", async () => {
  const f = await openInstallationFixture(true);
  try {
    const response = await read(f, {}, f.developerCookie!);
    assertEquals(response.status, 403);
    assertEquals((await response.json()).code, "AUTH_FORBIDDEN");
    const written = await f.pgDatabase.query(
      "select 1 from bakery.audit_events where operation = 'auditEvents.stream'",
    );
    assertEquals(written.rows.length, 0);
  } finally {
    await cleanup(f);
    await f.finish();
  }
});
