// F7.04 unit suite: the claim application refuses on the one shared dispatch
// gate (host status, desired mode, heartbeat connectivity, fresh checks)
// without a database. The repository is a recording fake whose
// readinessGate runs the real pure dispatchGate over the fake host.
import { assertEquals } from "@std/assert";
import type { ClaimsRepository } from "../../packages/persistence/src/claims.ts";
import {
  connectivityState,
  type DispatchGate,
  dispatchGate,
} from "../../packages/persistence/src/machine-readiness.ts";
import { executeClaim } from "../../apps/server/src/modules/execution/claim-application.ts";

const NOW = new Date("2026-10-20T12:00:00.000Z");
const HOST_ID = "00000000-0000-4000-8000-0000000000a1";
const CLAIM_KEY = "00000000-0000-4000-8000-0000000000c1";

type FakeHost = {
  status: string;
  desiredMode: string;
  heartbeatAgeSeconds: number | null;
  slots?: number;
  activeAttempts?: bigint;
};

function claimWith(host: FakeHost, checks: Array<{
  checkId: string;
  status: string;
}> = []) {
  const calls = { jobLookups: 0, noAssignmentReplays: 0, gates: 0 };
  let gate: DispatchGate | undefined;
  const persistence = {
    acquireClaimLock: () => Promise.resolve(),
    loadReplay: () => Promise.resolve(null),
    reclaimAndCountCapacity: () => Promise.resolve(host.activeAttempts ?? 0n),
    saveNoAssignmentReplay: () => {
      calls.noAssignmentReplays += 1;
      return Promise.resolve();
    },
    readinessGate: () => {
      calls.gates += 1;
      const lastHeartbeatAt = host.heartbeatAgeSeconds === null
        ? null
        : new Date(NOW.getTime() - host.heartbeatAgeSeconds * 1_000);
      gate = dispatchGate({
        now: NOW,
        connectivity: connectivityState(lastHeartbeatAt, NOW),
        status: host.status,
        desiredMode: host.desiredMode,
        credentialGeneration: 1,
        inventoryRevision: 1,
        checks: checks.map((entry) => ({
          checkId: entry.checkId,
          componentKey: null,
          status: entry.status,
          reason: null,
          hostGeneration: 1,
          inventoryRevision: 1,
          expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
        })),
      });
      return Promise.resolve(gate);
    },
    findClaimableJob: () => {
      calls.jobLookups += 1;
      return Promise.resolve(null);
    },
  } as unknown as ClaimsRepository;
  const result = executeClaim({
    secret: "unit-secret",
    headers: new Headers({ "Idempotency-Key": CLAIM_KEY }),
    input: {
      claimKey: CLAIM_KEY,
      workerHostId: HOST_ID,
      capabilities: ["git"],
    } as Parameters<typeof executeClaim>[0]["input"],
    unitOfWork: {
      run: (_headers, _hostId, work) =>
        work({
          identity: {
            host: {
              id: HOST_ID,
              organizationId: "00000000-0000-4000-8000-0000000000b1",
              principalId: "00000000-0000-4000-8000-0000000000b2",
              capabilities: ["git"],
              slots: host.slots ?? 1,
              status: host.status,
              desiredMode: host.desiredMode,
              protocolVersion: 1,
              credentialGeneration: 1,
              inventoryRevision: 1,
              workerSessionId: null,
              workerSessionGeneration: 0,
            },
          },
          persistence,
        }),
    },
  });
  return { result, calls, gateOf: () => gate };
}

const REFUSED: Array<[string, FakeHost, string | null]> = [
  ["stale heartbeat", {
    status: "online",
    desiredMode: "accepting",
    heartbeatAgeSeconds: 45,
  }, "stale"],
  ["offline heartbeat", {
    status: "online",
    desiredMode: "accepting",
    heartbeatAgeSeconds: 120,
  }, "offline"],
  ["never heartbeated", {
    status: "online",
    desiredMode: "accepting",
    heartbeatAgeSeconds: null,
  }, "offline"],
  ["paused desired mode", {
    status: "online",
    desiredMode: "paused",
    heartbeatAgeSeconds: 1,
  }, "paused"],
  ["draining desired mode", {
    status: "online",
    desiredMode: "draining",
    heartbeatAgeSeconds: 1,
  }, "draining"],
  ["offline status", {
    status: "offline",
    desiredMode: "accepting",
    heartbeatAgeSeconds: 1,
  }, "offline"],
];

for (const [name, host, reason] of REFUSED) {
  Deno.test(`claim is refused before job lookup: ${name}`, async () => {
    const { result, calls, gateOf } = claimWith(host);
    assertEquals(await result, { status: 204, replayed: false });
    assertEquals(calls.jobLookups, 0);
    assertEquals(calls.noAssignmentReplays, 1);
    assertEquals(gateOf()?.allBlocked, true);
    assertEquals(gateOf()?.reason, reason);
  });
}

Deno.test("claim proceeds to job lookup on a fresh accepting host", async () => {
  const { result, calls } = claimWith({
    status: "online",
    desiredMode: "accepting",
    heartbeatAgeSeconds: 5,
  });
  assertEquals(await result, { status: 204, replayed: false });
  assertEquals(calls.jobLookups, 1);
});

Deno.test("a full slot refuses before the gate is consulted", async () => {
  const { result, calls } = claimWith({
    status: "online",
    desiredMode: "accepting",
    heartbeatAgeSeconds: 5,
    slots: 1,
    activeAttempts: 1n,
  });
  assertEquals(await result, { status: 204, replayed: false });
  assertEquals(calls.gates, 0);
  assertEquals(calls.jobLookups, 0);
});

Deno.test("a capability-only failure refuses just that capability", async () => {
  const { result, calls } = claimWith({
    status: "online",
    desiredMode: "accepting",
    heartbeatAgeSeconds: 5,
  }, [{ checkId: "capability:git", status: "fail" }]);
  assertEquals(await result, { status: 204, replayed: false });
  assertEquals(calls.jobLookups, 0);
});
