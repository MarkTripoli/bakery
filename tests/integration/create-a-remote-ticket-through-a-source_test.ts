import { assert, assertEquals } from "@std/assert";
import {
  type TicketFixture,
  withTicketFixture,
} from "../helpers/ticket-admission/fixtures.ts";
import { SEND_ARGUMENTS_REFUSED } from "../../apps/server/src/modules/work/ticket-create.ts";
import {
  type Json,
  type Problem,
  read,
  ticketCall,
} from "../helpers/ticket-admission/operations-http.ts";

/**
 * Issue 32: `POST /v1/ticket-sources/{id}/tickets` creates one ticket in the
 * tracker through the source's connection. The caller needs the Developer role
 * and a live grant for the creating action on the source's repository; the
 * answer is a 202 receipt of the recorded effect, never a claim that the issue
 * exists; the same Idempotency-Key is the same effect.
 */

type Receipt = { effectId: string; status: string; location: string };

const create = (
  fx: TicketFixture,
  sourceId: string,
  body: unknown,
  options: { key?: string | null; cookie?: string } = {},
) =>
  ticketCall(fx, "POST", `/v1/ticket-sources/${sourceId}/tickets`, {
    body,
    ...options,
  });

const ISSUE = {
  title: "Add a status page",
  body: "Show uptime for each region.",
};

Deno.test("a granted caller creates a ticket and gets a 202 receipt of the effect", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource();
    await fx.grantAction(fx.adminId);
    const key = crypto.randomUUID();
    const receipt = await read<Receipt>(
      await create(fx, sourceId, {
        ...ISSUE,
        providerFields: { labels: ["bakery", "ui"] },
      }, { key }),
      202,
    );
    assertEquals(receipt.status, "submitted");
    assertEquals(
      receipt.location,
      `/v1/integration-connections/${fx.connectionId}/effects/${receipt.effectId}`,
    );
    assertEquals(fx.creator.requests.length, 1);
    const sent = fx.creator.requests[0];
    assertEquals(sent.provider, "github");
    assertEquals(sent.connectionId, fx.connectionId);
    assertEquals(sent.resourceId, fx.resource.id);
    assertEquals(sent.title, ISSUE.title);
    assertEquals(sent.body, ISSUE.body);
    assertEquals(sent.labels, ["bakery", "ui"]);
    assertEquals(sent.actorPrincipalId, fx.adminId);
    assertEquals(sent.idempotencyKey, key);

    // The same key is the same effect: the repeat is answered from the first.
    const again = await read<Receipt>(
      await create(fx, sourceId, {
        ...ISSUE,
        providerFields: { labels: ["bakery", "ui"] },
      }, { key }),
      202,
    );
    assertEquals(again, receipt);
    assertEquals(fx.creator.requests.length, 1, "no second send");

    const audit = await fx.owner.query<{ details: Json }>(
      `select details from bakery.audit_events
        where organization_id = $1 and operation = 'externalTickets.create'`,
      [fx.organizationId],
    );
    assertEquals(audit.rows.length, 1);
    assertEquals(audit.rows[0].details.status, "submitted");
  }));

Deno.test("without a live grant for the creating action the call is refused and sends nothing", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource();
    // The grant is held by someone else: the caller's role alone does not admit.
    await fx.grantAction(fx.developerId);
    const refused = await read<Problem>(
      await create(fx, sourceId, ISSUE),
      403,
    );
    assertEquals(refused.code, "AUTH_FORBIDDEN");
    assertEquals(fx.creator.requests.length, 0);

    // A revoked grant is no grant.
    await fx.grantAction(fx.adminId);
    await fx.owner.query(
      "update bakery.integration_grants set revoked_at = now() where organization_id = $1",
      [fx.organizationId],
    );
    await read(await create(fx, sourceId, ISSUE), 403);
    assertEquals(fx.creator.requests.length, 0);
  }));

Deno.test("a missing source is 404, a disabled one 409, and a blank body or bad labels 422", () =>
  withTicketFixture(async (fx) => {
    await fx.grantAction(fx.adminId);
    const missing = crypto.randomUUID();
    assertEquals((await create(fx, missing, ISSUE)).status, 404);

    const disabled = await fx.insertSource({ enabled: false });
    const stopped = await read<Problem>(await create(fx, disabled, ISSUE), 409);
    assertEquals(stopped.reason, "source_disabled");

    const sourceId = await fx.insertSource();
    await read(await create(fx, sourceId, { ...ISSUE, body: "  " }), 422);
    await read(
      await create(fx, sourceId, {
        ...ISSUE,
        providerFields: { labels: "bug" },
      }),
      422,
    );
    // Only the label list is read from the provider fields; the rest is not passed on.
    await read<Receipt>(
      await create(fx, sourceId, {
        ...ISSUE,
        providerFields: { assignees: ["octocat"] },
      }),
      202,
    );
    assertEquals(fx.creator.requests.length, 1);
    assertEquals(fx.creator.requests[0].labels, undefined);
  }));

Deno.test("a send that failed is a 503 with a fixed reason, and one with no answer yet is an uncertain receipt", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource();
    await fx.grantAction(fx.adminId);
    fx.creator.next.push({
      kind: "failed",
      problemCode: "connection_unhealthy",
    });
    const failed = await read<Problem>(await create(fx, sourceId, ISSUE), 503);
    assertEquals(failed.code, "DEPENDENCY_UNAVAILABLE");

    // Input the provider action refuses is the caller's to fix: 422, not an outage.
    fx.creator.next.push({
      kind: "failed",
      problemCode: SEND_ARGUMENTS_REFUSED,
    });
    const refused = await read<Problem>(await create(fx, sourceId, ISSUE), 422);
    assertEquals(refused.code, "UNPROCESSABLE");

    fx.creator.next.push({
      kind: "sent",
      effectId: crypto.randomUUID(),
      status: "uncertain",
    });
    const uncertain = await read<Receipt>(
      await create(fx, sourceId, ISSUE),
      202,
    );
    assertEquals(uncertain.status, "uncertain");
    assert(fx.creator.requests.length === 3);
  }));
