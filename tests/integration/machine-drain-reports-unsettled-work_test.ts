import { assertEquals } from "@std/assert";
import {
  EXECUTE_LABEL,
  withTicketFixture,
} from "../helpers/ticket-admission/fixtures.ts";
import {
  read,
  ticketCall,
} from "../helpers/ticket-admission/operations-http.ts";
import { seedAttempt } from "../helpers/ticket-admission/seed-attempt.ts";

/**
 * Issue 70: a machine finishing its work ("Finish and stop") reports how much
 * work it has left, so the page can say when there is none. The mode itself
 * stays draining: it is the Admin's intent, and retiring is a separate act.
 */

type Host = {
  id: string;
  desiredMode: string;
  unsettledAttemptCount: number;
};

Deno.test("a draining machine reports the work it has left and is done at zero", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource({ policy: fx.policy() });
    fx.reader.setIssue({ number: 951, labels: [EXECUTE_LABEL] });
    const admitted = await fx.admit(sourceId, { number: 951, intent: "start" });
    const attempt = await seedAttempt(
      fx,
      admitted.request!.workflowRunId!,
      ["steer"],
      "Drain test worker",
    );
    try {
      const get = async () =>
        await read<Host>(
          await ticketCall(fx, "GET", `/v1/workers/${attempt.hostId}`),
          200,
        );
      const listed = async () => {
        const page = await read<{ items: Host[] }>(
          await ticketCall(fx, "GET", "/v1/workers"),
          200,
        );
        return page.items.find((item) => item.id === attempt.hostId)!
          .unsettledAttemptCount;
      };
      const setAttempt = (status: string) =>
        fx.owner.query(
          `update bakery.job_attempts
              set status = $2,
                  ended_at = case when $2 in ('lost', 'completed') then now() end
            where id = $1`,
          [attempt.attemptId, status],
        );

      assertEquals((await get()).unsettledAttemptCount, 1, "a running attempt");
      const draining = await read<Host>(
        await ticketCall(fx, "PATCH", `/v1/workers/${attempt.hostId}`, {
          body: { status: "draining" },
        }),
        200,
      );
      assertEquals(draining.desiredMode, "draining");
      assertEquals(draining.unsettledAttemptCount, 1, "still finishing it");

      await setAttempt("canceling");
      assertEquals((await get()).unsettledAttemptCount, 1, "being stopped");
      await setAttempt("quarantined");
      assertEquals(
        (await get()).unsettledAttemptCount,
        1,
        "an outcome nobody knows is not settled",
      );

      await setAttempt("lost");
      const done = await get();
      assertEquals(done.unsettledAttemptCount, 0, "nothing is left");
      assertEquals(done.desiredMode, "draining", "the Admin's intent stays");
      assertEquals(await listed(), 0, "the list says the same");
    } finally {
      await attempt.cleanup();
    }
  }));
