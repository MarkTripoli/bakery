import { assert, assertEquals } from "@std/assert";
import {
  FAKE_PROVIDER_CANARY,
  type FakeFailureScript,
} from "../helpers/fake-github-app.ts";
import {
  count,
  enabledConnection,
  type GitHubAppFixture,
  openGitHubAppFixture,
  postCheck,
} from "../helpers/github-app-registration.ts";

async function withFixture(run: (f: GitHubAppFixture) => Promise<void>) {
  // A short client deadline so the scripted hang times out quickly.
  const f = await openGitHubAppFixture({ requestTimeoutMs: 1_500 });
  try {
    await run(f);
  } finally {
    await f.finish();
  }
}

/** Every console line written while `run` runs. */
async function capturing<T>(
  run: (lines: string[]) => Promise<T>,
): Promise<T> {
  const lines: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const originals = methods.map((name) => console[name]);
  for (const name of methods) {
    console[name] = (...args: unknown[]) => {
      lines.push(
        args.map((arg) =>
          arg instanceof Error
            ? `${arg.name} ${arg.message} ${arg.stack} ${String(arg.cause)}`
            : typeof arg === "string"
            ? arg
            : JSON.stringify(arg)
        ).join(" "),
      );
    };
  }
  try {
    return await run(lines);
  } finally {
    methods.forEach((name, index) => console[name] = originals[index]);
  }
}

const TABLES = [
  "bakery.audit_events",
  "bakery.domain_events",
  "bakery.idempotency_records",
  "bakery.integration_resources",
  "bakery.integration_connections",
  "bakery.integration_installations",
] as const;

/** What GitHub's scripted failures say, which must never be repeated. */
const PROVIDER_TEXT = [
  FAKE_PROVIDER_CANARY,
  "Bad credentials",
  "Resource not accessible by integration",
  "API rate limit exceeded",
  "secondary rate limit",
  "docs.github.com",
  "api.github.com",
  "x-ratelimit",
  "x-github-request-id",
];

Deno.test("no provider status text, body, header or message reaches a response, problem, row, audit, event or log on any scripted failure", async () => {
  await withFixture(async (f) => {
    const { connectionId, installation } = await enabledConnection(f);
    await capturing(async (lines) => {
      const responses: string[] = [];
      const check = async (expected: number) => {
        const response = await postCheck(f, connectionId);
        const body = await response.text();
        assertEquals(response.status, expected, body);
        responses.push(
          body,
          JSON.stringify(Object.fromEntries(response.headers.entries())),
        );
        return JSON.parse(body);
      };
      const listing: [FakeFailureScript, number][] = [
        ["unauthorized", 200],
        ["forbidden", 200],
        ["rate_limited", 429],
        ["quota", 429],
        ["hang", 504],
      ];
      for (const [script, status] of listing) {
        f.github.failures.tokenListingScripts.set(installation.id, script);
        const body = await check(status);
        if (status === 200) assertEquals(body.fault, null, script);
        else assertEquals(body.status, status, script);
        f.github.failures.tokenListingScripts.delete(installation.id);
        await f.pgDatabase.query(
          `update bakery.integration_connections set next_allowed_at = null
            where id = $1`,
          [connectionId],
        );
      }
      for (const script of ["quota", "hang"] as const) {
        // A revoked cached token forces the mint the script answers.
        f.github.revokedTokens.push(...f.github.issuedTokens);
        f.github.failures.tokenScripts.set(installation.id, script);
        await check(script === "quota" ? 429 : 504);
        f.github.failures.tokenScripts.delete(installation.id);
        await f.pgDatabase.query(
          `update bakery.integration_connections set next_allowed_at = null
            where id = $1`,
          [connectionId],
        );
      }
      for (const text of PROVIDER_TEXT) {
        for (const body of responses) {
          assert(!body.toLowerCase().includes(text.toLowerCase()), text);
        }
        for (const line of lines) {
          assert(!line.toLowerCase().includes(text.toLowerCase()), text);
        }
        for (const table of TABLES) {
          assertEquals(
            await count(
              f,
              `select count(*) from ${table} as t
                where lower(t::text) like '%' || lower($1) || '%'`,
              [text],
            ),
            0,
            `${table}: ${text}`,
          );
        }
      }
      // Installation tokens stay out of the same places.
      for (const token of f.github.issuedTokens) {
        for (const body of responses) assert(!body.includes(token));
        for (const line of lines) assert(!line.includes(token));
      }
    });
  });
});

Deno.test("a provider 401 never answers the Admin with a Bakery-session 401 and leaves the session valid", async () => {
  await withFixture(async (f) => {
    const { connectionId, installation } = await enabledConnection(f);
    f.github.failures.tokenListingScripts.set(installation.id, "unauthorized");
    const response = await postCheck(f, connectionId);
    const body = await response.text();
    assertEquals(response.status, 200, body);
    assertEquals(response.headers.get("www-authenticate"), null);
    assertEquals(JSON.parse(body).health, "auth_required");
    // The same session still works.
    f.github.failures.tokenListingScripts.delete(installation.id);
    const next = await postCheck(f, connectionId);
    assertEquals(next.status, 200, await next.text());
  });
});

Deno.test("audit and events for provider failures carry only safe codes and identifiers", async () => {
  await withFixture(async (f) => {
    const { connectionId, installation } = await enabledConnection(f);
    f.github.failures.tokenListingScripts.set(installation.id, "forbidden");
    assertEquals((await postCheck(f, connectionId)).status, 200);
    f.github.failures.tokenListingScripts.set(installation.id, "unauthorized");
    assertEquals((await postCheck(f, connectionId)).status, 200);
    const audit = await f.pgDatabase.query<
      { details: Record<string, unknown> }
    >(
      `select details from bakery.audit_events
        where operation = 'integrationConnections.check' and resource_id = $1
        order by created_at`,
      [connectionId],
    );
    assertEquals(
      audit.rows.map((row) => [row.details.problem, row.details.to]),
      [["permission_lost", "degraded"], ["token_rejected", "auth_required"]],
    );
    for (const row of audit.rows) {
      assertEquals(Object.keys(row.details).sort(), [
        "discovery",
        "from",
        "healthy",
        "problem",
        "provider",
        "to",
      ]);
    }
    // The connection's health events and the discovery its loss queued.
    const events = await f.pgDatabase.query<{ payload: unknown }>(
      `select payload from bakery.domain_events
        where (aggregate_id::text = $1
            and event_type = 'integration.health_changed')
           or (event_type = 'integration.discovery_requested'
            and aggregate_id::text in (
              select id::text from bakery.integration_discoveries
               where connection_id::text = $1))`,
      [connectionId],
    );
    assert(events.rows.length >= 3);
    for (const row of events.rows) {
      assertEquals(
        Object.keys(row.payload as object).sort(),
        ["resourceId", "resourceVersion"],
      );
    }
  });
});
