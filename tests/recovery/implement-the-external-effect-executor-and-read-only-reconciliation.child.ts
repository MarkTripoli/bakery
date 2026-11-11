import { z } from "zod";
import {
  closePgDatabase,
  openPgDatabase,
} from "../../apps/server/src/platform/database.ts";
import type {
  AuthoritySnapshot,
  ProviderRequestPort,
} from "../../apps/server/src/modules/catalog/integration-gate.ts";
import {
  GITHUB_ACTION,
  loopbackExecutor,
} from "../helpers/external-effects.ts";

/** What the parent test hands this process: where to connect and which effect to run. */
const ConfigSchema = z.strictObject({
  databaseUrl: z.string().min(1).describe(
    "Owner connection string of the test database.",
  ),
  origin: z.string().min(1).describe(
    "Loopback origin of the fake provider server.",
  ),
  mode: z.enum(["block_before_send", "plain"]).describe(
    "block_before_send parks the process just before the provider write leaves; plain runs the effect.",
  ),
  organizationId: z.uuid().describe("Organization that owns the effect."),
  effectId: z.uuid().describe("Effect the child drives."),
  snapshot: z.unknown().describe("Authority snapshot the parent's rig serves."),
}).describe("Child process configuration written by the recovery test.");

const config = ConfigSchema.parse(JSON.parse(Deno.env.get("EFFECT_CHILD")!));
const database = openPgDatabase(config.databaseUrl);
const port = {
  load: () => Promise.resolve(config.snapshot as AuthoritySnapshot),
};

const executor = loopbackExecutor({
  database,
  port,
  origin: config.origin,
  wrap: (inner): ProviderRequestPort =>
    config.mode === "plain" ? inner : {
      request: async (bound, ref, input, allowed, signal) => {
        if (ref.id === GITHUB_ACTION) {
          // The claim has committed; the write has not left. Park here for the SIGKILL.
          console.log("READY_BEFORE_SEND");
          await new Promise<never>(() => {});
        }
        return await inner.request(bound, ref, input, allowed, signal);
      },
    },
});

try {
  const result = await executor.runEffect({
    organizationId: config.organizationId,
    effectId: config.effectId,
    requestId: "child-request",
    traceId: "child-trace",
  });
  console.log(`DONE ${result.outcome}`);
} finally {
  await closePgDatabase(database);
}
