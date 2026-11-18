import { assertEquals } from "@std/assert";
import {
  deliveryIdentity,
  type DeliveryLedger,
  type DeliveryTransport,
  dispatchEventExport,
} from "../../apps/server/src/modules/integrations/event-export-dispatch.ts";
import type { AuthoritySnapshot } from "../../apps/server/src/modules/catalog/integration-gate.ts";

/**
 * Issue #21: a retry must present the same delivery identity as the first
 * attempt.
 *
 * This is the property a receiver deduplicates on. If the identity changes per
 * attempt, that receiver stores one event twice under two names, which is the
 * replay this whole path exists to prevent.
 *
 * It ran through a database test before, and that test asserted
 * `startsWith("bakery-")` - a shape check - so it passed while the value it was
 * protecting changed on every attempt. The property is a property of the pure
 * function, so it is asserted here without a database at all.
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

function snapshot(): AuthoritySnapshot {
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
      state: "active",
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

const raw = new TextEncoder().encode('{"event":"issue.opened"}');

function ports(): {
  ledger: DeliveryLedger;
  transport: DeliveryTransport;
  sent: string[];
} {
  const sent: string[] = [];
  return {
    sent,
    ledger: {
      record: () => Promise.resolve({ deliveryId: crypto.randomUUID() }),
      settle: () => Promise.resolve(),
    },
    transport: {
      send: (input) => {
        sent.push(input.headers["x-bakery-delivery"]!);
        return Promise.resolve({ kind: "acknowledged", status: 202 });
      },
    },
  };
}

Deno.test("two subscriptions sharing a long prefix do not collide", async () => {
  // The old identity truncated raw ids to fit the 128-character header, so these
  // two - identical for the first 40 characters - produced one identity for two
  // different delivery streams. That is a collision in the single value a
  // receiver is entitled to trust as unique.
  const prefix = "1a2b3c4d-".repeat(5);
  const first = await deliveryIdentity({
    subscriptionId: `${prefix}aaaa`,
    sourceEventId: "event-1",
  });
  const second = await deliveryIdentity({
    subscriptionId: `${prefix}bbbb`,
    sourceEventId: "event-1",
  });
  assertEquals(first === second, false, "a shared prefix must not collide");

  // And it still fits the header the verifier accepts.
  assertEquals(first.length <= 128, true);
});

Deno.test("the identity does not vary with the attempt number", async () => {
  // The function takes no attempt argument at all, so this asserts the shape of
  // the contract rather than only its behaviour: an identity that cannot see the
  // attempt cannot vary by it.
  assertEquals(
    await deliveryIdentity({
      subscriptionId: subscription.id,
      sourceEventId: "event-1",
    }),
    await deliveryIdentity({
      subscriptionId: subscription.id,
      sourceEventId: "event-1",
    }),
  );
});

Deno.test("attempt 2 presents the same identity to the receiver as attempt 1", async () => {
  const identities: string[] = [];
  for (const attempt of [1, 2]) {
    const { ledger, transport } = ports();
    const result = await dispatchEventExport({
      snapshot: snapshot(),
      subscription,
      destination,
      eventKind: "issue.opened",
      sourceEventId: "event-1",
      attempt,
      raw,
      payloadDigest: "digest-1",
      sign: (identity) => Promise.resolve({ "x-bakery-delivery": identity }),
      resolve: () => Promise.resolve(["93.184.216.34"]),
      reloadAuthority: () => Promise.resolve(snapshot()),
      ledger,
      transport,
      now: () => new Date("2026-01-01T00:00:00Z"),
    });
    if (!result.ok) throw new Error("unreachable");
    identities.push(result.deliveryIdentity);
  }

  assertEquals(
    identities[1],
    identities[0],
    "a retry must present the same delivery identity, or the receiver stores one event twice",
  );
});

Deno.test("two different events from one subscription do not share an identity", async () => {
  // The other half: collapsing the attempt must not collapse distinct events.
  const identities: string[] = [];
  for (const eventId of ["event-1", "event-2"]) {
    const { ledger, transport } = ports();
    const result = await dispatchEventExport({
      snapshot: snapshot(),
      subscription,
      destination,
      eventKind: "issue.opened",
      sourceEventId: eventId,
      attempt: 1,
      raw,
      payloadDigest: "digest-1",
      sign: (identity) => Promise.resolve({ "x-bakery-delivery": identity }),
      resolve: () => Promise.resolve(["93.184.216.34"]),
      reloadAuthority: () => Promise.resolve(snapshot()),
      ledger,
      transport,
      now: () => new Date("2026-01-01T00:00:00Z"),
    });
    if (!result.ok) throw new Error("unreachable");
    identities.push(result.deliveryIdentity);
  }
  assertEquals(identities[1] === identities[0], false);
});
