import {
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import type { PgDatabase } from "../../apps/server/src/platform/database.ts";
import { runAdmission } from "../../apps/server/src/modules/effects/admission.ts";
import { EFFECT_FAILURE_CODES } from "../../apps/server/src/modules/effects/schema.ts";
import {
  denyAllProviderRequests,
  type ProviderRequestPort,
  providerRequestsForEnvironment,
} from "../../apps/server/src/modules/catalog/integration-gate.ts";
import { mintBrokerToken } from "../../apps/server/src/modules/catalog/plugin-broker.ts";
import {
  createInstallationCredentialPort,
  type CredentialStoreDeps,
} from "../../apps/server/src/modules/integrations/credential-port.ts";
import {
  childRunEnvironment,
  toRunEnvironment,
} from "../../apps/server/src/modules/work/run-environment.ts";

/**
 * Issue #427 slice S1: a run pinned `offline` makes no external effect and is
 * never brokered a credential; a spawned run inherits its parent's environment.
 */

const run = (environment: string) => ({
  runId: "r",
  taskId: "t",
  runStatus: "running",
  stepStatus: "running",
  environment,
});

Deno.test("effect admission refuses every effect of an offline run", () => {
  assertEquals(EFFECT_FAILURE_CODES.includes("environment_offline"), true);
  assertEquals(runAdmission(run("offline"), []), "environment_offline");
  // Offline wins over the other blocks: the run's reach is permanent.
  assertEquals(
    runAdmission({ ...run("offline"), runStatus: "completed" }, []),
    "environment_offline",
  );
  // An unknown stored value fails closed.
  assertEquals(runAdmission(run("bogus"), []), "environment_offline");
  assertEquals(runAdmission(run("live"), []), null);
  // Work with no run is unchanged.
  assertEquals(runAdmission(null, []), null);
});

Deno.test("the broker port for an offline run is denyAllProviderRequests", () => {
  const live: ProviderRequestPort = { request: () => Promise.resolve("sent") };
  assertStrictEquals(
    providerRequestsForEnvironment("offline", live),
    denyAllProviderRequests,
  );
  assertStrictEquals(providerRequestsForEnvironment("live", live), live);
  assertStrictEquals(providerRequestsForEnvironment(undefined, live), live);
});

Deno.test("credential brokering refuses an offline run before any read", async () => {
  let touched = 0;
  const database = {
    query: () => {
      touched += 1;
      return Promise.resolve({ rows: [] });
    },
  } as unknown as PgDatabase;
  const deps = {
    database,
    broker: {
      token: () => {
        touched += 1;
        return Promise.reject(new Error("never minted"));
      },
    },
    readAppCredentials: () => {
      touched += 1;
      return Promise.resolve(null);
    },
    generationOf: () => 7,
  } as unknown as CredentialStoreDeps;
  const error = await assertRejects(
    () =>
      createInstallationCredentialPort(deps).resolve({
        organizationId: "00000000-0000-4000-8000-000000004271",
        connectionId: "00000000-0000-4000-8000-000000004272",
        resourceId: "00000000-0000-4000-8000-000000004273",
        profileId: "github-app",
        providerPermissions: { contents: "write" },
        generation: 7,
        runEnvironment: "offline",
        subject: {
          installId: "00000000-0000-4000-8000-000000004274",
          resourceKind: "repository",
          repositoryId: "900",
        },
      }),
    StandardError,
  );
  assertEquals(error.code, "STATE_CONFLICT");
  assertEquals(error.params?.reason, "environment_offline");
  assertEquals(touched, 0);
});

Deno.test("no plugin broker token is minted for an offline run", async () => {
  const key = new Uint8Array(32).fill(7);
  const claims = {
    organizationId: "00000000-0000-4000-8000-000000004275",
    installId: "00000000-0000-4000-8000-000000004276",
    jobId: "00000000-0000-4000-8000-000000004277",
    epoch: "00000000-0000-4000-8000-000000004278",
    now: 1_000,
    ttlMs: 60_000,
  };
  await assertRejects(
    () => mintBrokerToken(key, { ...claims, runEnvironment: "offline" }),
    Error,
    "BROKER_ENVIRONMENT_OFFLINE",
  );
  const minted = await mintBrokerToken(key, {
    ...claims,
    runEnvironment: "live",
  });
  assertEquals(minted.claims.jobId, claims.jobId);
});

Deno.test("a spawned run inherits its parent's environment", () => {
  assertEquals(childRunEnvironment("offline", undefined), "offline");
  assertEquals(childRunEnvironment("live", undefined), "live");
  assertEquals(childRunEnvironment("live", "offline"), "offline");
  assertEquals(childRunEnvironment("offline", "offline"), "offline");
  const error = assertThrows(
    () => childRunEnvironment("offline", "live"),
    StandardError,
  );
  assertEquals(error.code, "STATE_CONFLICT");
  assertEquals(error.params?.reason, "environment_offline_parent");
  assertEquals(toRunEnvironment("live"), "live");
  assertEquals(toRunEnvironment(undefined), "offline");
});
