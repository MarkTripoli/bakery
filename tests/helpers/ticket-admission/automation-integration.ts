/**
 * Issue 82 integration lane: the webhook and poll functions on real Postgres.
 * The intake function body runs over a signed delivery the application
 * received and reads the fake GitHub through the live reader; the poll
 * function runs over the scripted reader and the live fact index. Fixtures and
 * the fake are not live GitHub proof.
 */
import { assert, assertEquals } from "@std/assert";
import { createTicketFactIndex } from "../../../apps/server/src/modules/integrations/ticket-reads.ts";
import { withPgTransaction } from "../../../apps/server/src/platform/database.ts";
import { readSourceHandle } from "../../../apps/server/src/modules/work/ticket-store.ts";
import {
  createTicketIntakeWorkflow,
  createTicketPollWorkflow,
  listPollSources,
  type TicketIntakeOutcome,
} from "../../../apps/server/src/modules/work/ticket-workflows.ts";
import {
  afterQuery,
  afterRead,
  type AutomationFixture,
  captureFunction,
  failingStatements,
  memoryIssue,
  seedAttempt,
  seedFact,
  slowReader,
  withAutomation,
  withoutRows,
} from "./automation-fixtures.ts";
import {
  automaticPolicy,
  EXECUTE_LABEL,
  HOLD_LABEL,
  PLAN_LABEL,
  seedLabeler,
  type TicketReadFailure,
  watchTransactions,
} from "./fixtures.ts";

const signal = new AbortController().signal;

let clock = Date.parse("2026-06-10T00:00:00Z");
/** A new provider-update instant, one second after the last. */
const instant = () => new Date(clock += 1000).toISOString();

/** The per-source outcomes of an intake run that handled its delivery. */
function handled(outcome: TicketIntakeOutcome) {
  assert(outcome.kind === "processed", JSON.stringify(outcome));
  return outcome.sources;
}

/** A webhook request for `number`: a ready labeled issue, delivered once. */
async function admitted(a: AutomationFixture, number: number) {
  a.issue(number);
  const [outcome] = handled(await a.intake(await a.deliver(number)));
  assertEquals(outcome.admission, "admitted");
}

async function latestReport(
  a: AutomationFixture,
  sourceId: string,
  number: number,
) {
  const result = await a.fx.owner.query<
    { verdict: string; checks: { reason: string }[] }
  >(
    `select report.verdict, report.checks
       from bakery.ticket_readiness_reports as report
       join bakery.external_tickets as ticket
         on ticket.id = report.external_ticket_id
      where ticket.ticket_source_id = $1 and ticket.number = $2
      order by report.version desc limit 1`,
    [sourceId, String(number)],
  );
  return result.rows[0];
}

const rows = async (a: AutomationFixture, sourceId: string) =>
  Object.values(await a.fx.counts(sourceId)).reduce((sum, n) => sum + n, 0);

/** Deletes a source that owns no ticket yet, as an operator's cleanup would. */
async function dropSource(a: AutomationFixture, sourceId: string) {
  await a.fx.owner.query("delete from bakery.ticket_sources where id = $1", [
    sourceId,
  ]);
}

/** What the reader answers once a source lost its repository or installation. */
const LOST_AUTHORITY: TicketReadFailure = {
  kind: "unavailable",
  reason: "forbidden",
  retryAfterSeconds: null,
};

/** A stored checkpoint at `marker`/`number`, optionally waiting until `notBefore`. */
const checkpointJson = (
  marker: string | null,
  markerNumber: number | null,
  notBefore: string | null = null,
  attemptedAt: string | number | null = null,
  cursor: number | null = null,
  failure: { number: number; code: string; count: number } | null = null,
) =>
  JSON.stringify({
    marker,
    markerNumber,
    cursor,
    notBefore,
    attemptedAt,
    failure,
  });

/** Runs `work` with `console.error` captured; what the poll logs for a defect. */
async function logging<T>(work: () => Promise<T>) {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void lines.push(args.join(" "));
  try {
    return { value: await work(), lines };
  } finally {
    console.error = original;
  }
}

/** A reader whose first issue read answers, then dies on a plain `Error`. */
const dyingReader = (a: AutomationFixture, message: string) =>
  afterRead(
    a.fx.reader,
    "readIssue",
    () => Promise.reject(new Error(message)),
  );

Deno.test("issue 82 automation: the poll runs every five minutes one run at a time and the intake function listens to intake.received", () => {
  const deps = {
    database: {} as never,
    reader: {} as never,
    factIndex: {} as never,
    budget: undefined,
  };
  assertEquals(
    captureFunction((client) => createTicketPollWorkflow({ client, ...deps }))
      .config,
    {
      id: "bakery-ticket-poll",
      retries: 3,
      concurrency: [{ limit: 1 }],
      triggers: [{ cron: "*/5 * * * *" }],
    },
  );
  assertEquals(
    captureFunction((client) => createTicketIntakeWorkflow({ client, ...deps }))
      .config,
    {
      id: "bakery-ticket-intake",
      retries: 3,
      concurrency: [{ limit: 4 }],
      triggers: [{ event: "bakery/intake.received.v1" }],
    },
  );
});

Deno.test("issue 82 automation: a labeled delivery admits once with the delegation, over the live reader and the server budget policy", () =>
  withAutomation(async (a) => {
    const { fx } = a;
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    a.seedLabeler();
    a.issue(11);
    a.issue(12);

    // Without the server budget policy the fixed preset is never available.
    const [unbudgeted] = handled(
      await a.intake(await a.deliver(12), { budget: undefined }),
    );
    assertEquals(unbudgeted.admission, "unadmitted");
    assertEquals((await fx.counts(sourceId)).requests, 0);

    const route = await a.deliver(11);
    assertEquals(handled(await a.intake(route)), [{
      sourceId,
      action: "admit",
      admission: "admitted",
      applied: [],
      problem: null,
    }]);
    const counts = await fx.counts(sourceId);
    assertEquals(
      [counts.requests, counts.tasks, counts.links, counts.runs],
      [1, 1, 1, 1],
    );
    const [request] = await a.requests(sourceId);
    assertEquals(request.origin, "webhook");
    assertEquals(request.authority_principal_id, fx.developerId);
    assertEquals(request.inbound_event_route_id, route);
    assert(request.workflow_run_id !== null);

    // The same event again (the outbox and the recovery both send it) rechecks
    // the request it made and changes nothing.
    const [replay] = handled(await a.intake(route));
    assertEquals([replay.action, replay.applied], ["recheck", []]);
    assertEquals(await fx.counts(sourceId), counts);
  }));

Deno.test("issue 82 automation: two deliveries and a concurrent poll for one issue leave one request, task, link and run", () =>
  withAutomation(async (a) => {
    const { fx } = a;
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    a.seedLabeler();
    a.issue(21);
    a.index.set(21, instant(), [EXECUTE_LABEL]);
    const routes = [await a.deliver(21), await a.deliver(21, "edited")];
    const [first, second, poll] = await Promise.all([
      a.intake(routes[0]),
      a.intake(routes[1]),
      a.poll(),
    ]);
    const admissions = [...handled(first), ...handled(second)].filter((
      entry,
    ) => entry.admission === "admitted").length + poll.outcomes[0].admitted;
    assertEquals(admissions, 1);
    const counts = await fx.counts(sourceId);
    assertEquals(
      [counts.requests, counts.tasks, counts.links, counts.runs],
      [1, 1, 1, 1],
    );
  }));

Deno.test("issue 82 automation: an unlabeled delivery suspends the request and keeps every row, and a labeled one resumes it once the reason has cleared", () =>
  withAutomation(async (a) => {
    const { fx } = a;
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    a.seedLabeler();
    await admitted(a, 31);
    const before = await fx.counts(sourceId);

    a.edit(31, { labels: [] });
    const [suspended] = handled(
      await a.intake(await a.deliver(31, "unlabeled")),
    );
    assertEquals([suspended.action, suspended.applied], ["recheck", [
      "suspend",
    ]]);
    const [request] = await a.requests(sourceId);
    assertEquals([request.disposition, request.disposition_reason], [
      "suspended",
      "label_withdrawn",
    ]);
    assertEquals(await fx.counts(sourceId), {
      ...before,
      reports: before.reports + 1,
    });

    a.edit(31, { labels: [EXECUTE_LABEL] });
    const [resumed] = handled(await a.intake(await a.deliver(31)));
    assertEquals(resumed.applied, ["resume"]);
    const [after] = await a.requests(sourceId);
    assertEquals([after.disposition, after.disposition_reason], [
      "admitted",
      null,
    ]);
  }));

Deno.test("issue 82 automation: a hold label on a request that owns a run suspends it and requests one pause", () =>
  withAutomation(async (a) => {
    const { fx } = a;
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    a.seedLabeler();
    await admitted(a, 41);
    const [created] = await a.requests(sourceId);
    const attempt = await seedAttempt(fx, created.workflow_run_id!, ["steer"]);
    try {
      a.edit(41, { labels: [EXECUTE_LABEL, HOLD_LABEL] });
      const route = await a.deliver(41);
      const [held] = handled(await a.intake(route));
      assertEquals(held.applied, ["suspend", "pause"]);
      const [request] = await a.requests(sourceId);
      assertEquals([request.disposition, request.disposition_reason], [
        "suspended",
        "held",
      ]);
      assert(request.pause_requested_at !== null);
      assertEquals((await attempt.commands()).length, 1);

      const [replay] = handled(await a.intake(route));
      assertEquals(replay.applied, [], "a replay pauses nothing more");
      assertEquals((await attempt.commands()).length, 1);
    } finally {
      await attempt.cleanup();
    }
  }));

Deno.test("issue 82 automation: a delivery that names no issue, an invalid event, a repository with no enabled source and an issue that asks for nothing are ignored", () =>
  withAutomation(async (a) => {
    const { fx } = a;
    a.seedLabeler();
    a.issue(51);
    a.issue(53, []);
    const route = await a.deliver(51);
    const policy = automaticPolicy(fx);
    await fx.insertSource({ policy, enabled: false });
    assertEquals(await a.intake(route), {
      kind: "ignored",
      reason: "no_source",
    });

    // An unlabeled issue Bakery has never seen asks for nothing: no ticket row.
    const sourceId = await fx.insertSource({ policy });
    const [unlabeled] = handled(await a.intake(await a.deliver(53, "edited")));
    assertEquals([unlabeled.action, unlabeled.problem], ["none", null]);

    await fx.owner.query(
      `update bakery.inbound_events set event_kind = 'pull_request'
        where id = (select inbound_event_id from bakery.inbound_event_routes
                     where id = $1)`,
      [route],
    );
    assertEquals(await a.intake(route), {
      kind: "ignored",
      reason: "no_issue_target",
    });
    assertEquals(await a.intake("not-a-route"), {
      kind: "ignored",
      reason: "event_invalid",
    });
    assertEquals(await rows(a, sourceId), 0);
  }));

Deno.test("issue 82 automation: a deselected repository and a suspended installation get no provider call and no admission", () =>
  withAutomation(async (a) => {
    const { fx } = a;
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    a.seedLabeler();
    a.issue(52);
    const route = await a.deliver(52);
    const installation = (await fx.owner.query<{ id: string }>(
      "select id from bakery.integration_installations",
    )).rows[0].id;
    const calls = fx.f.github.calls.length;
    const nothing = async () => {
      const [only] = handled(await a.intake(route));
      assertEquals([only.action, only.problem], [
        "none",
        "provider_unavailable:forbidden",
      ]);
      assertEquals(await rows(a, sourceId), 0);
      assertEquals(fx.f.github.calls.length, calls);
    };
    const select = (selected: boolean) =>
      fx.owner.query(
        "update bakery.integration_resources set selected = $2 where id = $1",
        [fx.resource.id, selected],
      );
    await select(false);
    await nothing();
    await select(true);
    await fx.owner.query(
      "update bakery.integration_installations set status = 'suspended' where id = $1",
      [installation],
    );
    await nothing();
  }));

Deno.test("issue 82 automation: a known ticket whose repository was deselected is rechecked or reported with the lost authority named, and gains no request", () =>
  withAutomation(async (a) => {
    const { fx } = a;
    const github = fx.f.github;
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    a.seedLabeler();
    await admitted(a, 54);
    a.issue(55);
    github.seedIssueDetail(a.repositoryId, 55, { body: "No criteria yet." });
    const [waiting] = handled(await a.intake(await a.deliver(55)));
    assertEquals(waiting.admission, "unadmitted");
    const routes = [
      await a.deliver(54, "edited"),
      await a.deliver(55, "edited"),
    ];
    const before = await fx.counts(sourceId);
    const calls = github.calls.length;

    await fx.owner.query(
      "update bakery.integration_resources set selected = false where id = $1",
      [fx.resource.id],
    );
    const [recheck] = handled(await a.intake(routes[0]));
    assertEquals([recheck.action, recheck.problem], [
      "recheck",
      "provider_unavailable:forbidden",
    ]);
    const [admit] = handled(await a.intake(routes[1]));
    assertEquals([admit.action, admit.admission, admit.problem], [
      "admit",
      "unadmitted",
      "provider_unavailable:forbidden",
    ]);
    assertEquals(github.calls.length, calls, "no provider call was made");
    const after = await fx.counts(sourceId);
    assertEquals(
      [after.requests, after.tasks, after.links, after.runs],
      [before.requests, before.tasks, before.links, before.runs],
    );
  }));

Deno.test("issue 82 automation: a source that vanishes after the delivery listed it is recorded by code and the next source on the repository still runs", () =>
  withAutomation(async (a) => {
    const { fx } = a;
    const policy = automaticPolicy(fx);
    const ids = [
      await fx.insertSource({ policy }),
      await fx.insertSource({ policy }),
    ].sort();
    a.seedLabeler();
    a.issue(91);
    const database = afterQuery(
      fx.runtime,
      "from bakery.ticket_sources",
      () => dropSource(a, ids[0]),
    );
    const outcomes = handled(await a.intake(await a.deliver(91), { database }));
    assertEquals(outcomes.map((entry) => entry.sourceId), ids);
    assertEquals(outcomes[0], {
      sourceId: ids[0],
      action: "none",
      admission: null,
      applied: [],
      problem: "resource_not_found",
    });
    assertEquals(outcomes[1].admission, "admitted");
    assertEquals(await rows(a, ids[0]), 0);
    assertEquals((await fx.counts(ids[1])).requests, 1);
  }));

Deno.test("issue 82 automation: an admission or a recheck that the source policy outran is recorded by code and writes nothing", async () => {
  for (const known of [false, true]) {
    await withAutomation(async (a) => {
      const { fx } = a;
      const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
      a.seedLabeler();
      if (known) await admitted(a, 92);
      else a.issue(92);
      const before = await fx.counts(sourceId);

      // The execute label is renamed after the reads and before the write, so
      // the provenance the intake read answers for a label the policy dropped.
      const reader = afterRead(a.live, "readLabelProvenance", async () => {
        await fx.owner.query(
          `update bakery.ticket_sources
              set policy = jsonb_set(policy, '{labels,execute}', '"bakery:go"')
            where id = $1`,
          [sourceId],
        );
      });
      const [only] = handled(
        await a.intake(await a.deliver(92, "edited"), { reader }),
      );
      assertEquals(only, {
        sourceId,
        action: "none",
        admission: null,
        applied: [],
        problem: "ticket_prefetch_stale",
      }, known ? "recheck" : "admission");
      assertEquals(await fx.counts(sourceId), before);
    });
  }
});

Deno.test("issue 82 automation: a source deleted after the poll listed it fails its own step by code and the sweep goes on", () =>
  withAutomation(async (a) => {
    const { fx } = a;
    const policy = automaticPolicy(fx);
    const [gone, kept] = [
      await fx.insertSource({ policy }),
      await fx.insertSource({ policy }),
    ].sort();
    seedLabeler(fx);
    memoryIssue(a, 101, instant(), [PLAN_LABEL]);
    const database = afterQuery(
      fx.runtime,
      "from bakery.ticket_sources",
      () => dropSource(a, gone),
    );
    const { value: run, lines } = await logging(() =>
      a.poll({ reader: fx.reader, database })
    );
    const { sources, outcomes } = run;
    assertEquals(sources, 2);
    assertEquals(outcomes[0], {
      sourceId: gone,
      outcome: "failed",
      health: null,
      problemCode: "resource_not_found",
      candidates: 0,
      admitted: 0,
      rechecked: 0,
    });
    assertEquals(
      [outcomes[1].sourceId, outcomes[1].outcome, outcomes[1].admitted],
      [kept, "completed", 1],
    );
    assertEquals((await fx.counts(kept)).requests, 1);
    // The row is gone, so there is nothing to stamp, and that is no fault.
    assertEquals(lines, []);
  }));

/** A source row's columns the refusal cases compare: all but the poll's own. */
async function untouchedColumns(a: AutomationFixture, sourceId: string) {
  const result = await a.fx.owner.query<Record<string, unknown>>(
    `select enabled, policy, policy_revision, version, updated_at,
            sync_health, last_synced_at
       from bakery.ticket_sources where organization_id = $1 and id = $2`,
    [a.fx.organizationId, sourceId],
  );
  return result.rows[0];
}

/** The two sources of a refusal case, ordered so the refused one is listed first. */
async function refusedAndHealthy(a: AutomationFixture) {
  const policy = automaticPolicy(a.fx);
  const [refused, healthy] = [
    await a.fx.insertSource({ policy }),
    await a.fx.insertSource({ policy }),
  ].sort();
  seedLabeler(a.fx);
  memoryIssue(a, 141, instant(), [PLAN_LABEL]);
  return { refused, healthy };
}

/** What a refused step reports for its source: a recorded refusal that moved no health. */
const refusal = (sourceId: string, problemCode: string) => ({
  sourceId,
  outcome: "failed",
  health: null,
  problemCode,
  candidates: 0,
  admitted: 0,
  rechecked: 0,
});

/** The row says the refusal was recorded and the attempt stamped, and moved nothing else. */
async function assertRefusalRecorded(
  a: AutomationFixture,
  sourceId: string,
  problemCode: string,
  before: Awaited<ReturnType<typeof untouchedColumns>>,
) {
  const row = await a.source(sourceId);
  assertEquals(row.last_problem_code, problemCode);
  assertEquals(await untouchedColumns(a, sourceId), before);
  const { attemptedAt, ...checkpoint } = row.sync_checkpoint!;
  assert(
    typeof attemptedAt === "string" &&
      /^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(attemptedAt) &&
      Date.now() - Date.parse(attemptedAt) < 60_000,
    "the refusal stamps the attempt instant",
  );
  assertEquals(checkpoint, {
    marker: null,
    markerNumber: null,
    cursor: null,
    notBefore: null,
    failure: null,
  });
  return attemptedAt;
}

Deno.test("issue 82 automation: a source whose stored policy no longer parses is recorded by code and stamped, so a healthy source behind it is polled in a later run", () =>
  withAutomation(async (a) => {
    const { fx } = a;
    const { refused, healthy } = await refusedAndHealthy(a);
    // A key the strict stored schema refuses, as a manual edit would leave it.
    await fx.owner.query(
      `update bakery.ticket_sources
          set policy = policy || '{"unknown": true}'::jsonb where id = $1`,
      [refused],
    );
    const before = await untouchedColumns(a, refused);

    // The refused source is first in line (both were never attempted and its
    // id is lower); the cap of one leaves the healthy source out of this run.
    const first = await a.poll({ reader: fx.reader, sourcesPerRun: 1 });
    assertEquals(first.outcomes, [
      refusal(refused, "ticket_source_policy_invalid"),
    ]);
    assertEquals((await a.source(refused)).sync_health, "unknown");
    const stamped = await assertRefusalRecorded(
      a,
      refused,
      "ticket_source_policy_invalid",
      before,
    );

    // The stamp puts it behind the source that was never attempted.
    const second = await a.poll({ reader: fx.reader, sourcesPerRun: 1 });
    assertEquals(second.outcomes.map((entry) => entry.sourceId), [healthy]);
    assertEquals(second.outcomes[0].outcome, "completed");
    assertEquals((await a.source(healthy)).sync_health, "healthy");

    // The source still needs an operator: the next turn refuses again and restamps.
    const third = await a.poll({ reader: fx.reader, sourcesPerRun: 1 });
    assertEquals(third.outcomes, [
      refusal(refused, "ticket_source_policy_invalid"),
    ]);
    assert(
      String((await a.source(refused)).sync_checkpoint!.attemptedAt) >=
        stamped,
      "the attempt instant moves forward",
    );
    assertEquals((await untouchedColumns(a, refused)).policy, before.policy);
  }));

Deno.test("issue 82 automation: a source whose connection or resource is missing is recorded by code and stamped the same way", () =>
  withAutomation(async (a) => {
    const { fx } = a;
    const { refused, healthy } = await refusedAndHealthy(a);
    const before = await untouchedColumns(a, refused);

    // The foreign keys of a source keep its connection and resource in place,
    // so the join that names them answers no row instead.
    const database = withoutRows(
      fx.runtime,
      "from bakery.integration_connections as connection",
    );
    const first = await a.poll({
      reader: fx.reader,
      database,
      sourcesPerRun: 1,
    });
    assertEquals(first.outcomes, [refusal(refused, "resource_not_found")]);
    await assertRefusalRecorded(a, refused, "resource_not_found", before);

    const second = await a.poll({ reader: fx.reader, sourcesPerRun: 1 });
    assertEquals(second.outcomes.map((entry) => entry.sourceId), [healthy]);
    assertEquals(second.outcomes[0].outcome, "completed");
  }));

Deno.test("issue 82 automation: a refusal whose record cannot be written ends the step as the same outcome, and one on a source stored as auth_required keeps that problem code", () =>
  withAutomation(async (a) => {
    const { fx } = a;
    const { refused } = await refusedAndHealthy(a);
    await fx.owner.query(
      `update bakery.ticket_sources
          set policy = policy || '{"unknown": true}'::jsonb
        where id = $1`,
      [refused],
    );

    // The record cannot be written: the outcome is the refusal, nothing is
    // rethrown, and one log line names the source, the code and the class.
    const { value: failed, lines } = await logging(() =>
      a.poll({
        reader: fx.reader,
        database: failingStatements(fx.runtime, "'{attemptedAt}'"),
        sourcesPerRun: 1,
      })
    );
    assertEquals(failed.outcomes, [
      refusal(refused, "ticket_source_policy_invalid"),
    ]);
    const unrecorded = await a.source(refused);
    assertEquals(
      [unrecorded.sync_checkpoint, unrecorded.last_problem_code],
      [null, null],
    );
    assertEquals(lines.length, 1);
    assertEquals(JSON.parse(lines[0]), {
      component: "work",
      event: "ticket_poll_refusal_unrecorded",
      sourceId: refused,
      code: "ticket_source_policy_invalid",
      errorName: "Error",
    });
    assert(!lines[0].includes("statement refused"), "no error message");

    // Lost authority needs a person, so a refusal stamps the attempt and
    // leaves that code on the row.
    await fx.owner.query(
      `update bakery.ticket_sources
          set sync_health = 'auth_required', last_problem_code = 'auth_required'
        where id = $1`,
      [refused],
    );
    const stopped = await a.poll({ reader: fx.reader, sourcesPerRun: 1 });
    assertEquals(stopped.outcomes, [
      refusal(refused, "ticket_source_policy_invalid"),
    ]);
    const row = await a.source(refused);
    assertEquals(
      [row.sync_health, row.last_problem_code],
      ["auth_required", "auth_required"],
    );
    assert(
      /^20\d\d-/.test(String(row.sync_checkpoint!.attemptedAt)),
      "the attempt is stamped",
    );
  }));

Deno.test("issue 82 automation: sources stopped on lost authority take their turn, so a healthy source behind a full run of them is still polled", () =>
  withAutomation(async (a) => {
    const { fx } = a;
    const policy = automaticPolicy(fx);
    const perRun = 3;
    const at = instant();
    memoryIssue(a, 111, at, [PLAN_LABEL]);
    fx.reader.setIssueRead(111, LOST_AUTHORITY);
    // One more stopped source than a run takes: each stops on its first read
    // and, stopped, keeps its old `last_synced_at`.
    const stopped: string[] = [];
    for (let n = 0; n <= perRun; n++) {
      stopped.push(await fx.insertSource({ policy }));
    }
    // And a source that is up to date with the fact index, so its step reads
    // nothing, synced an hour ago.
    const healthy = await fx.insertSource({ policy });
    await fx.owner.query(
      `update bakery.ticket_sources
          set sync_checkpoint = $3::jsonb,
              last_synced_at = now() - interval '1 hour'
        where organization_id = $1 and id = $2`,
      [fx.organizationId, healthy, checkpointJson(at, 111)],
    );
    const syncedBefore = (await a.source(healthy)).last_synced_at!;

    const first = await a.poll({ reader: fx.reader, sourcesPerRun: perRun });
    assertEquals(first.sources, perRun);
    assert(first.outcomes.every((entry) => stopped.includes(entry.sourceId)));
    assertEquals(
      first.outcomes.map((entry) => entry.outcome),
      Array(perRun).fill("auth_required"),
    );

    // The next run takes the source the first left out and the healthy one
    // before it repeats a stopped one; the stopped ones cannot hold the front.
    const second = await a.poll({ reader: fx.reader, sourcesPerRun: perRun });
    const polled = second.outcomes.map((entry) => entry.sourceId);
    assert(polled.includes(healthy), "the healthy source is polled");
    const left = stopped.filter((id) =>
      !first.outcomes.some((entry) => entry.sourceId === id)
    );
    assert(polled.includes(left[0]), "the stopped source left out is polled");
    const source = await a.source(healthy);
    assertEquals(source.sync_health, "healthy");
    assert(source.last_synced_at! > syncedBefore);
    for (const id of stopped) {
      assertEquals((await a.source(id)).sync_health, "auth_required");
    }
  }));

Deno.test("issue 82 automation: a source waiting out a rate limit is left off the poll list until its wait is over", () =>
  withAutomation(async (a) => {
    const { fx } = a;
    const policy = automaticPolicy(fx);
    const until = new Date(Date.now() + 3_600_000).toISOString();
    const waiting: string[] = [];
    for (let n = 0; n < 3; n++) waiting.push(await fx.insertSource({ policy }));
    const ready = await fx.insertSource({ policy });
    await fx.owner.query(
      `update bakery.ticket_sources set sync_checkpoint = $2::jsonb
        where id = any($1::uuid[])`,
      [waiting, checkpointJson(null, null, until)],
    );
    await fx.owner.query(
      `update bakery.ticket_sources
          set last_synced_at = now() - interval '1 hour' where id = $1`,
      [ready],
    );

    // Three waiting sources fill the run's cap of three, unless they are left off.
    const run = await a.poll({ reader: fx.reader, sourcesPerRun: 3 });
    assertEquals(run.outcomes.map((entry) => entry.sourceId), [ready]);
    assertEquals((await a.source(waiting[0])).sync_health, "unknown");

    const after = new Date(Date.parse(until) + 1000);
    const listed = await listPollSources(fx.runtime, 10, after);
    assertEquals(listed.length, 4);
  }));

Deno.test("issue 82 automation: a source whose poll step dies on an unexpected error is recorded as an internal failure and the next source is polled in the same run", () =>
  withAutomation(async (a) => {
    const { fx } = a;
    const policy = automaticPolicy(fx);
    const [broken, healthy] = [
      await fx.insertSource({ policy }),
      await fx.insertSource({ policy }),
    ].sort();
    seedLabeler(fx);
    memoryIssue(a, 121, instant(), [PLAN_LABEL]);
    const message = "defect holding the token ghp_abc123 and an issue title";
    const updatedAt = () =>
      fx.owner.query<{ updated_at: Date }>(
        "select updated_at from bakery.ticket_sources where id = $1",
        [broken],
      );
    const before = { row: await a.source(broken), at: await updatedAt() };

    const { value: run, lines } = await logging(() =>
      a.poll({ reader: dyingReader(a, message) })
    );
    assertEquals(run.sources, 2);
    assertEquals(run.outcomes[0], {
      sourceId: broken,
      outcome: "failed",
      health: "degraded",
      problemCode: "internal",
      candidates: 0,
      admitted: 0,
      rechecked: 0,
      errorName: "Error",
      candidateNumber: 121,
    });
    assertEquals(
      [
        run.outcomes[1].sourceId,
        run.outcomes[1].outcome,
        run.outcomes[1].admitted,
      ],
      [healthy, "completed", 1],
    );

    // The source row says the step failed on an internal error, was attempted
    // just now, and moved nothing else: no sync, no position, no version bump.
    const row = await a.source(broken);
    assertEquals(
      [row.sync_health, row.last_problem_code, row.last_synced_at],
      ["degraded", "internal", null],
    );
    const { attemptedAt, ...checkpoint } = row.sync_checkpoint!;
    assert(
      typeof attemptedAt === "string" &&
        Date.now() - Date.parse(attemptedAt) < 60_000,
      "the defect stamps the attempt instant",
    );
    assertEquals(checkpoint, {
      marker: null,
      markerNumber: null,
      cursor: null,
      notBefore: null,
      failure: null,
    });
    assertEquals([row.version, row.policy_revision], [
      before.row.version,
      before.row.policy_revision,
    ]);
    assertEquals((await updatedAt()).rows, before.at.rows);
    assertEquals(await rows(a, broken), 0);

    // One log line: the code, the source, the class and the failing issue
    // number, never the message.
    assertEquals(lines.length, 1);
    assertEquals(JSON.parse(lines[0]), {
      component: "work",
      event: "ticket_poll_step_defect",
      sourceId: broken,
      code: "internal",
      errorName: "Error",
      candidateNumber: 121,
    });
    for (const dropped of ["ghp_abc123", "issue title"]) {
      assert(!lines[0].includes(dropped), dropped);
    }
  }));

Deno.test("issue 82 automation: a defect keeps a source stored as auth_required and its code, and still names the candidate", () =>
  withAutomation(async (a) => {
    const { fx } = a;
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    seedLabeler(fx);
    memoryIssue(a, 131, instant(), [PLAN_LABEL]);
    await fx.owner.query(
      `update bakery.ticket_sources
          set sync_health = 'auth_required', last_problem_code = 'auth_required'
        where id = $1`,
      [sourceId],
    );

    const { value: run } = await logging(() =>
      a.poll({ reader: dyingReader(a, "boom") })
    );
    assertEquals(
      run.outcomes.map((entry) => [
        entry.outcome,
        entry.health,
        entry.problemCode,
        entry.candidateNumber,
      ]),
      [["failed", "auth_required", "internal", 131]],
    );

    // Lost authority needs a person, so the defect leaves it and its code on
    // the row; the attempt is still stamped and nothing else moved.
    const row = await a.source(sourceId);
    assertEquals(
      [row.sync_health, row.last_problem_code, row.last_synced_at],
      ["auth_required", "auth_required", null],
    );
    assert(
      /^20\d\d-/.test(String(row.sync_checkpoint!.attemptedAt)),
      "the attempt is stamped",
    );
  }));

Deno.test("issue 82 automation: an admission or a recheck that dies inside its transaction names its candidate in the outcome and the log, and writes nothing", async () => {
  for (const known of [false, true]) {
    await withAutomation(async (a) => {
      const { fx } = a;
      const label = known ? "recheck" : "admission";
      const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
      seedLabeler(fx);
      const number = known ? 171 : 172;
      memoryIssue(a, number, instant(), [PLAN_LABEL]);
      if (known) {
        // The request exists; its label is then withdrawn, so a recheck would
        // suspend it.
        const first = await a.poll({ reader: fx.reader });
        assertEquals(first.outcomes[0].admitted, 1, label);
        fx.reader.setIssue({ number, labels: [], updatedAt: instant() });
      }
      const before = await fx.counts(sourceId);
      const message = "defect holding the token ghp_abc123 and an issue title";
      // The first write the candidate makes after its reads fails.
      const database = failingStatements(
        fx.runtime,
        known
          ? "update bakery.ticket_requests"
          : "insert into bakery.ticket_requests",
        message,
      );

      const { value: run, lines } = await logging(() =>
        a.poll({ reader: fx.reader, database })
      );
      assertEquals(run.outcomes, [{
        sourceId,
        outcome: "failed",
        health: "degraded",
        problemCode: "internal",
        candidates: 0,
        admitted: 0,
        rechecked: 0,
        errorName: "Error",
        candidateNumber: number,
      }], label);
      assertEquals(await fx.counts(sourceId), before, label);
      const row = await a.source(sourceId);
      assertEquals(
        [row.sync_health, row.last_problem_code, row.last_synced_at !== null],
        ["degraded", "internal", known],
        label,
      );
      assertEquals(lines.length, 1, label);
      assertEquals(JSON.parse(lines[0]), {
        component: "work",
        event: "ticket_poll_step_defect",
        sourceId,
        code: "internal",
        errorName: "Error",
        candidateNumber: number,
      }, label);
      for (const dropped of ["ghp_abc123", "issue title"]) {
        assert(!lines[0].includes(dropped), `${label}: ${dropped}`);
      }
    });
  }
});

Deno.test("issue 82 automation: a source that died on an unexpected error takes its turn behind the rest and does not hold the front of every run", () =>
  withAutomation(async (a) => {
    const { fx } = a;
    const policy = automaticPolicy(fx);
    const [broken, other] = [
      await fx.insertSource({ policy }),
      await fx.insertSource({ policy }),
    ].sort();
    seedLabeler(fx);
    memoryIssue(a, 122, instant(), [PLAN_LABEL]);

    const { value: first } = await logging(() =>
      a.poll({ reader: dyingReader(a, "boom"), sourcesPerRun: 1 })
    );
    assertEquals(first.outcomes.map((entry) => entry.sourceId), [broken]);
    assertEquals(first.outcomes[0].problemCode, "internal");

    // Both sources were never attempted before; only the stamp of the dead
    // step puts `broken` behind `other`, for it wrote nothing else.
    const second = await a.poll({ reader: fx.reader, sourcesPerRun: 1 });
    assertEquals(second.outcomes.map((entry) => entry.sourceId), [other]);
    assertEquals(second.outcomes[0].outcome, "completed");
  }));

Deno.test("issue 82 automation: a stored notBefore or attemptedAt that is not a fixed-format ISO instant cannot hide a source or send it to the back", () =>
  withAutomation(async (a) => {
    const { fx } = a;
    const policy = automaticPolicy(fx);
    const seed = async (checkpoint: string) => {
      const id = await fx.insertSource({ policy });
      await fx.owner.query(
        "update bakery.ticket_sources set sync_checkpoint = $2::jsonb where id = $1",
        [id, checkpoint],
      );
      return id;
    };
    const corrupt: string[] = [];
    for (const bad of ["zzz", "2999-01-01", "9999-99-99T99:99:99.999Z"]) {
      corrupt.push(await seed(checkpointJson(null, null, bad)));
    }
    const waiting = await seed(
      checkpointJson(
        null,
        null,
        new Date(Date.now() + 3_600_000).toISOString(),
      ),
    );

    // Text of another shape compares greater than any ISO instant, so only
    // the list's own shape check keeps these sources on it. A real wait is
    // still left off.
    const listed = (await listPollSources(fx.runtime, 10)).map((entry) =>
      entry.sourceId
    );
    assertEquals(listed.sort(), [...corrupt].sort());
    assert(!listed.includes(waiting), "a real wait stays off the list");

    // Polled, each step reads the checkpoint as empty and repairs it.
    const run = await a.poll({ reader: fx.reader });
    assertEquals(
      run.outcomes.map((entry) => entry.sourceId).sort(),
      [...corrupt].sort(),
    );
    for (const id of corrupt) {
      const { notBefore, attemptedAt } = (await a.source(id)).sync_checkpoint!;
      assertEquals(notBefore, null);
      assert(/^20\d\d-/.test(String(attemptedAt)), "the attempt is stamped");
    }

    // An attemptedAt of another shape counts as never attempted: first, not last.
    const skewed = await seed(checkpointJson(null, null, null, "zzz"));
    const stamped = await seed(
      checkpointJson(null, null, null, "2026-01-01T00:00:00.000Z"),
    );
    const [front, second] = await listPollSources(fx.runtime, 2);
    assertEquals([front.sourceId, second.sourceId], [skewed, stamped]);
  }));

Deno.test("issue 82 automation: a corrupt attemptedAt alone costs no position, whether the step completes or dies, and the next write restamps it", () =>
  withAutomation(async (a) => {
    const { fx } = a;
    const policy = automaticPolicy(fx);
    seedLabeler(fx);
    memoryIssue(a, 151, instant(), []);
    const seed = async (checkpoint: string) => {
      const id = await fx.insertSource({ policy });
      await fx.owner.query(
        "update bakery.ticket_sources set sync_checkpoint = $2::jsonb where id = $1",
        [id, checkpoint],
      );
      return id;
    };
    // Past every fact, so its step completes with nothing to read.
    const completes = await seed(
      checkpointJson("2030-01-01T00:00:00.000Z", 999, null, "zzz", 7),
    );
    // Before issue 151, so its step reads it and dies; the attempt instant is
    // not even text.
    const failure = { number: 5, code: "provider_unavailable", count: 2 };
    const dies = await seed(
      checkpointJson("2000-01-01T00:00:00.000Z", 1, null, 5, 7, failure),
    );

    const { value: run } = await logging(() =>
      a.poll({ reader: dyingReader(a, "boom") })
    );
    const outcomes = Object.fromEntries(
      run.outcomes.map((entry) => [entry.sourceId, entry.outcome]),
    );
    assertEquals(outcomes, { [completes]: "completed", [dies]: "failed" });

    for (
      const [id, marker, markerNumber, held] of [
        [completes, "2030-01-01T00:00:00.000Z", 999, null],
        [dies, "2000-01-01T00:00:00.000Z", 1, failure],
      ] as const
    ) {
      const kept = (await a.source(id)).sync_checkpoint!;
      assertEquals(
        [kept.marker, kept.markerNumber, kept.cursor, kept.failure],
        [marker, markerNumber, 7, held],
      );
      assert(
        /^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(
          String(kept.attemptedAt),
        ),
        "the next write restamps the attempt",
      );
    }
  }));

Deno.test("issue 82 automation: a provider outage leaves no request and a provider_unavailable report, and the next delivery recovers", () =>
  withAutomation(async (a) => {
    const { fx } = a;
    const github = fx.f.github;
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    a.seedLabeler();
    a.issue(61);
    github.seedIssueDetail(a.repositoryId, 61, { body: "No criteria yet." });
    const [seen] = handled(await a.intake(await a.deliver(61)));
    assertEquals(seen.admission, "unadmitted");
    const reports = (await fx.counts(sourceId)).reports;
    github.seedIssueDetail(a.repositoryId, 61, {
      body: "## Acceptance criteria\n- it retries\n",
    });

    // A ticket Bakery knows records the outage as a report; the request waits.
    github.failNext("issue", "server_error");
    const [outage] = handled(await a.intake(await a.deliver(61)));
    assertEquals([outage.action, outage.admission, outage.problem], [
      "admit",
      "unadmitted",
      "provider_unavailable:provider_error",
    ]);
    const counts = await fx.counts(sourceId);
    assertEquals([counts.reports, counts.requests], [reports + 1, 0]);
    const latest = await latestReport(a, sourceId, 61);
    assertEquals(latest.verdict, "waiting");
    assert(
      latest.checks.some((check) => check.reason === "provider_unavailable"),
    );

    // An issue it has never seen has nothing to store; the outcome says so.
    a.issue(62);
    github.failNext("issue", "server_error");
    const [unknown] = handled(await a.intake(await a.deliver(62)));
    assertEquals([unknown.action, unknown.problem], [
      "none",
      "provider_unavailable:provider_error",
    ]);
    assertEquals((await fx.counts(sourceId)).tickets, counts.tickets);

    const [recovered] = handled(await a.intake(await a.deliver(61)));
    assertEquals(recovered.admission, "admitted");
  }));

Deno.test("issue 82 automation: a poll of 30 labeled issues admits ten new ones per run, looks at no more than 25 candidates, and writes the checkpoint and health only", () =>
  withAutomation(async (a) => {
    const { fx } = a;
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    await fx.insertSource({ policy: automaticPolicy(fx), enabled: false });
    seedLabeler(fx);
    for (let number = 1; number <= 30; number++) {
      const updatedAt = instant();
      memoryIssue(a, number, updatedAt, [PLAN_LABEL]);
      await seedFact(a, number, updatedAt, [PLAN_LABEL]);
    }
    const untouched = await a.source(sourceId);
    const deps = { reader: fx.reader, factIndex: createTicketFactIndex() };
    const seen: number[][] = [];
    for (let run = 1; run <= 3; run++) {
      const { sources, outcomes } = await a.poll(deps);
      assertEquals(sources, 1);
      seen.push([outcomes[0].candidates, outcomes[0].admitted]);
      assertEquals((await fx.counts(sourceId)).requests, run * 10);
    }
    assertEquals(seen, [[10, 10], [20, 10], [25, 10]]);

    const source = await a.source(sourceId);
    assertEquals(
      [source.sync_health, source.last_problem_code],
      ["healthy", null],
    );
    assertEquals(
      [source.version, source.policy_revision],
      [untouched.version, untouched.policy_revision],
    );
    assert(source.last_synced_at !== null);
    assertEquals(source.sync_checkpoint?.markerNumber, 30);
    const counts = await fx.counts(sourceId);
    assertEquals([counts.tickets, counts.tasks, counts.links, counts.runs], [
      30,
      30,
      30,
      0,
    ]);

    // Every request is looked at again, and nothing more is admitted.
    const [again] = (await a.poll(deps)).outcomes;
    assertEquals([again.candidates, again.admitted, again.rechecked], [
      25,
      0,
      25,
    ]);
  }));

Deno.test("issue 82 automation: a poll never infers absence from the fact index", () =>
  withAutomation(async (a) => {
    const { fx } = a;
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    seedLabeler(fx);
    memoryIssue(a, 71, instant(), [PLAN_LABEL]);
    assertEquals((await a.poll({ reader: fx.reader })).outcomes[0].admitted, 1);
    const [before] = await a.requests(sourceId);
    const reports = (await fx.counts(sourceId)).reports;

    // The fact is gone from the index, and a number it never listed is never read.
    a.index.remove(71);
    fx.reader.clearCalls();
    const [outcome] = (await a.poll({ reader: fx.reader })).outcomes;
    assertEquals([outcome.outcome, outcome.rechecked, outcome.admitted], [
      "completed",
      1,
      0,
    ]);
    assertEquals(fx.reader.callsOf("readIssue").map((call) => call.number), [
      71,
    ]);
    const [after] = await a.requests(sourceId);
    assertEquals([after.disposition, after.disposition_reason], [
      before.disposition,
      before.disposition_reason,
    ]);
    assertEquals((await fx.counts(sourceId)).reports, reports);
  }));

Deno.test("issue 82 automation: 120 issues tied at one instant, more than a run's share, are all read over successive polls", () =>
  withAutomation(async (a) => {
    const { fx } = a;
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    const at = instant();
    for (let number = 1; number <= 120; number++) {
      memoryIssue(a, number, at, []);
    }
    let runs = 0;
    while ((await a.source(sourceId)).sync_checkpoint?.markerNumber !== 120) {
      assert(++runs <= 12, "ten new issues per run reach 120 in twelve runs");
      await a.poll({ reader: fx.reader });
    }
    const numbers = fx.reader.callsOf("readIssue").map((call) => call.number);
    assertEquals(runs, 12);
    assertEquals(numbers.length, 120, "each issue is read once");
    assertEquals(new Set(numbers).size, 120);
  }));

Deno.test("issue 82 automation: no backend sits idle in a transaction while the intake function, a poll step, admission or a recheck reads a slow provider", () =>
  withAutomation(async (a) => {
    const { fx } = a;
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    a.seedLabeler();
    seedLabeler(fx);
    const watch = watchTransactions(fx.runtime);
    const database = watch.database;
    // One call at a time: a pool-wide watch only proves this for sequential calls.
    const live = slowReader(fx, a.live);
    a.issue(81);
    handled(
      await a.intake(await a.deliver(81), { reader: live.reader, database }),
    );

    const scripted = slowReader(fx, fx.reader);
    memoryIssue(a, 82, instant(), [PLAN_LABEL]);
    await a.poll({ reader: scripted.reader, database });

    memoryIssue(a, 83, instant());
    const deps = { ...fx.automationDeps(database), reader: scripted.reader };
    const admission = await fx.admit(sourceId, {
      number: 83,
      origin: "webhook",
      deps,
    });
    assertEquals(admission.kind, "admitted");
    await fx.recheck(admission.ticketId!, { origin: "webhook", deps });

    for (const probe of [live, scripted]) {
      assert(probe.samples.length > 0, "the reader was called");
      assertEquals(probe.samples.filter((sample) => sample.idle > 0), []);
    }
    assert(watch.peak() > 0, "the watch saw transactions");
    assertEquals(watch.open(), 0);

    // Control: a read made inside a transaction shows up in the same probe.
    const control = slowReader(fx, fx.reader);
    const { handle } = await fx.inTransaction((transaction) =>
      readSourceHandle(transaction, fx.organizationId, sourceId)
    );
    await withPgTransaction(fx.runtime, async (transaction) => {
      await transaction.query("select 1");
      await control.reader.readIssue(handle, 83, signal);
    });
    assert(control.samples.some((sample) => sample.idle > 0));
  }));
