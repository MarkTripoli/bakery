import { assertEquals } from "@std/assert";
import {
  EXECUTE_LABEL,
  type TicketFixture,
  withTicketFixture,
} from "../helpers/ticket-admission/fixtures.ts";
import {
  read,
  ticketCall,
} from "../helpers/ticket-admission/operations-http.ts";

/**
 * Issue 32: the progress a ticket request shows is read from the completion
 * policy's evidence, not from the run alone. A finished run reads `active`
 * until the policy is met; a failed run is never held back.
 */

type View = { id: string; disposition: string; progress: string };

/** The progress of one request as `get` and `list` answer it; the two must agree. */
async function progressOf(
  fx: TicketFixture,
  requestId: string,
  ticketId: string,
): Promise<string> {
  const one = await read<View>(
    await ticketCall(fx, "GET", `/v1/ticket-requests/${requestId}`),
    200,
  );
  const list = await read<{ items: View[] }>(
    await ticketCall(
      fx,
      "GET",
      `/v1/ticket-requests?externalTicketId=${ticketId}`,
    ),
    200,
  );
  assertEquals(
    list.items.find((item) => item.id === requestId)?.progress,
    one.progress,
    "list and get agree",
  );
  return one.progress;
}

Deno.test("the request view shows active until the completion policy is met", () =>
  withTicketFixture(async (fx) => {
    for (
      const [completion, number] of [
        ["merged", 901],
        ["deployed_healthy", 902],
        ["task", 903],
      ] as const
    ) {
      const sourceId = await fx.insertSource({
        policy: fx.policy({ completion }),
      });
      fx.reader.setIssue({ number, labels: [EXECUTE_LABEL] });
      const admitted = await fx.admit(sourceId, { number, intent: "start" });
      const request = admitted.request!;
      const setPullRequest = (pullRequest: number, status: string) =>
        fx.owner.query(
          `update bakery.pull_requests set status = $3
            where organization_id = $1 and provider_number = $2`,
          [fx.organizationId, pullRequest, status],
        );
      const finishRun = (status: string) =>
        fx.owner.query(
          `update bakery.workflow_runs set status = $3, finished_at = now()
            where organization_id = $1 and id = $2`,
          [fx.organizationId, request.workflowRunId, status],
        );
      const progress = () => progressOf(fx, request.id, admitted.ticketId!);
      const seen: string[] = [];

      await finishRun("completed");
      seen.push(await progress()); // completed run, no pull request
      await fx.registerPullRequest({
        sourceId,
        taskId: request.taskId,
        number: number * 10,
        status: "closed",
      });
      seen.push(await progress()); // a pull request closed without a merge
      await fx.registerPullRequest({
        sourceId,
        taskId: request.taskId,
        number: number * 10 + 1,
        status: "open",
      });
      seen.push(await progress()); // a replacement still open
      await setPullRequest(number * 10 + 1, "merged");
      seen.push(await progress()); // the replacement merged
      // A run that failed is never held back by delivery.
      await setPullRequest(number * 10 + 1, "closed");
      await setPullRequest(number * 10, "open");
      await finishRun("failed");
      seen.push(await progress());

      assertEquals(
        seen,
        completion === "task"
          // Pull requests do not matter to a task policy: finished is done.
          ? ["completed", "completed", "completed", "completed", "failed"]
          : completion === "merged"
          // No pull request yet is delivered (nothing to merge); once one is
          // registered, an unmerged one holds the work until it merges.
          ? ["completed", "active", "active", "completed", "failed"]
          : ["active", "active", "active", "active", "failed"],
        completion,
      );
    }
  }));
