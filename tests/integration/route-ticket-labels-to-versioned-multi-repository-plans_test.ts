/**
 * #31 [B09.05] Route ticket labels to versioned multi-repository plans, on real
 * Postgres with the in-memory provider reader. Each case names the acceptance
 * criterion (AC1 to AC3) or the guard it proves; #69 AC1 (an edit leaves the
 * pinned report and digest of an admitted request alone) is here too.
 *
 * Routed targets run as child tasks of a ticket-origin coordination plan, so
 * every routed repository has a ready profile (copied from the fixture's)
 * and a role binding alias, as a real application would.
 */
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import type { TicketReadinessReport } from "../../packages/contracts/src/ticket-admission.ts";
import { recordReadiness } from "../../apps/server/src/modules/work/ticket-admission.ts";
import { reconcileCoordinationPlan } from "../../apps/server/src/modules/work/coordination-projection.ts";
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

type Rule = {
  labelId: string;
  labelName: string;
  repositoryId: string;
  role: string;
};
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
  childTaskId: string | null;
};

/** A provider label: the id rules match and the name people see. */
const LABEL = {
  backend: { id: "9001", name: "backend" },
  frontend: { id: "9002", name: "frontend" },
  api: { id: "9003", name: "api" },
  server: { id: "9004", name: "server" },
  web: { id: "9005", name: "web" },
} as const;
type LabelKey = keyof typeof LABEL;

/** The issue labels: the execute label plus the routing labels, with ids. */
function issueLabels(...keys: LabelKey[]) {
  return {
    labels: [EXECUTE_LABEL, ...keys.map((key) => LABEL[key].name)],
    labelIds: ["8000", ...keys.map((key) => LABEL[key].id)],
  };
}

function rule(key: LabelKey, repositoryId: string, role: string): Rule {
  return {
    labelId: LABEL[key].id,
    labelName: LABEL[key].name,
    repositoryId,
    role,
  };
}

/**
 * A repository of the fixture's application, as the owner role: with a copy
 * of the fixture repository's ready profile unless `profile` is false, and a
 * role binding (alias = name) for each of `roles`.
 */
async function addRepository(
  fx: TicketFixture,
  name: string,
  options: {
    roles?: string[];
    profile?: boolean;
    connectionId?: string;
  } = {},
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
      fx.applicationId,
      options.connectionId ?? fx.connectionId,
      `route-${id}`,
      name,
    ],
  );
  if (options.profile !== false) {
    const profileId = crypto.randomUUID();
    await fx.owner.query(
      `insert into bakery.repository_profiles (
         id, organization_id, application_id, repository_id, revision, config,
         digest, created_by
       ) select $1, profile.organization_id, profile.application_id, $2, 1,
                profile.config, profile.digest, profile.created_by
           from bakery.repository_profiles as profile
           join bakery.repositories as repository
             on repository.active_profile_id = profile.id
          where repository.id = $3`,
      [profileId, id, fx.repositoryId],
    );
    await fx.owner.query(
      "update bakery.repositories set active_profile_id = $2 where id = $1",
      [id, profileId],
    );
  }
  for (const role of options.roles ?? [name]) {
    await fx.owner.query(
      `insert into bakery.repository_role_bindings (
         organization_id, application_id, repository_id, role, alias
       ) values ($1, $2, $3, $4, $5)`,
      [fx.organizationId, fx.applicationId, id, role, `${name}-${role}`],
    );
  }
  return id;
}

/** A copy of the fixture's connection that is archived, as the owner role. */
async function archivedConnection(fx: TicketFixture): Promise<string> {
  const id = crypto.randomUUID();
  await fx.owner.query(
    `insert into bakery.integration_connections
       select (jsonb_populate_record(connection, jsonb_build_object(
         'id', $2::uuid, 'archived_at', now()))).*
         from bakery.integration_connections as connection
        where id = $1`,
    [fx.connectionId, id],
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

type TargetRow = {
  repository_id: string;
  role: string;
  routing_rule_id: string | null;
  routing_rule_version: number | null;
  source_policy_revision: number;
  coordination_plan_id: string | null;
  child_task_id: string | null;
};

async function targetsOf(fx: TicketFixture, requestId: string) {
  const result = await fx.owner.query<TargetRow>(
    `select repository_id, role, routing_rule_id, routing_rule_version,
            source_policy_revision, coordination_plan_id, child_task_id
       from bakery.ticket_request_targets
      where organization_id = $1 and ticket_request_id = $2
      order by role, repository_id`,
    [fx.organizationId, requestId],
  );
  return result.rows;
}

async function childTask(fx: TicketFixture, taskId: string) {
  const result = await fx.owner.query<{
    repository_id: string | null;
    parent_task_id: string | null;
    status: string;
    runs: number;
    scope: string[];
  }>(
    `select task.repository_id, task.parent_task_id, task.status,
            (select count(*)::int from bakery.workflow_runs
              where organization_id = task.organization_id
                and task_id = task.id) as runs,
            array(select repository_id::text from bakery.task_repositories
                   where organization_id = task.organization_id
                     and task_id = task.id) as scope
       from bakery.tasks as task
      where task.organization_id = $1 and task.id = $2`,
    [fx.organizationId, taskId],
  );
  return result.rows[0];
}

/** Ends one child task as the engine would, then projects its plan. */
async function finishChild(
  fx: TicketFixture,
  target: TargetRow,
  status: "completed" | "failed",
): Promise<void> {
  await fx.owner.query(
    `update bakery.tasks set status = $3, updated_at = now(),
            version = version + 1
      where organization_id = $1 and id = $2`,
    [fx.organizationId, target.child_task_id, status],
  );
  await fx.inTransaction((transaction) =>
    reconcileCoordinationPlan(transaction, {
      organizationId: fx.organizationId,
      principalId: null,
      traceId: crypto.randomUUID().replaceAll("-", ""),
    }, target.coordination_plan_id!)
  );
}

async function dispositionOf(fx: TicketFixture, requestId: string) {
  const result = await fx.owner.query<
    { disposition: string; disposition_reason: string | null }
  >(
    "select disposition, disposition_reason from bakery.ticket_requests where id = $1",
    [requestId],
  );
  return result.rows[0];
}

function check(report: TicketReadinessReport, id: string) {
  const found = report.checks.find((entry) => entry.id === id);
  assert(found, `the report has a ${id} check`);
  return found;
}

/** A source whose labels "backend" and "frontend" route to two repositories. */
async function routedSource(fx: TicketFixture) {
  const sourceId = await fx.insertSource();
  const backend = await addRepository(fx, "backend");
  const frontend = await addRepository(fx, "frontend");
  const set = await read<RuleSet>(
    await putRules(fx, sourceId, [
      rule("backend", backend, "backend"),
      rule("frontend", frontend, "frontend"),
    ]),
    200,
  );
  return { sourceId, backend, frontend, set };
}

Deno.test("#31 AC1: backend and frontend labels admit one parent with two scoped child tasks that run", () =>
  withTicketFixture(async (fx) => {
    const { sourceId, backend, frontend, set } = await routedSource(fx);
    assertEquals(set.policyRevision, 2, "saving rules advances the revision");
    fx.reader.setIssue({ number: 1, ...issueLabels("backend", "frontend") });
    const result = await fx.admit(sourceId, { number: 1 });
    assertEquals(result.kind, "admitted");
    const request = result.request!;
    const targets = await targetsOf(fx, request.id);
    assertEquals(
      targets.map((t) => [t.repository_id, t.role, t.routing_rule_version]),
      [[backend, "backend", 1], [frontend, "frontend", 1]],
    );
    const ruleOf = (labelId: string) =>
      set.rules.find((entry) => entry.labelId === labelId)!.id;
    assertEquals(targets.map((t) => t.routing_rule_id), [
      ruleOf(LABEL.backend.id),
      ruleOf(LABEL.frontend.id),
    ]);
    // One ticket-origin plan; each child is a real task scoped to its
    // repository, under the request's task, with its own run.
    const planIds = new Set(targets.map((t) => t.coordination_plan_id));
    assertEquals(planIds.size, 1);
    const plan = await fx.owner.query<
      { parent_task_id: string; origin: { kind: string } }
    >(
      "select parent_task_id, origin from bakery.coordination_plans where id = $1",
      [[...planIds][0]],
    );
    assertEquals(plan.rows[0].parent_task_id, request.taskId);
    assertEquals(plan.rows[0].origin.kind, "ticket");
    for (const target of targets) {
      const child = await childTask(fx, target.child_task_id!);
      assertEquals(child.repository_id, target.repository_id);
      assertEquals(child.parent_task_id, request.taskId);
      assertEquals(child.scope, [target.repository_id]);
      assertEquals(child.runs, 1, "the child runs on the existing engine");
    }
    // One parent: one request and one linked task; the parent runs nothing.
    const counts = await fx.counts(sourceId);
    assertEquals([counts.requests, counts.tasks, counts.links, counts.runs], [
      1,
      1,
      1,
      0,
    ]);
    assertEquals(request.disposition, "admitted");
    assertEquals(
      check(result.report, "repository_ready").evidence.map((e) => e.ref),
      ["route:backend", "route:frontend"],
    );
  }));

Deno.test("#31 AC1 and AC3: the parent completes only when every child does, and fails when one fails", () =>
  withTicketFixture(async (fx) => {
    const { sourceId } = await routedSource(fx);
    for (
      const [number, outcome] of [[2, "completed"], [3, "failed"]] as const
    ) {
      fx.reader.setIssue({ number, ...issueLabels("backend", "frontend") });
      const admitted = await fx.admit(sourceId, { number });
      const request = admitted.request!;
      const [first, second] = await targetsOf(fx, request.id);
      if (outcome === "completed") {
        // Issue 32: finished children are delivered once their work merged.
        for (const [index, child] of [first, second].entries()) {
          await fx.registerPullRequest({
            sourceId,
            taskId: child.child_task_id!,
            number: 1000 + number * 10 + index,
            status: "merged",
          });
        }
      }
      await finishChild(fx, first, "completed");
      // One child done is not the parent done.
      await fx.recheck(request.externalTicketId);
      assertEquals(
        (await dispositionOf(fx, request.id)).disposition,
        "admitted",
        `${number}: one of two children finished`,
      );
      await finishChild(fx, second, outcome);
      await fx.recheck(request.externalTicketId);
      assertEquals(await dispositionOf(fx, request.id), {
        disposition: outcome,
        disposition_reason: `task_${outcome}`,
      });
    }
  }));

Deno.test("#31 AC1: labels that agree on one repository collapse into one child (dedupe)", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource();
    const backend = await addRepository(fx, "backend");
    await read(
      await putRules(fx, sourceId, [
        rule("api", backend, "backend"),
        rule("backend", backend, "backend"),
      ]),
      200,
    );
    fx.reader.setIssue({ number: 4, ...issueLabels("api", "backend") });
    const result = await fx.admit(sourceId, { number: 4 });
    assertEquals(result.kind, "admitted");
    const targets = await targetsOf(fx, result.request!.id);
    assertEquals(targets.map((t) => [t.repository_id, t.role]), [[
      backend,
      "backend",
    ]]);
  }));

Deno.test("#31 rules match label ids: a renamed label keeps routing", () =>
  withTicketFixture(async (fx) => {
    const { sourceId, backend } = await routedSource(fx);
    // The provider renamed "backend" to "server-side"; its id is unchanged.
    fx.reader.setIssue({
      number: 5,
      labels: [EXECUTE_LABEL, "server-side"],
      labelIds: ["8000", LABEL.backend.id],
    });
    const result = await fx.admit(sourceId, { number: 5 });
    assertEquals(result.kind, "admitted");
    assertEquals(
      (await targetsOf(fx, result.request!.id)).map((t) => t.repository_id),
      [backend],
    );
    // A label that only shares the old name routes nowhere.
    fx.reader.setIssue({
      number: 6,
      labels: [EXECUTE_LABEL, "backend"],
      labelIds: ["8000", "7777"],
    });
    const other = await fx.admit(sourceId, { number: 6 });
    assertEquals(
      (await targetsOf(fx, other.request!.id)).map((t) => t.role),
      ["default"],
    );
    // A read that names no ids cannot be routed and is refused, not guessed.
    fx.reader.setIssue({
      number: 7,
      labels: [EXECUTE_LABEL, "backend"],
      labelIds: null,
    });
    const blind = await fx.admit(sourceId, { number: 7 });
    assertEquals(blind.kind, "unadmitted");
    const ready = check(blind.report, "repository_ready");
    assertEquals([ready.reason, ready.evidence], [
      "route_ambiguous",
      [{ ref: "route:labels:unidentified" }],
    ]);
  }));

Deno.test("#31 AC2: a deleted (archived) target blocks the preview with a reason and never admits", () =>
  withTicketFixture(async (fx) => {
    const { sourceId, frontend } = await routedSource(fx);
    await fx.owner.query(
      "update bakery.repositories set archived_at = now() where id = $1",
      [frontend],
    );
    fx.reader.setIssue({ number: 8, ...issueLabels("backend", "frontend") });
    // A preview stores nothing; a poll caches the ticket and its readiness.
    await fx.admit(sourceId, { number: 8, origin: "poll" });
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
      view.latestReadiness.checks.find((c) => c.id === "repository_ready"),
      {
        id: "repository_ready",
        status: "reject",
        reason: "route_target_deleted",
        evidence: [{ ref: "route:label:frontend" }],
      } as never,
    );
    const result = await fx.admit(sourceId, { number: 8 });
    assertEquals(result.kind, "unadmitted");
    assertEquals((await fx.counts(sourceId)).requests, 0);
  }));

Deno.test("#31 AC2: a target on an archived connection, or with its role binding gone, is inaccessible and blocks", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource();
    const backend = await addRepository(fx, "backend");
    const archived = await addRepository(fx, "frontend", {
      connectionId: await archivedConnection(fx),
    });
    await read(
      await putRules(fx, sourceId, [
        rule("backend", backend, "backend"),
        rule("frontend", archived, "frontend"),
      ]),
      200,
    );
    fx.reader.setIssue({ number: 9, ...issueLabels("backend", "frontend") });
    const result = await fx.admit(sourceId, { number: 9 });
    assertEquals(result.kind, "unadmitted");
    const ready = check(result.report, "repository_ready");
    assertEquals([ready.status, ready.reason, ready.evidence], [
      "reject",
      "route_target_inaccessible",
      [{ ref: "route:label:frontend" }],
    ]);
    assertEquals((await fx.counts(sourceId)).requests, 0);
    // The healthy route still admits; then its binding is archived.
    fx.reader.setIssue({ number: 10, ...issueLabels("backend") });
    assertEquals((await fx.admit(sourceId, { number: 10 })).kind, "admitted");
    await fx.owner.query(
      `update bakery.repository_role_bindings set archived_at = now()
        where repository_id = $1`,
      [backend],
    );
    fx.reader.setIssue({ number: 11, ...issueLabels("backend") });
    const unbound = await fx.admit(sourceId, { number: 11 });
    assertEquals(
      check(unbound.report, "repository_ready").reason,
      "route_target_inaccessible",
    );
  }));

Deno.test("#31 AC2: an ambiguous role or repository blocks with route_ambiguous", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource();
    const one = await addRepository(fx, "one", {
      roles: ["backend", "frontend"],
    });
    const two = await addRepository(fx, "two", { roles: ["backend"] });
    await read(
      await putRules(fx, sourceId, [
        rule("backend", one, "backend"),
        rule("server", two, "backend"),
        rule("web", one, "frontend"),
      ]),
      200,
    );
    for (
      const [number, keys, refs] of [
        [12, ["backend", "server"], ["route:role:backend"]],
        [13, ["backend", "web"], ["route:label:backend", "route:label:web"]],
      ] as const
    ) {
      fx.reader.setIssue({ number, ...issueLabels(...keys) });
      const result = await fx.admit(sourceId, { number });
      assertEquals(result.kind, "unadmitted", String(number));
      const ready = check(result.report, "repository_ready");
      assertEquals(ready.reason, "route_ambiguous");
      assertEquals(ready.evidence.map((e) => e.ref), [...refs]);
    }
    assertEquals((await fx.counts(sourceId)).requests, 0);
  }));

Deno.test("#31 per-target readiness: a routed repository with no ready profile waits with its role named", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource();
    const backend = await addRepository(fx, "backend");
    const bare = await addRepository(fx, "frontend", { profile: false });
    await read(
      await putRules(fx, sourceId, [
        rule("backend", backend, "backend"),
        rule("frontend", bare, "frontend"),
      ]),
      200,
    );
    fx.reader.setIssue({ number: 14, ...issueLabels("backend", "frontend") });
    const result = await fx.admit(sourceId, { number: 14 });
    assertEquals(result.kind, "unadmitted");
    const ready = check(result.report, "repository_ready");
    assertEquals([ready.status, ready.reason, ready.evidence], [
      "wait",
      "no_active_profile",
      [{ ref: "route:role:frontend" }],
    ]);
    assertEquals((await fx.counts(sourceId)).requests, 0);
  }));

Deno.test("#31 AC2: with rules but no matching label the ticket falls back to the source repository, visibly", () =>
  withTicketFixture(async (fx) => {
    const { sourceId } = await routedSource(fx);
    fx.reader.setIssue({ number: 15, ...issueLabels() });
    const result = await fx.admit(sourceId, { number: 15 });
    assertEquals(result.kind, "admitted");
    assertEquals(
      check(result.report, "repository_ready").evidence.map((e) => e.ref),
      ["route:fallback"],
    );
    const targets = await targetsOf(fx, result.request!.id);
    assertEquals(
      targets.map((t) => [t.repository_id, t.role, t.child_task_id]),
      [[fx.repositoryId, "default", null]],
    );
    // The fallback runs on the request's own task, as before routing.
    assertEquals((await fx.counts(sourceId)).runs, 1);
    const plain = await fx.insertSource();
    fx.reader.setIssue({ number: 16, labels: [EXECUTE_LABEL] });
    const before = await fx.admit(plain, { number: 16 });
    assertEquals(check(before.report, "repository_ready").evidence, []);
  }));

Deno.test("#31 AC3 and #69 AC1: rule and policy edits affect new admissions only; active pins and children stay", () =>
  withTicketFixture(async (fx) => {
    const { sourceId, backend, frontend } = await routedSource(fx);
    fx.reader.setIssue({ number: 17, ...issueLabels("backend", "frontend") });
    const admitted = await fx.admit(sourceId, { number: 17 });
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
    const moved = await addRepository(fx, "moved", { roles: ["backend"] });
    const replaced = await read<RuleSet>(
      await putRules(fx, sourceId, [rule("backend", moved, "backend")]),
      200,
    );
    assertEquals(replaced.policyRevision, 3);
    const policy = fx.policy({ requireAcceptanceCriteria: false });
    const patched = await read<{ policyRevision: number }>(
      await ticketCall(fx, "PATCH", `${SOURCES}/${sourceId}`, {
        body: { policy },
        ifMatch: replaced.version,
      }),
      200,
    );
    assertEquals(patched.policyRevision, 4);
    const recheck = await fx.recheck(request.externalTicketId);
    assertEquals(recheck.request?.id, request.id);
    const again = await fx.admit(sourceId, { number: 17 });
    assertEquals(again.kind, "existing");
    assertEquals(again.request?.id, request.id);

    assertEquals(await targetsOf(fx, request.id), before);
    assertEquals(
      before.map((t) => t.repository_id).sort(),
      [backend, frontend].sort(),
    );
    const plans = await fx.owner.query<{ n: number }>(
      `select count(*)::int as n from bakery.coordination_plans
        where parent_task_id = $1`,
      [request.taskId],
    );
    assertEquals(plans.rows[0].n, 1, "no second plan retargets the request");
    const after = await fx.owner.query<{
      readiness_report_id: string;
      requirements_digest: string;
      source_policy_revision: number;
    }>(
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

    fx.reader.setIssue({ number: 18, ...issueLabels("backend", "frontend") });
    const next = await fx.admit(sourceId, { number: 18 });
    assertEquals(next.kind, "admitted");
    assertEquals(
      (await targetsOf(fx, next.request!.id)).map((t) => [
        t.repository_id,
        t.source_policy_revision,
      ]),
      [[moved, 4]],
    );
  }));

Deno.test("#31 AC3: on the recheck path, deleting a rule, retargeting one and archiving a target leave the admitted request's targets and pins alone", () =>
  withTicketFixture(async (fx) => {
    const { sourceId, backend, frontend } = await routedSource(fx);
    fx.reader.setIssue({ number: 22, ...issueLabels("backend", "frontend") });
    const admitted = await fx.admit(sourceId, { number: 22 });
    assertEquals(admitted.kind, "admitted");
    const request = admitted.request!;
    const before = await targetsOf(fx, request.id);
    assertEquals(before.length, 2);
    const pinsOf = async () =>
      (await fx.owner.query<{
        disposition: string;
        disposition_reason: string | null;
        source_policy_revision: number;
        readiness_report_id: string;
      }>(
        `select disposition, disposition_reason, source_policy_revision,
                readiness_report_id
           from bakery.ticket_requests where id = $1`,
        [request.id],
      )).rows[0];
    const pinned = await pinsOf();

    /** Rechecks the ticket and asserts nothing about the request moved. */
    const recheckUnchanged = async (step: string) => {
      const result = await fx.recheck(request.externalTicketId);
      assertEquals(result.request?.id, request.id, step);
      const report = result.report;
      assert(report !== null, `${step}: the recheck evaluated the ticket`);
      const routeReasons = report.checks.filter((entry) =>
        entry.reason.startsWith("route_")
      );
      assertEquals(routeReasons, [], `${step}: no route reason on recheck`);
      // A request that exists keeps its targets: readiness judges the
      // repository as before routing and carries no route evidence.
      assertEquals(
        [
          check(report, "repository_ready").status,
          check(report, "repository_ready").evidence,
        ],
        ["pass", []],
        `${step}: an admitted request is not re-routed`,
      );
      assertEquals(await targetsOf(fx, request.id), before, step);
      assertEquals(await pinsOf(), pinned, step);
    };

    // (a) Delete the frontend rule.
    await read(
      await putRules(fx, sourceId, [rule("backend", backend, "backend")]),
      200,
    );
    await recheckUnchanged("rule deleted");
    // (b) Retarget the backend label to another repository and role.
    const moved = await addRepository(fx, "moved", { roles: ["api"] });
    await read(
      await putRules(fx, sourceId, [rule("backend", moved, "api")]),
      200,
    );
    await recheckUnchanged("rule retargeted");
    // (c) Archive a repository the request was admitted to, and the one the
    // label routes to now: a new admission would be blocked, this request
    // is not.
    await fx.owner.query(
      "update bakery.repositories set archived_at = now() where id = any($1)",
      [[frontend, moved]],
    );
    await recheckUnchanged("target archived");
  }));

Deno.test("#31 AC3: a deleted rule leaves the child exactly as admitted", () =>
  withTicketFixture(async (fx) => {
    const { sourceId, backend } = await routedSource(fx);
    fx.reader.setIssue({ number: 19, ...issueLabels("backend") });
    const admitted = await fx.admit(sourceId, { number: 19 });
    const [child] = await targetsOf(fx, admitted.request!.id);
    assertNotEquals(child.routing_rule_id, null);
    await read(await putRules(fx, sourceId, []), 200);
    assertEquals(await targetsOf(fx, admitted.request!.id), [child]);
    assertEquals(child.repository_id, backend);
  }));

Deno.test("#31 rules: replace is CAS (428 and 412), validates targets and bindings, and an identical set changes nothing", () =>
  withTicketFixture(async (fx) => {
    const { sourceId, backend, frontend, set } = await routedSource(fx);
    const same = [
      rule("backend", backend, "backend"),
      rule("frontend", frontend, "frontend"),
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
    // A rename keeps the rule id and advances its version.
    const renamed = await read<RuleSet>(
      await putRules(fx, sourceId, [
        { ...rule("backend", backend, "backend"), labelName: "server-side" },
      ]),
      200,
    );
    const backendRule = set.rules.find((r) => r.labelId === LABEL.backend.id)!;
    assertEquals(
      renamed.rules.map((r) => [r.id, r.version, r.labelName]),
      [[backendRule.id, 2, "server-side"]],
    );
    const duplicate = await read<Problem>(
      await putRules(fx, sourceId, [
        rule("api", backend, "backend"),
        { ...rule("api", backend, "backend"), labelName: "again" },
      ]),
      422,
    );
    assertEquals(duplicate.issues?.[0]?.code, "routing_rule_duplicate");
    const unboundRole = await read<Problem>(
      await putRules(fx, sourceId, [rule("api", backend, "unbound-role")]),
      422,
    );
    assertEquals(unboundRole.issues?.[0]?.code, "routing_role_unbound");
    fx.reader.setIssue({ number: 20, labels: [EXECUTE_LABEL] });
    await fx.admit(sourceId, { number: 20, origin: "poll" });
    const ticket = await fx.owner.query<
      { id: string; requirements_digest: string }
    >(
      `select id, requirements_digest from bakery.external_tickets
        where ticket_source_id = $1 and number = '20'`,
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
      assertEquals((await ticketCall(fx, "GET", path, asOther)).status, 404);
      const replace = await ticketCall(fx, "PUT", path, {
        ...asOther,
        body: { rules: [rule("api", backend, "backend")] },
        ifMatch: set.version,
      });
      assertEquals(replace.status, 404, await replace.text());
      const own = await read<RuleSet>(await ticketCall(fx, "GET", path), 200);
      assertEquals([own.version, own.rules.length], [set.version, 2]);
    } finally {
      await cleanupSeededOrganizations(fx.f);
    }
  }));

Deno.test("#31 AC1 over HTTP: ticketRequests.create answers the request's targets and child tasks", () =>
  withTicketFixture(async (fx) => {
    const { sourceId, backend, frontend, set } = await routedSource(fx);
    fx.reader.setIssue({
      number: 21,
      labels: ["backend", "frontend"],
      labelIds: [LABEL.backend.id, LABEL.frontend.id],
    });
    const recorded = await recordReadiness(fx.automationDeps(), {
      organizationId: fx.organizationId,
      sourceId,
      number: 21,
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
      created.targets.map((t) => [t.role, t.repositoryId]),
      [["backend", backend], ["frontend", frontend]],
    );
    assert(created.targets.every((t) => t.childTaskId !== null));
  }, { budget: true }));
