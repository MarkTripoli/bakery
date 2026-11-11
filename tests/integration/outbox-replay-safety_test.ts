import { assertEquals } from "@std/assert";
import { createOutboxDispatcher } from "../../apps/server/src/platform/outbox-dispatcher.ts";
import {
  type EngineEvent,
  EngineEventIdSchema,
} from "../../apps/server/src/platform/inngest-event-client.ts";
import {
  enqueueOutboxEvent,
  openOutboxTestFixture,
} from "../helpers/outbox-fixture.ts";

function recordingEngine(received: EngineEvent[]) {
  return {
    send(event: EngineEvent) {
      received.push(event);
      return Promise.resolve(
        EngineEventIdSchema.parse(`engine-${received.length}`),
      );
    },
  };
}

Deno.test("legacy unattempted sending rows resume after lease expiry", async () => {
  const fixture = await openOutboxTestFixture();
  const { owner, appPg, organizationId } = fixture;
  const received: EngineEvent[] = [];
  try {
    const id = await enqueueOutboxEvent(owner, organizationId, "inngest");
    await owner`
      update bakery.outbox
      set status = 'sending', attempt_count = 0,
        replay_deadline_at = null,
        lease_token = ${crypto.randomUUID()},
        lease_until = now() - interval '1 minute'
      where id = ${id}`;
    const dispatcher = createOutboxDispatcher({
      database: appPg,
      engine: recordingEngine(received),
    });

    const summary = await dispatcher.dispatchBatch(1);

    assertEquals(summary.delivered, 1);
    assertEquals(received.length, 1);
    assertEquals(
      (await owner`
        select status, attempt_count as "attemptCount",
          replay_deadline_at is not null as "hasReplayDeadline"
        from bakery.outbox where id = ${id}`)[0],
      { status: "delivered", attemptCount: 1, hasReplayDeadline: true },
    );
  } finally {
    await fixture.close();
  }
});

Deno.test("attempted rows stop before provider timeout can cross replay deadline", async () => {
  const fixture = await openOutboxTestFixture();
  const { owner, appPg, organizationId } = fixture;
  const received: EngineEvent[] = [];
  try {
    const id = await enqueueOutboxEvent(owner, organizationId, "inngest");
    await owner`
      update bakery.outbox
      set attempt_count = 1, next_attempt_at = now(),
        replay_deadline_at = now() + interval '5 seconds'
      where id = ${id}`;
    const dispatcher = createOutboxDispatcher({
      database: appPg,
      engine: recordingEngine(received),
    });

    const summary = await dispatcher.dispatchBatch(1);

    assertEquals(summary.claimed, 0);
    assertEquals(received.length, 0);
    assertEquals(
      (await owner`
        select status, last_error->>'code' as code
        from bakery.outbox where id = ${id}`)[0],
      { status: "failed", code: "OUTBOX_RECONCILIATION_REQUIRED" },
    );
  } finally {
    await fixture.close();
  }
});

Deno.test("claimed replay is parked when its deadline expires before provider send", async () => {
  const fixture = await openOutboxTestFixture();
  const { owner, appPg, organizationId } = fixture;
  const received: EngineEvent[] = [];
  try {
    const id = await enqueueOutboxEvent(owner, organizationId, "inngest");
    await owner`
      update bakery.outbox
      set attempt_count = 1, next_attempt_at = now(),
        replay_deadline_at = now() + interval '1 hour'
      where id = ${id}`;
    const dispatcher = createOutboxDispatcher({
      database: appPg,
      engine: recordingEngine(received),
      now: () => Date.now() + 2 * 60 * 60 * 1_000,
    });

    const summary = await dispatcher.dispatchBatch(1);

    assertEquals(summary.failed, 1);
    assertEquals(received.length, 0);
    assertEquals(
      (await owner`
        select status, last_error->>'code' as code
        from bakery.outbox where id = ${id}`)[0],
      { status: "failed", code: "OUTBOX_RECONCILIATION_REQUIRED" },
    );
  } finally {
    await fixture.close();
  }
});
