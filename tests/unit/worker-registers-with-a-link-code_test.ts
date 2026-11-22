// The worker sends a one-paste link code (#70) in its own field, and a long
// enrollment token as before; the two never share a field.
import { assertEquals } from "@std/assert";
import { ensureRegistration } from "../../apps/worker/src/registration-enrollment.ts";
import type { WorkerConfig } from "../../apps/worker/src/config.ts";
import type { WorkerApiClient } from "../../apps/worker/src/client.ts";
import type { RegistrationStore } from "../../apps/worker/src/registration-store.ts";

async function registerWith(enrollmentToken: string) {
  const stateDir = await Deno.makeTempDir({ prefix: "bakery-link-worker-" });
  const sent: Record<string, unknown>[] = [];
  const store = {
    load: () => Promise.resolve(null),
    savePendingRegistration: (
      workerCredential: string,
      registrationIdempotencyKey: string,
    ) => Promise.resolve({ workerCredential, registrationIdempotencyKey }),
    saveRegistered: (workerCredential: string, value: object) =>
      Promise.resolve({ ...value, workerCredential }),
  };
  const client = {
    setCredential: () => undefined,
    register: (body: Record<string, unknown>) => {
      sent.push(body);
      return Promise.resolve({
        value: {
          workerHostId: crypto.randomUUID(),
          principalId: crypto.randomUUID(),
          status: "registered",
          registrationGeneration: 1,
        },
        replayed: false,
      });
    },
  };
  const config = {
    stateDir,
    enrollmentToken,
    name: "build-box-01",
    os: "linux",
    architecture: "arm64",
    capabilities: ["git"],
    toolchainVersions: {},
    slots: 1,
  };
  try {
    await ensureRegistration(
      config as unknown as WorkerConfig,
      store as unknown as RegistrationStore,
      client as unknown as WorkerApiClient,
    );
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
  return sent[0]!;
}

Deno.test("a link code goes in linkCode, never enrollmentToken", async () => {
  for (const code of ["K7QM-2XPD", "k7qm2xpd"]) {
    const body = await registerWith(code);
    assertEquals(body.linkCode, code);
    assertEquals("enrollmentToken" in body, false);
  }
});

Deno.test("a long enrollment token goes in enrollmentToken as before", async () => {
  const token = "b3J0LXRva2VuLWZvci10aGUtd29ya2VyLWVucm9sbG1lbnQtMDE";
  const body = await registerWith(token);
  assertEquals(body.enrollmentToken, token);
  assertEquals("linkCode" in body, false);
});

Deno.test("a code with a confusable letter is not taken for a link code", async () => {
  const body = await registerWith("K7QM-2XP0");
  assertEquals(body.enrollmentToken, "K7QM-2XP0");
  assertEquals("linkCode" in body, false);
});
