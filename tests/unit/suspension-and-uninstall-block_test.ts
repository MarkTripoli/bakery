import { assertEquals } from "@std/assert";
import { readInngestRuntimeConfig } from "@bakery/config";
import type { PgDatabase } from "@bakery/persistence";
import type { Inngest } from "inngest";
import { createDefaultInngestFunctions } from "../../apps/server/src/modules/execution/inngest-http.ts";
import { createInstallationTokenBroker } from "../../apps/server/src/modules/integrations/token-broker.ts";
import { createIntegrationDiscoveryWorkflow } from "../../apps/server/src/modules/integrations/discovery-workflow.ts";
import type { DiscoveryResult } from "../../apps/server/src/modules/integrations/discoveries.ts";
import { createFakeGitHubApp } from "../helpers/fake-github-app.ts";

function registered(
  withIntegrations: boolean,
  prefix = "bakery-integration-",
) {
  const captured: { id: unknown; triggers: unknown }[] = [];
  const client = {
    createFunction(config: Record<string, unknown>) {
      captured.push({ id: config.id, triggers: config.triggers });
      return config;
    },
  } as unknown as Inngest;
  const github = createFakeGitHubApp().client;
  createDefaultInngestFunctions({
    config: readInngestRuntimeConfig({
      BAKERY_ENV: "test",
      INNGEST_URL: "http://127.0.0.1:8288",
      INNGEST_SIGNING_KEY:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      INNGEST_EVENT_KEY: "issue-488-event-key",
    }),
    database: {} as PgDatabase,
    client,
    ...(withIntegrations
      ? {
        integrations: {
          github,
          broker: createInstallationTokenBroker({ github }),
        },
      }
      : {}),
  });
  return captured.filter(({ id }) => String(id).startsWith(prefix));
}

Deno.test("the integration lifecycle, discovery, intake, intake retention and fact sweep functions register with the integrations runtime only", () => {
  assertEquals(registered(false), []);
  assertEquals(registered(true), [
    {
      id: "bakery-integration-installation-sweep",
      triggers: [
        { cron: "*/5 * * * *" },
        { event: "bakery/integration-installations.reconcile.v1" },
      ],
    },
    {
      id: "bakery-integration-discovery",
      triggers: [{ event: "bakery/integration.discovery.requested.v1" }],
    },
    {
      id: "bakery-integration-discovery-recovery",
      triggers: [{ cron: "* * * * *" }],
    },
    {
      id: "bakery-integration-intake",
      triggers: [{ event: "bakery/intake.received.v1" }],
    },
    {
      id: "bakery-integration-intake-recovery",
      triggers: [{ cron: "* * * * *" }],
    },
    {
      id: "bakery-integration-intake-retention",
      triggers: [{ cron: "17 * * * *" }],
    },
    {
      id: "bakery-integration-fact-sweep",
      triggers: [{ cron: "*/5 * * * *" }],
    },
  ]);
});

Deno.test("the ticket intake and poll functions register with the integrations runtime only", () => {
  assertEquals(registered(false, "bakery-ticket-"), []);
  assertEquals(registered(true, "bakery-ticket-"), [
    {
      id: "bakery-ticket-intake",
      triggers: [{ event: "bakery/intake.received.v1" }],
    },
    { id: "bakery-ticket-poll", triggers: [{ cron: "*/5 * * * *" }] },
  ]);
});

/** Runs the discovery function's handler with `results` as the run outcomes. */
async function paced(results: DiscoveryResult[]) {
  let handler: ((context: unknown) => Promise<unknown>) | undefined;
  const client = {
    createFunction(_config: unknown, run: typeof handler) {
      handler = run;
      return {};
    },
  } as unknown as Inngest;
  const github = createFakeGitHubApp().client;
  const runs: string[] = [];
  createIntegrationDiscoveryWorkflow({
    client,
    database: {} as PgDatabase,
    github,
    broker: createInstallationTokenBroker({ github }),
    execute: (_dependencies, discoveryId) => {
      runs.push(discoveryId);
      return Promise.resolve(results.shift() ?? { kind: "skipped" });
    },
  });
  const sleeps: { id: string; until: string }[] = [];
  const outcome = await handler!({
    event: { data: { payload: { resourceId: "d-1", resourceVersion: 1 } } },
    step: {
      run: async <T>(_id: string, work: () => Promise<T>) => await work(),
      sleepUntil: (id: string, until: Date) => {
        sleeps.push({ id, until: until.toISOString() });
        return Promise.resolve();
      },
    },
  });
  return { outcome, runs, sleeps };
}

Deno.test("the discovery function sleeps until the Postgres pacing time, then runs the discovery", async () => {
  const until = "2026-10-28T12:00:30.000Z";
  const finished: DiscoveryResult = {
    kind: "finished",
    status: "completed",
    outcome: null,
    unavailable: 0,
    restored: 0,
  };
  const { outcome, runs, sleeps } = await paced([
    { kind: "waiting", until },
    finished,
  ]);
  assertEquals(outcome, finished);
  assertEquals(runs, ["d-1", "d-1"]);
  assertEquals(sleeps, [{ id: "pace-d-1-0", until }]);
});

Deno.test("the discovery function defers to recovery after its bounded pacing waits", async () => {
  const until = "2026-10-28T12:00:30.000Z";
  const { outcome, runs, sleeps } = await paced(
    Array.from({ length: 10 }, () => ({ kind: "waiting" as const, until })),
  );
  assertEquals(outcome, { kind: "deferred" });
  assertEquals(runs.length, 6);
  assertEquals(sleeps.length, 6);
});
