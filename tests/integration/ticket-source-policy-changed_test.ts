import { assertEquals } from "@std/assert";
import { withTicketFixture } from "../helpers/ticket-admission/fixtures.ts";
import {
  type Problem,
  read,
  type SourceView,
  ticketCall,
  type TicketView,
} from "../helpers/ticket-admission/operations-http.ts";

/*
 * The 412 PRECONDITION_FAILED reason `source_policy_changed`: an operation
 * naming a ticket carries the source policy revision its caller last saw, and
 * a revision the source has moved past is refused with nothing written. The
 * operation runner checks it before GitHub is read; `ticketRequests.create`
 * checks it again under the source lock. The GitHub reader is the fixture's
 * in-memory fake, not live GitHub proof.
 */

const SOURCES = "/v1/ticket-sources";
const TICKETS = "/v1/external-tickets";

const post = (
  fx: Parameters<typeof ticketCall>[0],
  path: string,
  body: unknown,
) => ticketCall(fx, "POST", path, { body });

/** The ticket the source recorded for issue `number`. */
async function ticketOf(
  fx: Parameters<typeof ticketCall>[0],
  sourceId: string,
  number: number,
): Promise<TicketView> {
  const page = await read<{ items: TicketView[] }>(
    await ticketCall(
      fx,
      "GET",
      `${TICKETS}?sourceId=${sourceId}&limit=100`,
    ),
    200,
  );
  const found = page.items.find((item) => Number(item.number) === number);
  if (!found) throw new Error(`no ticket for issue ${number}`);
  return found;
}

/**
 * Asserts the refusal a stale revision gets over HTTP: 412
 * PRECONDITION_FAILED with reason `source_policy_changed`, so the person is
 * told why the start was refused. Each site's refusal is told apart by
 * whether GitHub was read.
 */
async function assertPolicyChanged(response: Response, label: string) {
  const problem = await read<Problem>(response, 412);
  assertEquals(
    [problem.code, problem.reason],
    ["PRECONDITION_FAILED", "source_policy_changed"],
    label,
  );
}

Deno.test("source_policy_changed: a stale revision is refused with nothing written, the current one is served", async () => {
  await withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource();
    for (const number of [1, 2]) {
      fx.reader.setIssue({ number, labels: [] });
      fx.facts.set(number, `2026-06-01T00:00:0${number}Z`);
    }
    // A preview stores nothing, so cache the issues the way a poll does.
    for (const number of [1, 2]) {
      await fx.admit(sourceId, { number, origin: "poll" });
    }

    // A policy edit moves the revision from 1 to 2.
    const source = await read<SourceView>(
      await ticketCall(fx, "GET", `${SOURCES}/${sourceId}`),
      200,
    );
    const edited = await read<SourceView>(
      await ticketCall(fx, "PATCH", `${SOURCES}/${sourceId}`, {
        body: {
          policy: { ...source.policy, approval: { plan: "human_approval" } },
        },
        ifMatch: source.version,
      }),
      200,
    );
    assertEquals(edited.policyRevision, source.policyRevision + 1);
    const current = edited.policyRevision;
    const stale = current - 1;

    // (2) Readiness, through the operation runner: an edited issue would get a
    // new report, but the stale revision is refused before GitHub is read.
    fx.reader.setIssue({
      number: 1,
      body: "Edited.\n\n## Acceptance criteria\n- a new criterion\n",
    });
    const first = await ticketOf(fx, sourceId, 1);
    const readiness = `${TICKETS}/${first.id}/readiness-checks`;
    const beforeReadiness = await fx.counts(sourceId);
    const calls = fx.reader.calls.length;
    await assertPolicyChanged(
      await post(fx, readiness, { expectedSourcePolicyRevision: stale }),
      "readiness, stale",
    );
    assertEquals(fx.reader.calls.length, calls);
    assertEquals(await fx.counts(sourceId), beforeReadiness);
    // (3) Control: the current revision records the report.
    await read(
      await post(fx, readiness, { expectedSourcePolicyRevision: current }),
      201,
    );
    assertEquals(
      (await fx.counts(sourceId)).reports,
      beforeReadiness.reports + 1,
    );

    // (1) ticketRequests.create with the stale revision writes no request or task.
    const second = await ticketOf(fx, sourceId, 2);
    const requests = `${TICKETS}/${second.id}/requests`;
    const body = (revision: number) => ({
      intent: "start",
      expectedSourcePolicyRevision: revision,
      requirementsDigest: second.requirementsDigest,
    });
    const beforeRequest = await fx.counts(sourceId);
    const asked = fx.reader.calls.length;
    await assertPolicyChanged(
      await post(fx, requests, body(stale)),
      "request, stale",
    );
    // Refused by the runner, before GitHub is read.
    assertEquals(fx.reader.calls.length, asked);
    assertEquals(await fx.counts(sourceId), beforeRequest);

    // (1, under the lock) The policy moves while GitHub is read, after the
    // runner's check passed: the locked re-check refuses and nothing is written.
    fx.reader.pause = async () => {
      fx.reader.pause = null;
      await fx.owner.query(
        `update bakery.ticket_sources set policy_revision = policy_revision + 1
          where id = $1`,
        [sourceId],
      );
    };
    const readBefore = fx.reader.calls.length;
    await assertPolicyChanged(
      await post(fx, requests, body(current)),
      "request, moved under the lock",
    );
    // Refused by the locked re-check, after GitHub was read.
    assertEquals(fx.reader.calls.length > readBefore, true);
    assertEquals(await fx.counts(sourceId), beforeRequest);

    // (3) Control: the revision the source now holds admits once.
    await read(await post(fx, requests, body(current + 1)), 201);
    const after = await fx.counts(sourceId);
    assertEquals(
      [after.requests, after.tasks],
      [beforeRequest.requests + 1, beforeRequest.tasks + 1],
    );
  }, { budget: true });
});
