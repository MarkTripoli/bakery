import { assertEquals } from "@std/assert";
import { claimOutboxRows } from "../../apps/server/src/platform/outbox-claim.ts";
import {
  enqueueOutboxEvent,
  openOutboxTestFixture,
} from "../helpers/outbox-fixture.ts";

Deno.test("concurrent outbox claims return disjoint bounded rows", async () => {
  const fixture = await openOutboxTestFixture();
  const { owner, appPg, organizationId } = fixture;
  try {
    // Given four eligible rows and two independent claim transactions
    for (let index = 0; index < 4; index++) {
      await enqueueOutboxEvent(owner, organizationId, "inngest");
    }
    const options = {
      database: appPg,
      leaseSeconds: 30,
      maxAttempts: 5,
      replaySafetySeconds: 6,
    };

    // When both transactions claim two rows concurrently
    const [first, second] = await Promise.all([
      claimOutboxRows(options, 2),
      claimOutboxRows(options, 2),
    ]);

    // Then each claim stays bounded and no row is leased twice
    assertEquals(first.length, 2);
    assertEquals(second.length, 2);
    assertEquals(new Set([...first, ...second].map(({ id }) => id)).size, 4);
  } finally {
    await fixture.close();
  }
});
