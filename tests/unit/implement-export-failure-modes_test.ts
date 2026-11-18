import { assertEquals } from "@std/assert";
import {
  type DeliveryLedger,
  type DeliveryTransport,
  dispatchEventExport,
} from "../../apps/server/src/modules/integrations/event-export-dispatch.ts";
import type { AuthoritySnapshot } from "../../apps/server/src/modules/catalog/integration-gate.ts";

/**
 * Issue #21: three failures that must not be confused with each other.
 *
 * A signing failure is local and terminal. An uncertain send means the receiver
 * may or may not have acted. Authority that changed mid-flight means the attempt
 * must be abandoned. Treating the first as the second, which is what happened
 * until review, produces a delivery retried forever for a reason no retry can
 * fix.
 */

const subscription = {
  id: "6f1b0f3e-6f1b-4f3e-8f1b-6f1b0f3e6f1b",
  status: "active" as const,
  revokedAt: null,
  eventKinds: ["issue.opened"],
};

const destination = {
  id: "7a2c1f4d-7a2c-4f4d-9a2c-7a2c1f4d7a2c",
  status: "active" as const,
  tombstonedAt: null,
  origin: "https://receiver.example.test",
  path: "/events",
};

function snapshot(
  overrides: { revoked?: boolean } = {},
): AuthoritySnapshot {
  return {
    organizationId: "8b3d2a5e-8b3d-4a5e-ab3d-8b3d2a5e8b3d",
    actor: { principalId: "9c4e3b6f", subjectType: "principal", active: true },
    install: {
      id: "install-1",
      providerId: "github",
      manifestDigest: "digest-1",
      enabled: true,
      approvedScopes: ["events:subscribe"],
    },
    connection: {
      id: "0d5f4c7a",
      installId: "install-1",
      state: overrides.revoked ? "disabled" : "active",
      providerPermissions: {},
    },
    resource: {
      id: "1e6a5d8b",
      kind: "repository",
      selected: true,
      available: true,
      binding: {},
      repositoryId: "1",
    },
    grants: [],
    policyRevision: 1,
  } as unknown as AuthoritySnapshot;
}

type Recorded = {
  settled: { deliveryId: string; status: string; outcomeCode: string | null }[];
  sent: number;
};

function ports(): { ledger: DeliveryLedger; transport: DeliveryTransport } {
  const state: Recorded = { settled: [], sent: 0 };
  return {
    ledger: {
      record: () => Promise.resolve({ deliveryId: "delivery-1" }),
      settle: (input) => {
        state.settled.push({
          deliveryId: input.deliveryId,
          status: input.status,
          outcomeCode: input.outcomeCode,
        });
        return Promise.resolve();
      },
    },
    transport: {
      send: () => {
        state.sent += 1;
        return Promise.resolve({ kind: "acknowledged", status: 202 });
      },
    },
  };
}

const raw = new TextEncoder().encode('{"event":"issue.opened"}');

Deno.test("a signing failure is terminal, not an uncertain delivery", async () => {
  const { ledger, transport } = ports();
  const result = await dispatchEventExport({
    snapshot: snapshot(),
    subscription,
    destination,
    eventKind: "issue.opened",
    sourceEventId: "event-1",
    attempt: 1,
    raw,
    payloadDigest: "digest-1",
    sign: () => Promise.reject(new Error("key unavailable")),
    resolve: () => Promise.resolve(["93.184.216.34"]),
    reloadAuthority: () => Promise.resolve(snapshot()),
    ledger,
    transport,
    now: () => new Date("2026-01-01T00:00:00Z"),
  });

  // Terminal: a local failure before anything left. Recording it as uncertain
  // would schedule a retry that can never succeed for a reason no retry fixes.
  assertEquals(result, { ok: false, reason: "signing_failed" });
});

Deno.test("a signing failure sends nothing and records nothing", async () => {
  let recorded = 0;
  let sent = 0;
  const result = await dispatchEventExport({
    snapshot: snapshot(),
    subscription,
    destination,
    eventKind: "issue.opened",
    sourceEventId: "event-1",
    attempt: 1,
    raw,
    payloadDigest: "digest-1",
    sign: () => {
      throw new Error("key unavailable");
    },
    resolve: () => Promise.resolve(["93.184.216.34"]),
    reloadAuthority: () => Promise.resolve(snapshot()),
    ledger: {
      record: () => {
        recorded += 1;
        return Promise.resolve({ deliveryId: "delivery-1" });
      },
      settle: () => Promise.resolve(),
    },
    transport: {
      send: () => {
        sent += 1;
        return Promise.resolve({ kind: "acknowledged", status: 202 });
      },
    },
    now: () => new Date("2026-01-01T00:00:00Z"),
  });

  assertEquals(result, { ok: false, reason: "signing_failed" });
  // Signing happens before the row exists, so a failure leaves no orphan attempt
  // that the recovery sweep would pick up and retry forever.
  assertEquals(recorded, 0);
  assertEquals(sent, 0);
});

Deno.test("authority revoked between the snapshot and the send is not sent", async () => {
  const { ledger, transport } = ports();
  const result = await dispatchEventExport({
    snapshot: snapshot(),
    subscription,
    destination,
    eventKind: "issue.opened",
    sourceEventId: "event-1",
    attempt: 1,
    raw,
    payloadDigest: "digest-1",
    sign: () => Promise.resolve({ "x-bakery-delivery": "d" }),
    // The subscription was revoked in the window between authorizing and sending;
    // a snapshot is a value, not a lock.
    resolve: () => Promise.resolve(["93.184.216.34"]),
    reloadAuthority: () => Promise.resolve(snapshot({ revoked: true })),
    ledger,
    transport,
    now: () => new Date("2026-01-01T00:00:00Z"),
  });

  assertEquals(result, { ok: false, reason: "authority_changed" });
});

Deno.test("the abandoned attempt is settled rather than left due", async () => {
  const settled: { status: string; outcomeCode: string | null }[] = [];
  let sent = 0;
  const result = await dispatchEventExport({
    snapshot: snapshot(),
    subscription,
    destination,
    eventKind: "issue.opened",
    sourceEventId: "event-1",
    attempt: 1,
    raw,
    payloadDigest: "digest-1",
    sign: () => Promise.resolve({ "x-bakery-delivery": "d" }),
    resolve: () => Promise.resolve(["93.184.216.34"]),
    reloadAuthority: () => Promise.resolve(snapshot({ revoked: true })),
    ledger: {
      record: () => Promise.resolve({ deliveryId: "delivery-1" }),
      settle: (input) => {
        settled.push({
          status: input.status,
          outcomeCode: input.outcomeCode,
        });
        return Promise.resolve();
      },
    },
    transport: {
      send: () => {
        sent += 1;
        return Promise.resolve({ kind: "acknowledged", status: 202 });
      },
    },
    now: () => new Date("2026-01-01T00:00:00Z"),
  });

  assertEquals(result, { ok: false, reason: "authority_changed" });
  assertEquals(sent, 0);
  // A row exists, because an attempt was prepared. Leaving it unsettled would
  // make the recovery sweep retry it; marking it failed with the reason records
  // what actually happened.
  assertEquals(settled.length, 1);
  assertEquals(settled[0]!.status, "failed");
  assertEquals(settled[0]!.outcomeCode, "connection_not_active");
});
