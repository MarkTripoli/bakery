import { assert, assertEquals } from "@std/assert";
import {
  EXECUTE_LABEL,
  withTicketFixture,
} from "../helpers/ticket-admission/fixtures.ts";
import {
  read,
  ticketCall,
} from "../helpers/ticket-admission/operations-http.ts";

/**
 * Issue 61: a stopped request says who stopped it, by principal and display
 * name, resolved by the server from the stop's audit row. That holds for a
 * request stopped before its run (`ticketRequests.cancel`) and for one whose
 * run was stopped (`runs.control` cancel, Stop work).
 */

type View = {
  id: string;
  progress: string;
  workflowRunId: string | null;
  version: number;
  stoppedByPrincipalId: string | null;
  stoppedByName: string | null;
};

async function viewOf(
  fx: Parameters<Parameters<typeof withTicketFixture>[0]>[0],
  id: string,
): Promise<View> {
  return await read<View>(
    await ticketCall(fx, "GET", `/v1/ticket-requests/${id}`),
    200,
  );
}

async function adminName(
  fx: Parameters<Parameters<typeof withTicketFixture>[0]>[0],
): Promise<string> {
  const row = await fx.owner.query<{ display_name: string }>(
    "select display_name from bakery.principals where id = $1",
    [fx.adminId],
  );
  return row.rows[0]!.display_name;
}

Deno.test("issue 61: a request stopped before its run names who stopped it", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource();
    fx.reader.setIssue({ number: 615, labels: [EXECUTE_LABEL] });
    const admitted = await fx.admit(sourceId, { number: 615, intent: "plan" });
    const request = admitted.request!;
    const before = await viewOf(fx, request.id);
    assertEquals([before.stoppedByPrincipalId, before.stoppedByName], [
      null,
      null,
    ]);
    const response = await ticketCall(
      fx,
      "POST",
      `/v1/ticket-requests/${request.id}/cancellations`,
      { body: {}, ifMatch: request.version },
    );
    const canceled = await read<View>(response, 201);
    const name = await adminName(fx);
    assertEquals([canceled.progress, canceled.stoppedByPrincipalId], [
      "canceled",
      fx.adminId,
    ]);
    assertEquals(canceled.stoppedByName, name);
    assertEquals(await viewOf(fx, request.id), canceled);
  }));

Deno.test("issue 61: a request whose run was stopped names who stopped it", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource();
    fx.reader.setIssue({ number: 616, labels: [EXECUTE_LABEL] });
    const admitted = await fx.admit(sourceId, { number: 616, intent: "start" });
    const request = admitted.request!;
    const runId = request.workflowRunId;
    assert(runId !== null, "a start request owns a run");
    const running = await viewOf(fx, request.id);
    assertEquals([running.stoppedByPrincipalId, running.stoppedByName], [
      null,
      null,
    ]);
    const stop = await ticketCall(fx, "POST", `/v1/runs/${runId}/controls`, {
      body: { action: "cancel" },
    });
    assert(stop.status < 300, await stop.clone().text());
    const stopped = await viewOf(fx, request.id);
    assertEquals(stopped.progress, "canceled");
    assertEquals(
      [stopped.stoppedByPrincipalId, stopped.stoppedByName],
      [fx.adminId, await adminName(fx)],
    );
  }, { budget: true }));
