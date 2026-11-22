import { assert, assertEquals } from "@std/assert";
import {
  EXECUTE_LABEL,
  withTicketFixture,
} from "../helpers/ticket-admission/fixtures.ts";
import {
  type Problem,
  read,
  ticketCall,
} from "../helpers/ticket-admission/operations-http.ts";
import { addMember } from "../helpers/durable-questions.ts";

/**
 * Issue 61: `ticketRequests.cancel` stops a start request that has no run
 * yet, by the version the caller last read. A request with a live run is
 * refused and named the run, which `runs.control` stops instead.
 */

type View = {
  id: string;
  disposition: string;
  dispositionReasonCode: string | null;
  progress: string;
  workflowRunId: string | null;
  version: number;
};

const cancelPath = (id: string) => `/v1/ticket-requests/${id}/cancellations`;

Deno.test("issue 61: a request with no run is stopped once, by its version, as the caller", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource();
    fx.reader.setIssue({ number: 611, labels: [EXECUTE_LABEL] });
    const admitted = await fx.admit(sourceId, { number: 611, intent: "plan" });
    const request = admitted.request!;
    assertEquals([request.disposition, request.workflowRunId], [
      "waiting",
      null,
    ]);

    // No If-Match, or a stale one, is refused and changes nothing.
    const missing = await ticketCall(fx, "POST", cancelPath(request.id), {
      body: {},
    });
    assertEquals(missing.status, 428, await missing.clone().text());
    const stale = await ticketCall(fx, "POST", cancelPath(request.id), {
      body: {},
      ifMatch: request.version + 5,
    });
    assertEquals(stale.status, 412, await stale.clone().text());

    const key = crypto.randomUUID();
    const response = await ticketCall(fx, "POST", cancelPath(request.id), {
      body: {},
      key,
      ifMatch: request.version,
    });
    const status = response.status;
    assertEquals(status, 201, await response.clone().text());
    const canceled = await response.json() as View;
    assertEquals(
      [
        canceled.id,
        canceled.disposition,
        canceled.dispositionReasonCode,
        canceled.progress,
      ],
      [request.id, "canceled", "request_canceled", "canceled"],
    );
    assertEquals(canceled.version, request.version + 1);
    // The read agrees, and the caller is the one recorded.
    assertEquals(
      await read<View>(
        await ticketCall(fx, "GET", `/v1/ticket-requests/${request.id}`),
        200,
      ),
      canceled,
    );
    const facts = await fx.requestFacts(request.id);
    assertEquals(facts.audit.at(-1), "ticketRequests.cancel");
    assertEquals(facts.events.at(-1), {
      resourceId: request.id,
      resourceVersion: canceled.version,
    });
    const actor = await fx.owner.query<{ principal_id: string }>(
      `select principal_id from bakery.audit_events
        where organization_id = $1 and resource_id = $2
          and operation = 'ticketRequests.cancel'`,
      [fx.organizationId, request.id],
    );
    assertEquals(actor.rows.map((row) => row.principal_id), [fx.adminId]);

    // The same key answers from the stored response.
    const replay = await ticketCall(fx, "POST", cancelPath(request.id), {
      body: {},
      key,
      ifMatch: request.version,
    });
    assertEquals(replay.status, status);
    assertEquals(await replay.json(), canceled);

    // A finished request cannot be stopped again.
    const again = await ticketCall(fx, "POST", cancelPath(request.id), {
      body: {},
      ifMatch: canceled.version,
    });
    assertEquals(again.status, 409);
    assertEquals(
      (await again.json() as Problem).reason,
      "ticket_request_finished",
    );
    assertEquals(
      (await fx.requestFacts(request.id)).audit.filter((op) =>
        op === "ticketRequests.cancel"
      ).length,
      1,
    );

    // An unknown request is 404.
    const unknown = await ticketCall(
      fx,
      "POST",
      cancelPath(crypto.randomUUID()),
      { body: {}, ifMatch: 1 },
    );
    assertEquals(unknown.status, 404);
  }));

Deno.test("issue 61: a request with a live run is refused and names the run", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource();
    fx.reader.setIssue({ number: 612, labels: [EXECUTE_LABEL] });
    const admitted = await fx.admit(sourceId, { number: 612, intent: "start" });
    const request = admitted.request!;
    assert(request.workflowRunId !== null, "a start request owns a run");
    const refused = await ticketCall(fx, "POST", cancelPath(request.id), {
      body: {},
      ifMatch: request.version,
    });
    assertEquals(refused.status, 409);
    const problem = await refused.json() as Problem & {
      params?: { runId?: string };
      runId?: string;
    };
    assertEquals(problem.reason, "ticket_request_has_run");
    const view = await read<View>(
      await ticketCall(fx, "GET", `/v1/ticket-requests/${request.id}`),
      200,
    );
    assertEquals([view.disposition, view.version], [
      request.disposition,
      request.version,
    ]);
    assertEquals(
      (await fx.requestFacts(request.id)).audit.includes(
        "ticketRequests.cancel",
      ),
      false,
    );
  }, { budget: true }));

Deno.test("issue 61: a viewer cannot stop a request and nothing is written; a developer can", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource();
    fx.reader.setIssue({ number: 712, labels: [EXECUTE_LABEL] });
    const admitted = await fx.admit(sourceId, { number: 712, intent: "plan" });
    const request = admitted.request!;
    const context = {
      organizationId: fx.organizationId,
      principalId: fx.adminId,
      cookie: fx.f.adminCookie,
      applicationId: fx.applicationId,
      repositoryId: fx.repositoryId,
      conversationId: "",
      agentVersionId: "",
    };
    const viewer = await addMember(fx.f, context, "stop-viewer", "viewer");
    const asViewer = await ticketCall(fx, "POST", cancelPath(request.id), {
      body: {},
      ifMatch: request.version,
      cookie: viewer.cookie,
    });
    assertEquals(asViewer.status, 403, await asViewer.clone().text());
    assertEquals(
      (await fx.requestFacts(request.id)).audit.includes(
        "ticketRequests.cancel",
      ),
      false,
    );
    const row = await fx.owner.query<{ disposition: string }>(
      "select disposition from bakery.ticket_requests where id = $1",
      [request.id],
    );
    assertEquals(row.rows[0].disposition, "waiting");

    const developer = await addMember(fx.f, context, "stop-dev", "developer");
    const asDeveloper = await ticketCall(fx, "POST", cancelPath(request.id), {
      body: {},
      ifMatch: request.version,
      cookie: developer.cookie,
    });
    assertEquals(asDeveloper.status, 201, await asDeveloper.clone().text());
    const who = await fx.owner.query<{ principal_id: string }>(
      `select principal_id from bakery.audit_events
        where resource_id = $1 and operation = 'ticketRequests.cancel'`,
      [request.id],
    );
    assertEquals(who.rows.length, 1);
    assert(
      who.rows[0].principal_id !== fx.adminId,
      "recorded as the developer",
    );
  }));
