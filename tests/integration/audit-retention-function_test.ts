import { assert, assertEquals } from "@std/assert";
import type { Inngest } from "inngest";
import { createDefaultInngestFunctions } from "../../apps/server/src/modules/execution/inngest-http.ts";
import type { PgDatabase } from "../../apps/server/src/platform/database.ts";
import { purgeExpiredAuditEvents } from "../../apps/server/src/modules/auth/audit/mod.ts";

const INNGEST_CONFIG = {
  signingKey: "k",
  eventKey: "k",
  baseUrl: "http://127.0.0.1:1",
  serveOrigin: "http://127.0.0.1:1",
  maxBodyBytes: 1024,
  waitMs: 1000,
  jobCompletionTimeout: "1h",
  engineRetries: 1,
  maxAttempts: 3,
};

type Config = { id: string; triggers: { cron?: string }[] };
type Handler = (
  ctx: { step: { run: (name: string, fn: () => unknown) => unknown } },
) => Promise<unknown>;

function fakeClient() {
  const registered: { config: Config; handler: Handler }[] = [];
  const client = {
    createFunction(config: Config, handler: Handler) {
      registered.push({ config, handler });
      return { config, handler };
    },
  } as unknown as Inngest;
  return { client, registered };
}

Deno.test("retention function is an hourly cron whose run purges expired events", async () => {
  const calls: string[] = [];
  const database = {
    connect: () =>
      Promise.resolve({
        query(sql: string) {
          calls.push(sql);
          return Promise.resolve({ rows: [{ purged: 0 }], rowCount: 1 });
        },
        release() {},
      }),
    query(sql: string) {
      calls.push(sql);
      if (sql.includes("from bakery.audit_retention_settings")) {
        return Promise.resolve({
          rows: [{ organizationId: "org-1", retentionDays: 30 }],
        });
      }
      if (sql.includes("purge_audit_events")) {
        return Promise.resolve({ rows: [{ purged: 0 }] });
      }
      return Promise.resolve({ rows: [] });
    },
  } as unknown as PgDatabase;
  const { client, registered } = fakeClient();
  const functions = createDefaultInngestFunctions({
    config: INNGEST_CONFIG,
    database,
    client,
  });
  assert(functions.length > 0);
  const retention = registered.find((fn) =>
    fn.config.id === "bakery-audit-retention"
  );
  assert(retention, "retention function registered");
  assertEquals(retention.config.triggers, [{ cron: "17 * * * *" }]);
  await retention.handler({ step: { run: (_name, fn) => fn() } });
  assert(calls.some((sql) => sql.includes("purge_audit_events")));
});

Deno.test("one failing organization never starves the rest and the run still fails loudly", async () => {
  const purged: string[] = [];
  const client = {
    query(sql: string, values?: unknown[]) {
      if (sql.includes("purge_audit_events")) {
        if (values?.[0] === "org-bad") {
          return Promise.reject(new Error("purge failed"));
        }
        purged.push(String(values?.[0]));
      }
      return Promise.resolve({ rows: [{ purged: 0 }], rowCount: 1 });
    },
    release() {},
  };
  const database = {
    connect: () => Promise.resolve(client),
    query: () =>
      Promise.resolve({
        rows: [
          { organizationId: "org-bad", retentionDays: 30 },
          { organizationId: "org-good", retentionDays: 30 },
        ],
      }),
  } as unknown as PgDatabase;
  const error = await purgeExpiredAuditEvents({ database })
    .then(() => undefined, (caught: unknown) => caught);
  assert(error instanceof AggregateError);
  assertEquals((error as AggregateError).errors.length, 1);
  assertEquals(purged, ["org-good"]);
});
