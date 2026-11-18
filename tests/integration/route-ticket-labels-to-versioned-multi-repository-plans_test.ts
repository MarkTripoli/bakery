/**
 * #31 [B09.05] Route ticket labels to versioned multi-repository plans, on real
 * Postgres with the in-memory provider reader. Each case names the acceptance
 * criterion (AC1 to AC3) or the guard it proves; #69 AC1 (an edit leaves the
 * pinned report and digest of an admitted request alone) is here too.
 */
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import type { TicketReadinessReport } from "../../packages/contracts/src/ticket-admission.ts";
import { recordReadiness } from "../../apps/server/src/modules/work/ticket-admission.ts";
import {
  cleanupSeededOrganizations,
  seedOrganization,
} from "../helpers/coordinator-turns.ts";
import {
  EXECUTE_LABEL,
  type TicketFixture,
  withTicketFixture,
} from "../helpers/ticket-admission/fixtures.ts";
import {
  type Problem,
  read,
  ticketCall,
} from "../helpers/ticket-admission/operations-http.ts";

const SOURCES = "/v1/ticket-sources";

type Rule = { labelId: string; repositoryId: string; role: string };
type RuleSet = {
  ticketSourceId: string;
  policyRevision: number;
  version: number;
  rules: (Rule & { id: string; version: number; presetId: string })[];
};
type Target = {
  repositoryId: string;
  role: string;
  routingRuleId: string | null;
  routingRuleVersion: number | null;
  sourcePolicyRevision: number;
};

/** A repository of `applicationId` (the fixture's by default), as the owner role. */
async function addRepository(
  fx: TicketFixture,
  name: string,
  applicationId = fx.applicationId,
): Promise<string> {
  const id = crypto.randomUUID();
  await fx.owner.query(
    `insert into bakery.repositories (
       id, organization_id, application_id, integration_connection_id,
       provider_repo_id, owner, name, default_branch
     ) values ($1, $2, $3, $4, $5, 'bakery', $6, 'main')`,
    [
      id,
      fx.organizationId,
      applicationId,
      fx.connectionId,
      `route-${id}`,
      name,
    ],
  );
  return id;
}

async function addApplication(fx: TicketFixture): Promise<string> {
  const id = crypto.randomUUID();
  await fx.owner.query(
    `insert into bakery.applications (id, organization_id, slug, name)
     values ($1, $2, $3, 'Other application')`,
    [id, fx.organizationId, `route-app-${id}`],
  );
  return id;
}

async function sourceVersion(fx: TicketFixture, sourceId: string) {
  const result = await fx.owner.query<
    { version: number; policy_revision: number }
  >(
    `select version, policy_revision from bakery.ticket_sources
      where organization_id = $1 and id = $2`,
    [fx.organizationId, sourceId],
  );
  return result.rows[0];
}

/** Replaces a source's rules over HTTP as the Admin; returns the response. */
async function putRules(
  fx: TicketFixture,
  sourceId: string,
  rules: Rule[],
  options: { ifMatch?: number | null; cookie?: string } = {},
): Promise<Response> {
  const ifMatch = options.ifMatch === undefined
    ? (await sourceVersion(fx, sourceId)).version
    : options.ifMatch;
  return await ticketCall(fx, "PUT", `${SOURCES}/${sourceId}/routing-rules`, {
    body: { rules },
    ...(ifMatch === null ? {} : { ifMatch }),
    ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
  });
}

async function targetsOf(fx: TicketFixture, requestId: string) {
  const result = await fx.owner.query<{
    repository_id: string;
    role: string;
    routing_rule_id: string | null;
    routing_rule_version: number | null;
    source_policy_revision: number;
  }>(
    `select repository_id, role, routing_rule_id, routing_rule_version,
            source_policy_revision
       from bakery.ticket_request_targets
      where organization_id = $1 and ticket_request_id = $2
      order by role, repository_id`,
    [fx.organizationId, requestId],
  );
  return result.rows;
}

function routeCheck(report: TicketReadinessReport) {
  const check = report.checks.find((entry) => entry.id === "repository_ready");
  assert(check, "the report has a repository_ready check");
  return check;
}

/** A source whose labels "backend" and "frontend" route to two repositories. */
async function routedSource(fx: TicketFixture) {
  const sourceId = await fx.insertSource();
  const backend = await addRepository(fx, "backend");
  const frontend = await addRepository(fx, "frontend");
  const set = await read<RuleSet>(
    await putRules(fx, sourceId, [
      { labelId: "backend", repositoryId: backend, role: "backend" },
      { labelId: "frontend", repositoryId: frontend, role: "frontend" },
    ]),
    200,
  );
  return { sourceId, backend, frontend, set };
}

Deno.test("#31 AC1: backend and frontend labels admit one parent request with two scoped children", () =>
  withTicketFixture(async (fx) => {
    const { sourceId, backend, frontend, set } = await routedSource(fx);
    assertEquals(set.policyRevision, 2, "saving rules advances the revision");
    fx.reader.setIssue({
      number: 1,
      labels: [EXECUTE_LABEL, "backend", "frontend"],
    });
    const result = await fx.admit(sourceId, { number: 1 });
    assertEquals(result.kind, "admitted");
    const request = result.request!;
    assertEquals(request.sourcePolicyRevision, 2);
    const rule = (labelId: string) =>
      set.rules.find((entry) => entry.labelId === labelId)!;
    assertEquals(
      await targetsOf(fx, request.id),
      [
        {
          repository_id: backend,
          role: "backend",
          routing_rule_id: rule("backend").id,
          routing_rule_version: 1,
          source_policy_revision: 2,
        },
        {
          repository_id: frontend,
          role: "frontend",
          routing_rule_id: rule("frontend").id,
          routing_rule_version: 1,
          source_policy_revision: 2,
        },
      ].sort((a, b) => a.role.localeCompare(b.role)),
    );
    // One parent: one request, one task, one link; no duplicate work.
    const counts = await fx.counts(sourceId);
    assertEquals(
      [counts.requests, counts.tasks, counts.links],
      [1, 1, 1],
    );
    assertEquals(
      routeCheck(result.report).evidence.map((entry) => entry.ref),
      ["route:backend", "route:frontend"],
    );
  }));

Deno.test("#31 AC1: labels that agree on one repository collapse into one child (dedupe)", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource();
    const backend = await addRepository(fx, "backend");
    await read(
      await putRules(fx, sourceId, [
        { labelId: "api", repositoryId: backend, role: "backend" },
        { labelId: "backend", repositoryId: backend, role: "backend" },
      ]),
      200,
    );
    fx.reader.setIssue({
      number: 2,
      labels: [EXECUTE_LABEL, "api", "backend"],
    });
    const result = await fx.admit(sourceId, { number: 2 });
    assertEquals(result.kind, "admitted");
    const targets = await targetsOf(fx, result.request!.id);
    assertEquals(targets.length, 1);
    assertEquals(
      [targets[0].repository_id, targets[0].role],
      [backend, "backend"],
    );
  }));

Deno.test("#31 AC2: a deleted (archived) target blocks the preview with a reason and never admits", () =>
  withTicketFixture(async (fx) => {
    const { sourceId, frontend } = await routedSource(fx);
    await fx.owner.query(
      "update bakery.repositories set archived_at = now() where id = $1",
      [frontend],
    );
    fx.reader.setIssue({
      number: 3,
      labels: [EXECUTE_LABEL, "backend", "frontend"],
    });
    // The source preview records the blocked verdict where a client reads it.
    await read(
      await ticketCall(fx, "POST", `${SOURCES}/${sourceId}/previews`, {
        body: {},
      }),
      201,
    );
    const ticket = await fx.owner.query<{ id: string }>(
      "select id from bakery.external_tickets where ticket_source_id = $1",
      [sourceId],
    );
    const view = await read<{
      latestReadiness: {
        verdict: string;
        checks: { id: string; status: string; reason: string }[];
      };
    }>(
      await ticketCall(fx, "GET", `/v1/external-tickets/${ticket.rows[0].id}`),
      200,
    );
    assertEquals(view.latestReadiness.verdict, "rejected");
    assertEquals(
      view.latestReadiness.checks.find((check) =>
        check.id === "repository_ready"
      ),
      {
        id: "repository_ready",
        status: "reject",
        reason: "route_target_deleted",
        evidence: [{ ref: "route:label:frontend" }],
      } as never,
    );
    const result = await fx.admit(sourceId, { number: 3 });
    assertEquals(result.kind, "unadmitted");
    assertEquals(routeCheck(result.report).reason, "route_target_deleted");
    assertEquals((await fx.counts(sourceId)).requests, 0);
  }));

Deno.test("#31 AC2: an inaccessible required target blocks; it is not dropped from the union", () =>
  withTicketFixture(async (fx) => {
    const { sourceId, frontend } = await routedSource(fx);
    // The repository left the source's application after the rules were saved.
    const elsewhere = await addApplication(fx);
    await fx.owner.query(
      "update bakery.repositories set application_id = $2 where id = $1",
      [frontend, elsewhere],
    );
    fx.reader.setIssue({
      number: 4,
      labels: [EXECUTE_LABEL, "backend", "frontend"],
    });
    const result = await fx.admit(sourceId, { number: 4 });
    assertEquals(result.kind, "unadmitted");
    const check = routeCheck(result.report);
    assertEquals([check.status, check.reason], [
      "reject",
      "route_target_inaccessible",
    ]);
    assertEquals(result.report.verdict, "rejected");
    assertEquals((await fx.counts(sourceId)).requests, 0);
    // The label that routes only to the healthy repository still admits.
    fx.reader.setIssue({ number: 5, labels: [EXECUTE_LABEL, "backend"] });
    assertEquals((await fx.admit(sourceId, { number: 5 })).kind, "admitted");
  }));

Deno.test("#31 AC2: an ambiguous role or repository blocks with route_ambiguous", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource();
    const one = await addRepository(fx, "one");
    const two = await addRepository(fx, "two");
    await read(
      await putRules(fx, sourceId, [
        // One role, two repositories.
        { labelId: "backend", repositoryId: one, role: "backend" },
        { labelId: "server", repositoryId: two, role: "backend" },
        // One repository, two roles.
        { labelId: "web", repositoryId: one, role: "frontend" },
      ]),
      200,
    );
    for (
      const [number, labels, refs] of [
        [6, ["backend", "server"], ["route:role:backend"]],
        [7, ["backend", "web"], ["route:label:backend", "route:label:web"]],
      ] as const
    ) {
      fx.reader.setIssue({ number, labels: [EXECUTE_LABEL, ...labels] });
      const result = await fx.admit(sourceId, { number });
      assertEquals(result.kind, "unadmitted", String(number));
      const check = routeCheck(result.report);
      assertEquals(check.reason, "route_ambiguous");
      assertEquals(check.evidence.map((entry) => entry.ref), [...refs]);
    }
    assertEquals((await fx.counts(sourceId)).requests, 0);
  }));

Deno.test("#31 AC2: with rules but no matching label the ticket falls back to the source repository, visibly", () =>
  withTicketFixture(async (fx) => {
    const { sourceId } = await routedSource(fx);
    fx.reader.setIssue({ number: 8, labels: [EXECUTE_LABEL] });
    const result = await fx.admit(sourceId, { number: 8 });
    assertEquals(result.kind, "admitted");
    assertEquals(
      routeCheck(result.report).evidence.map((entry) => entry.ref),
      ["route:fallback"],
    );
    const targets = await targetsOf(fx, result.request!.id);
    assertEquals(
      targets.map((target) => [target.repository_id, target.role]),
      [[fx.repositoryId, "default"]],
    );
    assertEquals(targets[0].routing_rule_id, null);

    // A source without rules routes exactly as before: no route evidence.
    const plain = await fx.insertSource();
    fx.reader.setIssue({ number: 9, labels: [EXECUTE_LABEL] });
    const before = await fx.admit(plain, { number: 9 });
    assertEquals(routeCheck(before.report).evidence, []);
  }));

Deno.test("#31 AC3 and #69 AC1: rule and policy edits affect new admissions only; active pins and children stay", () =>
  withTicketFixture(async (fx) => {
    const { sourceId, backend, frontend } = await routedSource(fx);
    fx.reader.setIssue({
      number: 10,
      labels: [EXECUTE_LABEL, "backend", "frontend"],
    });
    const admitted = await fx.admit(sourceId, { number: 10 });
    assertEquals(admitted.kind, "admitted");
    const request = admitted.request!;
    const before = await targetsOf(fx, request.id);
    const pinned = await fx.owner.query<
      { readiness_report_id: string; requirements_digest: string }
    >(
      `select readiness_report_id, requirements_digest
         from bakery.ticket_requests where id = $1`,
      [request.id],
    );

    // Retarget the labels: backend moves to a new repository, frontend goes.
    const moved = await addRepository(fx, "moved");
    const replaced = await read<RuleSet>(
      await putRules(fx, sourceId, [
        { labelId: "backend", repositoryId: moved, role: "backend" },
      ]),
      200,
    );
    assertEquals(replaced.policyRevision, 3);
    // And edit the policy itself.
    const policy = fx.policy({ requireAcceptanceCriteria: false });
    const patched = await read<{ policyRevision: number }>(
      await ticketCall(fx, "PATCH", `${SOURCES}/${sourceId}`, {
        body: { policy },
        ifMatch: replaced.version,
      }),
      200,
    );
    assertEquals(patched.policyRevision, 4);

    // A recheck and a duplicate explicit request see the active request and
    // keep it as admitted.
    const recheck = await fx.recheck(request.externalTicketId);
    assertEquals(recheck.request?.id, request.id);
    const again = await fx.admit(sourceId, { number: 10 });
    assertEquals(again.kind, "existing");
    assertEquals(again.request?.id, request.id);

    assertEquals(await targetsOf(fx, request.id), before);
    assertEquals(
      before.map((target) => target.repository_id).sort(),
      [backend, frontend].sort(),
    );
    const after = await fx.owner.query<
      {
        readiness_report_id: string;
        requirements_digest: string;
        source_policy_revision: number;
      }
    >(
      `select readiness_report_id, requirements_digest, source_policy_revision
         from bakery.ticket_requests where id = $1`,
      [request.id],
    );
    assertEquals(
      after.rows[0].readiness_report_id,
      pinned.rows[0].readiness_report_id,
    );
    assertEquals(
      after.rows[0].requirements_digest,
      pinned.rows[0].requirements_digest,
    );
    assertEquals(after.rows[0].source_policy_revision, 2);

    // The next admission is judged on the new rules.
    fx.reader.setIssue({
      number: 11,
      labels: [EXECUTE_LABEL, "backend", "frontend"],
    });
    const next = await fx.admit(sourceId, { number: 11 });
    assertEquals(next.kind, "admitted");
    assertEquals(
      (await targetsOf(fx, next.request!.id)).map((target) => [
        target.repository_id,
        target.source_policy_revision,
      ]),
      [[moved, 4]],
    );
  }));

Deno.test("#31 AC3: a deleted rule leaves the child exactly as admitted", () =>
  withTicketFixture(async (fx) => {
    const { sourceId, backend } = await routedSource(fx);
    fx.reader.setIssue({ number: 12, labels: [EXECUTE_LABEL, "backend"] });
    const admitted = await fx.admit(sourceId, { number: 12 });
    const [child] = await targetsOf(fx, admitted.request!.id);
    assertNotEquals(child.routing_rule_id, null);
    await read(await putRules(fx, sourceId, []), 200);
    assertEquals(await targetsOf(fx, admitted.request!.id), [child]);
    assertEquals(child.repository_id, backend);
    assertEquals(child.routing_rule_version, 1);
  }));

Deno.test("#31 rules: replace is CAS on the source version (428 and 412), validates targets, and an identical set changes nothing", () =>
  withTicketFixture(async (fx) => {
    const { sourceId, backend, set } = await routedSource(fx);
    const same = [
      { labelId: "backend", repositoryId: backend, role: "backend" },
      ...set.rules.filter((rule) => rule.labelId === "frontend").map((
        { labelId, repositoryId, role },
      ) => ({ labelId, repositoryId, role })),
    ];
    const missing = await read<Problem>(
      await putRules(fx, sourceId, same, { ifMatch: null }),
      428,
    );
    assertEquals(missing.code, "PRECONDITION_REQUIRED");
    const stale = await read<Problem>(
      await putRules(fx, sourceId, same, { ifMatch: set.version - 1 }),
      412,
    );
    assertEquals(stale.code, "PRECONDITION_FAILED");
    const unchanged = await read<RuleSet>(
      await putRules(fx, sourceId, same),
      200,
    );
    assertEquals(
      [unchanged.version, unchanged.policyRevision],
      [set.version, set.policyRevision],
    );
    assertEquals(
      unchanged.rules.map((rule) => [rule.id, rule.version]),
      set.rules.map((rule) => [rule.id, rule.version]),
    );
    // A changed role keeps the rule id and advances its version.
    const edited = await read<RuleSet>(
      await putRules(fx, sourceId, [
        { labelId: "backend", repositoryId: backend, role: "api" },
      ]),
      200,
    );
    const backendRule = set.rules.find((rule) => rule.labelId === "backend")!;
    assertEquals(edited.rules.map((rule) => [rule.id, rule.version]), [[
      backendRule.id,
      2,
    ]]);
    // Duplicate pairs, archived and foreign-application targets are refused.
    const duplicate = await read<Problem>(
      await putRules(fx, sourceId, [
        { labelId: "x", repositoryId: backend, role: "a" },
        { labelId: "x", repositoryId: backend, role: "b" },
      ]),
      422,
    );
    assertEquals(duplicate.issues?.[0]?.code, "routing_rule_duplicate");
    const foreign = await addRepository(
      fx,
      "foreign",
      await addApplication(fx),
    );
    const outside = await read<Problem>(
      await putRules(fx, sourceId, [
        { labelId: "x", repositoryId: foreign, role: "a" },
      ]),
      422,
    );
    assertEquals(outside.issues?.[0]?.code, "routing_repository_unavailable");
    // A request sent with the revision the rules moved past is 412.
    fx.reader.setIssue({ number: 13, labels: [EXECUTE_LABEL] });
    await read(
      await ticketCall(fx, "POST", `${SOURCES}/${sourceId}/previews`, {
        body: {},
      }),
      201,
    );
    const ticket = await fx.owner.query<
      { id: string; requirements_digest: string }
    >(
      `select id, requirements_digest from bakery.external_tickets
        where ticket_source_id = $1 and number = '13'`,
      [sourceId],
    );
    const refused = await read<Problem>(
      await ticketCall(
        fx,
        "POST",
        `/v1/external-tickets/${ticket.rows[0].id}/requests`,
        {
          body: {
            intent: "start",
            expectedSourcePolicyRevision: set.policyRevision,
            requirementsDigest: ticket.rows[0].requirements_digest,
          },
        },
      ),
      412,
    );
    assertEquals(refused.code, "PRECONDITION_FAILED");
  }));

Deno.test("#31 rules: another organization gets 404 for a source's rules, read or replace", () =>
  withTicketFixture(async (fx) => {
    const { sourceId, backend, set } = await routedSource(fx);
    try {
      const other = await seedOrganization(fx.f, "route-other", {
        role: "admin",
        agent: false,
      });
      const asOther = {
        cookie: other.cookie,
        organizationId: other.organizationId,
      };
      const path = `${SOURCES}/${sourceId}/routing-rules`;
      assertEquals(
        (await ticketCall(fx, "GET", path, asOther)).status,
        404,
      );
      const replace = await ticketCall(fx, "PUT", path, {
        ...asOther,
        body: {
          rules: [{ labelId: "x", repositoryId: backend, role: "a" }],
        },
        ifMatch: set.version,
      });
      assertEquals(replace.status, 404, await replace.text());
      const own = await read<RuleSet>(await ticketCall(fx, "GET", path), 200);
      assertEquals(own.version, set.version);
      assertEquals(own.rules.length, 2);
    } finally {
      await cleanupSeededOrganizations(fx.f);
    }
  }));

Deno.test("#31 AC1 over HTTP: ticketRequests.create answers the request's targets", () =>
  withTicketFixture(async (fx) => {
    const { sourceId, backend, frontend, set } = await routedSource(fx);
    fx.reader.setIssue({
      number: 14,
      labels: ["backend", "frontend"],
    });
    const recorded = await recordReadiness(fx.automationDeps(), {
      organizationId: fx.organizationId,
      sourceId,
      number: 14,
      intent: null,
      origin: "poll",
      caller: null,
      prefetch: null,
      signal: new AbortController().signal,
    });
    const ticket = await fx.owner.query<{ requirements_digest: string }>(
      "select requirements_digest from bakery.external_tickets where id = $1",
      [recorded.ticketId],
    );
    const created = await read<{ targets: Target[] }>(
      await ticketCall(
        fx,
        "POST",
        `/v1/external-tickets/${recorded.ticketId}/requests`,
        {
          body: {
            intent: "plan",
            expectedSourcePolicyRevision: set.policyRevision,
            requirementsDigest: ticket.rows[0].requirements_digest,
          },
        },
      ),
      201,
    );
    assertEquals(
      created.targets.map((target) => [target.role, target.repositoryId]),
      [["backend", backend], ["frontend", frontend]],
    );
  }, { budget: true }));
