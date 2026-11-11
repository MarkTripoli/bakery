import { assert, assertEquals } from "@std/assert";
import { openAuthFixture } from "../helpers/auth.ts";
import {
  call,
  cleanupSeededOrganizations,
  type Fixture,
  publishCoordinatorVersion,
  type Seed,
  seedOrganization,
  sendMessage,
} from "../helpers/coordinator-turns.ts";
import {
  type CoordinatorTurnExecutor,
  type CoordinatorTurnInput,
  createUnavailableCoordinatorExecutor,
} from "../../apps/server/src/modules/conversation/coordinator.ts";
import {
  claimNextTurn,
  executeClaimedTurn,
  processNextConversationTurn,
} from "../../apps/server/src/modules/conversation/turn-runtime.ts";

type Turn = {
  id: string;
  status: string;
  version: number;
  failure: { code: string } | null;
};

function recordingExecutor(
  reply: (input: CoordinatorTurnInput) => string = (input) =>
    `reply to ${input.triggerMessageId}`,
  delayMs = 0,
) {
  const inputs: CoordinatorTurnInput[] = [];
  let active = 0;
  let maxActive = 0;
  const executor: CoordinatorTurnExecutor = {
    async execute(input) {
      active++;
      maxActive = Math.max(maxActive, active);
      inputs.push(input);
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      active--;
      return {
        status: "completed",
        effects: [{ type: "reply", body: reply(input) }],
      };
    },
  };
  return { executor, inputs, maxActive: () => maxActive };
}

async function turnsOf(fixture: Fixture, seed: Seed): Promise<Turn[]> {
  const response = await call(
    fixture,
    seed,
    `/v1/conversations/${seed.conversationId}/turns?limit=100`,
  );
  assertEquals(response.status, 200);
  return ((await response.json()) as { items: Turn[] }).items;
}

function runtime(fixture: Fixture, executor: CoordinatorTurnExecutor) {
  return {
    database: fixture.runtimePgDatabase,
    executor,
    leaseMs: 60_000,
    heartbeatMs: 100,
  };
}

async function withFixture(
  work: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const fixture = await openAuthFixture();
  try {
    await work(fixture);
  } finally {
    try {
      await cleanupSeededOrganizations(fixture);
    } finally {
      await fixture.close();
    }
  }
}

Deno.test("AC1: concurrent sends and duplicate receipts stay distinct and execute one turn at a time", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "ac1");
    const duplicateId = crypto.randomUUID();
    const responses = await Promise.all([
      ...Array.from(
        { length: 5 },
        (_, i) => sendMessage(fixture, seed, "agent_request", `ask ${i}`),
      ),
      sendMessage(fixture, seed, "agent_request", "dup", duplicateId),
      sendMessage(fixture, seed, "agent_request", "dup", duplicateId),
    ]);
    const messages = await Promise.all(
      responses.map(async (r) => {
        assert(r.status === 201 || r.status === 200, `status ${r.status}`);
        return await r.json() as { id: string; sequence: string };
      }),
    );
    assertEquals(new Set(messages.map((m) => m.id)).size, 6);
    assertEquals(new Set(messages.map((m) => m.sequence)).size, 6);
    assertEquals((await turnsOf(fixture, seed)).length, 6);

    const probe = recordingExecutor(undefined, 40);
    const options = runtime(fixture, probe.executor);
    await Promise.all(
      Array.from({ length: 6 }, () =>
        processNextConversationTurn(options, {
          organizationId: seed.organizationId,
          conversationId: seed.conversationId,
        })),
    );
    // Concurrent claimers drained at most one turn each; finish any leftovers.
    for (let i = 0; i < 6; i++) {
      await processNextConversationTurn(options, {
        organizationId: seed.organizationId,
        conversationId: seed.conversationId,
      });
    }
    assertEquals(probe.maxActive(), 1);
    const turns = await turnsOf(fixture, seed);
    assertEquals(turns.map((t) => t.status), Array(6).fill("completed"));
    assertEquals(probe.inputs.length, 6);
    const outputs = await fixture.pgDatabase.query<
      {
        intent: string;
        message_type: string;
        author_id: string | null;
        agent_session_id: string | null;
      }
    >(
      `select intent, message_type, author_id, agent_session_id from bakery.messages
        where conversation_id = $1 and intent = 'agent_output'`,
      [seed.conversationId],
    );
    assertEquals(outputs.rows.length, 6);
    for (const row of outputs.rows) {
      assertEquals(row.message_type, "assistant");
      assertEquals(row.author_id, null);
      assert(row.agent_session_id);
    }
  }));

Deno.test("AC2: discussion text starts no turn, session or executor", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "ac2");
    assertEquals(
      (await sendMessage(fixture, seed, "discussion", "just talking")).status,
      201,
    );
    const probe = recordingExecutor();
    const result = await processNextConversationTurn(
      runtime(fixture, probe.executor),
      {
        organizationId: seed.organizationId,
        conversationId: seed.conversationId,
      },
    );
    assertEquals(result.kind, "none");
    assertEquals(probe.inputs.length, 0);
    assertEquals((await turnsOf(fixture, seed)).length, 0);
    const sessions = await fixture.pgDatabase.query(
      `select 1 from bakery.agent_sessions where conversation_id = $1`,
      [seed.conversationId],
    );
    assertEquals(sessions.rows.length, 0);
  }));

Deno.test("participants list names message authors without role data", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "participants");
    assertEquals(
      (await sendMessage(fixture, seed, "discussion", "hello")).status,
      201,
    );
    const response = await call(
      fixture,
      seed,
      `/v1/conversations/${seed.conversationId}/participants`,
    );
    assertEquals(response.status, 200);
    const page = await response.json() as {
      items: Record<string, unknown>[];
      nextCursor: string | null;
    };
    assertEquals(page.nextCursor, null);
    const me = page.items.find((item) => item.principalId === seed.principalId);
    assert(me, "message author is listed");
    assert(typeof me.displayName === "string" && me.displayName !== "");
    assertEquals(Object.keys(me).sort(), [
      "displayName",
      "principalId",
      "principalType",
    ]);
    assertEquals(
      (await call(
        fixture,
        seed,
        `/v1/conversations/${crypto.randomUUID()}/participants`,
      )).status,
      404,
    );
  }));

Deno.test("participants list refuses a conversation in another organization and a role without message:read", () =>
  withFixture(async (fixture) => {
    const owner = await seedOrganization(fixture, "participants-own");
    const other = await seedOrganization(fixture, "participants-other");
    // Viewers hold every :read permission the catalog gives Developer, so the
    // role that lacks message:read is guest.
    const guest = await seedOrganization(fixture, "participants-guest", {
      role: "guest",
      agent: false,
    });
    const path = `/v1/conversations/${owner.conversationId}/participants`;
    // A real conversation in another organization is not found for this caller.
    assertEquals((await call(fixture, other, path)).status, 404);
    // Without message:read the route refuses the caller, with the same
    // non-disclosing answer messages.list gives for the same guest.
    const guestMessages = await call(
      fixture,
      guest,
      `/v1/conversations/${guest.conversationId}/messages`,
    );
    const guestParticipants = await call(
      fixture,
      guest,
      `/v1/conversations/${guest.conversationId}/participants`,
    );
    assert(
      guestParticipants.status === 403 || guestParticipants.status === 404,
    );
    assertEquals(guestParticipants.status, guestMessages.status);
    // The owner still reads its own conversation.
    assertEquals((await call(fixture, owner, path)).status, 200);
  }));

Deno.test("AC3: pinned cutoff and agent version survive later messages, new versions and restarts", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "ac3");
    const ask =
      await (await sendMessage(fixture, seed, "agent_request", "first"))
        .json() as { sequence: string };
    await sendMessage(fixture, seed, "discussion", "later 1");
    await sendMessage(fixture, seed, "discussion", "later 2");
    await publishCoordinatorVersion(
      fixture,
      seed.organizationId,
      seed.principalId,
      2,
    );
    const pinned = await fixture.pgDatabase.query<
      { context_through_sequence: string; agent_version_id: string }
    >(
      `select context_through_sequence::text, agent_version_id from bakery.conversation_turns where conversation_id = $1`,
      [seed.conversationId],
    );
    assertEquals(pinned.rows[0].context_through_sequence, ask.sequence);
    assertEquals(pinned.rows[0].agent_version_id, seed.agentVersionId);

    // "Restart": a fresh runtime instance claims the still-queued turn.
    const probe = recordingExecutor();
    await processNextConversationTurn(runtime(fixture, probe.executor), {
      organizationId: seed.organizationId,
      conversationId: seed.conversationId,
    });
    assertEquals(probe.inputs.length, 1);
    assertEquals(probe.inputs[0].messages.map((m) => m.sequence), [
      ask.sequence,
    ]);
    assertEquals(probe.inputs[0].agentVersion.id, seed.agentVersionId);
    // Reply lands after the later messages, preserving transcript order.
    const sequences = await fixture.pgDatabase.query<
      { sequence: string; intent: string }
    >(
      `select sequence::text, intent from bakery.messages where conversation_id = $1 order by sequence`,
      [seed.conversationId],
    );
    assertEquals(sequences.rows.map((r) => r.intent), [
      "agent_request",
      "discussion",
      "discussion",
      "agent_output",
    ]);
  }));

Deno.test("AC3: revoked authority or archived scope fails the turn without executing", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "revoked");
    await sendMessage(fixture, seed, "agent_request", "will be revoked");
    await fixture.pgDatabase.query(
      `update bakery.organization_memberships set status = 'inactive' where organization_id = $1 and principal_id = $2`,
      [seed.organizationId, seed.principalId],
    );
    const probe = recordingExecutor();
    const result = await processNextConversationTurn(
      runtime(fixture, probe.executor),
      {
        organizationId: seed.organizationId,
        conversationId: seed.conversationId,
      },
    );
    assertEquals(result, {
      kind: "processed",
      turnId: (result as { turnId: string }).turnId,
      status: "failed",
    });
    assertEquals(probe.inputs.length, 0);
    const row = await fixture.pgDatabase.query<
      { status: string; failure: { code: string } }
    >(
      `select status, failure from bakery.conversation_turns where conversation_id = $1`,
      [seed.conversationId],
    );
    assertEquals(row.rows[0].status, "failed");
    assertEquals(row.rows[0].failure.code, "authority_revoked");

    const archived = await seedOrganization(fixture, "archived");
    await sendMessage(fixture, archived, "agent_request", "archive me");
    await fixture.pgDatabase.query(
      `update bakery.conversations set archived_at = now() where id = $1`,
      [archived.conversationId],
    );
    await processNextConversationTurn(runtime(fixture, probe.executor), {
      organizationId: archived.organizationId,
      conversationId: archived.conversationId,
    });
    const gone = await fixture.pgDatabase.query<{ failure: { code: string } }>(
      `select failure from bakery.conversation_turns where conversation_id = $1`,
      [archived.conversationId],
    );
    assertEquals(gone.rows[0].failure.code, "authority_revoked");
    assertEquals(probe.inputs.length, 0);
  }));

Deno.test("explicit unavailable executor fails coordinator_unavailable and an unconfigured agent fails at execution", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "unavailable");
    await sendMessage(fixture, seed, "agent_request", "hello");
    await processNextConversationTurn(
      runtime(fixture, createUnavailableCoordinatorExecutor()),
      {
        organizationId: seed.organizationId,
        conversationId: seed.conversationId,
      },
    );
    const [turn] = await turnsOf(fixture, seed);
    assertEquals(turn.status, "failed");
    assertEquals(turn.failure?.code, "coordinator_unavailable");
    const outputs = await fixture.pgDatabase.query(
      `select 1 from bakery.messages where conversation_id = $1 and intent = 'agent_output'`,
      [seed.conversationId],
    );
    assertEquals(outputs.rows.length, 0);

    const bare = await seedOrganization(fixture, "unconfigured", {
      agent: false,
    });
    await sendMessage(fixture, bare, "agent_request", "hello");
    const probe = recordingExecutor();
    await processNextConversationTurn(runtime(fixture, probe.executor), {
      organizationId: bare.organizationId,
      conversationId: bare.conversationId,
    });
    assertEquals(
      (await turnsOf(fixture, bare))[0].failure?.code,
      "coordinator_unconfigured",
    );
    assertEquals(probe.inputs.length, 0);
  }));

Deno.test("planRevision effects need a task: a taskless conversation fails the turn with nothing applied", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "unsupported");
    await sendMessage(fixture, seed, "agent_request", "hello");
    const executor: CoordinatorTurnExecutor = {
      execute: () =>
        Promise.resolve({
          status: "completed",
          effects: [
            { type: "reply", body: "should not land" },
            {
              type: "planRevision",
              title: "Plan",
              steps: [{ id: "s1", title: "Step", detail: "d" }],
            },
          ],
        }),
    };
    await processNextConversationTurn(runtime(fixture, executor), {
      organizationId: seed.organizationId,
      conversationId: seed.conversationId,
    });
    assertEquals(
      (await turnsOf(fixture, seed))[0].failure?.code,
      "question_requires_task",
    );
    const outputs = await fixture.pgDatabase.query(
      `select 1 from bakery.messages where conversation_id = $1 and intent = 'agent_output'`,
      [seed.conversationId],
    );
    assertEquals(outputs.rows.length, 0);
  }));

Deno.test("cancel: queued becomes canceled; active becomes cancel_requested then canceled without effects", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "cancel");
    await sendMessage(fixture, seed, "agent_request", "queued one");
    const [queued] = await turnsOf(fixture, seed);
    const canceled = await call(
      fixture,
      seed,
      `/v1/conversation-turns/${queued.id}/cancel`,
      {
        method: "POST",
        ifMatch: queued.version,
      },
    );
    assertEquals(canceled.status, 200);
    assertEquals(((await canceled.json()) as Turn).status, "canceled");
    const probe = recordingExecutor();
    assertEquals(
      (await processNextConversationTurn(runtime(fixture, probe.executor), {
        organizationId: seed.organizationId,
        conversationId: seed.conversationId,
      })).kind,
      "none",
    );

    await sendMessage(fixture, seed, "agent_request", "active one");
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    let sawAbort = false;
    const blocking: CoordinatorTurnExecutor = {
      async execute(_input, signal) {
        started();
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        sawAbort = signal.aborted;
        return {
          status: "completed",
          effects: [{ type: "reply", body: "late" }],
        };
      },
    };
    const processing = processNextConversationTurn(runtime(fixture, blocking), {
      organizationId: seed.organizationId,
      conversationId: seed.conversationId,
    });
    await running;
    const active = (await turnsOf(fixture, seed)).find((t) =>
      t.status === "active"
    )!;
    const requested = await call(
      fixture,
      seed,
      `/v1/conversation-turns/${active.id}/cancel`,
      {
        method: "POST",
        ifMatch: active.version,
      },
    );
    assertEquals(((await requested.json()) as Turn).status, "cancel_requested");
    await processing;
    assert(sawAbort);
    const final = await call(
      fixture,
      seed,
      `/v1/conversation-turns/${active.id}`,
    );
    assertEquals(((await final.json()) as Turn).status, "canceled");
    const outputs = await fixture.pgDatabase.query(
      `select 1 from bakery.messages where conversation_id = $1 and intent = 'agent_output'`,
      [seed.conversationId],
    );
    assertEquals(outputs.rows.length, 0);
    const runs = await fixture.pgDatabase.query(
      `select 1 from bakery.workflow_runs where organization_id = $1`,
      [seed.organizationId],
    );
    assertEquals(runs.rows.length, 0);
  }));

Deno.test("an expired lease is taken over after a restart and completes once", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "lease");
    await sendMessage(fixture, seed, "agent_request", "recover me");
    const claim = await claimNextTurn(fixture.runtimePgDatabase, {
      organizationId: seed.organizationId,
      conversationId: seed.conversationId,
      leaseMs: 1,
    });
    assertEquals(claim.kind, "claimed");
    await new Promise((r) => setTimeout(r, 30));
    const probe = recordingExecutor();
    const result = await processNextConversationTurn(
      runtime(fixture, probe.executor),
      {
        organizationId: seed.organizationId,
        conversationId: seed.conversationId,
      },
    );
    assertEquals(result.kind, "processed");
    assertEquals((await turnsOf(fixture, seed))[0].status, "completed");
    assertEquals(probe.inputs.length, 1);
  }));

Deno.test("a taken-over executor loses its claim: heartbeat aborts it and nothing applies", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "stale");
    await sendMessage(fixture, seed, "agent_request", "stale claim");
    const first = await claimNextTurn(fixture.runtimePgDatabase, {
      organizationId: seed.organizationId,
      conversationId: seed.conversationId,
      leaseMs: 1,
    });
    assertEquals(first.kind, "claimed");
    if (first.kind !== "claimed") return;
    await new Promise((r) => setTimeout(r, 30));
    const second = await claimNextTurn(fixture.runtimePgDatabase, {
      organizationId: seed.organizationId,
      conversationId: seed.conversationId,
      leaseMs: 60_000,
    });
    assertEquals(second.kind, "claimed");
    let aborted = false;
    const stale: CoordinatorTurnExecutor = {
      execute(_input, signal) {
        return new Promise((resolve) => {
          const timer = setTimeout(
            () =>
              resolve({
                status: "completed",
                effects: [{ type: "reply", body: "stale" }],
              }),
            5_000,
          );
          signal.addEventListener("abort", () => {
            aborted = true;
            clearTimeout(timer);
            resolve({
              status: "completed",
              effects: [{ type: "reply", body: "stale" }],
            });
          });
        });
      },
    };
    const result = await executeClaimedTurn(runtime(fixture, stale), {
      organizationId: seed.organizationId,
      conversationId: seed.conversationId,
      turnId: first.turnId,
      claimVersion: first.claimVersion,
    });
    assert(aborted, "heartbeat must abort the executor after takeover");
    assertEquals(result.kind, "lost");
    assertEquals((await turnsOf(fixture, seed))[0].status, "active");
  }));

Deno.test("conversations API creates, lists, reads, edits and archives with audit and events", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "api");
    const created = await call(fixture, seed, "/v1/conversations", {
      method: "POST",
      body: {
        title: "Planning",
        applicationId: seed.applicationId,
        repositoryId: seed.repositoryId,
      },
    });
    assertEquals(created.status, 201);
    const conversation = await created.json() as {
      id: string;
      version: number;
      title: string;
    };
    const list = await call(fixture, seed, "/v1/conversations?limit=10");
    assertEquals(list.status, 200);
    assert(
      ((await list.json()) as { items: { id: string }[] }).items.some((c) =>
        c.id === conversation.id
      ),
    );
    const read = await call(
      fixture,
      seed,
      `/v1/conversations/${conversation.id}`,
    );
    assertEquals(read.status, 200);
    const renamed = await call(
      fixture,
      seed,
      `/v1/conversations/${conversation.id}`,
      {
        method: "PATCH",
        ifMatch: conversation.version,
        body: { title: "Renamed" },
      },
    );
    assertEquals(renamed.status, 200);
    const next = await renamed.json() as { version: number; title: string };
    assertEquals(next.title, "Renamed");
    const stale = await call(
      fixture,
      seed,
      `/v1/conversations/${conversation.id}`,
      {
        method: "PATCH",
        ifMatch: conversation.version,
        body: { title: "Stale" },
      },
    );
    assertEquals(stale.status, 412);
    const archived = await call(
      fixture,
      seed,
      `/v1/conversations/${conversation.id}`,
      {
        method: "PATCH",
        ifMatch: next.version,
        body: { archivedAt: new Date().toISOString() },
      },
    );
    assertEquals(
      ((await archived.json()) as { archivedAt: string | null }).archivedAt !==
        null,
      true,
    );
    const blocked = await sendMessage(
      fixture,
      { ...seed, conversationId: conversation.id },
      "discussion",
      "x",
    );
    assertEquals(blocked.status, 409);
    const facts = await fixture.pgDatabase.query<
      { events: number; audits: number }
    >(
      `select (select count(*)::int from bakery.domain_events where organization_id = $1 and aggregate_id = $2
                and event_type in ('conversations.created', 'conversations.updated')) as events,
              (select count(*)::int from bakery.audit_events where organization_id = $1 and resource_id = $2::text
                and operation in ('conversations.create', 'conversations.update')) as audits`,
      [seed.organizationId, conversation.id],
    );
    assertEquals(facts.rows[0], { events: 3, audits: 3 });
  }));
