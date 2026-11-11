/**
 * Issue 82 security lane, depth cases. They run through the live reader, the
 * signed-delivery helpers and the fake GitHub on real Postgres (fixtures, not
 * live GitHub), so the whole automatic path is exercised: a delivery or a poll
 * reads the provider with no transaction open and the write re-verifies
 * authority under its locks. Each case asserts the visible reason a report
 * records and that no task, conversation, link, request or run was written.
 *
 * The operation matrix (roles, scopes, a foreign organization's ids, issue
 * text in operation logs) lives in `operations-security.ts` and is not
 * repeated; this file adds the automation path, the link-creation gaps and the
 * reasons the operation lane cannot reach.
 */
import { assert, assertEquals } from "@std/assert";
import { readWebhookSecret } from "../../../apps/server/src/modules/integrations/intake-receipts.ts";
import type { AdmissionDeps } from "../../../apps/server/src/modules/work/ticket-admission.ts";
import type { TicketSourceReader } from "../../../apps/server/src/modules/work/ticket-source-reader.ts";
import type { TicketIntakeOutcome } from "../../../apps/server/src/modules/work/ticket-workflows.ts";
import {
  TICKET_REASON_CODES,
  type TicketReasonCode,
} from "../../../packages/contracts/src/ticket-admission.ts";
import {
  cleanupSeededOrganizations,
  seedOrganization,
} from "../coordinator-turns.ts";
import {
  type FakeGitHubApp,
  type FakeInstallation,
  fakeTimestamp,
} from "../fake-github-app.ts";
import {
  pendingConnection,
  secondOrganization,
} from "../github-app-registration.ts";
import {
  issuesPayload,
  receipt,
  type RouteRow,
  routeRows,
  selectAndEnable,
} from "../github-intake/receipts-shared.ts";
import {
  type AutomationFixture,
  withAutomation,
} from "./automation-fixtures.ts";
import {
  ACCEPTANCE_BODY,
  AFTER_SINCE,
  automaticPolicy,
  EXECUTE_LABEL,
  HOLD_LABEL,
  insertBareTask,
  LABELER_ID,
  LABELER_LOGIN,
  PLAN_LABEL,
} from "./fixtures.ts";
import { ticketCall } from "./operations-http.ts";

/** Every reason code by its own name, so a case names a code the contract defines and a rename fails to compile. */
const REASON = Object.fromEntries(
  TICKET_REASON_CODES.map((code) => [code, code]),
) as { readonly [C in TicketReasonCode]: C };

let clock = Date.parse("2026-06-10T00:00:00Z");
/** A new provider-update instant, one second after the last. */
const instant = () => new Date(clock += 1000).toISOString();

type Actor = { id: number; login: string } | null;
const LABELER: Actor = { id: Number(LABELER_ID), login: LABELER_LOGIN };

/**
 * An issue in the fake GitHub, its labels applied by `actor` (the labeler by
 * default; `null` is the ghost user GitHub names no actor for). The default
 * labeler's collaborator record is seeded as well.
 */
function seedIssue(
  a: AutomationFixture,
  number: number,
  options: {
    labels?: string[];
    actor?: Actor;
    title?: string;
    body?: string;
  } = {},
) {
  const github = a.fx.f.github;
  const labels = options.labels ?? [EXECUTE_LABEL];
  a.seedLabeler();
  github.seedIssues(a.repositoryId, [{ number, labels }]);
  github.seedIssueDetail(a.repositoryId, number, {
    title: options.title ?? `Issue ${number}`,
    body: options.body ?? ACCEPTANCE_BODY,
  });
  for (const label of labels) {
    github.seedIssueEvent(a.repositoryId, number, {
      event: "labeled",
      label,
      actor: options.actor === undefined ? LABELER : options.actor,
      createdAt: fakeTimestamp(Date.parse(AFTER_SINCE)),
    });
  }
}

/** The same issue, listed by the fact index so the next poll finds it as new work. */
function listed(a: AutomationFixture, number: number, labels: string[]) {
  a.index.set(number, instant(), labels);
}

/** A new enabled source for the fixture repository; the earlier ones stop taking deliveries and polls. */
async function freshSource(a: AutomationFixture): Promise<string> {
  await a.fx.owner.query(
    "update bakery.ticket_sources set enabled = false where organization_id = $1",
    [a.fx.organizationId],
  );
  return await a.fx.insertSource({ policy: automaticPolicy(a.fx) });
}

function handled(outcome: TicketIntakeOutcome) {
  assert(outcome.kind === "processed", JSON.stringify(outcome));
  return outcome.sources;
}

/** The reason of each check that did not pass in the latest stored report of a ticket, by check id. */
async function failing(
  a: AutomationFixture,
  sourceId: string,
  number: number,
): Promise<Record<string, string>> {
  const result = await a.fx.owner.query<
    { checks: { id: string; status: string; reason: string }[] }
  >(
    `select report.checks from bakery.ticket_readiness_reports as report
       join bakery.external_tickets as ticket
         on ticket.id = report.external_ticket_id
      where ticket.ticket_source_id = $1 and ticket.number = $2
      order by report.version desc limit 1`,
    [sourceId, String(number)],
  );
  assertEquals(result.rows.length, 1, `a report is stored for issue ${number}`);
  return Object.fromEntries(
    result.rows[0].checks.filter((check) => check.status !== "pass").map((
      check,
    ) => [check.id, check.reason]),
  );
}

/**
 * The source holds `refused` issues that were looked at and refused: each has
 * its snapshot and one report with the reason, and nothing else was written.
 */
async function assertOnlyRefusals(
  a: AutomationFixture,
  sourceId: string,
  refused: number,
  label: string,
) {
  const counts = await a.fx.counts(sourceId);
  assertEquals(
    {
      tickets: counts.tickets,
      reports: counts.reports,
      requests: counts.requests,
      links: counts.links,
      tasks: counts.tasks,
      conversations: counts.conversations,
      runs: counts.runs,
    },
    {
      tickets: refused,
      reports: refused,
      requests: 0,
      links: 0,
      tasks: 0,
      conversations: 0,
      runs: 0,
    },
    label,
  );
}

/** One webhook delivery, then the intake function, for the single source that takes it. */
async function webhook(
  a: AutomationFixture,
  number: number,
  action = "labeled",
  deps: Parameters<AutomationFixture["intake"]>[1] = {},
) {
  const [outcome] = handled(
    await a.intake(await a.deliver(number, action), deps),
  );
  return outcome;
}

/** One poll run; the outcome of its single source. */
async function pollOnce(
  a: AutomationFixture,
  deps: Parameters<AutomationFixture["poll"]>[0] = {},
) {
  const { outcomes } = await a.poll(deps);
  assertEquals(outcomes.length, 1);
  return outcomes[0];
}

// ---------------------------------------------------------------------------
// Who applied the label: allowlist, role and identity, through the live reader.
// ---------------------------------------------------------------------------

type ActorCase = {
  name: string;
  /** The reason the report records for `authority_live`. */
  reason: TicketReasonCode;
  seed(a: AutomationFixture, number: number): void;
};

const fake = (a: AutomationFixture) => a.fx.f.github;
const STRANGER: Actor = { id: 999, login: "stranger" };

const ACTOR_CASES: ActorCase[] = [
  {
    name: "actor not on the allowlist",
    reason: REASON.actor_not_allowlisted,
    seed(a, number) {
      seedIssue(a, number, { actor: STRANGER });
      fake(a).seedCollaborator(a.repositoryId, "stranger", {
        id: 999,
        permission: "write",
      });
    },
  },
  {
    name: "read-role actor",
    reason: REASON.actor_role_insufficient,
    seed(a, number) {
      seedIssue(a, number);
      fake(a).seedCollaborator(a.repositoryId, LABELER_LOGIN, {
        id: Number(LABELER_ID),
        permission: "read",
      });
    },
  },
  {
    name: "actor with no access",
    reason: REASON.actor_role_insufficient,
    seed(a, number) {
      seedIssue(a, number);
      fake(a).seedCollaborator(a.repositoryId, LABELER_LOGIN, {
        id: Number(LABELER_ID),
        permission: "none",
      });
    },
  },
  {
    name: "collaborator id differs from the event actor",
    reason: REASON.actor_unverifiable,
    seed(a, number) {
      seedIssue(a, number);
      fake(a).seedCollaborator(a.repositoryId, LABELER_LOGIN, {
        id: 5151,
        permission: "write",
      });
    },
  },
  {
    name: "event actor is not a collaborator",
    reason: REASON.actor_unverifiable,
    seed(a, number) {
      // Allowlisted by id, yet GitHub knows no collaborator of the login the
      // event carries (the account was renamed or the user left).
      seedIssue(a, number, {
        actor: { id: Number(LABELER_ID), login: "renamed-labeler" },
      });
    },
  },
  {
    name: "ghost actor (the event names none)",
    reason: REASON.actor_unverifiable,
    seed(a, number) {
      seedIssue(a, number, { actor: null });
    },
  },
];

/** The cause is removed: the labeler applies the label last and is a writer. */
function repair(a: AutomationFixture, number: number) {
  a.seedLabeler();
  fake(a).seedIssueEvent(a.repositoryId, number, {
    event: "labeled",
    label: EXECUTE_LABEL,
    actor: LABELER,
    createdAt: fakeTimestamp(Date.parse(AFTER_SINCE) + 86_400_000),
  });
}

Deno.test("issue 82 security depth: a label applied by an actor off the allowlist, without write role or with an identity GitHub does not confirm admits nothing, by webhook and by poll", () =>
  withAutomation(async (a) => {
    for (const scenario of ACTOR_CASES) {
      const label = scenario.name;
      const sourceId = await freshSource(a);
      const base = 100 + 10 * ACTOR_CASES.indexOf(scenario);
      const [hooked, polled] = [base + 1, base + 2];

      scenario.seed(a, hooked);
      const delivery = await webhook(a, hooked);
      assertEquals(delivery.admission, "unadmitted", label);
      assertEquals(
        (await failing(a, sourceId, hooked)).authority_live,
        scenario.reason,
        label,
      );

      scenario.seed(a, polled);
      listed(a, polled, [EXECUTE_LABEL]);
      const poll = await pollOnce(a);
      assertEquals(poll.admitted, 0, label);
      assert(poll.candidates >= 1, label);
      assertEquals(
        (await failing(a, sourceId, polled)).authority_live,
        scenario.reason,
        label,
      );
      a.index.remove(polled);
      await assertOnlyRefusals(a, sourceId, 2, label);

      // Control: with the cause gone the same issue is admitted, so the
      // reason above was the only thing standing in the way.
      repair(a, hooked);
      const admitted = await webhook(a, hooked);
      assertEquals(admitted.admission, "admitted", label);
      assertEquals((await a.fx.counts(sourceId)).requests, 1, label);
    }
  }));

// ---------------------------------------------------------------------------
// The delegation principal: deactivated or without the permissions to act.
// ---------------------------------------------------------------------------

/** One piece of authority a source stands on, and how a test loses and restores it. */
type Loss = {
  name: string;
  /** The check that records the lost authority, and the reason it records. */
  check: string;
  reason: TicketReasonCode;
  /** The ids the update binds; the last parameter is whether the authority is lost. */
  ids(a: AutomationFixture, sourceId: string): string[];
  sql: string;
};

const LOSSES: Loss[] = [
  {
    name: "delegation principal deactivated",
    check: "authority_live",
    reason: REASON.principal_inactive,
    ids: (a) => [a.fx.developerId],
    sql: `update bakery.principals
             set disabled_at = case when $2::boolean then now() end
           where id = $1`,
  },
  {
    name: "delegation principal demoted to viewer",
    check: "authority_live",
    reason: REASON.principal_inactive,
    ids: (a) => [a.fx.organizationId, a.fx.developerId],
    sql: `update bakery.organization_memberships
             set role = case when $3::boolean then 'viewer' else 'developer' end
           where organization_id = $1 and principal_id = $2`,
  },
  {
    name: "repository grant revoked",
    check: "source_live",
    reason: REASON.resource_not_selected,
    ids: (a) => [a.fx.resource.id],
    sql:
      "update bakery.integration_resources set selected = not $2::boolean where id = $1",
  },
  {
    name: "installation suspended",
    check: "source_live",
    reason: REASON.installation_not_enabled,
    ids: (a) => [a.fx.connectionId],
    sql: `update bakery.integration_installations
             set status = case when $2::boolean then 'suspended' else 'enabled' end
           where id = (select installation_id from bakery.integration_connections
                        where id = $1)`,
  },
  {
    name: "connection archived",
    check: "source_live",
    reason: REASON.connection_not_enabled,
    ids: (a) => [a.fx.connectionId],
    sql: `update bakery.integration_connections
             set archived_at = case when $2::boolean then now() end
           where id = $1`,
  },
  {
    name: "source disabled",
    check: "source_live",
    reason: REASON.source_disabled,
    ids: (_a, sourceId) => [sourceId],
    sql:
      "update bakery.ticket_sources set enabled = not $2::boolean where id = $1",
  },
];

const setLost = (
  loss: Loss,
  a: AutomationFixture,
  sourceId: string,
  lost: boolean,
) =>
  a.fx.owner.query(loss.sql, [...loss.ids(a, sourceId), lost]).then(() => {});

Deno.test("issue 82 security depth: a deactivated or demoted delegation principal admits nothing, and suspends the request it already admitted", () =>
  withAutomation(async (a) => {
    for (const [index, loss] of LOSSES.slice(0, 2).entries()) {
      const label = loss.name;
      const sourceId = await freshSource(a);
      const [fresh, listedFresh, known] = [1, 2, 3].map((n) =>
        200 + 10 * index + n
      );
      await setLost(loss, a, sourceId, true);
      seedIssue(a, fresh);
      assertEquals((await webhook(a, fresh)).admission, "unadmitted", label);
      assertEquals(
        (await failing(a, sourceId, fresh))[loss.check],
        loss.reason,
        label,
      );
      seedIssue(a, listedFresh);
      listed(a, listedFresh, [EXECUTE_LABEL]);
      assertEquals((await pollOnce(a)).admitted, 0, label);
      a.index.remove(listedFresh);
      assertEquals(
        (await failing(a, sourceId, listedFresh))[loss.check],
        loss.reason,
        label,
      );
      await assertOnlyRefusals(a, sourceId, 2, label);

      // An admitted request: the next delivery suspends it and keeps every row.
      await setLost(loss, a, sourceId, false);
      seedIssue(a, known);
      assertEquals((await webhook(a, known)).admission, "admitted", label);
      const before = await a.fx.counts(sourceId);
      assertEquals([before.requests, before.runs], [1, 1], label);
      await setLost(loss, a, sourceId, true);
      const suspended = await webhook(a, known, "edited");
      assertEquals(suspended.applied, ["suspend"], label);
      const [request] = (await a.requests(sourceId)).filter((row) =>
        row.number === String(known)
      );
      assertEquals(
        [request.disposition, request.disposition_reason],
        ["suspended", loss.reason],
        label,
      );
      assertEquals(
        await a.fx.counts(sourceId),
        { ...before, reports: before.reports + 1 },
        label,
      );

      // The cause clears and the request comes back by itself.
      await setLost(loss, a, sourceId, false);
      assertEquals((await webhook(a, known, "edited")).applied, ["resume"]);
    }
  }));

// ---------------------------------------------------------------------------
// Between the provider read and the write.
// ---------------------------------------------------------------------------

/**
 * A reader that runs `hook` once, right after the `reads`-th `method` answer.
 * Each read of `method` closes the reads of one candidate (the actor role is
 * the last read of a prefetch), so with `reads` set to the number of
 * candidates read at once the hook runs at the instant after every provider
 * read and before the write transaction. A hook that ran after the first
 * candidate's answer would race the reads of the others.
 */
function racing(
  reader: TicketSourceReader,
  method: keyof TicketSourceReader,
  hook: () => Promise<void>,
  reads = 1,
) {
  let ran = 0;
  const proxy = new Proxy(reader, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property !== method || typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        const answer = await value.apply(target, args);
        if (++ran === reads) await hook();
        return answer;
      };
    },
  });
  return { reader: proxy, ran: () => ran };
}

Deno.test("issue 82 security depth: authority lost after the provider was read and before the write admits nothing, by webhook and by poll", () =>
  withAutomation(async (a) => {
    for (const [index, loss] of LOSSES.entries()) {
      const label = loss.name;
      const sourceId = await freshSource(a);
      const [hooked, polled] = [1, 2].map((n) => 300 + 10 * index + n);
      seedIssue(a, hooked);
      seedIssue(a, polled);
      listed(a, polled, [EXECUTE_LABEL]);

      const viaWebhook = racing(
        a.live,
        "readActorRole",
        () => setLost(loss, a, sourceId, true),
      );
      const delivery = await webhook(a, hooked, "labeled", {
        reader: viaWebhook.reader,
      });
      assertEquals(
        viaWebhook.ran(),
        1,
        `${label}: the authority was lost mid-way`,
      );
      assertEquals(delivery.admission, "unadmitted", label);
      assertEquals(
        (await failing(a, sourceId, hooked))[loss.check],
        loss.reason,
        label,
      );
      await setLost(loss, a, sourceId, false);

      // The poll reads two candidates at once: the issue the delivery left
      // refused (a known ticket now) and the listed one.
      const viaPoll = racing(
        a.live,
        "readActorRole",
        () => setLost(loss, a, sourceId, true),
        2,
      );
      const poll = await pollOnce(a, { reader: viaPoll.reader });
      assert(viaPoll.ran() >= 2, `${label}: the authority was lost mid-way`);
      assertEquals(poll.admitted, 0, label);
      assertEquals(
        (await failing(a, sourceId, polled))[loss.check],
        loss.reason,
        label,
      );
      await assertOnlyRefusals(a, sourceId, 2, label);
      await setLost(loss, a, sourceId, false);
      a.index.remove(polled);

      // Control: with the authority back the same delivery admits.
      assertEquals((await webhook(a, hooked)).admission, "admitted", label);
      assertEquals((await a.fx.counts(sourceId)).requests, 1, label);
    }
  }));

// ---------------------------------------------------------------------------
// Another organization.
// ---------------------------------------------------------------------------

/** Row counts of the ticket tables, tasks and runs in one organization. */
async function organizationRows(a: AutomationFixture, organizationId: string) {
  const result = await a.fx.owner.query<Record<string, string>>(
    `select
       (select count(*) from bakery.ticket_sources where organization_id = $1) as sources,
       (select count(*) from bakery.external_tickets where organization_id = $1) as tickets,
       (select count(*) from bakery.ticket_readiness_reports where organization_id = $1) as reports,
       (select count(*) from bakery.ticket_task_links where organization_id = $1) as links,
       (select count(*) from bakery.ticket_requests where organization_id = $1) as requests,
       (select count(*) from bakery.tasks where organization_id = $1) as tasks,
       (select count(*) from bakery.workflow_runs where organization_id = $1) as runs`,
    [organizationId],
  );
  return Object.fromEntries(
    Object.entries(result.rows[0]).map(([key, value]) => [key, Number(value)]),
  );
}

/** What a signed `issues` delivery needs: the App's webhook secret and the ids a payload carries. */
async function deliveryContext(a: AutomationFixture) {
  const stored = await readWebhookSecret(a.fx.runtime, a.fx.f.secretsKey);
  assert(stored !== null, "the fake App registered a webhook secret");
  const secret = new TextDecoder().decode(stored.secret);
  stored.secret.fill(0);
  const installation = await a.fx.owner.query<
    { external_authorization_id: string }
  >("select external_authorization_id from bakery.integration_installations");
  return {
    secret,
    target: {
      installationId: Number(installation.rows[0].external_authorization_id),
      repositoryId: a.repositoryId,
    },
  };
}

/** A signed `issues` delivery with extra claims in its payload; every route it created. */
async function signedIssue(
  a: AutomationFixture,
  number: number,
  claims: Record<string, unknown> = {},
  options: { action?: string; repositoryId?: number } = {},
): Promise<RouteRow[]> {
  const { secret, target } = await deliveryContext(a);
  const payload = issuesPayload(
    { ...target, repositoryId: options.repositoryId ?? target.repositoryId },
    number,
    options.action ?? "labeled",
  );
  const accepted = await receipt({ f: a.fx.f, secret }, {
    event: "issues",
    payload: {
      ...payload,
      ...claims,
      issue: { ...payload.issue, ...(claims.issue as object | undefined) },
    },
  });
  return await routeRows(a.fx.f, accepted.eventId);
}

/**
 * The second organization connects the installation the fixture uses and
 * selects another repository of it: GitHub's installation is shared, the
 * repository is not (one repository of an installation is selected by one
 * organization at a time).
 */
async function connectSecondOrganization(a: AutomationFixture) {
  const { fx } = a;
  const { target } = await deliveryContext(a);
  const organizationId = await secondOrganization(fx.f);
  // The flow only reads the installation's id; the App and the installation are
  // the fake's own, already registered by the fixture.
  const app: FakeGitHubApp = {
    id: 1,
    slug: "shared",
    name: "shared",
    clientId: "shared",
    clientSecret: "shared",
    webhookSecret: null,
    pem: "",
    ownerLogin: "shared",
    ownerId: 1,
  };
  const installation: FakeInstallation = {
    id: target.installationId,
    appId: app.id,
    account: { id: 1, login: "shared", type: "Organization" },
    repositorySelection: "selected",
    permissions: {},
    suspendedAt: null,
    repositories: [],
  };
  const second = await pendingConnection(fx.f, {
    app,
    existing: installation,
    attempt: { organizationId },
  });
  const resource = second.resources.find((row) =>
    row.external_id !== fx.resource.external_id
  );
  assert(resource !== undefined, "the installation covers another repository");
  await selectAndEnable(fx.f, second.connectionId, resource, organizationId);
  return { organizationId, repositoryId: Number(resource.external_id) };
}

Deno.test("issue 82 security depth: a signed delivery about another organization's repository reads and writes nothing of this organization's, whatever the issue number", () =>
  withAutomation(async (a) => {
    const { fx } = a;
    const sourceId = await freshSource(a);
    const number = 401;
    seedIssue(a, number);
    assertEquals((await webhook(a, number)).admission, "admitted");
    const second = await connectSecondOrganization(a);
    const ticketText = async () =>
      (await fx.owner.query<{ row: string }>(
        "select t::text as row from bakery.external_tickets t where ticket_source_id = $1",
        [sourceId],
      )).rows;
    const before = {
      counts: await fx.counts(sourceId),
      ticket: await ticketText(),
      second: await organizationRows(a, second.organizationId),
      own: await organizationRows(a, fx.organizationId),
    };
    assertEquals(before.second.requests, 0);

    // The same issue number in the other organization's repository: validly
    // signed (the App's secret is installation-wide) and routed to the other
    // organization alone. It has no source, so nothing is read or written.
    const calls = fx.f.github.calls.length;
    const foreign = await signedIssue(a, number, {}, {
      repositoryId: second.repositoryId,
    });
    assertEquals(foreign.map((route) => route.organization_id), [
      second.organizationId,
    ]);
    assertEquals(await a.intake(foreign[0].id), {
      kind: "ignored",
      reason: "no_source",
    });
    assertEquals(fx.f.github.calls.length, calls, "no provider read");
    assertEquals(await fx.counts(sourceId), before.counts);
    assertEquals(await ticketText(), before.ticket, "the ticket is untouched");
    assertEquals(await organizationRows(a, fx.organizationId), before.own);

    // A delivery about this organization's repository never reaches the other.
    const own = await signedIssue(a, number, {}, { action: "edited" });
    assertEquals(own.map((route) => route.organization_id), [
      fx.organizationId,
    ]);
    assertEquals(handled(await a.intake(own[0].id))[0].action, "recheck");
    assertEquals(
      await organizationRows(a, second.organizationId),
      before.second,
    );
  }));

/** A response as a client sees it, without the fields that name the request. */
async function visible(response: Response) {
  const body = await response.json() as Record<string, unknown>;
  for (const key of ["requestId", "traceId", "instance"]) delete body[key];
  return [response.status, body];
}

Deno.test("issue 82 security depth: another organization's admin naming this organization's ticket gets the answer an unknown id gets, and links nothing", () =>
  withAutomation(async (a) => {
    const { fx } = a;
    try {
      const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
      fx.reader.setIssue({ number: 501, labels: [EXECUTE_LABEL] });
      const admitted = await fx.admit(sourceId, {
        number: 501,
        intent: "plan",
      });
      const ticketId = admitted.ticketId!;
      const digest = admitted.report.requirementsDigest!;
      const other = await seedOrganization(fx.f, "ticket-depth-other", {
        role: "admin",
        agent: false,
      });
      const foreignTask = await insertBareTask({
        owner: fx.owner,
        organizationId: other.organizationId,
        applicationId: other.applicationId,
        adminId: other.principalId,
      });
      const asOther = {
        cookie: other.cookie,
        organizationId: other.organizationId,
      };
      const before = {
        source: await fx.counts(sourceId),
        other: await organizationRows(a, other.organizationId),
      };
      fx.reader.clearCalls();

      // The same call for a ticket that does not exist is the control: the
      // answer must not tell a ticket of another organization from no ticket.
      const unknown = crypto.randomUUID();
      const attempts: [string, string, unknown][] = [
        ["GET", "", undefined],
        ["POST", "/links", { taskId: foreignTask, role: "reference" }],
        ["POST", "/readiness-checks", { expectedSourcePolicyRevision: 1 }],
        ["POST", "/requests", {
          intent: "plan",
          expectedSourcePolicyRevision: 1,
          requirementsDigest: digest,
        }],
      ];
      for (const [method, suffix, body] of attempts) {
        const named = await ticketCall(
          fx,
          method,
          `/v1/external-tickets/${ticketId}${suffix}`,
          { ...asOther, body },
        );
        const absent = await ticketCall(
          fx,
          method,
          `/v1/external-tickets/${unknown}${suffix}`,
          { ...asOther, body },
        );
        const [status, problem] = await visible(named);
        assertEquals(status, 404, `${method} ${suffix}`);
        assertEquals(
          [status, problem],
          await visible(absent),
          `${method} ${suffix}: no existence leak`,
        );
      }
      assertEquals(fx.reader.calls, [], "no provider read");
      assertEquals(await fx.counts(sourceId), before.source);
      assertEquals(
        await organizationRows(a, other.organizationId),
        before.other,
      );
      assertEquals(
        (await fx.owner.query(
          "select 1 from bakery.ticket_task_links where task_id = $1",
          [foreignTask],
        )).rows,
        [],
        "the foreign task is linked to nothing",
      );
    } finally {
      await cleanupSeededOrganizations(fx.f);
    }
  }));

// ---------------------------------------------------------------------------
// Issue text, and claims in the payload.
// ---------------------------------------------------------------------------

Deno.test("issue 82 security depth: issue title and body stay out of audit rows, domain events, reports and logs on the webhook and poll paths", () =>
  withAutomation(async (a) => {
    const { fx } = a;
    const marker = `TEXT-MARKER-${crypto.randomUUID()}`;
    const body = (note: string) =>
      `${note} ${marker}\n\n## Acceptance criteria\n- ${marker}\n`;
    const lines: string[] = [];
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const originals = methods.map((method) => console[method]);
    const sourceId = await freshSource(a);
    for (const method of methods) {
      console[method] = (...args: unknown[]) => {
        // An object argument is spelled out in full, so a marker inside it
        // reaches the check instead of reading as "[object Object]".
        lines.push(
          args.map((arg) =>
            typeof arg === "string" ? arg : Deno.inspect(arg, {
              depth: 20,
              iterableLimit: 10_000,
              strAbbreviateSize: 1_000_000,
              breakLength: Infinity,
            })
          ).join(" "),
        );
      };
    }
    try {
      // The capture itself: a marker inside an object argument is seen.
      console.error({ nested: { text: marker } });
      assert(
        lines.pop()?.includes(marker),
        "the capture spells out object arguments",
      );

      // Webhook: admit, edit the text, an outage, then the edit lands.
      seedIssue(a, 601, { title: `Title ${marker}`, body: body("Body") });
      assertEquals((await webhook(a, 601)).admission, "admitted");
      fake(a).seedIssueDetail(a.repositoryId, 601, {
        title: `Retitled ${marker}`,
        body: body("Edited body"),
      });
      a.edit(601, { labels: [EXECUTE_LABEL] });
      fake(a).failNext("issue", "server_error");
      await webhook(a, 601, "edited");
      assertEquals((await webhook(a, 601, "edited")).applied, ["suspend"]);

      // Poll: admit new work, then recheck it after an edit and an outage.
      seedIssue(a, 602, { title: `Title ${marker}`, body: body("Body") });
      listed(a, 602, [EXECUTE_LABEL]);
      assertEquals((await pollOnce(a)).admitted, 1);
      fake(a).seedIssueDetail(a.repositoryId, 602, {
        title: `Retitled ${marker}`,
        body: body("Edited body"),
      });
      a.edit(602, { labels: [EXECUTE_LABEL] });
      fake(a).failNext("issue", "server_error");
      await pollOnce(a);
      assertEquals((await pollOnce(a)).rechecked, 2);
    } finally {
      methods.forEach((method, index) => (console[method] = originals[index]));
    }
    assertEquals((await fx.counts(sourceId)).requests, 2);
    assert(lines.every((line) => !line.includes(marker)), "logs");
    for (
      const [table, column] of [
        ["audit_events", "details"],
        ["domain_events", "payload"],
        ["ticket_readiness_reports", "checks"],
        ["ticket_requests", "authority_evidence"],
      ]
    ) {
      const rows = await fx.owner.query(
        `select 1 from bakery.${table} where organization_id = $1 and ${column}::text like $2`,
        [fx.organizationId, `%${marker}%`],
      );
      assertEquals(rows.rows.length, 0, table);
    }
    // The text belongs in the snapshot and the task, and only there.
    for (const table of ["external_tickets", "tasks"]) {
      const column = table === "tasks" ? "title" : "snapshot::text";
      const stored = await fx.owner.query(
        `select 1 from bakery.${table} where organization_id = $1 and ${column} like $2`,
        [fx.organizationId, `%${marker}%`],
      );
      assert(stored.rows.length > 0, table);
    }
  }));

Deno.test("issue 82 security depth: author_association in a payload decides nothing; the verified role and allowlist do", () =>
  withAutomation(async (a) => {
    const sourceId = await freshSource(a);
    const claims = (association: string) => ({
      issue: { author_association: association },
      sender: { login: LABELER_LOGIN, id: Number(LABELER_ID), type: "User" },
      label: { name: EXECUTE_LABEL },
    });
    const deliver = async (number: number, association: string) => {
      const [route] = await signedIssue(a, number, claims(association));
      return handled(await a.intake(route.id))[0];
    };
    const scenarios: {
      name: string;
      reason: TicketReasonCode;
      seed(number: number): void;
    }[] = [
      {
        name: "OWNER association, collaborator with read role",
        reason: REASON.actor_role_insufficient,
        seed: (number) => {
          seedIssue(a, number);
          fake(a).seedCollaborator(a.repositoryId, LABELER_LOGIN, {
            id: Number(LABELER_ID),
            permission: "read",
          });
        },
      },
      {
        name: "OWNER association, label applied by an actor off the allowlist",
        reason: REASON.actor_not_allowlisted,
        seed: (number) => {
          seedIssue(a, number, { actor: STRANGER });
          fake(a).seedCollaborator(a.repositoryId, "stranger", {
            id: 999,
            permission: "admin",
          });
        },
      },
      {
        name: "OWNER association, ghost actor",
        reason: REASON.actor_unverifiable,
        seed: (number) => seedIssue(a, number, { actor: null }),
      },
    ];
    let number = 700;
    for (const scenario of scenarios) {
      number += 1;
      scenario.seed(number);
      const outcome = await deliver(number, "OWNER");
      assertEquals(outcome.admission, "unadmitted", scenario.name);
      assertEquals(
        (await failing(a, sourceId, number)).authority_live,
        scenario.reason,
        scenario.name,
      );
      await assertOnlyRefusals(a, sourceId, number - 700, scenario.name);
    }

    // Control: the weakest association with the verified role and allowlist admits.
    number += 1;
    seedIssue(a, number);
    assertEquals((await deliver(number, "NONE")).admission, "admitted");
    assertEquals((await a.fx.counts(sourceId)).requests, 1);
  }));

// ---------------------------------------------------------------------------
// The hold label.
// ---------------------------------------------------------------------------

Deno.test("issue 82 security depth: the hold label wins over the execute label, the planning label and an adoption, by webhook, poll and adoption", () =>
  withAutomation(async (a) => {
    const { fx } = a;
    const adoption: AdmissionDeps = { ...fx.automationDeps(), reader: a.live };
    const cases = [
      {
        name: "execute and hold",
        labels: [EXECUTE_LABEL, HOLD_LABEL],
        intent: "start",
        runs: 1,
      },
      {
        name: "plan and hold",
        labels: [PLAN_LABEL, HOLD_LABEL],
        intent: "plan",
        runs: 0,
      },
      {
        name: "execute, plan and hold",
        labels: [EXECUTE_LABEL, PLAN_LABEL, HOLD_LABEL],
        intent: "start",
        runs: 1,
      },
    ] as const;
    let number = 800;
    for (const scenario of cases) {
      const label = scenario.name;
      const sourceId = await freshSource(a);
      const [hooked, polled, adopted] = [number + 1, number + 2, number + 3];
      number += 10;
      for (const n of [hooked, polled, adopted]) {
        seedIssue(a, n, { labels: [...scenario.labels] });
      }
      listed(a, polled, [...scenario.labels]);

      const delivery = await webhook(a, hooked);
      assertEquals(delivery.admission, "unadmitted", label);
      assertEquals((await failing(a, sourceId, hooked)).not_held, REASON.held);
      assertEquals((await pollOnce(a)).admitted, 0, label);
      assertEquals((await failing(a, sourceId, polled)).not_held, REASON.held);
      a.index.remove(polled);
      const person = await fx.admit(sourceId, {
        number: adopted,
        origin: "adoption",
        intent: scenario.intent,
        deps: adoption,
      });
      assertEquals(person.kind, "unadmitted", label);
      assertEquals(
        person.report.checks.find((check) => check.id === "not_held")?.reason,
        REASON.held,
        label,
      );
      await assertOnlyRefusals(a, sourceId, 3, label);

      // Control: without the hold label the same webhook issue is admitted.
      a.edit(hooked, {
        labels: scenario.labels.filter((name) => name !== HOLD_LABEL),
      });
      assertEquals(
        (await webhook(a, hooked, "unlabeled")).admission,
        "admitted",
      );
      const counts = await fx.counts(sourceId);
      assertEquals([counts.requests, counts.runs], [1, scenario.runs], label);
    }
  }));
