import { assertEquals } from "@std/assert";
import { authTestOrigin, cleanupAuthFixture } from "../helpers/auth.ts";
import {
  openSocketFixture,
  type SocketFixture,
} from "../helpers/events-socket.ts";

type Outcome = {
  status: string;
  decidedBy:
    | { principalId: string; displayName: string; avatarUrl: string | null }
    | null;
  decidedAt: string | null;
} | null;

type ApprovalState = {
  status: string;
  decision?: string;
  decided?: boolean;
  revoked?: boolean;
  expiresAt?: string;
};

async function seedApproval(
  fixture: SocketFixture,
  state: ApprovalState,
): Promise<string> {
  const id = crypto.randomUUID();
  const decidedAt = state.decided ? new Date().toISOString() : null;
  await fixture.pgDatabase.query(
    `insert into bakery.questions (
       id, organization_id, kind, conversation_id, task_id, generation,
       prompt, status, decision, decided_by, decided_at, revoked_by,
       revoked_at, expires_at
     ) values ($1, $2, 'approval', $3, $4, 1, 'Ship it?', $5, $6, $7, $8,
       $9, $10, $11)`,
    [
      id,
      fixture.organizationId,
      fixture.conversationId,
      fixture.taskId,
      state.status,
      state.decision ?? null,
      state.decided ? fixture.principalId : null,
      decidedAt,
      state.revoked ? fixture.principalId : null,
      state.revoked ? new Date().toISOString() : null,
      state.expiresAt ?? null,
    ],
  );
  return id;
}

async function seedNotification(
  fixture: SocketFixture,
  kind: string,
  targetKind: string,
  targetId: string,
  taskId: string | null = fixture.taskId,
): Promise<string> {
  const event = await fixture.insertDomainEvent({
    eventType: "approval.requested",
    aggregateId: crypto.randomUUID(),
  });
  const row = await fixture.pgDatabase.query<{ id: string }>(
    `insert into bakery.notifications (
       organization_id, recipient_id, kind, target_kind, target_id, task_id,
       source_event_id, source_version
     ) values ($1, $2, $3, $4, $5, $6, $7, 1)
     returning id`,
    [
      fixture.organizationId,
      fixture.principalId,
      kind,
      targetKind,
      targetId,
      taskId,
      event.id,
    ],
  );
  return row.rows[0]!.id;
}

async function listInbox(fixture: SocketFixture) {
  const response = await fixture.app.fetch(
    new Request(`${authTestOrigin}/v1/notifications?limit=50`, {
      headers: {
        cookie: fixture.cookie,
        "Bakery-Organization-Id": fixture.organizationId,
      },
    }),
  );
  const text = await response.text();
  assertEquals(response.status, 200, text);
  return (JSON.parse(text) as {
    items: {
      id: string;
      destination: { available: boolean };
      approvalOutcome: Outcome;
    }[];
  }).items;
}

Deno.test("one inbox read says how each approval ended and by whom", async () => {
  const fixture = await openSocketFixture();
  try {
    const name = (await fixture.pgDatabase.query<{ name: string }>(
      "select display_name as name from bakery.principals where id = $1",
      [fixture.principalId],
    )).rows[0]!.name;
    const past = new Date(Date.now() - 60_000).toISOString();
    const cases: [ApprovalState, string, boolean][] = [
      [{ status: "open" }, "open", false],
      [
        { status: "answered", decision: "approve", decided: true },
        "approved",
        true,
      ],
      [
        { status: "consumed", decision: "approve", decided: true },
        "approved",
        true,
      ],
      [
        { status: "answered", decision: "request_changes", decided: true },
        "changes_requested",
        true,
      ],
      [
        { status: "answered", decision: "reject", decided: true },
        "rejected",
        true,
      ],
      [{ status: "expired" }, "expired", false],
      [{ status: "open", expiresAt: past }, "expired", false],
      [{ status: "superseded" }, "withdrawn", false],
      [{ status: "revoked", revoked: true }, "withdrawn", true],
    ];
    const expected = new Map<string, [string, boolean]>();
    for (const [state, status, byPerson] of cases) {
      const approvalId = await seedApproval(fixture, state);
      const id = await seedNotification(
        fixture,
        "approval_requested",
        "approval",
        approvalId,
      );
      expected.set(id, [status, byPerson]);
    }
    const mention = await seedNotification(
      fixture,
      "mention",
      "conversation_message",
      crypto.randomUUID(),
    );
    const missing = await seedNotification(
      fixture,
      "approval_requested",
      "approval",
      crypto.randomUUID(),
    );

    const items = await listInbox(fixture);
    const byId = new Map(items.map((item) => [item.id, item.approvalOutcome]));
    for (const [id, [status, byPerson]] of expected) {
      const outcome = byId.get(id);
      assertEquals(outcome?.status, status, id);
      assertEquals(
        outcome?.decidedBy,
        byPerson
          ? {
            principalId: fixture.principalId,
            displayName: name,
            avatarUrl: null,
          }
          : null,
        status,
      );
      assertEquals(outcome?.decidedAt !== null, byPerson, status);
    }
    assertEquals(byId.get(mention), null);
    assertEquals(byId.get(missing), null);
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [fixture.email]);
    await fixture.close();
  }
});

Deno.test("an approval notification whose destination is unavailable carries no outcome", async () => {
  const fixture = await openSocketFixture();
  try {
    const approvalId = await seedApproval(fixture, {
      status: "answered",
      decision: "approve",
      decided: true,
    });
    const reachable = await seedNotification(
      fixture,
      "approval_requested",
      "approval",
      approvalId,
    );
    const unreachable = await seedNotification(
      fixture,
      "approval_requested",
      "approval",
      approvalId,
      null,
    );
    const byId = new Map(
      (await listInbox(fixture)).map((item) => [item.id, item]),
    );
    assertEquals(byId.get(reachable)?.destination.available, true);
    assertEquals(byId.get(reachable)?.approvalOutcome?.status, "approved");
    assertEquals(byId.get(unreachable)?.destination.available, false);
    assertEquals(byId.get(unreachable)?.approvalOutcome, null);
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [fixture.email]);
    await fixture.close();
  }
});
