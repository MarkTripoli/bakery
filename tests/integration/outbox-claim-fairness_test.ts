import { assertEquals } from "@std/assert";
import { claimOutboxRows } from "../../apps/server/src/platform/outbox-claim.ts";
import { createOutboxDispatcher } from "../../apps/server/src/platform/outbox-dispatcher.ts";
import {
  type EngineEvent,
  EngineEventIdSchema,
  OutboxDeliveryError,
} from "../../apps/server/src/platform/inngest-event-client.ts";
import {
  enqueueOutboxEvent,
  openOutboxTestFixture,
} from "../helpers/outbox-fixture.ts";

const boundedScanSize = 100;

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

Deno.test("exhausted pending rows do not consume the bounded claim scan", async () => {
  const fixture = await openOutboxTestFixture();
  const { owner, appPg, organizationId } = fixture;
  const received: EngineEvent[] = [];
  try {
    for (let index = 0; index < boundedScanSize; index++) {
      const id = await enqueueOutboxEvent(owner, organizationId, "inngest");
      await owner`
        update bakery.outbox
        set attempt_count = 5, next_attempt_at = now(),
          replay_deadline_at = now() + interval '24 hours'
        where id = ${id}`;
    }
    const validId = await enqueueOutboxEvent(owner, organizationId, "inngest");
    const validDeliveryKey = String(
      (await owner`
        select delivery_key as "deliveryKey"
        from bakery.outbox where id = ${validId}`)[0].deliveryKey,
    );
    const dispatcher = createOutboxDispatcher({
      database: appPg,
      engine: recordingEngine(received),
    });

    const classified = await dispatcher.dispatchBatch(1);

    assertEquals(classified, {
      claimed: 0,
      delivered: 0,
      retried: 0,
      failed: 0,
      stale: 0,
    });
    assertEquals(
      Number(
        (await owner`
          select count(*)::int as count
          from bakery.outbox
          where status = 'failed'
            and last_error->>'code' = 'OUTBOX_ATTEMPTS_EXHAUSTED'`)[0].count,
      ),
      boundedScanSize,
    );
    const delivered = await dispatcher.dispatchBatch(1);
    assertEquals(delivered.delivered, 1);
    assertEquals(received.map(({ id }) => id), [validDeliveryKey]);
  } finally {
    await fixture.close();
  }
});

Deno.test("inconsistent replay scheduling is quarantined before delivery", async () => {
  const fixture = await openOutboxTestFixture();
  const { owner, appPg, organizationId } = fixture;
  const received: EngineEvent[] = [];
  try {
    const missingDeadlineId = await enqueueOutboxEvent(
      owner,
      organizationId,
      "inngest",
    );
    const prematureDeadlineId = await enqueueOutboxEvent(
      owner,
      organizationId,
      "inngest",
    );
    const missingLeaseDeadlineId = await enqueueOutboxEvent(
      owner,
      organizationId,
      "inngest",
    );
    const missingLeaseTokenId = await enqueueOutboxEvent(
      owner,
      organizationId,
      "inngest",
    );
    const pendingLeaseId = await enqueueOutboxEvent(
      owner,
      organizationId,
      "inngest",
    );
    const pendingAcknowledgementId = await enqueueOutboxEvent(
      owner,
      organizationId,
      "inngest",
    );
    const expiredAcknowledgementId = await enqueueOutboxEvent(
      owner,
      organizationId,
      "inngest",
    );
    await owner`update bakery.outbox set attempt_count = 1
      where id = ${missingDeadlineId}`;
    await owner`update bakery.outbox
      set replay_deadline_at = now() + interval '24 hours'
      where id = ${prematureDeadlineId}`;
    await owner`update bakery.outbox set status = 'sending', attempt_count = 1,
      lease_token = ${crypto.randomUUID()},
      replay_deadline_at = now() + interval '24 hours'
      where id = ${missingLeaseDeadlineId}`;
    await owner`update bakery.outbox set status = 'sending', attempt_count = 1,
      lease_until = now() + interval '1 hour',
      replay_deadline_at = now() + interval '24 hours'
      where id = ${missingLeaseTokenId}`;
    await owner`update bakery.outbox
      set lease_token = ${crypto.randomUUID()},
        lease_until = now() + interval '1 hour'
      where id = ${pendingLeaseId}`;
    await owner`update bakery.outbox
      set delivered_at = now(), engine_event_id = 'stale-pending-ack'
      where id = ${pendingAcknowledgementId}`;
    await owner`update bakery.outbox set status = 'sending', attempt_count = 1,
      lease_token = ${crypto.randomUUID()},
      lease_until = now() - interval '1 minute',
      replay_deadline_at = now() + interval '24 hours',
      delivered_at = now(), engine_event_id = 'stale-sending-ack'
      where id = ${expiredAcknowledgementId}`;
    const dispatcher = createOutboxDispatcher({
      database: appPg,
      engine: recordingEngine(received),
    });

    const summary = await dispatcher.dispatchBatch(7);

    assertEquals(summary.claimed, 0);
    assertEquals(received, []);
    assertEquals(
      [
        ...await owner`
        select status, last_error->>'code' as code
        from bakery.outbox
        where id in (
          ${missingDeadlineId}, ${prematureDeadlineId},
          ${missingLeaseDeadlineId}, ${missingLeaseTokenId},
          ${pendingLeaseId}, ${pendingAcknowledgementId},
          ${expiredAcknowledgementId}
        )
        order by id`,
      ],
      [
        { status: "failed", code: "OUTBOX_STATE_INVALID" },
        { status: "failed", code: "OUTBOX_STATE_INVALID" },
        { status: "failed", code: "OUTBOX_STATE_INVALID" },
        { status: "failed", code: "OUTBOX_STATE_INVALID" },
        { status: "failed", code: "OUTBOX_STATE_INVALID" },
        { status: "failed", code: "OUTBOX_STATE_INVALID" },
        { status: "failed", code: "OUTBOX_STATE_INVALID" },
      ],
    );
  } finally {
    await fixture.close();
  }
});

Deno.test("expired sending leases win against a sustained pending backlog", async () => {
  const fixture = await openOutboxTestFixture();
  const { owner, appPg, organizationId } = fixture;
  const received: EngineEvent[] = [];
  try {
    for (let index = 0; index <= boundedScanSize; index++) {
      await enqueueOutboxEvent(owner, organizationId, "inngest");
    }
    const expiredId = await enqueueOutboxEvent(
      owner,
      organizationId,
      "inngest",
    );
    await owner`
        update bakery.outbox
        set status = 'sending', attempt_count = 1,
          replay_deadline_at = now() + interval '24 hours',
          lease_token = ${crypto.randomUUID()},
        lease_until = now() - interval '1 minute'
      where id = ${expiredId}`;
    const expiredDeliveryKey = String(
      (await owner`
        select delivery_key as "deliveryKey"
        from bakery.outbox where id = ${expiredId}`)[0].deliveryKey,
    );
    const dispatcher = createOutboxDispatcher({
      database: appPg,
      engine: recordingEngine(received),
    });

    const summary = await dispatcher.dispatchBatch(1);

    assertEquals(summary.delivered, 1);
    assertEquals(received.map(({ id }) => id), [expiredDeliveryKey]);
    assertEquals(
      (await owner`
        select status, attempt_count as "attemptCount"
        from bakery.outbox where id = ${expiredId}`)[0],
      { status: "delivered", attemptCount: 2 },
    );
  } finally {
    await fixture.close();
  }
});

Deno.test("an active final-attempt lease survives a concurrent exhaustion sweep", async () => {
  const fixture = await openOutboxTestFixture();
  const { owner, appPg, organizationId } = fixture;
  let releaseSend: (() => void) | undefined;
  const sendReleased = new Promise<void>((resolve) => {
    releaseSend = resolve;
  });
  let markSendStarted: (() => void) | undefined;
  const sendStarted = new Promise<void>((resolve) => {
    markSendStarted = resolve;
  });
  try {
    const id = await enqueueOutboxEvent(owner, organizationId, "inngest");
    await owner`
      update bakery.outbox set attempt_count = 1,
        replay_deadline_at = now() + interval '24 hours'
      where id = ${id}`;
    const engine = {
      async send() {
        markSendStarted?.();
        await sendReleased;
        return EngineEventIdSchema.parse("engine-final-attempt");
      },
    };
    const first = createOutboxDispatcher({
      database: appPg,
      engine,
      maxAttempts: 2,
    });
    const second = createOutboxDispatcher({
      database: appPg,
      engine,
      maxAttempts: 2,
    });

    const activeDelivery = first.dispatchBatch(1);
    await sendStarted;
    const concurrentSweep = await second.dispatchBatch(1);
    releaseSend?.();
    const delivered = await activeDelivery;

    assertEquals(concurrentSweep.claimed, 0);
    assertEquals(delivered.delivered, 1);
    assertEquals(
      (await owner`
        select status, attempt_count as "attemptCount"
        from bakery.outbox where id = ${id}`)[0],
      { status: "delivered", attemptCount: 2 },
    );
  } finally {
    releaseSend?.();
    await fixture.close();
  }
});

Deno.test("an expired final-attempt lease is parked for reconciliation", async () => {
  const fixture = await openOutboxTestFixture();
  const { owner, appPg, organizationId } = fixture;
  const received: EngineEvent[] = [];
  try {
    const id = await enqueueOutboxEvent(owner, organizationId, "inngest");
    await owner`
      update bakery.outbox
      set status = 'sending', attempt_count = 2,
        replay_deadline_at = now() + interval '24 hours',
        lease_token = ${crypto.randomUUID()},
        lease_until = now() - interval '1 minute'
      where id = ${id}`;
    const dispatcher = createOutboxDispatcher({
      database: appPg,
      engine: recordingEngine(received),
      maxAttempts: 2,
    });

    const summary = await dispatcher.dispatchBatch(1);

    assertEquals(summary.claimed, 0);
    assertEquals(received.length, 0);
    assertEquals(
      (await owner`
        select status, attempt_count as "attemptCount",
          lease_token::text as "leaseToken", last_error->>'code' as code
        from bakery.outbox where id = ${id}`)[0],
      {
        status: "failed",
        attemptCount: 2,
        leaseToken: null,
        code: "OUTBOX_RECONCILIATION_REQUIRED",
      },
    );
  } finally {
    await fixture.close();
  }
});

Deno.test("attempted deliveries never replay beyond their immutable deadline", async () => {
  const fixture = await openOutboxTestFixture();
  const { owner, appPg, organizationId } = fixture;
  const received: EngineEvent[] = [];
  try {
    // Given an old delivery that has never been attempted
    const freshId = await enqueueOutboxEvent(owner, organizationId, "inngest");
    await owner`
      update bakery.outbox
      set created_at = now() - interval '25 hours',
        updated_at = now() - interval '25 hours'
      where id = ${freshId}`;
    const successful = createOutboxDispatcher({
      database: appPg,
      engine: recordingEngine(received),
    });

    // When it receives its first claim
    const delivered = await successful.dispatchBatch(1);

    // Then age alone does not prevent first delivery
    assertEquals(delivered.delivered, 1);
    assertEquals(received.length, 1);

    // Given an attempted pending delivery whose replay deadline elapsed
    const expiredPendingId = await enqueueOutboxEvent(
      owner,
      organizationId,
      "inngest",
    );
    await owner`
      update bakery.outbox
      set attempt_count = 1, replay_deadline_at = now() - interval '1 second',
        next_attempt_at = now()
      where id = ${expiredPendingId}`;

    // When the dispatcher scans it
    const expired = await successful.dispatchBatch(1);

    // Then it parks the delivery without another engine request
    assertEquals(expired.claimed, 0);
    assertEquals(received.length, 1);
    assertEquals(
      (await owner`
        select status, last_error->>'code' as code
        from bakery.outbox where id = ${expiredPendingId}`)[0],
      { status: "failed", code: "OUTBOX_RECONCILIATION_REQUIRED" },
    );

    // Given a retryable delivery before its replay deadline
    const retryId = await enqueueOutboxEvent(owner, organizationId, "inngest");
    const failing = createOutboxDispatcher({
      database: appPg,
      engine: {
        send() {
          throw new OutboxDeliveryError("ENGINE_REJECTED", true, 503);
        },
      },
    });

    // When two claims fail inside the replay window
    assertEquals((await failing.dispatchBatch(1)).retried, 1);
    const firstDeadline = (await owner`
      select replay_deadline_at as "replayDeadlineAt"
      from bakery.outbox where id = ${retryId}`)[0].replayDeadlineAt;
    await owner`
      update bakery.outbox set next_attempt_at = now() where id = ${retryId}`;
    assertEquals((await failing.dispatchBatch(1)).retried, 1);
    const secondDeadline = (await owner`
      select replay_deadline_at as "replayDeadlineAt"
      from bakery.outbox where id = ${retryId}`)[0].replayDeadlineAt;

    // Then each retry preserves the first claim's immutable deadline
    assertEquals(secondDeadline, firstDeadline);
  } finally {
    await fixture.close();
  }
});

Deno.test("database clock alone decides replay deadline eligibility", async () => {
  const fixture = await openOutboxTestFixture();
  const { owner, appPg, organizationId } = fixture;
  const originalNow = Date.now;
  try {
    // Given a retry eligible by PostgreSQL time while the process clock is far ahead
    const id = await enqueueOutboxEvent(owner, organizationId, "inngest");
    await owner`
      update bakery.outbox
      set attempt_count = 1, next_attempt_at = now(),
        replay_deadline_at = now() + interval '1 hour'
      where id = ${id}`;
    Date.now = () => originalNow() + 48 * 60 * 60 * 1000;
    const claimed = await claimOutboxRows({
      database: appPg,
      leaseSeconds: 30,
      maxAttempts: 5,
      replaySafetySeconds: 31,
    }, 1);

    // Then PostgreSQL time permits the claim despite process-clock skew
    assertEquals(claimed.length, 1);
    assertEquals(claimed[0]?.id, id);
  } finally {
    Date.now = originalNow;
    await fixture.close();
  }
});
