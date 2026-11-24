import { assert, assertEquals } from "@std/assert";
import catalog from "../../docs/technical-design/api-catalog.json" with {
  type: "json",
};
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";
import { NotificationImplementedAction } from "../../packages/contracts/src/implemented-actions.ts";

type CatalogAction = {
  action: string;
  access: string;
  permission?: string;
  organizationContext?: string;
  method: string;
  path: string;
  event: string;
};
const actions = (catalog as unknown as { actions: CatalogAction[] }).actions;
const byName = (name: string) => actions.find((a) => a.action === name);

Deno.test("notification inbox operations are catalogued and implemented", () => {
  const expected: Record<string, [string, string, string]> = {
    "notifications.list": [
      "GET",
      "/v1/notifications",
      "notification:read",
    ],
    "notifications.count": [
      "GET",
      "/v1/notifications/count",
      "notification:read",
    ],
    "notifications.get": [
      "GET",
      "/v1/notifications/{id}",
      "notification:read",
    ],
    "notifications.resolveTarget": [
      "GET",
      "/v1/notifications/{id}/target",
      "notification:read",
    ],
    "notifications.setRead": [
      "PATCH",
      "/v1/notifications/{id}",
      "notification:write",
    ],
    "notifications.markAllRead": [
      "POST",
      "/v1/notifications/read-all",
      "notification:write",
    ],
  };
  for (const [name, [method, path, permission]] of Object.entries(expected)) {
    const entry = byName(name);
    assert(entry, `${name} catalogued`);
    assertEquals([entry.method, entry.path, entry.permission], [
      method,
      path,
      permission,
    ]);
    // Reading and managing your own inbox needs no role beyond membership.
    assertEquals(entry.access, "Current member");
    assertEquals(entry.organizationContext, "required_authenticated_context");
  }
  const implemented = Object.values(NotificationImplementedAction);
  for (const name of Object.keys(expected)) {
    assert(implemented.includes(name as never), `${name} implemented`);
  }
});

Deno.test("Notification carries a typed destination and a revision, never a body", () => {
  const now = new Date().toISOString();
  const parsed = contractSchemas.Notification.parse({
    id: crypto.randomUUID(),
    organizationId: crypto.randomUUID(),
    recipientId: crypto.randomUUID(),
    kind: "mention",
    targetKind: "conversation_message",
    targetId: crypto.randomUUID(),
    targetAnchor: "42",
    conversationId: crypto.randomUUID(),
    runId: null,
    taskId: null,
    actor: {
      principalId: crypto.randomUUID(),
      displayName: "Sam Lee",
      avatarUrl: null,
    },
    destination: { title: "Repository onboarding", available: true },
    approvalOutcome: null,
    read: false,
    revision: 1,
    createdAt: now,
  });
  assertEquals(parsed.kind, "mention");
  assertEquals(parsed.destination.available, true);
  assertEquals(parsed.actor?.displayName, "Sam Lee");
});

Deno.test("Notification rejects an unknown kind or destination kind", () => {
  const base = {
    id: crypto.randomUUID(),
    organizationId: crypto.randomUUID(),
    recipientId: crypto.randomUUID(),
    targetId: crypto.randomUUID(),
    targetAnchor: null,
    conversationId: null,
    runId: null,
    taskId: null,
    actor: null,
    destination: { title: null, available: false },
    approvalOutcome: null,
    read: false,
    revision: 1,
    createdAt: new Date().toISOString(),
  };
  assert(
    !contractSchemas.Notification.safeParse({ ...base, kind: "email_sent" })
      .success,
  );
  assert(
    !contractSchemas.Notification.safeParse({
      ...base,
      kind: "mention",
      targetKind: "email",
    }).success,
  );
});

Deno.test("NotificationCount keeps an unknown count as null, never zero", () => {
  const unknown = contractSchemas.NotificationCount.parse({
    unread: null,
    revision: null,
  });
  assertEquals(unknown.unread, null);
  assertEquals(unknown.revision, null);

  const zero = contractSchemas.NotificationCount.parse({
    unread: 0,
    revision: 3,
  });
  assertEquals(zero.unread, 0);
});

Deno.test("NotificationTarget reports unavailable without a route", () => {
  const unavailable = contractSchemas.NotificationTarget.parse({
    status: "unavailable",
    targetKind: "run",
    path: null,
    anchor: null,
  });
  assertEquals(unavailable.path, null);

  const available = contractSchemas.NotificationTarget.parse({
    status: "available",
    targetKind: "run",
    path: "/tasks/00000000-0000-4000-8000-000000000001",
    anchor: null,
  });
  assertEquals(available.status, "available");
});

Deno.test("NotificationReadUpdate and NotificationMarkAllRead require their guards", () => {
  assert(
    !contractSchemas.NotificationReadUpdate.safeParse({
      id: crypto.randomUUID(),
      read: true,
    }).success,
    "a read mutation must carry the revision it expects",
  );
  assert(
    contractSchemas.NotificationReadUpdate.safeParse({
      id: crypto.randomUUID(),
      read: false,
      expectedCasVersion: 2,
    }).success,
  );
  assert(
    !contractSchemas.NotificationMarkAllRead.safeParse({}).success,
    "mark-all-read must be bounded by a snapshot cutoff",
  );
});

Deno.test("NotificationCursorQuery offers exactly the three inbox views", () => {
  for (const filter of ["all", "unread", "mentions"]) {
    assert(
      contractSchemas.NotificationCursorQuery.safeParse({ filter }).success,
      `${filter} is a valid view`,
    );
  }
  assert(
    !contractSchemas.NotificationCursorQuery.safeParse({ filter: "archived" })
      .success,
  );
});
