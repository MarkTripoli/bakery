import { assertEquals } from "@std/assert";
import { readInngestEventConfig } from "../../packages/config/src/env.ts";
import { createOutboxDispatcher } from "../../apps/server/src/platform/outbox-dispatcher.ts";
import {
  createInngestEventClient,
  type EngineEventClient,
  OutboxDeliveryUncertainError,
} from "../../apps/server/src/platform/inngest-event-client.ts";
import {
  enqueueOutboxEvent,
  openOutboxTestFixture,
} from "../helpers/outbox-fixture.ts";

const inngestConfig = readInngestEventConfig(Deno.env.toObject());

Deno.test("native Inngest recovery replays stable outbox identity", async () => {
  const fixture = await openOutboxTestFixture();
  const nativeClient = createInngestEventClient({
    baseUrl: inngestConfig.url,
    eventKey: inngestConfig.eventKey,
  });
  const sentIds: string[] = [];
  let loseAcknowledgement = true;
  const acknowledgementLossClient: EngineEventClient = {
    async send(event, signal) {
      sentIds.push(event.id);
      const result = await nativeClient.send(event, signal);
      if (loseAcknowledgement) {
        loseAcknowledgement = false;
        throw new OutboxDeliveryUncertainError("SIMULATED_ACK_LOSS");
      }
      return result;
    },
  };
  try {
    const outboxId = await enqueueOutboxEvent(
      fixture.owner,
      fixture.organizationId,
      "inngest",
    );
    const deliveryKey = String(
      (await fixture.owner`
        select delivery_key as "deliveryKey"
        from bakery.outbox where id = ${outboxId}`)[0].deliveryKey,
    );

    // Given native Inngest accepted an event but its acknowledgement was lost
    const first = createOutboxDispatcher({
      database: fixture.appPg,
      engine: acknowledgementLossClient,
    });
    const unacknowledged = await first.dispatchBatch(1);
    await fixture.owner`
      update bakery.outbox set next_attempt_at = now() where id = ${outboxId}`;

    // When a replacement dispatcher retries from durable Postgres state
    const replacement = createOutboxDispatcher({
      database: fixture.appPg,
      engine: acknowledgementLossClient,
    });
    const recovered = await replacement.dispatchBatch(1);

    // Then Bakery completes the same stable delivery after the native replay
    assertEquals(unacknowledged.retried, 1);
    assertEquals(recovered.delivered, 1);
    assertEquals(sentIds, [deliveryKey, deliveryKey]);
    assertEquals(
      (await fixture.owner`
      select status, attempt_count as "attemptCount"
      from bakery.outbox where id = ${outboxId}
    `)[0],
      { status: "delivered", attemptCount: 2 },
    );
  } finally {
    await fixture.close();
  }
});

Deno.test("native final-attempt acknowledgement loss requires reconciliation", async () => {
  const fixture = await openOutboxTestFixture();
  const nativeClient = createInngestEventClient({
    baseUrl: inngestConfig.url,
    eventKey: inngestConfig.eventKey,
  });
  try {
    const outboxId = await enqueueOutboxEvent(
      fixture.owner,
      fixture.organizationId,
      "inngest",
    );
    const dispatcher = createOutboxDispatcher({
      database: fixture.appPg,
      engine: {
        async send(event, signal) {
          await nativeClient.send(event, signal);
          throw new OutboxDeliveryUncertainError("SIMULATED_ACK_LOSS");
        },
      },
      maxAttempts: 1,
    });

    const result = await dispatcher.dispatchBatch(1);

    assertEquals(result.failed, 1);
    assertEquals(
      (await fixture.owner`
        select status, lease_token as "leaseToken", last_error->>'code' as code
        from bakery.outbox where id = ${outboxId}`)[0],
      {
        status: "failed",
        leaseToken: null,
        code: "OUTBOX_RECONCILIATION_REQUIRED",
      },
    );
  } finally {
    await fixture.close();
  }
});
