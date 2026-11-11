import { assertEquals, assertRejects } from "@std/assert";
import { createOutboxDispatcher } from "../../apps/server/src/platform/outbox-dispatcher.ts";
import {
  createInngestEventClient,
  OutboxDeliveryError,
} from "../../apps/server/src/platform/inngest-event-client.ts";
import {
  enqueueOutboxEvent,
  openOutboxTestFixture,
} from "../helpers/outbox-fixture.ts";

Deno.test("Inngest event client rejects redirects before forwarding the credential", async () => {
  let redirectedRequestReceived = false;
  const destination = Deno.serve(
    { hostname: "127.0.0.1", port: 0 },
    () => {
      redirectedRequestReceived = true;
      return Response.json({ ids: ["engine-redirected"], status: 200 });
    },
  );
  const redirector = Deno.serve(
    { hostname: "127.0.0.1", port: 0 },
    () =>
      Response.redirect(
        `http://127.0.0.1:${(destination.addr as Deno.NetAddr).port}`,
        307,
      ),
  );
  try {
    const client = createInngestEventClient({
      baseUrl: `http://127.0.0.1:${(redirector.addr as Deno.NetAddr).port}`,
      eventKey: "credential-must-not-follow",
    });
    await assertRejects(
      () =>
        client.send({
          id: "event-redirect",
          name: "bakery/test",
          ts: Date.now(),
          data: {},
        }),
      OutboxDeliveryError,
      "ENGINE_UNREACHABLE",
    );
    assertEquals(redirectedRequestReceived, false);
  } finally {
    await Promise.all([destination.shutdown(), redirector.shutdown()]);
  }
});

Deno.test("final-attempt uncertain delivery is parked for reconciliation", async () => {
  const fixture = await openOutboxTestFixture();
  let received = 0;
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0 }, () => {
    received++;
    return Response.json({ ids: [" "], status: 200 });
  });
  try {
    const id = await enqueueOutboxEvent(
      fixture.owner,
      fixture.organizationId,
      "inngest",
    );
    const dispatcher = createOutboxDispatcher({
      database: fixture.appPg,
      engine: createInngestEventClient({
        baseUrl: `http://${server.addr.hostname}:${server.addr.port}`,
        eventKey: "test",
      }),
      maxAttempts: 1,
    });

    const summary = await dispatcher.dispatchBatch(1);

    assertEquals(summary.failed, 1);
    assertEquals(received, 1);
    assertEquals(
      (await fixture.owner`
        select status, lease_token as "leaseToken", last_error->>'code' as code
        from bakery.outbox where id = ${id}`)[0],
      {
        status: "failed",
        leaseToken: null,
        code: "OUTBOX_RECONCILIATION_REQUIRED",
      },
    );
  } finally {
    await server.shutdown();
    await fixture.close();
  }
});

Deno.test("ambiguous HTTP rejection is parked for reconciliation", async () => {
  const fixture = await openOutboxTestFixture();
  let responseStatus = 408;
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0 },
    () => new Response("ambiguous", { status: responseStatus }),
  );
  try {
    const dispatcher = createOutboxDispatcher({
      database: fixture.appPg,
      engine: createInngestEventClient({
        baseUrl: `http://${server.addr.hostname}:${server.addr.port}`,
        eventKey: "test",
      }),
      maxAttempts: 1,
    });
    for (const status of [408, 503]) {
      responseStatus = status;
      const id = await enqueueOutboxEvent(
        fixture.owner,
        fixture.organizationId,
        "inngest",
      );

      const summary = await dispatcher.dispatchBatch(1);

      assertEquals(summary.failed, 1);
      assertEquals(
        (await fixture.owner`
          select status, last_error->>'code' as code,
            (last_error->>'status')::int as "responseStatus"
          from bakery.outbox where id = ${id}`)[0],
        {
          status: "failed",
          code: "OUTBOX_RECONCILIATION_REQUIRED",
          responseStatus: status,
        },
      );
    }
  } finally {
    await server.shutdown();
    await fixture.close();
  }
});
