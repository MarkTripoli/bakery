/**
 * Issue 82 integration lane: admission on real Postgres. Transactions run as
 * the application role; the reader is in memory and the fake GitHub only
 * backs the connection rows. Each case names the acceptance criterion or the
 * guard it proves.
 */
import { assert, assertEquals, assertFalse, assertRejects } from "@std/assert";
import { StandardError } from "../../../packages/contracts/src/http.ts";
import type { TicketReadinessReport } from "../../../packages/contracts/src/ticket-admission.ts";
import {
  prefetchTicketReads,
  TicketPrefetchRequiredError,
} from "../../../apps/server/src/modules/work/ticket-prefetch.ts";
import { readSourceHandle } from "../../../apps/server/src/modules/work/ticket-store.ts";
import { rolePermissions } from "../../../apps/server/src/modules/auth/application/permissions.ts";
import { admitTicket } from "../../../apps/server/src/modules/work/ticket-admission.ts";
import {
  normalizeSnapshot,
  requirementsDigest,
} from "../../../apps/server/src/modules/work/ticket-snapshot.ts";
import {
  ACCEPTANCE_BODY,
  AFTER_SINCE,
  automaticPolicy,
  BEFORE_SINCE,
  EXECUTE_LABEL,
  HOLD_LABEL,
  insertBareTask,
  LABELER_ID,
  LABELER_LOGIN,
  PLAN_LABEL,
  seedLabeler,
  SINCE,
  type TicketFixture,
  UNAVAILABLE,
  watchTransactions,
  withTicketFixture,
} from "./fixtures.ts";

function checkOf(report: TicketReadinessReport, id: string) {
  const check = report.checks.find((candidate) => candidate.id === id);
  assert(check, `report has a ${id} check`);
  return check;
}

async function taskOf(fx: TicketFixture, taskId: string) {
  const result = await fx.owner.query<{
    title: string;
    description: string;
    planning_only: boolean;
    status: string;
    current_run_id: string | null;
    approval_policy: { plan: string } | null;
  }>(
    `select title, description, planning_only, status, current_run_id,
            approval_policy
       from bakery.tasks where organization_id = $1 and id = $2`,
    [fx.organizationId, taskId],
  );
  return result.rows[0];
}

async function taskConversation(fx: TicketFixture, taskId: string) {
  const result = await fx.owner.query<{ conversation_id: string }>(
    "select conversation_id from bakery.tasks where organization_id = $1 and id = $2",
    [fx.organizationId, taskId],
  );
  return result.rows[0].conversation_id;
}

async function requestRow(fx: TicketFixture, requestId: string) {
  const result = await fx.owner.query<{
    disposition: string;
    disposition_reason: string | null;
    intent: string;
    generation: number;
    workflow_run_id: string | null;
    requirements_digest: string;
    source_policy_revision: number;
    origin: string;
    version: number;
    authority_evidence: { labelBasis: string; actingPrincipalId: string };
  }>(
    `select disposition, disposition_reason, intent, generation,
            workflow_run_id, requirements_digest, source_policy_revision,
            origin, version, authority_evidence
       from bakery.ticket_requests where organization_id = $1 and id = $2`,
    [fx.organizationId, requestId],
  );
  return result.rows[0];
}

async function reportCount(fx: TicketFixture, sourceId: string) {
  return (await fx.counts(sourceId)).reports;
}

Deno.test("issue 82 admission AC1: six mixed origins for one issue converge on one request, task, link and run", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    fx.reader.setIssue({ number: 7, labels: [EXECUTE_LABEL] });
    fx.reader.setLabelApplied(7, EXECUTE_LABEL, { appliedAt: AFTER_SINCE });
    seedLabeler(fx);
    const deps = fx.automationDeps();

    const results = await Promise.all([
      fx.admit(sourceId, {
        number: 7,
        origin: "manual",
        intent: "start",
        deps,
      }),
      fx.admit(sourceId, { number: 7, origin: "webhook", deps }),
      fx.admit(sourceId, { number: 7, origin: "poll", deps }),
      fx.admit(sourceId, { number: 7, origin: "poll", deps }),
      fx.admit(sourceId, { number: 7, origin: "webhook", deps }),
      fx.admit(sourceId, {
        number: 7,
        origin: "manual",
        intent: "start",
        deps,
      }),
    ]);

    assertEquals(results.filter((r) => r.kind === "admitted").length, 1);
    assertEquals(results.filter((r) => r.kind === "existing").length, 5);
    const winner = results.find((r) => r.kind === "admitted")!.request!;
    for (const result of results) assertEquals(result.request?.id, winner.id);
    const counts = await fx.counts(sourceId);
    assert(counts.reports >= 1, "the verdict is stored as a report");
    assertEquals(counts, {
      tickets: 1,
      reports: counts.reports,
      links: 1,
      requests: 1,
      nonterminalRequests: 1,
      tasks: 1,
      conversations: 1,
      runs: 1,
    });
    assertEquals(winner.disposition, "admitted");
    const facts = await fx.requestFacts(winner.id);
    assertEquals(facts.audit, ["ticketRequests.create"], "audit once");
    assertEquals(facts.events.length, 1, "domain event once");
    assertEquals(facts.outbox, 0, "ticket.request.updated has no outbox row");
    assertEquals(facts.events[0], {
      resourceId: winner.id,
      resourceVersion: (await requestRow(fx, winner.id)).version,
    });

    // Replay after commit returns the request that exists.
    const replay = await fx.admit(sourceId, {
      number: 7,
      origin: "manual",
      intent: "start",
    });
    assertEquals(replay.kind, "existing");
    assertEquals(replay.request?.id, winner.id);
    assertEquals((await fx.counts(sourceId)).tasks, 1);
  }));

Deno.test("issue 82 admission: no provider read happens while an admission transaction is open", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    seedLabeler(fx);
    // One admission at a time, so any open transaction on the watched pool is
    // this admission's own. Every automatic origin reads the issue, links,
    // proofs, label provenance and actor role, and every read must find the
    // pool without an open transaction.
    const watch = watchTransactions(fx.runtime);
    const readsInTransaction: string[] = [];
    fx.reader.onCall = (call) => {
      if (watch.open() > 0) readsInTransaction.push(call.method);
    };
    const blocker = {
      id: "5101",
      number: 3,
      repositoryFullName: fx.repositoryFullName,
    };
    let number = 130;
    for (const origin of ["webhook", "poll", "manual"] as const) {
      number += 1;
      fx.reader.setIssue({ number, labels: [EXECUTE_LABEL] });
      fx.reader.setLabelApplied(number, EXECUTE_LABEL, {
        appliedAt: AFTER_SINCE,
      });
      fx.reader.setLinks(number, { blockedBy: [blocker] });
      fx.reader.setProof(blocker.id, {
        kind: "satisfied",
        pullRequestNumber: 4,
        mergeSha: "b".repeat(40),
        mergedAt: AFTER_SINCE,
      });
      fx.reader.clearCalls();
      const result = await fx.admit(sourceId, {
        number,
        origin,
        intent: origin === "manual" ? "start" : null,
        deps: fx.automationDeps(watch.database),
      });
      assertEquals(result.kind, "admitted", origin);
      assert(watch.peak() >= 1, "the watch saw the admission transaction");
      assert(fx.reader.calls.length >= 3, `${origin} read the provider`);
      assertEquals(
        readsInTransaction,
        [],
        `${origin}: no read inside a transaction`,
      );
      assertEquals(watch.open(), 0);
    }
    assert(
      fx.reader.callsOf("readLabelProvenance").length === 0,
      "manual reads no provenance",
    );
  }));

Deno.test("issue 82 admission AC1: a second generation waits for the first to end, and a second nonterminal row is refused by the index", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource({ policy: fx.policy() });
    fx.reader.setIssue({ number: 8, labels: [EXECUTE_LABEL] });
    const first = await fx.admit(sourceId, { number: 8, intent: "start" });
    assertEquals(first.kind, "admitted");
    const again = await fx.admit(sourceId, { number: 8, intent: "start" });
    assertEquals(again.kind, "existing");
    assertEquals(again.request?.id, first.request?.id);
    assertEquals((await fx.counts(sourceId)).requests, 1);

    // The database floor: a second nonterminal request for the ticket raises 23505.
    const taskId = await insertBareTask(fx);
    const link = await fx.owner.query<{ id: string }>(
      `insert into bakery.ticket_task_links (
         id, organization_id, external_ticket_id, task_id, role
       ) values (gen_random_uuid(), $1, $2, $3, 'primary') returning id`,
      [fx.organizationId, first.ticketId, taskId],
    );
    const raw = await fx.owner.query<{ evidence: unknown; preset: unknown }>(
      `select authority_evidence as evidence, pinned_preset as preset
         from bakery.ticket_requests where id = $1`,
      [first.request!.id],
    ).then((r) => r.rows[0]);
    const error = await fx.owner.query(
      `insert into bakery.ticket_requests (
         id, organization_id, ticket_task_link_id, external_ticket_id, intent,
         generation, origin, authority_evidence, source_policy_revision,
         requirements_digest, pinned_preset, disposition
       ) values (gen_random_uuid(), $1, $2, $3, 'plan', 2, 'manual', $4::jsonb,
         1, 'x', $5::jsonb, 'waiting')`,
      [
        fx.organizationId,
        link.rows[0].id,
        first.ticketId,
        JSON.stringify(raw.evidence),
        JSON.stringify(raw.preset),
      ],
    ).then(
      () => null,
      (e: unknown) => e as { code?: string; constraint?: string },
    );
    assertEquals(error?.code, "23505");
    assertEquals(error?.constraint, "ticket_requests_one_nonterminal_idx");

    // After the first generation ends, a new one is admitted with a new task.
    await fx.finishRequests(sourceId, "completed");
    const second = await fx.admit(sourceId, { number: 8, intent: "start" });
    assertEquals(second.kind, "admitted");
    assertEquals(second.request?.generation, 2);
    assert(second.request!.id !== first.request!.id);
    assert(second.request!.taskId !== first.request!.taskId);
    const counts = await fx.counts(sourceId);
    assertEquals(
      [counts.requests, counts.nonterminalRequests, counts.runs],
      [2, 1, 2],
    );
  }));

Deno.test("issue 82 admission AC1: a forced unique violation rolls back the task, conversation, link and report", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource({ policy: fx.policy() });
    fx.reader.setIssue({ number: 9, labels: [EXECUTE_LABEL] });
    const prefetch = await prefetchOf(fx, sourceId, 9);
    const admin = await fx.actor(fx.adminId);
    const insertPattern = /insert into bakery\.ticket_requests/;
    let injected = false;
    const error = await assertRejects(() =>
      fx.inTransaction(async (transaction) => {
        // Just before the real request insert, put a second nonterminal request
        // for the same ticket into the same transaction, so the index refuses
        // the real one only after the task, link and report exist.
        const intercepting = {
          query: async (text: unknown, values?: unknown[]) => {
            if (
              !injected && typeof text === "string" && insertPattern.test(text)
            ) {
              injected = true;
              const copy = [...values!];
              copy[0] = crypto.randomUUID();
              copy[5] = (copy[5] as number) + 1;
              await transaction.query(text, copy);
            }
            return await transaction.query(text as string, values);
          },
        };
        await admitTicket(fx.operationDeps(intercepting as never), {
          organizationId: fx.organizationId,
          sourceId,
          number: 9,
          intent: "start",
          origin: "manual",
          caller: admin,
          prefetch,
          signal: new AbortController().signal,
        });
      })
    );
    assert(injected, "the unique violation was forced");
    assert(error instanceof StandardError);
    assertEquals(error.code, "STATE_CONFLICT");
    assertEquals(error.params?.reason, "ticket_request_exists");
    assertEquals(await fx.counts(sourceId), {
      tickets: 0,
      reports: 0,
      links: 0,
      requests: 0,
      nonterminalRequests: 0,
      tasks: 0,
      conversations: 0,
      runs: 0,
    });
    const orphans = await fx.owner.query(
      `select 1 from bakery.tasks where organization_id = $1 and title = 'Issue 9'`,
      [fx.organizationId],
    );
    assertEquals(orphans.rows.length, 0, "no orphan task");
  }));

async function prefetchOf(
  fx: TicketFixture,
  sourceId: string,
  number: number,
  origin: "manual" | "adoption" | "webhook" | "poll" = "manual",
) {
  const { source, handle } = await fx.inTransaction((transaction) =>
    readSourceHandle(transaction, fx.organizationId, sourceId)
  );
  return await prefetchTicketReads(
    fx.reader,
    handle,
    { number, policy: source.policy, origin },
    new AbortController().signal,
  );
}

Deno.test("issue 82 admission AC2: a prefetch writes nothing, and operation mode without answers throws instead of reading", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource({ policy: fx.policy() });
    fx.reader.setIssue({ number: 10, labels: [EXECUTE_LABEL] });
    const before = await fx.counts(sourceId);
    const prefetch = await prefetchOf(fx, sourceId, 10);
    assertEquals(prefetch.issue.kind, "present");
    assertEquals(
      await fx.counts(sourceId),
      before,
      "reader-only reads write nothing",
    );
    assertEquals(before.tickets, 0);

    fx.reader.clearCalls();
    const admin = await fx.actor(fx.adminId);
    const call = {
      organizationId: fx.organizationId,
      sourceId,
      number: 10,
      intent: "start" as const,
      origin: "manual" as const,
      caller: admin,
      prefetch: null,
      signal: new AbortController().signal,
    };
    const inOperation = await assertRejects(() =>
      fx.inTransaction((transaction) =>
        admitTicket(fx.operationDeps(transaction), call)
      )
    );
    assert(inOperation instanceof TicketPrefetchRequiredError);
    assertEquals(inOperation.reason, "TICKET_PREFETCH_REQUIRED");
    const noReads = await assertRejects(() =>
      admitTicket({ ...fx.automationDeps(), readsAllowed: false }, call)
    );
    assert(noReads instanceof TicketPrefetchRequiredError);
    assertEquals(fx.reader.calls, [], "no GitHub read was made");
    assertEquals(await fx.counts(sourceId), before);
  }));

Deno.test("issue 82 admission AC2: a plan intent creates a planning-only task and no run; start upgrades it only when asked", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource({
      policy: automaticPolicy(fx),
    });
    fx.reader.setIssue({ number: 11, labels: [PLAN_LABEL, EXECUTE_LABEL] });
    fx.reader.setLabelApplied(11, EXECUTE_LABEL, { appliedAt: AFTER_SINCE });
    seedLabeler(fx);
    const planned = await fx.admit(sourceId, { number: 11, intent: "plan" });
    assertEquals(planned.kind, "admitted");
    const request = planned.request!;
    assertEquals(request.intent, "plan");
    assertEquals(request.disposition, "waiting");
    assertEquals(request.workflowRunId, null);
    let task = await taskOf(fx, request.taskId);
    assertEquals(task.planning_only, true);
    assertEquals((await fx.counts(sourceId)).runs, 0);

    // An automatic origin that derives its intent from labels never upgrades.
    const poll = await fx.admit(sourceId, { number: 11, origin: "poll" });
    assertEquals(poll.kind, "existing");
    assertEquals(poll.request?.intent, "plan");
    assertEquals((await taskOf(fx, request.taskId)).planning_only, true);
    assertEquals((await fx.counts(sourceId)).runs, 0);

    // Only an explicit start intent upgrades, and then the run follows.
    const upgraded = await fx.admit(sourceId, {
      number: 11,
      origin: "manual",
      intent: "start",
    });
    assertEquals(upgraded.kind, "upgraded");
    assertEquals(upgraded.request?.intent, "start");
    assertEquals(upgraded.request?.disposition, "admitted");
    task = await taskOf(fx, request.taskId);
    assertEquals(task.planning_only, false);
    assert(task.current_run_id !== null);
    const counts = await fx.counts(sourceId);
    assertEquals([counts.requests, counts.tasks, counts.runs], [1, 1, 1]);
    assertEquals(
      (await fx.requestFacts(request.id)).audit,
      ["ticketRequests.create", "ticketRequests.upgrade"],
    );
  }));

Deno.test("issue 82 admission AC2: an automatic origin outside its window creates nothing and cannot upgrade a plan request", () =>
  withTicketFixture(async (fx) => {
    seedLabeler(fx);
    const cases: {
      name: string;
      policy: ReturnType<typeof automaticPolicy>;
      appliedAt: string;
      reason: string;
      check: string;
    }[] = [
      {
        name: "no delegation",
        policy: fx.policy({
          automatic: { enabled: true, since: SINCE },
        }),
        appliedAt: AFTER_SINCE,
        reason: "no_delegation",
        check: "authority_live",
      },
      {
        name: "automatic admission off",
        policy: fx.policy({
          delegation: true,
          automatic: { enabled: false, since: null },
        }),
        appliedAt: AFTER_SINCE,
        reason: "adoption_required",
        check: "intent_authorized",
      },
      {
        name: "label applied before since",
        policy: automaticPolicy(fx),
        appliedAt: BEFORE_SINCE,
        reason: "adoption_required",
        check: "intent_authorized",
      },
    ];
    let number = 20;
    for (const scenario of cases) {
      number += 1;
      const sourceId = await fx.insertSource({ policy: scenario.policy });
      fx.reader.setIssue({ number, labels: [EXECUTE_LABEL] });
      fx.reader.setLabelApplied(number, EXECUTE_LABEL, {
        appliedAt: scenario.appliedAt,
      });
      for (const origin of ["webhook", "poll"] as const) {
        const result = await fx.admit(sourceId, { number, origin });
        assertEquals(result.kind, "unadmitted", `${scenario.name} ${origin}`);
        assertEquals(result.request, null);
        assertEquals(
          checkOf(result.report, scenario.check).reason,
          scenario.reason,
        );
      }
      const counts = await fx.counts(sourceId);
      assertEquals(
        [counts.requests, counts.links, counts.tasks, counts.runs],
        [0, 0, 0, 0],
        scenario.name,
      );
      assertEquals(counts.tickets, 1, `${scenario.name} keeps the snapshot`);
      assert(counts.reports >= 1, `${scenario.name} appends a report`);
    }

    // The Phase 2 F1 case: an existing plan request, an explicit start from an
    // automatic origin, and the label applied before `since`: refused, unchanged.
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    number += 1;
    fx.reader.setIssue({ number, labels: [EXECUTE_LABEL] });
    fx.reader.setLabelApplied(number, EXECUTE_LABEL, {
      appliedAt: BEFORE_SINCE,
    });
    const planned = await fx.admit(sourceId, { number, intent: "plan" });
    assertEquals(planned.kind, "admitted");
    for (const origin of ["webhook", "poll"] as const) {
      const refused = await fx.admit(sourceId, {
        number,
        origin,
        intent: "start",
      });
      assertEquals(refused.kind, "unadmitted", origin);
      assertEquals(refused.request?.intent, "plan");
      assertEquals(
        checkOf(refused.report, "intent_authorized").reason,
        "adoption_required",
      );
    }
    assertEquals((await requestRow(fx, planned.request!.id)).intent, "plan");
    assertEquals(
      (await taskOf(fx, planned.request!.taskId)).planning_only,
      true,
    );
    assertEquals((await fx.counts(sourceId)).runs, 0);

    // Inside the window the same explicit ask upgrades.
    number += 1;
    fx.reader.setIssue({ number, labels: [EXECUTE_LABEL] });
    fx.reader.setLabelApplied(number, EXECUTE_LABEL, {
      appliedAt: AFTER_SINCE,
    });
    const inside = await fx.admit(sourceId, { number, intent: "plan" });
    assertEquals(inside.kind, "admitted");
    const upgraded = await fx.admit(sourceId, {
      number,
      origin: "poll",
      intent: "start",
    });
    assertEquals(upgraded.kind, "upgraded");
  }));

Deno.test("issue 82 admission: a duplicate is judged by the request's recorded origin and cannot flip a decision", () =>
  withTicketFixture(async (fx) => {
    // A manual request on a source with no delegation: a poll duplicate would
    // fail authority_live as a poll, but the request was admitted manually.
    const manualSource = await fx.insertSource({ policy: fx.policy() });
    fx.reader.setIssue({ number: 31, labels: [EXECUTE_LABEL] });
    const manual = await fx.admit(manualSource, {
      number: 31,
      intent: "start",
    });
    assertEquals(manual.kind, "admitted");
    const reports = await reportCount(fx, manualSource);
    for (const origin of ["poll", "webhook"] as const) {
      const duplicate = await fx.admit(manualSource, { number: 31, origin });
      assertEquals(duplicate.kind, "existing", origin);
      assertEquals(duplicate.request?.disposition, "admitted", origin);
    }
    const row = await requestRow(fx, manual.request!.id);
    assertEquals(row.disposition, "admitted");
    assertEquals(row.disposition_reason, null);
    assertEquals(row.authority_evidence.labelBasis, "manual");
    assertEquals(
      await reportCount(fx, manualSource),
      reports,
      "same basis stores no report",
    );

    // A webhook request: a manual caller cannot supply label provenance, so a
    // manual duplicate judges nothing and changes nothing.
    const autoSource = await fx.insertSource({ policy: automaticPolicy(fx) });
    fx.reader.setIssue({ number: 32, labels: [EXECUTE_LABEL] });
    fx.reader.setLabelApplied(32, EXECUTE_LABEL, { appliedAt: AFTER_SINCE });
    seedLabeler(fx);
    const auto = await fx.admit(autoSource, { number: 32, origin: "webhook" });
    assertEquals(auto.kind, "admitted");
    assertEquals(auto.request?.authorityEvidence.labelBasis, "label");
    assertEquals(
      auto.request?.authorityEvidence.provenance?.actorId,
      LABELER_ID,
    );
    const autoReports = await reportCount(fx, autoSource);
    const manualDuplicate = await fx.admit(autoSource, {
      number: 32,
      intent: "start",
    });
    assertEquals(manualDuplicate.kind, "existing");
    assertEquals(manualDuplicate.request?.disposition, "admitted");
    assertEquals(await reportCount(fx, autoSource), autoReports);
  }));

Deno.test("issue 82 admission: authority is live — a caller without run:write throws, a lost delegation principal admits nothing", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    fx.reader.setIssue({ number: 41, labels: [EXECUTE_LABEL] });
    fx.reader.setLabelApplied(41, EXECUTE_LABEL, { appliedAt: AFTER_SINCE });
    seedLabeler(fx);

    // Demote the Developer to Viewer: neither a manual caller nor the
    // delegation principal holds task:write and run:write.
    await fx.owner.query(
      `update bakery.organization_memberships set role = 'viewer'
        where organization_id = $1 and principal_id = $2`,
      [fx.organizationId, fx.developerId],
    );
    const viewer = await fx.actor(fx.developerId);
    const denied = await assertRejects(() =>
      fx.admit(sourceId, { number: 41, intent: "start", caller: viewer })
    );
    assert(denied instanceof StandardError);
    assertEquals(denied.code, "AUTH_FORBIDDEN");
    assertEquals(
      (await fx.counts(sourceId)).tickets,
      0,
      "a refused caller writes nothing",
    );

    const lost = await fx.admit(sourceId, { number: 41, origin: "poll" });
    assertEquals(lost.kind, "unadmitted");
    assertEquals(
      checkOf(lost.report, "authority_live").reason,
      "principal_inactive",
    );
    assertEquals((await fx.counts(sourceId)).tasks, 0);

    // A deactivated principal is the same.
    await fx.owner.query(
      `update bakery.organization_memberships set role = 'developer'
        where organization_id = $1 and principal_id = $2`,
      [fx.organizationId, fx.developerId],
    );
    await fx.owner.query(
      "update bakery.principals set disabled_at = now() where id = $1",
      [fx.developerId],
    );
    const disabled = await fx.admit(sourceId, {
      number: 41,
      origin: "webhook",
    });
    assertEquals(disabled.kind, "unadmitted");
    assertEquals(
      checkOf(disabled.report, "authority_live").reason,
      "principal_inactive",
    );
    await fx.owner.query(
      "update bakery.principals set disabled_at = null where id = $1",
      [fx.developerId],
    );

    // Restored authority admits, and the labelling actor's allowlist and role are checked.
    fx.reader.setRole(LABELER_LOGIN, {
      kind: "present",
      userId: LABELER_ID,
      permission: "read",
    });
    const weak = await fx.admit(sourceId, { number: 41, origin: "poll" });
    assertEquals(
      checkOf(weak.report, "authority_live").reason,
      "actor_role_insufficient",
    );
    fx.reader.setLabelApplied(41, EXECUTE_LABEL, {
      actorId: "999",
      appliedAt: AFTER_SINCE,
    });
    const stranger = await fx.admit(sourceId, { number: 41, origin: "poll" });
    assertEquals(
      checkOf(stranger.report, "authority_live").reason,
      "actor_not_allowlisted",
    );
    assertEquals((await fx.counts(sourceId)).tasks, 0);
    fx.reader.setLabelApplied(41, EXECUTE_LABEL, { appliedAt: AFTER_SINCE });
    seedLabeler(fx);
    const ok = await fx.admit(sourceId, { number: 41, origin: "poll" });
    assertEquals(ok.kind, "admitted");
    assertEquals(ok.request?.authorityPrincipalId, fx.developerId);
    assertEquals(
      ok.request?.authorityEvidence.actingPrincipalId,
      fx.developerId,
    );
  }));

Deno.test("issue 82 admission: the live actor must hold task:write and run:write each — a custom role with one of them admits nothing and its caller is refused", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    seedLabeler(fx);
    // No system role holds exactly one of the pair; a custom role on a guest
    // membership carries any set of permissions.
    const roleId = crypto.randomUUID();
    await fx.owner.query(
      `insert into bakery.organization_roles (
         id, organization_id, key, name, permissions, created_by_principal_id
       ) values ($1, $2, 'split', 'Split', $3::text[], $4)`,
      [roleId, fx.organizationId, rolePermissions.developer, fx.adminId],
    );
    await fx.owner.query(
      `update bakery.organization_memberships
          set role = 'guest', custom_role_id = $3
        where organization_id = $1 and principal_id = $2`,
      [fx.organizationId, fx.developerId, roleId],
    );
    const hold = (permissions: readonly string[]) =>
      fx.owner.query(
        `update bakery.organization_roles set permissions = $3::text[]
          where organization_id = $1 and id = $2`,
        [fx.organizationId, roleId, permissions],
      );
    const issue = (number: number) => {
      fx.reader.setIssue({ number, labels: [EXECUTE_LABEL] });
      fx.reader.setLabelApplied(number, EXECUTE_LABEL, {
        appliedAt: AFTER_SINCE,
      });
    };

    issue(61);
    const both = await fx.admit(sourceId, { number: 61, origin: "poll" });
    assertEquals(
      both.kind,
      "admitted",
      "the pair through a custom role admits",
    );

    for (const [number, missing] of [[62, "run:write"], [63, "task:write"]]) {
      await hold(rolePermissions.developer.filter((key) => key !== missing));
      issue(number as number);
      const lost = await fx.admit(sourceId, {
        number: number as number,
        origin: "poll",
      });
      assertEquals(lost.kind, "unadmitted", `without ${missing}`);
      assertEquals(
        checkOf(lost.report, "authority_live").reason,
        "principal_inactive",
        missing as string,
      );
      const denied = await assertRejects(
        async () =>
          await fx.admit(sourceId, {
            number: number as number,
            intent: "start",
            caller: await fx.actor(fx.developerId),
          }),
      );
      assert(denied instanceof StandardError, `without ${missing}`);
      assertEquals(denied.code, "AUTH_FORBIDDEN", `without ${missing}`);
    }
    const counts = await fx.counts(sourceId);
    assertEquals([counts.tasks, counts.requests], [1, 1]);
  }));

Deno.test("issue 82 admission: source authority is read under locks — a deselected repository or disabled source admits nothing", () =>
  withTicketFixture(async (fx) => {
    const disabled = await fx.insertSource({
      policy: fx.policy(),
      enabled: false,
    });
    fx.reader.setIssue({ number: 51, labels: [EXECUTE_LABEL] });
    const refused = await fx.admit(disabled, { number: 51, intent: "start" });
    assertEquals(refused.kind, "unadmitted");
    assertEquals(
      checkOf(refused.report, "source_live").reason,
      "source_disabled",
    );

    const sourceId = await fx.insertSource({ policy: fx.policy() });
    await fx.owner.query(
      "update bakery.integration_resources set selected = false where id = $1",
      [fx.resource.id],
    );
    const deselected = await fx.admit(sourceId, {
      number: 51,
      intent: "start",
    });
    assertEquals(deselected.kind, "unadmitted");
    assertEquals(
      checkOf(deselected.report, "source_live").reason,
      "resource_not_selected",
    );
    await fx.owner.query(
      "update bakery.integration_resources set selected = true where id = $1",
      [fx.resource.id],
    );
    for (const id of [disabled, sourceId]) {
      const counts = await fx.counts(id);
      assertEquals([counts.requests, counts.tasks, counts.runs], [0, 0, 0]);
    }
    const ready = await fx.admit(sourceId, { number: 51, intent: "start" });
    assertEquals(ready.kind, "admitted");
  }));

Deno.test("issue 82 admission: readiness inputs flow through — hold, closed, blockers, provider outage", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource({ policy: fx.policy() });
    const reasonOf = async (number: number, id: string) => {
      const result = await fx.admit(sourceId, { number, intent: "start" });
      assertEquals(result.kind, "unadmitted", `issue ${number}`);
      return checkOf(result.report, id).reason;
    };
    fx.reader.setIssue({ number: 61, labels: [EXECUTE_LABEL, HOLD_LABEL] });
    assertEquals(await reasonOf(61, "not_held"), "held");
    fx.reader.setIssue({
      number: 62,
      labels: [EXECUTE_LABEL],
      state: "closed",
      stateReason: "completed",
    });
    assertEquals(await reasonOf(62, "ticket_supported"), "ticket_closed");
    fx.reader.setIssue({
      number: 63,
      labels: [EXECUTE_LABEL],
      body: "No criteria here.",
    });
    assertEquals(
      await reasonOf(63, "acceptance_present"),
      "acceptance_missing",
    );
    const blocker = {
      id: "5001",
      number: 1,
      repositoryFullName: fx.repositoryFullName,
    };
    fx.reader.setIssue({ number: 64, labels: [EXECUTE_LABEL] });
    fx.reader.setLinks(64, { blockedBy: [blocker] });
    fx.reader.setProof(blocker.id, { kind: "open" });
    assertEquals(
      await reasonOf(64, "dependencies_satisfied"),
      "predecessor_open",
    );
    fx.reader.setIssue({ number: 65, labels: [EXECUTE_LABEL] });
    fx.reader.failNext("readIssue");
    const outage = await fx.admit(sourceId, { number: 65, intent: "start" });
    assertEquals(outage.kind, "unadmitted");
    assertEquals(
      outage.ticketId,
      null,
      "an unread, unseen issue has no ticket row",
    );
    assertEquals(
      checkOf(outage.report, "ticket_supported").reason,
      "provider_unavailable",
    );

    // Once the blocker is merged the same ticket admits, with its dependency digest in the report.
    fx.reader.setProof(blocker.id, {
      kind: "satisfied",
      pullRequestNumber: 9,
      mergeSha: "a".repeat(40),
      mergedAt: "2026-07-01T00:00:00Z",
    });
    const merged = await fx.admit(sourceId, { number: 64, intent: "start" });
    assertEquals(merged.kind, "admitted");
    assert(merged.report.dependencyDigest !== null);
    const task = await taskOf(fx, merged.request!.taskId);
    assertEquals(task.title, "Issue 64");
    assert(task.description.startsWith("Make the upload retry."));
    assert(task.description.endsWith(`GitHub: ${fx.repositoryFullName}#64`));
    assertEquals(task.approval_policy, { plan: "automatic" });
  }));

Deno.test("issue 82 admission: a human plan approval leaves a start request waiting with no run", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource({
      policy: fx.policy({ approval: "human_approval" }),
    });
    fx.reader.setIssue({ number: 71, labels: [EXECUTE_LABEL] });
    const result = await fx.admit(sourceId, { number: 71, intent: "start" });
    assertEquals(result.kind, "admitted");
    assertEquals(result.request?.disposition, "waiting");
    assertEquals(result.request?.workflowRunId, null);
    const task = await taskOf(fx, result.request!.taskId);
    assertEquals(task.approval_policy, { plan: "human_approval" });
    assertEquals((await fx.counts(sourceId)).runs, 0);
  }));

Deno.test("issue 82 admission CAS: an older provider read acts on nothing and never overwrites a newer snapshot", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource({ policy: fx.policy() });
    fx.reader.setIssue({
      number: 81,
      labels: [EXECUTE_LABEL],
      updatedAt: "2026-07-02T00:00:00Z",
      title: "Newer title",
    });
    const newer = await fx.admit(sourceId, { number: 81, intent: "start" });
    assertEquals(newer.kind, "admitted");
    const storedBefore = await fx.owner.query<
      { snapshot: { title: string }; marker: string }
    >(
      `select snapshot, provider_update_marker as marker
         from bakery.external_tickets where id = $1`,
      [newer.ticketId],
    );
    fx.reader.setIssue({
      number: 81,
      labels: [EXECUTE_LABEL, HOLD_LABEL],
      updatedAt: "2026-07-01T00:00:00Z",
      title: "Older title",
    });
    const error = await assertRejects(() =>
      fx.admit(sourceId, { number: 81, intent: "start" })
    );
    assert(error instanceof StandardError);
    assertEquals(error.params?.reason, "ticket_read_stale");
    const storedAfter = await fx.owner.query<
      { snapshot: { title: string }; marker: string }
    >(
      `select snapshot, provider_update_marker as marker
         from bakery.external_tickets where id = $1`,
      [newer.ticketId],
    );
    assertEquals(storedAfter.rows[0], storedBefore.rows[0]);
    assertEquals(storedAfter.rows[0].snapshot.title, "Newer title");
    assertEquals(
      (await requestRow(fx, newer.request!.id)).disposition,
      "admitted",
    );
  }));

Deno.test("issue 82 admission digest basis: an unchanged basis stores no report, a changed one stores the next and keeps the old", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource({ policy: fx.policy() });
    fx.reader.setIssue({ number: 91, labels: [EXECUTE_LABEL] });
    const first = await fx.admit(sourceId, { number: 91, intent: "start" });
    assertEquals(first.kind, "admitted");
    assertEquals(first.storedReport?.sequence, 1);
    assertEquals(await reportCount(fx, sourceId), 1);
    const replay = await fx.admit(sourceId, { number: 91, intent: "start" });
    assertEquals(replay.kind, "existing");
    assertEquals(replay.storedReport?.id, first.storedReport?.id);
    assertEquals(
      await reportCount(fx, sourceId),
      1,
      "the same basis appends nothing",
    );

    // A label that does not move the verdict or the requirements (an unrelated
    // label) changes no basis: the check outcomes are the same.
    fx.reader.setIssue({
      number: 91,
      labels: [EXECUTE_LABEL, "bug"],
      title: "Issue 91",
    });
    const relabeled = await fx.admit(sourceId, { number: 91, intent: "start" });
    assertEquals(relabeled.storedReport?.id, first.storedReport?.id);

    // A body edit changes the requirements digest: the duplicate suspends the
    // request with a new report, and the first report stays.
    fx.reader.setIssue({
      number: 91,
      labels: [EXECUTE_LABEL],
      body: `${ACCEPTANCE_BODY}- and it logs\n`,
    });
    const edited = await fx.admit(sourceId, { number: 91, intent: "start" });
    assertEquals(edited.kind, "existing");
    assertEquals(edited.request?.disposition, "suspended");
    assertEquals(edited.request?.dispositionReason, "acceptance_changed");
    assertEquals(edited.storedReport?.sequence, 2);
    const reports = await fx.owner.query<{ version: number; verdict: string }>(
      `select version, verdict from bakery.ticket_readiness_reports
        where external_ticket_id = $1 order by version`,
      [first.ticketId],
    );
    assertEquals(reports.rows.map((r) => [r.version, r.verdict]), [
      [1, "ready"],
      [2, "waiting"],
    ]);
    assertFalse(
      edited.report.requirementsDigest === first.report.requirementsDigest,
    );
  }));

Deno.test("issue 82 admission: an explicit call re-pins a suspended request without a run, and refuses with a run", () =>
  withTicketFixture(async (fx) => {
    // Without a run: a plan request.
    const sourceId = await fx.insertSource({ policy: fx.policy() });
    fx.reader.setIssue({ number: 101, labels: [EXECUTE_LABEL] });
    const planned = await fx.admit(sourceId, { number: 101, intent: "plan" });
    assertEquals(planned.kind, "admitted");
    const body = `${ACCEPTANCE_BODY}- and it logs\n`;
    fx.reader.setIssue({
      number: 101,
      labels: [EXECUTE_LABEL],
      body,
      title: "Retitled",
    });
    const suspended = await fx.admit(sourceId, { number: 101, intent: "plan" });
    assertEquals(suspended.request?.disposition, "suspended");
    const liveDigest = suspended.report.requirementsDigest;
    assert(liveDigest !== null);

    // No digest supplied: the explicit call re-evaluates and stays suspended.
    const stuck = await fx.admit(sourceId, { number: 101, intent: "plan" });
    assertEquals(stuck.request?.disposition, "suspended");
    // A digest that is not the live one (F12: the pin it saw is old) is
    // refused, not ignored, and the request stays suspended.
    const stale = await assertRejects(() =>
      fx.admit(sourceId, {
        number: 101,
        intent: "plan",
        requirementsDigest: planned.request!.requirementsDigest,
      })
    );
    assert(stale instanceof StandardError);
    assertEquals(stale.code, "PRECONDITION_FAILED");
    assertEquals(stale.params?.reason, "requirements_changed");
    assertEquals(
      (await requestRow(fx, planned.request!.id)).disposition,
      "suspended",
    );

    // An unconsumed plan approval was made for the old text: re-pinning would
    // start a run against the new text, so it is refused until the approval
    // is gone (only a person may revoke one).
    const taskId = planned.request!.taskId;
    const approvalId = crypto.randomUUID();
    const conversation = await taskConversation(fx, taskId);
    await fx.owner.query(
      `insert into bakery.questions (
         id, organization_id, kind, conversation_id, task_id, generation,
         prompt, status, subject_type, decision
       ) values ($1, $2, 'approval', $3, $4, 1, 'Approve the plan', 'answered',
         'plan_revision', 'approve')`,
      [approvalId, fx.organizationId, conversation, taskId],
    );
    try {
      const approved = await assertRejects(() =>
        fx.admit(sourceId, {
          number: 101,
          intent: "plan",
          requirementsDigest: liveDigest,
        })
      );
      assert(approved instanceof StandardError);
      assertEquals(approved.params?.reason, "ticket_request_has_approval");
      assertEquals(
        (await requestRow(fx, planned.request!.id)).disposition,
        "suspended",
      );
    } finally {
      await fx.owner.query("delete from bakery.questions where id = $1", [
        approvalId,
      ]);
    }

    const repinned = await fx.admit(sourceId, {
      number: 101,
      intent: "plan",
      requirementsDigest: liveDigest,
    });
    assertEquals(repinned.kind, "repinned");
    assertEquals(repinned.request?.disposition, "waiting");
    assertEquals(repinned.request?.dispositionReason, null);
    assertEquals(repinned.request?.requirementsDigest, liveDigest);
    assertEquals(
      repinned.request?.readinessReportId,
      repinned.storedReport?.id,
    );
    const task = await taskOf(fx, planned.request!.taskId);
    assertEquals(task.title, "Retitled");
    assert(task.description.includes("and it logs"));
    assertEquals(
      (await fx.requestFacts(planned.request!.id)).audit,
      [
        "ticketRequests.create",
        "ticketRequests.suspend",
        "ticketRequests.repin",
      ],
    );

    // With a run: a start request cannot be re-pinned.
    fx.reader.setIssue({ number: 102, labels: [EXECUTE_LABEL] });
    const started = await fx.admit(sourceId, { number: 102, intent: "start" });
    assertEquals(started.request?.disposition, "admitted");
    fx.reader.setIssue({ number: 102, labels: [EXECUTE_LABEL], body });
    const held = await fx.admit(sourceId, { number: 102, intent: "start" });
    assertEquals(held.request?.disposition, "suspended");
    const error = await assertRejects(() =>
      fx.admit(sourceId, {
        number: 102,
        intent: "start",
        requirementsDigest: held.report.requirementsDigest,
      })
    );
    assert(error instanceof StandardError);
    assertEquals(error.code, "STATE_CONFLICT");
    assertEquals(error.params?.reason, "ticket_request_has_run");
    const row = await requestRow(fx, started.request!.id);
    assertEquals(row.disposition, "suspended");
    assertEquals(row.requirements_digest, started.request!.requirementsDigest);
  }));

Deno.test("issue 82 admission: an explicit call resumes a request suspended for a reason that cleared", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource({ policy: fx.policy() });
    fx.reader.setIssue({ number: 111, labels: [EXECUTE_LABEL] });
    const admitted = await fx.admit(sourceId, { number: 111, intent: "start" });
    assertEquals(admitted.request?.disposition, "admitted");
    // Closing the issue suspends with an explicit-resume reason.
    fx.reader.setIssue({
      number: 111,
      labels: [EXECUTE_LABEL],
      state: "closed",
      stateReason: "completed",
    });
    const closed = await fx.admit(sourceId, { number: 111, intent: "start" });
    assertEquals(closed.request?.disposition, "suspended");
    assertEquals(closed.request?.dispositionReason, "ticket_closed");
    // The issue is reopened; an automatic origin does not resume it ...
    fx.reader.setIssue({ number: 111, labels: [EXECUTE_LABEL] });
    const poll = await fx.admit(sourceId, { number: 111, origin: "poll" });
    assertEquals(poll.request?.disposition, "suspended");
    // ... a person's explicit call does, back to the queued state of its run.
    const resumed = await fx.admit(sourceId, { number: 111, intent: "start" });
    assertEquals(resumed.kind, "existing");
    assertEquals(resumed.request?.disposition, "admitted");
    assertEquals(resumed.request?.dispositionReason, null);
    assertEquals(
      (await fx.requestFacts(admitted.request!.id)).audit,
      [
        "ticketRequests.create",
        "ticketRequests.suspend",
        "ticketRequests.resume",
      ],
    );
  }));

Deno.test("issue 82 admission: an explicit call on a request admitted on a label resumes it only while the label stands, so the resume outlives the next poll", () =>
  withTicketFixture(async (fx) => {
    seedLabeler(fx);
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    fx.reader.setIssue({ number: 113, labels: [EXECUTE_LABEL] });
    fx.reader.setLabelApplied(113, EXECUTE_LABEL, { appliedAt: AFTER_SINCE });
    const admitted = await fx.admit(sourceId, {
      number: 113,
      origin: "webhook",
    });
    assertEquals(admitted.request?.origin, "webhook");
    const requestId = admitted.request!.id;
    fx.reader.setIssue({ number: 113, labels: [] });
    const suspended = await fx.recheck(admitted.ticketId!);
    assertEquals(suspended.request?.dispositionReason, "label_withdrawn");

    // Without the label a person's call is refused: nothing but a report is
    // written, so the poll that follows has nothing to undo.
    const refused = await fx.admit(sourceId, { number: 113, intent: "start" });
    assertEquals(refused.request?.disposition, "suspended");
    assertEquals(refused.request?.dispositionReason, "label_withdrawn");
    assertEquals(
      checkOf(refused.report, "intent_authorized").reason,
      "label_withdrawn",
    );
    assertEquals((await fx.recheck(admitted.ticketId!)).applied, []);

    // With the label back the call resumes the request and the poll keeps it.
    fx.reader.setIssue({ number: 113, labels: [EXECUTE_LABEL] });
    const resumed = await fx.admit(sourceId, { number: 113, intent: "start" });
    assertEquals(resumed.request?.disposition, "admitted");
    assertEquals(resumed.request?.dispositionReason, null);
    assertEquals(
      resumed.request?.origin,
      "webhook",
      "the request keeps its origin",
    );
    const poll = await fx.recheck(admitted.ticketId!);
    assertEquals(poll.applied, []);
    assertEquals(poll.request?.disposition, "admitted");
    assertEquals((await fx.requestFacts(requestId)).audit, [
      "ticketRequests.create",
      "ticketRequests.suspend",
      "ticketRequests.resume",
    ]);
  }));

Deno.test("issue 82 admission: provider outage during an automation prefetch writes nothing and a prefetch outage reaches the report", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource({ policy: fx.policy() });
    fx.reader.setIssue({ number: 121, labels: [EXECUTE_LABEL] });
    fx.reader.failNext("readLinks", UNAVAILABLE);
    const outage = await fx.admit(sourceId, { number: 121, intent: "start" });
    assertEquals(outage.kind, "unadmitted");
    assertEquals(
      checkOf(outage.report, "epic_excluded").reason,
      "provider_unavailable",
    );
    const counts = await fx.counts(sourceId);
    assertEquals([counts.requests, counts.tasks, counts.runs], [0, 0, 0]);
    assertEquals(counts.tickets, 1);
    const recovered = await fx.admit(sourceId, {
      number: 121,
      intent: "start",
    });
    assertEquals(recovered.kind, "admitted");
  }));

Deno.test("issue 82 admission: an adoption rests on the label when the issue carries it, a manual request never does", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource({ policy: fx.policy() });
    const admin = fx.adminId;

    // The label is the authority of an adoption of a labeled issue; the
    // caller's live authority still admits it.
    fx.reader.setIssue({ number: 141, labels: [EXECUTE_LABEL] });
    const labeled = await fx.admit(sourceId, {
      number: 141,
      origin: "adoption",
      intent: null,
    });
    assertEquals(labeled.kind, "admitted");
    assertEquals(labeled.request?.origin, "adoption");
    assertEquals(labeled.request?.intent, "start");
    assertEquals(labeled.request?.authorityEvidence.labelBasis, "label");
    assertEquals(labeled.request?.authorityEvidence.callerPrincipalId, admin);
    assertEquals(labeled.request?.authorityEvidence.provenance, null);

    // An adoption of an unlabeled issue stands on the caller alone.
    fx.reader.setIssue({ number: 142, labels: [] });
    const unlabeled = await fx.admit(sourceId, {
      number: 142,
      origin: "adoption",
      intent: "plan",
    });
    assertEquals(unlabeled.kind, "admitted");
    assertEquals(unlabeled.request?.authorityEvidence.labelBasis, "manual");
    assertEquals(
      (await taskOf(fx, unlabeled.request!.taskId)).planning_only,
      true,
    );

    // No label to read an intent from and none given: nothing is written.
    fx.reader.setIssue({ number: 144, labels: [] });
    const missing = await assertRejects(() =>
      fx.admit(sourceId, { number: 144, origin: "adoption", intent: null })
    );
    assert(missing instanceof StandardError);
    assertEquals(missing.code, "UNPROCESSABLE");
    const manualMissing = await assertRejects(() =>
      fx.admit(sourceId, { number: 144, origin: "manual", intent: null })
    );
    assertEquals((manualMissing as StandardError).code, "UNPROCESSABLE");

    // Withdrawing the label suspends the label-based request and leaves a
    // manual one alone: each is judged by the basis it was admitted under.
    fx.reader.setIssue({ number: 143, labels: [EXECUTE_LABEL] });
    const manual = await fx.admit(sourceId, { number: 143, intent: "start" });
    assertEquals(manual.kind, "admitted");
    fx.reader.setIssue({ number: 141, labels: [] });
    fx.reader.setIssue({ number: 143, labels: [] });
    const withdrawn = await fx.admit(sourceId, {
      number: 141,
      origin: "adoption",
      intent: "start",
    });
    assertEquals(withdrawn.request?.disposition, "suspended");
    assertEquals(withdrawn.request?.dispositionReason, "label_withdrawn");
    const unaffected = await fx.admit(sourceId, {
      number: 143,
      intent: "start",
    });
    assertEquals(unaffected.kind, "existing");
    assertEquals(unaffected.request?.disposition, "admitted");
  }));

/** The digest of the issue as the reader answers it now, without writing anything. */
async function liveDigest(fx: TicketFixture, sourceId: string, number: number) {
  const prefetch = await prefetchOf(fx, sourceId, number);
  assert(prefetch.issue.kind === "present", "the issue is present");
  return await requirementsDigest(
    normalizeSnapshot(prefetch.issue.snapshot, {
      links: null,
      providerUpdatedAt: prefetch.issue.providerUpdatedAt,
    }),
  );
}

const EDITED_BODY = `${ACCEPTANCE_BODY}- and it logs\n`;

Deno.test("issue 82 admission 4b.0: a new admission refuses a digest that is not the live one and writes nothing; an equal one admits", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource({ policy: fx.policy() });
    // A held issue is seen (snapshot and report stored) but not admitted.
    fx.reader.setIssue({ number: 151, labels: [EXECUTE_LABEL, HOLD_LABEL] });
    const seen = await fx.admit(sourceId, { number: 151, intent: "start" });
    assertEquals(seen.kind, "unadmitted");
    const stale = seen.report.requirementsDigest!;
    const storedDigest = () =>
      fx.owner.query<{ requirements_digest: string }>(
        "select requirements_digest from bakery.external_tickets where id = $1",
        [seen.ticketId],
      ).then((r) => r.rows[0].requirements_digest);
    assertEquals(await storedDigest(), stale);

    // The issue is edited and released after the last webhook or poll: the
    // caller's digest equals the stored snapshot, not the live issue.
    fx.reader.setIssue({
      number: 151,
      labels: [EXECUTE_LABEL],
      body: EDITED_BODY,
    });
    const before = await fx.counts(sourceId);
    const refused = await assertRejects(() =>
      fx.admit(sourceId, {
        number: 151,
        intent: "start",
        requirementsDigest: stale,
      })
    );
    assert(refused instanceof StandardError);
    assertEquals(refused.code, "PRECONDITION_FAILED");
    assertEquals(refused.params?.reason, "requirements_changed");
    assertEquals(
      await fx.counts(sourceId),
      before,
      "no task, link, request, run or report; the snapshot upsert rolled back",
    );
    assertEquals(await storedDigest(), stale);

    // The client refreshes (a read that stores the live text) and asks again.
    const live = await liveDigest(fx, sourceId, 151);
    assert(live !== stale);
    const admitted = await fx.admit(sourceId, {
      number: 151,
      intent: "start",
      requirementsDigest: live,
    });
    assertEquals(admitted.kind, "admitted");
    assertEquals(admitted.request?.requirementsDigest, live);

    // A caller without a digest is unaffected.
    fx.reader.setIssue({ number: 152, labels: [EXECUTE_LABEL] });
    assertEquals(
      (await fx.admit(sourceId, { number: 152, intent: "plan" })).kind,
      "admitted",
    );
  }));

Deno.test("issue 82 admission F12: a plan request asked to start judges the pin against its own digest and refuses another", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource({ policy: fx.policy() });
    fx.reader.setIssue({ number: 161, labels: [EXECUTE_LABEL] });
    const planned = await fx.admit(sourceId, { number: 161, intent: "plan" });
    assertEquals(planned.kind, "admitted");
    const pin = planned.request!.requirementsDigest;
    assertEquals(pin, await liveDigest(fx, sourceId, 161));

    // Edited since it was pinned and not rechecked yet: the client read the new
    // text, so its digest is not the pin; the ask is refused and nothing starts.
    fx.reader.setIssue({
      number: 161,
      labels: [EXECUTE_LABEL],
      body: EDITED_BODY,
    });
    const live = await liveDigest(fx, sourceId, 161);
    assert(live !== pin);
    const refused = await assertRejects(() =>
      fx.admit(sourceId, {
        number: 161,
        intent: "start",
        requirementsDigest: live,
      })
    );
    assert(refused instanceof StandardError);
    assertEquals(refused.code, "PRECONDITION_FAILED");
    assertEquals(refused.params?.reason, "requirements_changed");

    // A client that still holds the pin is judged against the live text: not ready.
    for (const requirementsDigest of [pin, null]) {
      const unready = await fx.admit(sourceId, {
        number: 161,
        intent: "start",
        requirementsDigest,
      });
      assertEquals(unready.kind, "unadmitted");
      assertEquals(
        checkOf(unready.report, "requirements_unchanged").reason,
        "acceptance_changed",
      );
    }
    assertEquals(
      (await taskOf(fx, planned.request!.taskId)).planning_only,
      true,
    );
    assertEquals(
      (await requestRow(fx, planned.request!.id)).intent,
      "plan",
      "the request is unchanged",
    );
    assertEquals((await fx.counts(sourceId)).runs, 0);

    // The legitimate ask (the pin is the live digest) still upgrades.
    fx.reader.setIssue({ number: 162, labels: [EXECUTE_LABEL] });
    const second = await fx.admit(sourceId, { number: 162, intent: "plan" });
    const upgraded = await fx.admit(sourceId, {
      number: 162,
      intent: "start",
      requirementsDigest: second.request!.requirementsDigest,
    });
    assertEquals(upgraded.kind, "upgraded");
  }));

Deno.test("issue 82 admission F12: an explicit call on a suspended request refuses a digest that is not the live one and answers the request as is without one", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource({ policy: fx.policy() });
    fx.reader.setIssue({ number: 171, labels: [EXECUTE_LABEL] });
    const planned = await fx.admit(sourceId, { number: 171, intent: "plan" });
    fx.reader.setIssue({
      number: 171,
      labels: [EXECUTE_LABEL],
      body: EDITED_BODY,
    });
    const suspended = await fx.admit(sourceId, { number: 171, intent: "plan" });
    assertEquals(suspended.request?.dispositionReason, "acceptance_changed");
    const live = suspended.report.requirementsDigest!;
    const pin = planned.request!.requirementsDigest;
    assert(live !== pin);

    // Edited again after the client read `live`: its digest is stale.
    fx.reader.setIssue({
      number: 171,
      labels: [EXECUTE_LABEL],
      body: `${EDITED_BODY}- and it is documented\n`,
    });
    for (const stale of [live, pin]) {
      const refused = await assertRejects(() =>
        fx.admit(sourceId, {
          number: 171,
          intent: "plan",
          requirementsDigest: stale,
        })
      );
      assert(refused instanceof StandardError);
      assertEquals(refused.code, "PRECONDITION_FAILED");
      assertEquals(refused.params?.reason, "requirements_changed");
    }
    const asIs = await fx.admit(sourceId, { number: 171, intent: "plan" });
    assertEquals(asIs.kind, "existing");
    assertEquals(asIs.request?.disposition, "suspended");
    assertEquals(asIs.request?.requirementsDigest, pin, "not re-pinned");

    const current = await liveDigest(fx, sourceId, 171);
    const repinned = await fx.admit(sourceId, {
      number: 171,
      intent: "plan",
      requirementsDigest: current,
    });
    assertEquals(repinned.kind, "repinned");
    assertEquals(repinned.request?.requirementsDigest, current);
  }));

Deno.test("issue 82 admission F1: a duplicate with a digest that is not the pin is refused and changes nothing, on a manual or an automatic request", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource({ policy: fx.policy() });
    fx.reader.setIssue({ number: 181, labels: [EXECUTE_LABEL] });
    const first = await fx.admit(sourceId, { number: 181, intent: "plan" });
    assertEquals(first.kind, "admitted");
    const requestId = first.request!.id;
    const pin = first.request!.requirementsDigest;
    // Another issue's digest stands in for text the caller saw once.
    fx.reader.setIssue({
      number: 182,
      labels: [EXECUTE_LABEL],
      body: EDITED_BODY,
    });
    const other = await fx.admit(sourceId, { number: 182, intent: "plan" });
    const stale = other.request!.requirementsDigest;
    assert(stale !== pin);
    const stateOf = async (source: string, id: string) => ({
      request: await requestRow(fx, id),
      counts: await fx.counts(source),
      facts: await fx.requestFacts(id),
    });
    const state = () => stateOf(sourceId, requestId);
    const before = await state();
    assertEquals(before.request.disposition, "waiting");

    const refused = await assertRejects(() =>
      fx.admit(sourceId, {
        number: 181,
        intent: "plan",
        requirementsDigest: stale,
      })
    );
    assert(refused instanceof StandardError);
    assertEquals(refused.code, "PRECONDITION_FAILED");
    assertEquals(refused.params?.reason, "requirements_changed");
    assertEquals(
      await state(),
      before,
      "no suspension, report, version or audit",
    );

    // The pin itself, or no digest, is a plain duplicate.
    for (const requirementsDigest of [pin, null]) {
      const again = await fx.admit(sourceId, {
        number: 181,
        intent: "plan",
        requirementsDigest,
      });
      assertEquals(again.kind, "existing");
      assertEquals(again.request?.id, requestId);
    }
    assertEquals(await state(), before);

    // A webhook- or poll-admitted request is judged the same for a manual
    // caller: the pin check runs before the manual-on-automatic early return,
    // so a stale digest is refused rather than answered as unchanged.
    const autoSource = await fx.insertSource({ policy: automaticPolicy(fx) });
    seedLabeler(fx);
    for (
      const [number, origin] of [[183, "webhook"], [184, "poll"]] as const
    ) {
      fx.reader.setIssue({ number, labels: [EXECUTE_LABEL] });
      fx.reader.setLabelApplied(number, EXECUTE_LABEL, {
        appliedAt: AFTER_SINCE,
      });
      const auto = await fx.admit(autoSource, { number, origin });
      assertEquals(auto.kind, "admitted", origin);
      const autoPin = auto.request!.requirementsDigest;
      assert(stale !== autoPin);
      const autoBefore = await stateOf(autoSource, auto.request!.id);

      const staleCall = await assertRejects(() =>
        fx.admit(autoSource, {
          number,
          intent: "start",
          requirementsDigest: stale,
        })
      );
      assert(staleCall instanceof StandardError, origin);
      assertEquals(staleCall.code, "PRECONDITION_FAILED", origin);
      assertEquals(staleCall.params?.reason, "requirements_changed", origin);
      assertEquals(await stateOf(autoSource, auto.request!.id), autoBefore);

      for (const requirementsDigest of [autoPin, null]) {
        const again = await fx.admit(autoSource, {
          number,
          intent: "start",
          requirementsDigest,
        });
        assertEquals(again.kind, "existing", origin);
        assertEquals(again.request?.id, auto.request!.id, origin);
      }
      assertEquals(await stateOf(autoSource, auto.request!.id), autoBefore);
    }
  }));
