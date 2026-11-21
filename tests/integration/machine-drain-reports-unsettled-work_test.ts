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

Deno.test("a draining machine reports its own work, counts every live state, and is done at zero", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource({ policy: fx.policy() });
    fx.reader.setIssue({ number: 951, labels: [EXECUTE_LABEL] });
    fx.reader.setIssue({ number: 952, labels: [EXECUTE_LABEL] });
    const first = await fx.admit(sourceId, { number: 951, intent: "start" });
    const second = await fx.admit(sourceId, { number: 952, intent: "start" });
    const attempt = await seedAttempt(
      fx,
      first.request!.workflowRunId!,
      ["steer"],
      "Drain test worker",
    );
    // Another machine with its own live attempt: its work is not this one's.
    const other = await seedAttempt(
      fx,
      second.request!.workflowRunId!,
      ["steer"],
      "Other test worker",
    );
    try {
      const get = async (hostId = attempt.hostId) =>
        await read<Host>(
          await ticketCall(fx, "GET", `/v1/workers/${hostId}`),
          200,
        );
      const listed = async (hostId: string) => {
        const page = await read<{ items: Host[] }>(
          await ticketCall(fx, "GET", "/v1/workers"),
          200,
        );
        return page.items.find((item) => item.id === hostId)!
          .unsettledAttemptCount;
      };
      const setAttempt = (status: string) =>
        fx.owner.query(
          `update bakery.job_attempts
              set status = $2,
                  ended_at = case when $2 in ('lost', 'completed', 'failed', 'canceled')
                    then now() end
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

      // Every state in which the machine still holds the work.
      for (
        const [status, why] of [
          ["leased", "claimed, not yet running"],
          ["canceling", "being stopped"],
          ["quarantined", "an outcome nobody knows is not settled"],
        ] as const
      ) {
        await setAttempt(status);
        assertEquals((await get()).unsettledAttemptCount, 1, why);
      }

      // Every state in which it does not, and the other machine is untouched.
      for (const status of ["failed", "canceled", "completed", "lost"]) {
        await setAttempt(status);
        assertEquals(
          (await get()).unsettledAttemptCount,
          0,
          `${status} is settled, though another machine is still running`,
        );
        assertEquals(
          (await get(other.hostId)).unsettledAttemptCount,
          1,
          "the other machine's work is its own",
        );
      }
      const done = await get();
      assertEquals(done.desiredMode, "draining", "the Admin's intent stays");
      assertEquals(await listed(attempt.hostId), 0, "the list says the same");
      assertEquals(await listed(other.hostId), 1, "and for the other machine");
    } finally {
      await attempt.cleanup();
      await other.cleanup();
    }
  }));
