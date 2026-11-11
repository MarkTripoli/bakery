/**
 * Issue 82 integration lane: the ticket store on real Postgres, as the
 * application role. Admission has its own file; these cases pin what the store
 * guarantees by itself: version-guarded upserts that refuse an older read, a
 * select-and-insert-only report table whose reads take no lock, and a request
 * insert that turns the slot index into a typed conflict.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { StandardError } from "../../../packages/contracts/src/http.ts";
import {
  type TicketReadinessReport,
  type TicketSnapshot,
} from "../../../packages/contracts/src/ticket-admission.ts";
import { FIXED_CODING_PRESET } from "../../../packages/contracts/src/workflow-presets.ts";
import {
  appendReportIfChanged,
  findNonterminalRequest,
  insertPrimaryLink,
  insertRequest,
  latestReport,
  nextGeneration,
  reportById,
  requestById,
  taskHasUnconsumedApproval,
  type TicketObservation,
  updateRequest,
  upsertExternalTicket,
} from "../../../apps/server/src/modules/work/ticket-store.ts";
import {
  insertBareTask,
  type TicketFixture,
  withTicketFixture,
} from "./fixtures.ts";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const PRESET = {
  id: "fixed-coding" as const,
  revision: FIXED_CODING_PRESET.revision,
  digest: FIXED_CODING_PRESET.digest,
};

function snapshot(
  fx: TicketFixture,
  overrides: Partial<TicketSnapshot> = {},
): TicketSnapshot {
  return {
    title: "Retry uploads",
    body: "Body",
    bodyTruncated: false,
    labels: ["ready for agent"],
    state: "open",
    stateReason: null,
    locked: false,
    repositoryFullName: fx.repositoryFullName,
    links: { parent: null, subIssuesTotal: 0, blockedBy: [], blockingTotal: 0 },
    ...overrides,
  };
}

function observation(
  fx: TicketFixture,
  sourceId: string,
  marker: string,
  overrides: Partial<TicketSnapshot> = {},
): TicketObservation {
  return {
    organizationId: fx.organizationId,
    sourceId,
    externalTicketId: "9001",
    number: 301,
    snapshot: snapshot(fx, overrides),
    requirementsDigest: DIGEST_A,
    providerUpdateMarker: marker,
    visibility: "private",
  };
}

function report(
  basis: string,
  verdict: "ready" | "waiting" = "ready",
): TicketReadinessReport {
  return {
    version: 1,
    verdict,
    checks: [{
      id: "source_live",
      status: verdict === "ready" ? "pass" : "wait",
      reason: verdict === "ready" ? "ok" : "source_disabled",
      evidence: [],
    }],
    requirementsDigest: DIGEST_A,
    dependencyDigest: null,
    basisDigest: basis,
    sourcePolicyRevision: 1,
    preset: PRESET,
  };
}

Deno.test("issue 82 store CAS: an upsert writes a newer or different observation and never lets an older read overwrite", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource();
    const observe = (o: TicketObservation) =>
      fx.inTransaction((tx) => upsertExternalTicket(tx, o));
    const t = (second: number) =>
      `2026-07-01T00:00:${String(second).padStart(2, "0")}Z`;

    const first = await observe(observation(fx, sourceId, t(10)));
    assertEquals(first.result, "written");
    assertEquals(first.ticket.version, 1);
    assertEquals(
      (await observe(observation(fx, sourceId, t(10)))).result,
      "unchanged",
    );

    const newer = await observe(
      observation(fx, sourceId, t(20), { title: "Newer" }),
    );
    assertEquals([newer.result, newer.ticket.version], ["written", 2]);

    // An older provider marker is refused, whatever it says.
    const stale = await observe(
      observation(fx, sourceId, t(15), { title: "Older" }),
    );
    assertEquals(stale.result, "stale");
    assertEquals(stale.ticket.snapshot.title, "Newer");
    assertEquals(stale.ticket.providerUpdateMarker, t(20));

    // The same marker with a different snapshot is a change (labels can move
    // without the marker moving).
    const relabeled = await observe(
      observation(fx, sourceId, t(20), { title: "Newer", labels: ["bug"] }),
    );
    assertEquals([relabeled.result, relabeled.ticket.version], ["written", 3]);

    // A failed links read keeps the stored links.
    const noLinks = await observe(
      observation(fx, sourceId, t(30), {
        title: "Newer",
        labels: ["bug"],
        links: null,
      }),
    );
    assertEquals(noLinks.result, "written");
    assertEquals(noLinks.ticket.snapshot.links?.subIssuesTotal, 0);

    const row = await fx.owner.query<
      { number: string; key: string; safe_url: string }
    >(
      "select number, key, safe_url from bakery.external_tickets where id = $1",
      [first.ticket.id],
    );
    assertEquals(row.rows[0], {
      number: "301",
      key: `${fx.repositoryFullName}#301`,
      safe_url: `https://github.com/${fx.repositoryFullName}/issues/301`,
    });

    // A marker without an offset cannot be placed on the timeline.
    const invalid = await assertRejects(() =>
      observe(observation(fx, sourceId, "2026-07-01T00:00:40"))
    );
    assert(invalid instanceof StandardError);
    assertEquals(invalid.code, "UNPROCESSABLE");
  }));

Deno.test("issue 82 store: reports append only on a changed basis, keep every version and are read without a row lock", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource();
    const { ticket } = await fx.inTransaction((tx) =>
      upsertExternalTicket(
        tx,
        observation(fx, sourceId, "2026-07-01T00:00:10Z"),
      )
    );
    const append = (r: TicketReadinessReport) =>
      fx.inTransaction((tx) =>
        appendReportIfChanged(tx, fx.organizationId, ticket.id, r, "poll")
      );

    const first = await append(report(DIGEST_A));
    assertEquals([first.appended, first.stored.sequence], [true, 1]);
    const same = await append(report(DIGEST_A));
    assertEquals([same.appended, same.stored.id], [false, first.stored.id]);
    const changed = await append(report(DIGEST_B, "waiting"));
    assertEquals([changed.appended, changed.stored.sequence], [true, 2]);
    assertEquals(changed.stored.origin, "poll");
    // Back to an earlier basis is a new change of basis, not a repeat of v1.
    const back = await append(report(DIGEST_A));
    assertEquals([back.appended, back.stored.sequence], [true, 3]);

    const latest = await fx.inTransaction((tx) =>
      latestReport(tx, fx.organizationId, ticket.id)
    );
    assertEquals(latest?.id, back.stored.id);
    const kept = await fx.inTransaction((tx) =>
      reportById(tx, fx.organizationId, first.stored.id)
    );
    assertEquals(kept?.report.basisDigest, DIGEST_A);
    assertEquals(kept?.sequence, 1);

    // The table is select and insert only: no update, no delete, no row lock.
    const code = (work: () => Promise<unknown>) =>
      work().then(() => null, (e: { code?: string }) => e.code ?? "error");
    assertEquals(
      await code(() =>
        fx.runtime.query(
          "update bakery.ticket_readiness_reports set verdict = 'ready'",
        )
      ),
      "42501",
    );
    assertEquals(
      await code(() =>
        fx.runtime.query("delete from bakery.ticket_readiness_reports")
      ),
      "42501",
    );
    assertEquals(
      await code(() =>
        fx.runtime.query(
          "select id from bakery.ticket_readiness_reports for update",
        )
      ),
      "42501",
    );
  }));

Deno.test("issue 82 store: a request insert turns the slot index into a typed conflict and rolls the transaction back", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource();
    const { ticket } = await fx.inTransaction((tx) =>
      upsertExternalTicket(
        tx,
        observation(fx, sourceId, "2026-07-01T00:00:10Z"),
      )
    );
    const stored = await fx.inTransaction((tx) =>
      appendReportIfChanged(
        tx,
        fx.organizationId,
        ticket.id,
        report(DIGEST_A),
        "manual",
      )
    );
    const taskOne = await insertBareTask(fx);
    const taskTwo = await insertBareTask(fx);
    const evidence = {
      version: 1 as const,
      origin: "manual" as const,
      labelBasis: "manual" as const,
      actingPrincipalId: fx.adminId,
      callerPrincipalId: fx.adminId,
      provenance: null,
      actorRole: null,
    };
    const insert = (
      tx: Parameters<typeof insertRequest>[0],
      linkId: string,
      generation: number,
    ) =>
      insertRequest(tx, {
        id: crypto.randomUUID(),
        organizationId: fx.organizationId,
        linkId,
        ticketId: ticket.id,
        intent: "start",
        generation,
        origin: "manual",
        authorityPrincipalId: fx.adminId,
        authorityEvidence: evidence,
        inboundEventRouteId: null,
        sourcePolicyRevision: 1,
        requirementsDigest: DIGEST_A,
        readinessReportId: stored.stored.id,
        pinnedPreset: PRESET,
      });

    const first = await fx.inTransaction(async (tx) => {
      assertEquals(await nextGeneration(tx, fx.organizationId, ticket.id), 1);
      const linkId = await insertPrimaryLink(tx, {
        organizationId: fx.organizationId,
        ticketId: ticket.id,
        taskId: taskOne,
      });
      await insert(tx, linkId, 1);
      const found = await findNonterminalRequest(
        tx,
        fx.organizationId,
        ticket.id,
      );
      assert(found);
      assertEquals(found.taskId, taskOne);
      assertEquals(found.disposition, "waiting");
      assertEquals(found.authorityEvidence.actingPrincipalId, fx.adminId);
      return found;
    });

    // A second nonterminal request raises the typed conflict, and the link it
    // created in the same transaction is gone with the rollback.
    const error = await assertRejects(() =>
      fx.inTransaction(async (tx) => {
        const linkId = await insertPrimaryLink(tx, {
          organizationId: fx.organizationId,
          ticketId: ticket.id,
          taskId: taskTwo,
        });
        await insert(tx, linkId, 2);
      })
    );
    assert(error instanceof StandardError);
    assertEquals(error.code, "STATE_CONFLICT");
    assertEquals(error.params?.reason, "ticket_request_exists");
    const links = await fx.owner.query(
      "select 1 from bakery.ticket_task_links where task_id = $1",
      [taskTwo],
    );
    assertEquals(links.rows.length, 0, "the link rolled back");

    // The request moves through the machine; an illegal move and a stale
    // version are refused before any write.
    const suspended = await fx.inTransaction((tx) =>
      updateRequest(tx, first, {
        disposition: "suspended",
        dispositionReason: "held",
        pauseRequestedAt: "now",
      })
    );
    assertEquals(
      [suspended.disposition, suspended.dispositionReason, suspended.version],
      ["suspended", "held", first.version + 1],
    );
    assert(suspended.pauseRequestedAt instanceof Date);
    const illegal = await assertRejects(() =>
      fx.inTransaction((tx) =>
        updateRequest(tx, suspended, { disposition: "pending" })
      )
    );
    assertEquals(
      (illegal as StandardError).params?.reason,
      "ticket_request_transition_illegal",
    );
    const stale = await assertRejects(() =>
      fx.inTransaction((tx) =>
        updateRequest(tx, first, { disposition: "completed" })
      )
    );
    assertEquals(
      (stale as StandardError).params?.reason,
      "ticket_request_changed",
    );

    // A terminal request frees the slot and the next generation numbers on.
    await fx.inTransaction((tx) =>
      updateRequest(tx, suspended, {
        disposition: "canceled",
        dispositionReason: null,
      })
    );
    await fx.inTransaction(async (tx) => {
      assertEquals(
        await findNonterminalRequest(tx, fx.organizationId, ticket.id),
        null,
      );
      assertEquals(await nextGeneration(tx, fx.organizationId, ticket.id), 2);
      const done = await requestById(tx, fx.organizationId, first.id);
      assertEquals(done?.disposition, "canceled");
    });
  }));

Deno.test("issue 82 store: an unconsumed plan approval on a task is seen until it is consumed, revoked or expired", () =>
  withTicketFixture(async (fx) => {
    const taskId = await insertBareTask(fx);
    const conversation = await fx.owner.query<{ conversation_id: string }>(
      "select conversation_id from bakery.tasks where id = $1",
      [taskId],
    );
    const approvalId = crypto.randomUUID();
    const seen = () =>
      fx.inTransaction((tx) =>
        taskHasUnconsumedApproval(tx, fx.organizationId, taskId)
      );
    try {
      assertEquals(await seen(), false);
      await fx.owner.query(
        `insert into bakery.questions (
           id, organization_id, kind, conversation_id, task_id, generation,
           prompt, status, subject_type
         ) values ($1, $2, 'approval', $3, $4, 1, 'Approve the plan', 'answered',
           'plan_revision')`,
        [
          approvalId,
          fx.organizationId,
          conversation.rows[0].conversation_id,
          taskId,
        ],
      );
      await fx.owner.query(
        "update bakery.questions set decision = 'approve' where id = $1",
        [approvalId],
      );
      assertEquals(await seen(), true);
      for (
        const [change, restore] of [
          ["consumed_at = now()", "consumed_at = null"],
          ["revoked_at = now()", "revoked_at = null"],
          ["expires_at = now() - interval '1 minute'", "expires_at = null"],
        ]
      ) {
        await fx.owner.query(
          `update bakery.questions set ${change} where id = $1`,
          [approvalId],
        );
        assertEquals(await seen(), false, change);
        await fx.owner.query(
          `update bakery.questions set ${restore} where id = $1`,
          [approvalId],
        );
      }
      assertEquals(await seen(), true);
    } finally {
      await fx.owner.query("delete from bakery.questions where id = $1", [
        approvalId,
      ]);
    }
  }));
