import { assertEquals } from "@std/assert";
import type { Inngest } from "inngest";
import { createDefaultInngestFunctions } from "../../apps/server/src/modules/execution/inngest-http.ts";
import { readInngestRuntimeConfig } from "@bakery/config";
import { createFakeGitHubApp } from "../helpers/fake-github-app.ts";
import { createInstallationTokenBroker } from "../../apps/server/src/modules/integrations/token-broker.ts";

/**
 * The export worker must be reachable from the PRODUCTION function list.
 *
 * This test exists because the worker was registered with a trigger nothing
 * emitted: `bakery/source-event.recorded` had no producer outside tests, so the
 * function was registered and never fired. A registration is not a feature, and
 * a test that calls the worker directly cannot tell the difference - it proves
 * the code works, not that anything runs it.
 *
 * So this reads the same list the server builds, and asserts the trigger is one
 * that fires without another module's cooperation.
 */

const EXPORT_FUNCTION_ID = "bakery-integration-event-export";

function productionFunctions() {
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
      INNGEST_EVENT_KEY: "issue-21-event-key",
    }),
    database: {} as never,
    client,
    integrations: {
      github,
      broker: createInstallationTokenBroker({ github }),
      // An empty registry is enough: this test is about the trigger, and the
      // registry only decides which providers a function may resolve.
      registry: { integrations: [], get: () => undefined } as never,
      secretsKey: undefined,
    },
  });
  return captured;
}

Deno.test("the export worker is in the production function list", () => {
  const functions = productionFunctions();
  const exportFunction = functions.find((f) => f.id === EXPORT_FUNCTION_ID);
  assertEquals(
    exportFunction !== undefined,
    true,
    "the export worker is not registered at all",
  );
});

Deno.test("the export worker fires on a schedule, not on an event nobody sends", () => {
  const functions = productionFunctions();
  const exportFunction = functions.find((f) => f.id === EXPORT_FUNCTION_ID);
  const triggers = exportFunction?.triggers as
    | readonly { cron?: string; event?: string }[]
    | undefined;
  assertEquals(Array.isArray(triggers), true);

  const crons = (triggers ?? []).filter((t) => typeof t.cron === "string");
  assertEquals(
    crons.length > 0,
    true,
    "the export worker has no cron trigger, so nothing fires it in production",
  );

  // And specifically not the event trigger that had no producer: an event
  // trigger here would be the same defect wearing a different shape.
  const events = (triggers ?? []).filter((t) => typeof t.event === "string");
  assertEquals(
    events.some((t) => t.event === "bakery/source-event.recorded"),
    false,
    "the export worker still depends on an event nothing emits",
  );
});
