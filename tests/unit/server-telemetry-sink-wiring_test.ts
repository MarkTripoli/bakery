import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  createServerTelemetry,
  createServerTelemetryFromConfig,
} from "../../apps/server/src/platform/telemetry.ts";
import { readTelemetrySinkConfig } from "@bakery/config/telemetry-sink";

/**
 * The production wiring for telemetry export (#23).
 *
 * This file exists because of a specific failure: `main.ts` built the telemetry
 * facade with **no sink**, so every record was counted and discarded, and no
 * behaviour test could see it. A facade with no sink and a facade with a working
 * sink answer every question identically - they both accept events, both never
 * throw, both leave execution correct.
 *
 * So these tests call the same function production calls, and assert the
 * property that distinguishes the two: a record actually reaches a destination.
 */

const ENV_KEYS = [
  "BAKERY_TELEMETRY_LOG_DIR",
  "BAKERY_OTLP_ENDPOINT",
  "BAKERY_OTLP_HEADERS",
  "BAKERY_TELEMETRY_LOG_MAX_BYTES",
  "BAKERY_TELEMETRY_LOG_MAX_FILES",
] as const;

function withEnv(
  values: Partial<Record<(typeof ENV_KEYS)[number], string>>,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) env[key] = values[key];
  return env;
}

Deno.test("no configuration means export is disabled, not broken", () => {
  // The documented default. A server with no destination must behave exactly as
  // it did before this slice.
  assertEquals(readTelemetrySinkConfig(withEnv({})), undefined);
  const telemetry = createServerTelemetryFromConfig(undefined);
  assertEquals(telemetry.stats().disabled, true);
});

Deno.test("a configured log directory produces a sink that actually exports", async () => {
  // The property the old wiring lacked. `disabled` is the observable difference
  // between a facade with a sink and one without, and it is what a behaviour
  // test could never have told apart.
  const directory = await Deno.makeTempDir({ prefix: "bakery-telemetry-" });
  try {
    const config = readTelemetrySinkConfig(
      withEnv({ BAKERY_TELEMETRY_LOG_DIR: directory }),
    );
    assert(config !== undefined);

    const telemetry = createServerTelemetryFromConfig(config);
    assertEquals(telemetry.stats().disabled, false);

    telemetry.event("job.completed", {
      "bakery.action": "work.run",
      "bakery.outcome": "completed",
    });
    await telemetry.close(2_000);

    const written = await readDirectory(directory);
    assert(
      written.length > 0,
      "a configured sink exported nothing: the wiring is not connected",
    );
    const parsed = JSON.parse(written.trim().split("\n")[0]!);
    assertEquals(parsed.name, "job.completed");
    assertEquals(parsed.attributes["bakery.outcome"], "completed");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("saved destinations alone are enough to enable export", async () => {
  const received: string[] = [];
  const telemetry = createServerTelemetryFromConfig(undefined, {
    destinations: (batch) => {
      for (const record of batch) {
        if (record.kind === "event") received.push(record.name);
      }
    },
  });
  assertEquals(telemetry.stats().disabled, false);

  telemetry.event("job.completed", { "bakery.outcome": "completed" });
  await telemetry.close(2_000);
  assertEquals(received, ["job.completed"]);
});

Deno.test("the removed OTLP environment variables are refused at boot, not ignored", () => {
  // An operator who still sets them would otherwise see telemetry silently stop.
  for (
    const env of [
      withEnv({ BAKERY_OTLP_ENDPOINT: "https://collector.example.test" }),
      withEnv({ BAKERY_OTLP_HEADERS: "Authorization=Bearer t" }),
      withEnv({
        BAKERY_TELEMETRY_LOG_DIR: "/var/log/bakery",
        BAKERY_OTLP_ENDPOINT: "https://collector.example.test",
      }),
    ]
  ) {
    assertThrows(
      () => readTelemetrySinkConfig(env),
      Error,
      "TELEMETRY_OTLP_ENV_REMOVED",
    );
  }
});

Deno.test("a destination that never answers cannot hold the server", async () => {
  // AC1, at the wiring level: the exporter's bounds are what keep a hung
  // destination from becoming a hung server, and they must hold for the sink
  // this slice supplies rather than only for a test double.
  const telemetry = createServerTelemetryFromConfig(undefined, {
    destinations: () => new Promise<void>(() => undefined),
  });

  for (let index = 0; index < 5_000; index += 1) {
    telemetry.event("job.completed", { "bakery.outcome": "completed" });
  }
  // Bounded, not unbounded: the queue holds at most the configured capacity and
  // the rest are counted as dropped.
  const stats = telemetry.stats();
  assert(
    stats.queued <= 1_000,
    `queue grew to ${stats.queued}, past the configured capacity`,
  );
  assert(stats.dropped.queueFull > 0, "nothing was counted as dropped");

  // And closing returns rather than waiting for the hung destination forever.
  const started = Date.now();
  await telemetry.close(200);
  assert(Date.now() - started < 5_000);
});

Deno.test("a configuration with no destination is refused, not accepted as export", () => {
  // QA found this: BAKERY_OTLP_HEADERS alone, or an empty value, parsed as a
  // valid config. The facade then counted every record as exported while nothing
  // was written anywhere - "configured but exports nowhere", which is the exact
  // defect this work removes.
  for (
    const env of [
      // A bound with no destination reads the same way.
      withEnv({ BAKERY_TELEMETRY_LOG_MAX_BYTES: "8192" }),
      withEnv({ BAKERY_TELEMETRY_LOG_MAX_FILES: "3" }),
    ]
  ) {
    let threw = false;
    try {
      readTelemetrySinkConfig(env);
    } catch {
      threw = true;
    }
    assertEquals(
      threw,
      true,
      `accepted a destination-less config: ${JSON.stringify(env)}`,
    );
  }
});

Deno.test("a malformed configuration fails at boot instead of silently disabling export", () => {
  // An operator who set a variable and got no telemetry should find out at boot,
  // not by noticing the absence of data weeks later.
  for (
    const env of [
      withEnv({ BAKERY_TELEMETRY_LOG_DIR: "relative/path" }),
      withEnv({ BAKERY_TELEMETRY_LOG_MAX_BYTES: "1e9" }),
      withEnv({ BAKERY_TELEMETRY_LOG_MAX_FILES: "0" }),
    ]
  ) {
    let threw = false;
    try {
      readTelemetrySinkConfig(env);
    } catch {
      threw = true;
    }
    assertEquals(threw, true, `accepted ${JSON.stringify(env)}`);
  }
});

Deno.test("the server facade still works with no sink at all", () => {
  // The pre-existing contract, kept: a caller that supplies nothing gets a
  // disabled telemetry rather than an error.
  const telemetry = createServerTelemetry();
  assertEquals(telemetry.stats().disabled, true);
  telemetry.event("job.completed", { "bakery.outcome": "completed" });
  assertEquals(telemetry.stats().offered, 0);
});

async function readDirectory(directory: string): Promise<string> {
  let text = "";
  for await (const entry of Deno.readDir(directory)) {
    if (!entry.isFile) continue;
    text += await Deno.readTextFile(`${directory}/${entry.name}`);
  }
  return text;
}
