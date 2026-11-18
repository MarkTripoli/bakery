import { assertEquals } from "@std/assert";
import type { AuthoritySnapshot } from "../../apps/server/src/modules/catalog/integration-gate.ts";
import {
  authorizeEventExport,
  type ExportDestination,
  type ExportSubscription,
} from "../../apps/server/src/modules/integrations/event-export-authorization.ts";

/**
 * Slice 3 of issue #21, AC2: "a revoked subscription or a private source
 * resource => no event payload sent merely because the connection exists".
 *
 * Every test starts from a fully authorized baseline and breaks exactly one
 * fact, so a refusal is attributable to that fact and not to an unrelated
 * missing field. The baseline being permissive is itself the assertion that the
 * accepting path exists: a suite where everything refuses would prove nothing.
 */

const subscription: ExportSubscription = {
  status: "active",
  revokedAt: null,
  eventKinds: ["issue.opened", "pull_request.closed"],
};

const destination: ExportDestination = {
  status: "active",
  tombstonedAt: null,
};

function snapshot(
  overrides: {
    connectionState?: "active" | "reconnect_required" | "disabled";
    scopes?: readonly string[];
    selected?: boolean;
    available?: boolean;
  } = {},
): AuthoritySnapshot {
  return {
    organizationId: "org-1",
    actor: {
      principalId: "principal-1",
      subjectType: "principal",
      active: true,
    },
    install: {
      id: "install-1",
      providerId: "github",
      manifestDigest: "digest-1",
      enabled: true,
      approvedScopes: overrides.scopes ?? ["events:subscribe"],
    },
    connection: {
      id: "connection-1",
      installId: "install-1",
      state: overrides.connectionState ?? "active",
      providerPermissions: {},
    },
    resource: {
      id: "resource-1",
      kind: "repository",
      selected: overrides.selected ?? true,
      available: overrides.available ?? true,
      binding: {},
      repositoryId: "1",
    },
    grants: [],
    policyRevision: 1,
  } as unknown as AuthoritySnapshot;
}

const decide = (
  overrides: {
    snapshot?: Parameters<typeof snapshot>[0];
    subscription?: Partial<ExportSubscription>;
    destination?: Partial<ExportDestination>;
    eventKind?: string;
  } = {},
) =>
  authorizeEventExport({
    snapshot: snapshot(overrides.snapshot),
    subscription: { ...subscription, ...overrides.subscription },
    destination: { ...destination, ...overrides.destination },
    eventKind: overrides.eventKind ?? "issue.opened",
  });

Deno.test("an authorized export is allowed", () => {
  // The baseline must accept, or no refusal below is attributable to the fact
  // it breaks.
  assertEquals(decide(), { ok: true });
});

Deno.test("a revoked subscription sends nothing even though the connection exists", () => {
  assertEquals(decide({ subscription: { status: "revoked" } }), {
    ok: false,
    reason: "subscription_revoked",
  });
  // `revokedAt` alone must also refuse: a row can be marked revoked by either
  // field, and a disagreement between them has to fail closed.
  assertEquals(
    decide({ subscription: { revokedAt: "2026-01-01T00:00:00Z" } }),
    {
      ok: false,
      reason: "subscription_revoked",
    },
  );
});

Deno.test("a private (unselected or unavailable) source resource sends nothing", () => {
  assertEquals(decide({ snapshot: { selected: false } }), {
    ok: false,
    reason: "source_not_exportable",
  });
  assertEquals(decide({ snapshot: { available: false } }), {
    ok: false,
    reason: "source_not_exportable",
  });
});

Deno.test("an event the subscription did not name is not sent", () => {
  assertEquals(decide({ eventKind: "issue.deleted" }), {
    ok: false,
    reason: "event_not_subscribed",
  });
});

Deno.test("an empty event set exports nothing, never everything", () => {
  // The dangerous reading of an empty set is "all events". It must be "none".
  assertEquals(decide({ subscription: { eventKinds: [] } }), {
    ok: false,
    reason: "event_not_subscribed",
  });
});

Deno.test("a connection that is not active sends nothing", () => {
  assertEquals(decide({ snapshot: { connectionState: "disabled" } }), {
    ok: false,
    reason: "connection_not_active",
  });
  // A credential that needs reconnecting is not a credential that works.
  assertEquals(
    decide({ snapshot: { connectionState: "reconnect_required" } }),
    {
      ok: false,
      reason: "connection_not_active",
    },
  );
});

Deno.test("an install that lost the events:subscribe scope sends nothing", () => {
  // Re-approved with fewer scopes: the subscription row still exists, and this
  // is exactly the case that would leak if the scope were checked only once.
  assertEquals(decide({ snapshot: { scopes: [] } }), {
    ok: false,
    reason: "scope_not_granted",
  });
  // A different scope is not a substitute.
  assertEquals(decide({ snapshot: { scopes: ["tasks:read"] } }), {
    ok: false,
    reason: "scope_not_granted",
  });
});

Deno.test("a tombstoned destination sends nothing even if its status still reads active", () => {
  assertEquals(
    decide({ destination: { tombstonedAt: "2026-01-01T00:00:00Z" } }),
    { ok: false, reason: "destination_not_exportable" },
  );
  assertEquals(decide({ destination: { status: "disabled" } }), {
    ok: false,
    reason: "destination_not_exportable",
  });
});

Deno.test("the subscription is judged before the resource, so the reason names the first cause", () => {
  // Two things wrong at once: the reason must be deterministic rather than
  // depending on object key order, so a recorded refusal means one thing.
  assertEquals(
    decide({
      subscription: { status: "revoked" },
      snapshot: { selected: false },
    }),
    { ok: false, reason: "subscription_revoked" },
  );
});

Deno.test("a decision cannot be made from a mutable snapshot it could outlive", () => {
  // The function takes a snapshot and returns a verdict, holding no reference
  // afterwards; mutating the caller's object after the call must not change a
  // verdict already taken.
  const mutable = snapshot();
  const first = authorizeEventExport({
    snapshot: mutable,
    subscription,
    destination,
    eventKind: "issue.opened",
  });
  (mutable as { connection: { state: string } }).connection.state = "disabled";
  assertEquals(first, { ok: true });
  assertEquals(
    authorizeEventExport({
      snapshot: mutable,
      subscription,
      destination,
      eventKind: "issue.opened",
    }),
    { ok: false, reason: "connection_not_active" },
  );
});
