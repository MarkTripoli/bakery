import { assertEquals } from "@std/assert";
import { createOutboxDispatcher } from "../../apps/server/src/platform/outbox-dispatcher.ts";
import {
  createInngestEventClient,
  type EngineEvent,
} from "../../apps/server/src/platform/inngest-event-client.ts";
import {
  enqueueOutboxEvent,
  openOutboxTestFixture,
} from "../helpers/outbox-fixture.ts";

Deno.test("outbox dispatcher leases, retries, and terminally classifies deliveries", async () => {
  const fixture = await openOutboxTestFixture();
  const { owner, appPg, organizationId } = fixture;
  const received: EngineEvent[] = [];
  let failuresRemaining = 0;
  let malformedAcknowledgement = false;
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0 },
    async (request) => {
      const event = await request.json() as EngineEvent;
      received.push(event);
      if (malformedAcknowledgement) {
        malformedAcknowledgement = false;
        return Response.json({ ids: [" "], status: 200 });
      }
      if (failuresRemaining > 0) {
        failuresRemaining--;
        return new Response("unavailable", { status: 503 });
      }
      return Response.json({ ids: [`engine-${received.length}`], status: 200 });
    },
  );
  try {
    const baseUrl = `http://${server.addr.hostname}:${server.addr.port}`;
    const engine = createInngestEventClient({ baseUrl, eventKey: "test" });
    const first = createOutboxDispatcher({ database: appPg, engine });
    const second = createOutboxDispatcher({ database: appPg, engine });

    // Given one pending engine delivery and two competing dispatchers
    const concurrentId = await enqueueOutboxEvent(
      owner,
      organizationId,
      "inngest",
    );

    // When both dispatchers claim at the same time
    const concurrent = await Promise.all([
      first.dispatchBatch(1),
      second.dispatchBatch(1),
    ]);

    // Then one lease wins and one engine request is acknowledged
    assertEquals(
      concurrent.reduce((sum, result) => sum + result.claimed, 0),
      1,
    );
    assertEquals(received.length, 1);
    assertEquals(
      (await owner`
      select status, attempt_count as "attemptCount"
      from bakery.outbox where id = ${concurrentId}
    `)[0],
      { status: "delivered", attemptCount: 1 },
    );

    // Given an engine outage after a second row is leased
    const retryId = await enqueueOutboxEvent(owner, organizationId, "inngest");
    failuresRemaining = 1;

    // When delivery fails transiently and is retried after its durable backoff
    const transient = await first.dispatchBatch(1);
    await owner`
      update bakery.outbox set next_attempt_at = now() where id = ${retryId}`;
    const recovered = await second.dispatchBatch(1);

    // Then both attempts reuse one stable Inngest deduplication identity
    assertEquals(transient.retried, 1);
    assertEquals(recovered.delivered, 1);
    assertEquals(received[1].id, received[2].id);
    assertEquals(
      (await owner`
      select status, attempt_count as "attemptCount"
      from bakery.outbox where id = ${retryId}
    `)[0],
      { status: "delivered", attemptCount: 2 },
    );

    // Given an engine acknowledgement with a malformed identifier
    const malformedAckId = await enqueueOutboxEvent(
      owner,
      organizationId,
      "inngest",
    );
    malformedAcknowledgement = true;

    // When the dispatcher rejects the malformed acknowledgement
    const malformedAck = await first.dispatchBatch(1);

    // Then the delivery remains visibly retryable without fabricated progress
    assertEquals(malformedAck.retried, 1);
    assertEquals(
      (await owner`
      select status, last_error->>'code' as code
      from bakery.outbox where id = ${malformedAckId}
    `)[0],
      { status: "pending", code: "ENGINE_ACK_INVALID" },
    );
    await owner`
      update bakery.outbox set next_attempt_at = now() where id = ${malformedAckId}`;
    assertEquals((await first.dispatchBatch(1)).delivered, 1);

    // Given a malformed domain payload at the dispatch boundary
    const malformedInputId = await enqueueOutboxEvent(
      owner,
      organizationId,
      "inngest",
      { payload: [] },
    );

    // When the dispatcher maps the invalid input
    const malformedInput = await first.dispatchBatch(1);

    // Then it records a terminal safe failure without an engine request
    assertEquals(malformedInput.failed, 1);
    assertEquals(
      (await owner`
      select status, last_error->>'code' as code
      from bakery.outbox where id = ${malformedInputId}
    `)[0],
      { status: "failed", code: "EVENT_PAYLOAD_INVALID" },
    );

    // Given a provider destination with no implemented execution ledger
    const unsupportedId = await enqueueOutboxEvent(
      owner,
      organizationId,
      "slack",
    );

    // When the generic dispatcher sees that destination
    const unsupported = await first.dispatchBatch(1);

    // Then it fails closed without making an engine request
    assertEquals(unsupported.failed, 1);
    assertEquals(received.length, 5);
    assertEquals(
      (await owner`
      select status, last_error->>'code' as code
      from bakery.outbox where id = ${unsupportedId}
    `)[0],
      { status: "failed", code: "DESTINATION_UNSUPPORTED" },
    );

    // Given a retryable engine outage and a two-attempt delivery budget
    const exhaustedId = await enqueueOutboxEvent(
      owner,
      organizationId,
      "inngest",
    );
    const exhausting = createOutboxDispatcher({
      database: appPg,
      engine,
      maxAttempts: 2,
    });
    failuresRemaining = 2;

    // When both allowed attempts fail
    const exhaustedFirst = await exhausting.dispatchBatch(1);
    await owner`
      update bakery.outbox set next_attempt_at = now() where id = ${exhaustedId}`;
    const exhaustedSecond = await exhausting.dispatchBatch(1);

    // Then the row is terminal and no third attempt is claimed
    assertEquals(exhaustedFirst.retried, 1);
    assertEquals(exhaustedSecond.failed, 1);
    assertEquals((await exhausting.dispatchBatch(1)).claimed, 0);
    assertEquals(
      (await owner`
      select status, attempt_count as "attemptCount",
        last_error->>'code' as code
      from bakery.outbox where id = ${exhaustedId}
    `)[0],
      {
        status: "failed",
        attemptCount: 2,
        code: "OUTBOX_RECONCILIATION_REQUIRED",
      },
    );

    // Given a final-attempt send whose acknowledgement was lost with its lease
    const staleExhaustedId = await enqueueOutboxEvent(
      owner,
      organizationId,
      "inngest",
    );
    await owner`
      update bakery.outbox set status = 'sending', attempt_count = 2,
        replay_deadline_at = now() + interval '24 hours',
        lease_token = ${crypto.randomUUID()}, lease_until = now() - interval '1 second'
      where id = ${staleExhaustedId}`;

    const receivedBeforeReconciliation = received.length;

    // When a replacement dispatcher sees the expired final-attempt lease
    const staleSettled = await exhausting.dispatchBatch(1);

    // Then it parks the uncertain delivery instead of sending beyond its budget
    assertEquals(staleSettled.claimed, 0);
    assertEquals(received.length, receivedBeforeReconciliation);
    assertEquals(
      (await owner`
        select status, attempt_count as "attemptCount", lease_token as "leaseToken",
        last_error->>'code' as code
       from bakery.outbox where id = ${staleExhaustedId}
     `)[0],
      {
        status: "failed",
        attemptCount: 2,
        leaseToken: null,
        code: "OUTBOX_RECONCILIATION_REQUIRED",
      },
    );

    // Given a row left behind by a crashed dispatcher with an expired lease
    const expiredId = await enqueueOutboxEvent(
      owner,
      organizationId,
      "inngest",
    );
    await owner`
      update bakery.outbox set status = 'sending', attempt_count = 1,
        replay_deadline_at = now() + interval '24 hours',
        lease_token = ${crypto.randomUUID()}, lease_until = now() - interval '1 second'
      where id = ${expiredId}`;

    // When a replacement dispatcher scans the durable queue
    const reclaimed = await second.dispatchBatch(1);

    // Then it fences the old owner and completes the reclaimed delivery
    assertEquals(reclaimed.delivered, 1);
    assertEquals(
      (await owner`
      select status, attempt_count as "attemptCount", lease_token as "leaseToken"
      from bakery.outbox where id = ${expiredId}
    `)[0],
      { status: "delivered", attemptCount: 2, leaseToken: null },
    );
  } finally {
    await server.shutdown();
    await fixture.close();
  }
});
