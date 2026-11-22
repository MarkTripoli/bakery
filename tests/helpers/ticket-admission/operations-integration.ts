import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { installProblemErrorReporter } from "../../../packages/contracts/src/http.ts";
import { withPgTransaction } from "../../../apps/server/src/platform/database.ts";
import { unadmittedError } from "../../../apps/server/src/modules/work/ticket-request-command.ts";
import {
  type RemoteFact,
  upsertFact,
} from "../../../apps/server/src/modules/integrations/remote-facts.ts";
import {
  AFTER_SINCE,
  automaticPolicy,
  BEFORE_SINCE,
  EXECUTE_LABEL,
  HOLD_LABEL,
  insertBareTask,
  recordOpenIssues,
  seedLabeler,
  type TicketFixture,
  withTicketFixture,
} from "./fixtures.ts";
import { assertNoDeadlock, holdRow } from "../lock-race.ts";
import { addMember } from "../durable-questions.ts";
import {
  cleanupSeededOrganizations,
  seedOrganization,
} from "../coordinator-turns.ts";
import {
  factsOf,
  idleInTransaction,
  type Problem,
  read,
  sourceBody,
  sourceFacts,
  type SourceView,
  ticketCall,
  type TicketView,
  UUID_PATTERN,
} from "./operations-http.ts";

/*
 * Issue 82 operations over HTTP on real Postgres, with the fixture's in-memory
 * GitHub reader behind the production ticket routes: source setup and reads,
 * preview, sync, and the rule that no provider read happens while a
 * transaction is open. The fake and the in-memory reader are fixtures, not
 * live GitHub proof.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const SOURCES = "/v1/ticket-sources";
const TICKETS = "/v1/external-tickets";

type Receipt = { operationId: string; status: string };
type RequestView = {
  id: string;
  intent: string;
  origin: string;
  generation: number;
  disposition: string;
  dispositionReason: string | null;
  authorityPrincipalId: string | null;
  workflowRunId: string | null;
  requirementsDigest: string;
  version: number;
};
type Page<T> = { items: T[]; nextCursor: string | null };

/** Seeds `count` open issues; the first `labeled` carry the execute label applied before any window. */
function seedIssues(fx: TicketFixture, count: number, labeled = 0) {
  for (let number = 1; number <= count; number++) {
    const isLabeled = number <= labeled;
    fx.reader.setIssue({
      number,
      labels: isLabeled ? [EXECUTE_LABEL] : [],
    });
    if (isLabeled) {
      fx.reader.setLabelApplied(number, EXECUTE_LABEL, {
        appliedAt: BEFORE_SINCE,
      });
    }
    fx.facts.set(
      number,
      `2026-06-01T00:00:${String(number).padStart(2, "0")}Z`,
    );
  }
}

async function post(
  fx: TicketFixture,
  path: string,
  body: unknown = {},
  extra: Parameters<typeof ticketCall>[3] = {},
) {
  return await ticketCall(fx, "POST", path, { body, ...extra });
}

Deno.test("issue 82 ops: a source is created, read, updated and listed, each change with its audit row and event", async () => {
  await withTicketFixture(async (fx) => {
    seedLabeler(fx);
    const before = Date.now();
    // The client's back-dated `since` is ignored: the server stamps now.
    const policy = fx.policy({ delegation: true });
    const created = await read<SourceView>(
      await post(
        fx,
        SOURCES,
        sourceBody(fx, {
          policy: {
            ...policy,
            automatic: { enabled: true, since: "2020-01-01T00:00:00Z" },
          },
        }),
      ),
      201,
    );
    assertEquals(
      [created.version, created.policyRevision, created.enabled],
      [1, 1, true],
    );
    assertEquals(created.syncHealth, "unknown");
    const since = Date.parse(created.policy.automatic.since!);
    assert(since >= before - 1000 && since <= Date.now() + 1000);
    assertEquals(await sourceFacts(fx, created.id), {
      audit: ["ticketSources.create"],
      events: ["ticket.source_changed"],
      outbox: 0,
    });

    // Refusals write no audit row and no event.
    const refusals: [string, Record<string, unknown>, number][] = [
      ["ticket_source_exists", {}, 409],
      ["repository_required", { repositoryId: undefined }, 422],
      ["repository_mismatch", { repositoryId: crypto.randomUUID() }, 422],
      [
        "delegation_principal_unknown",
        {
          policy: {
            ...policy,
            delegation: {
              principalId: crypto.randomUUID(),
              externalActorIds: ["1"],
            },
          },
        },
        422,
      ],
    ];
    for (const [name, overrides, status] of refusals) {
      const refused = await post(fx, SOURCES, sourceBody(fx, overrides));
      assertEquals(refused.status, status, `${name}: ${await refused.text()}`);
    }
    assertEquals(
      (await sourceFacts(fx, created.id)).audit,
      ["ticketSources.create"],
    );

    const got = await read<SourceView>(
      await ticketCall(fx, "GET", `${SOURCES}/${created.id}`),
      200,
    );
    assertEquals(got, created);
    assertEquals(
      (await ticketCall(fx, "GET", `${SOURCES}/${crypto.randomUUID()}`))
        .status,
      404,
    );

    // Update: If-Match is required and compared.
    const patch = (ifMatch: number | undefined, body: unknown) =>
      ticketCall(fx, "PATCH", `${SOURCES}/${created.id}`, { body, ifMatch });
    assertEquals((await patch(undefined, { enabled: false })).status, 428);
    assertEquals((await patch(7, { enabled: false })).status, 412);
    assertEquals((await patch(1, {})).status, 422);
    // A policy change keeps `since` while automatic stays on, and advances the revision.
    const changed = await read<SourceView>(
      await patch(1, {
        policy: {
          ...policy,
          approval: { plan: "human_approval" },
          automatic: { enabled: true, since: "2019-01-01T00:00:00Z" },
        },
      }),
      200,
    );
    assertEquals([changed.version, changed.policyRevision], [2, 2]);
    assertEquals(
      changed.policy.automatic.since,
      created.policy.automatic.since,
    );
    // A toggle of `enabled` alone moves the version, not the policy revision.
    const disabled = await read<SourceView>(
      await patch(2, { enabled: false }),
      200,
    );
    assertEquals(
      [disabled.version, disabled.policyRevision, disabled.enabled],
      [3, 2, false],
    );
    // Off clears `since`; on again stamps a new one.
    const off = await read<SourceView>(
      await patch(3, {
        policy: { ...policy, automatic: { enabled: false } },
      }),
      200,
    );
    assertEquals(off.policy.automatic.since, null);
    const on = await read<SourceView>(
      await patch(4, {
        policy: {
          ...policy,
          automatic: { enabled: true, since: "2019-01-01T00:00:00Z" },
        },
      }),
      200,
    );
    assert(Date.parse(on.policy.automatic.since!) > since);
    assertEquals(on.policyRevision, 4);
    assertEquals((await sourceFacts(fx, created.id)).audit, [
      "ticketSources.create",
      ...Array(4).fill("ticketSources.update"),
    ]);
    assertEquals(
      (await sourceFacts(fx, created.id)).events.length,
      5,
      "one ticket.source_changed per change",
    );

    // List: newest first, cursor pages, filters bound into the cursor.
    const second = await fx.insertSource({ externalContainerId: "extra-2" });
    const third = await fx.insertSource({
      externalContainerId: "extra-3",
      enabled: false,
    });
    const first = await read<Page<SourceView>>(
      await ticketCall(fx, "GET", `${SOURCES}?limit=2`),
      200,
    );
    assertEquals(first.items.map((item) => item.id), [third, second]);
    assert(first.nextCursor !== null);
    const rest = await read<Page<SourceView>>(
      await ticketCall(
        fx,
        "GET",
        `${SOURCES}?limit=2&cursor=${first.nextCursor}`,
      ),
      200,
    );
    assertEquals(rest.items.map((item) => item.id), [created.id]);
    assertEquals(rest.nextCursor, null);
    const onlyDisabled = await read<Page<SourceView>>(
      await ticketCall(fx, "GET", `${SOURCES}?enabled=false`),
      200,
    );
    assertEquals(
      onlyDisabled.items.map((item) => item.id).sort(),
      [created.id, third].sort(),
    );
    for (
      const query of [
        `limit=2&enabled=false&cursor=${first.nextCursor}`,
        "cursor=not-a-cursor",
      ]
    ) {
      const refused = await ticketCall(fx, "GET", `${SOURCES}?${query}`);
      assertEquals(refused.status, 400, query);
      assertEquals((await refused.json() as Problem).code, "INVALID_CURSOR");
    }
  });
});

type PreviewResult = {
  sourceId: string;
  policyRevision: number;
  draft: boolean;
  evaluatedAt: string;
  counts: {
    wouldStart: number;
    planOnly: number;
    held: number;
    blocked: number;
    labeledBeforeWindow?: number;
  };
  issues: {
    number: number;
    title: string | null;
    outcome: string;
    verdict: string;
    reasons: string[];
  }[];
  skipped: number;
};

/** Every count a preview must leave alone: it judges and stores nothing. */
const NOTHING_STORED = {
  tickets: 0,
  reports: 0,
  links: 0,
  requests: 0,
  nonterminalRequests: 0,
  tasks: 0,
  conversations: 0,
  runs: 0,
};

Deno.test("issue 69 preview: the saved policy and a draft are judged with counts, and nothing is stored", async () => {
  await withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    seedLabeler(fx);
    seedIssues(fx, 4);
    // Issue 1 would start: labeled inside the window by an allowlisted writer.
    fx.reader.setIssue({ number: 1, labels: [EXECUTE_LABEL] });
    fx.reader.setLabelApplied(1, EXECUTE_LABEL, { appliedAt: AFTER_SINCE });
    // Issue 2 is held, whatever else it carries.
    fx.reader.setIssue({ number: 2, labels: [EXECUTE_LABEL, HOLD_LABEL] });
    fx.reader.setLabelApplied(2, EXECUTE_LABEL, { appliedAt: AFTER_SINCE });
    // Issue 3 carries a label only the draft names as its execute label.
    fx.reader.setIssue({ number: 3, labels: ["go"] });
    fx.reader.setLabelApplied(3, "go", { appliedAt: AFTER_SINCE });
    const path = `${SOURCES}/${sourceId}/previews`;

    const requestId = "not-a-uuid";
    const key = crypto.randomUUID();
    const saved = await read<PreviewResult>(
      await post(fx, path, {}, { key, headers: { "X-Request-Id": requestId } }),
      201,
    );
    assertEquals(
      [saved.sourceId, saved.policyRevision, saved.draft, saved.skipped],
      [sourceId, 1, false, 0],
    );
    assertEquals(
      saved.issues.map((issue) => [issue.number, issue.outcome]),
      [
        [1, "would_start"],
        [2, "held"],
        [3, "blocked"],
        [4, "blocked"],
      ],
      JSON.stringify(saved.issues),
    );
    assertEquals(saved.counts, {
      wouldStart: 1,
      planOnly: 0,
      held: 1,
      blocked: 2,
      labeledBeforeWindow: 0,
    });
    assertEquals(saved.issues[0].verdict, "ready");
    assertEquals(saved.issues[0].reasons, []);
    assert(saved.issues[2].reasons.length > 0, "a blocked issue says why");
    assert(!Number.isNaN(Date.parse(saved.evaluatedAt)));
    assertEquals(await fx.counts(sourceId), NOTHING_STORED);
    assertEquals(await sourceFacts(fx, sourceId), {
      audit: ["ticketSources.preview"],
      events: ["ticket.preview_requested"],
      outbox: 0,
    });

    // The same key answers from the stored response without asking GitHub again.
    const calls = fx.reader.calls.length;
    const replay = await read<PreviewResult>(
      await post(fx, path, {}, { key }),
      201,
    );
    assertEquals(replay, saved);
    assertEquals(fx.reader.calls.length, calls);

    // A draft that renames the execute label and adds a plan-only label is
    // judged under its own labels; the saved policy and revision do not move.
    const draft = automaticPolicy(fx, {});
    const draftBody = {
      policy: {
        ...draft,
        labels: { execute: "go", planOnly: EXECUTE_LABEL, hold: HOLD_LABEL },
      },
    };
    const judged = await read<PreviewResult>(
      await post(fx, path, draftBody),
      201,
    );
    assertEquals(judged.draft, true);
    assertEquals(judged.policyRevision, 1);
    assertEquals(judged.issues.map((issue) => [issue.number, issue.outcome]), [
      [1, "plan_only"],
      [2, "held"],
      [3, "would_start"],
      [4, "blocked"],
    ]);
    assertEquals(judged.counts, {
      wouldStart: 1,
      planOnly: 1,
      held: 1,
      blocked: 1,
      labeledBeforeWindow: 0,
    });
    assertEquals(await fx.counts(sourceId), NOTHING_STORED);
    const stored = await read<SourceView>(
      await ticketCall(fx, "GET", `${SOURCES}/${sourceId}`),
      200,
    );
    assertEquals(
      [
        stored.policyRevision,
        stored.version,
        (stored.policy as unknown as { labels: { execute: string } }).labels
          .execute,
      ],
      [1, 1, EXECUTE_LABEL],
    );

    // A draft with automatic admission off starts nothing by itself.
    const off = await read<PreviewResult>(
      await post(fx, path, {
        policy: { ...draft, automatic: { enabled: false } },
      }),
      201,
    );
    assertEquals(off.counts.wouldStart, 0);

    // Filters narrow the issues judged: by number, then by label.
    const byNumber = await read<PreviewResult>(
      await post(fx, path, { filters: { numbers: [3, 1, 3] } }),
      201,
    );
    assertEquals(byNumber.issues.map((issue) => issue.number), [3, 1]);
    const byLabel = await read<PreviewResult>(
      await post(fx, path, { filters: { labels: [HOLD_LABEL] } }),
      201,
    );
    assertEquals(byLabel.issues.map((issue) => issue.number), [2]);
    assertEquals((await post(fx, path, { filters: {} })).status, 201);

    // A refused filter or draft reads nothing and writes no audit row.
    const audits = (await sourceFacts(fx, sourceId)).audit.length;
    const before = fx.reader.calls.length;
    const refusals: [unknown, string][] = [
      [{ filters: { repositories: ["x"] } }, "filters_invalid"],
      [{ filters: { numbers: [] } }, "filters_invalid"],
      [
        { policy: { ...draft, labels: { execute: "" } } },
        "ticket_source_policy_invalid",
      ],
    ];
    for (const [body, code] of refusals) {
      const refused = await post(fx, path, body);
      assertEquals(refused.status, 422, code);
      assertEquals((await refused.json() as Problem).issues?.[0].code, code);
    }
    assertEquals(fx.reader.calls.length, before);
    // A draft delegating to a principal outside the organization is refused.
    const stranger = await post(fx, path, {
      policy: {
        ...draft,
        delegation: {
          principalId: crypto.randomUUID(),
          externalActorIds: ["1"],
        },
      },
    });
    assertEquals(stranger.status, 422);
    assertEquals(
      (await stranger.json() as Problem).issues?.[0].code,
      "delegation_principal_unknown",
    );
    assertEquals((await sourceFacts(fx, sourceId)).audit.length, audits);
    assertEquals(await fx.counts(sourceId), NOTHING_STORED);

    // A page the provider cannot list is DEPENDENCY_UNAVAILABLE and writes nothing.
    fx.reader.failNext("listIssues");
    const down = await post(fx, path);
    assertEquals(down.status, 503, await down.clone().text());
    assertEquals((await down.json() as Problem).code, "DEPENDENCY_UNAVAILABLE");
    assertEquals((await sourceFacts(fx, sourceId)).audit.length, audits);

    // A developer may not preview, and is refused before any read.
    const reads = fx.reader.calls.length;
    const developer = await post(fx, path, {}, {
      cookie: fx.f.developerCookie,
    });
    assertEquals(developer.status, 403);
    assertEquals(fx.reader.calls.length, reads);
  }, { budget: true });
});

Deno.test("issue 69 preview: an issue a poll already recorded keeps its stored report and row", async () => {
  await withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource();
    seedIssues(fx, 2);
    await previewAll(fx, sourceId);
    const before = await fx.counts(sourceId);
    assertEquals([before.tickets, before.reports], [2, 2]);
    // An edit the provider shows would change the snapshot and the report.
    fx.reader.setIssue({ number: 1, labels: [EXECUTE_LABEL], body: "Edited." });
    const judged = await read<PreviewResult>(
      await post(fx, `${SOURCES}/${sourceId}/previews`),
      201,
    );
    assertEquals(judged.issues.length, 2);
    assertEquals(await fx.counts(sourceId), before);
    const ticket = await ticketOf(fx, sourceId, 1) as unknown as {
      snapshot: { labels: string[] };
    };
    assertEquals(ticket.snapshot.labels, []);
  });
});

type LinkView = {
  id: string;
  externalTicketId: string;
  taskId: string;
  role: string;
  syncHealth: string;
  statusCommentExternalId: string | null;
  lastProblemCode: string | null;
};

Deno.test("issue 69 reads: links list from either side, keyset paged, and PRs filter by ticket", async () => {
  await withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource();
    seedIssues(fx, 2);
    await previewAll(fx, sourceId);
    const first = await ticketOf(fx, sourceId, 1);
    const second = await ticketOf(fx, sourceId, 2);
    const tasks = [
      await fx.createPlainTask(),
      await fx.createPlainTask(),
      await fx.createPlainTask(),
    ];
    for (const taskId of tasks) {
      await read(
        await post(fx, `${TICKETS}/${first.id}/links`, {
          taskId,
          role: "reference",
        }),
        201,
      );
    }
    await read(
      await post(fx, `${TICKETS}/${second.id}/links`, {
        taskId: tasks[0],
        role: "reference",
      }),
      201,
    );
    const LINKS = "/v1/ticket-task-links";
    const list = (query: string, cookie?: string) =>
      ticketCall(
        fx,
        "GET",
        `${LINKS}?${query}`,
        cookie === undefined ? {} : { cookie },
      );

    // By ticket: newest first, two pages of two then one.
    const page1 = await read<Page<LinkView>>(
      await list(`externalTicketId=${first.id}&limit=2`),
      200,
    );
    assertEquals(page1.items.length, 2);
    assert(page1.nextCursor !== null);
    const page2 = await read<Page<LinkView>>(
      await list(
        `externalTicketId=${first.id}&limit=2&cursor=${
          encodeURIComponent(page1.nextCursor!)
        }`,
      ),
      200,
    );
    assertEquals(page2.nextCursor, null);
    const byTicket = [...page1.items, ...page2.items];
    assertEquals(
      byTicket.map((link) => link.taskId).sort(),
      [...tasks].sort(),
    );
    assert(byTicket.every((link) => link.externalTicketId === first.id));
    assert(
      byTicket.every((link) =>
        link.role === "reference" && link.syncHealth === "unknown" &&
        link.statusCommentExternalId === null
      ),
    );
    // A cursor is bound to its filters.
    const rebound = await list(
      `externalTicketId=${second.id}&cursor=${
        encodeURIComponent(page1.nextCursor!)
      }`,
    );
    assertEquals(rebound.status, 400);
    assertEquals((await rebound.json() as Problem).code, "INVALID_CURSOR");

    // By task: the task's tickets; the role filter narrows.
    const byTask = await read<Page<LinkView>>(
      await list(`taskId=${tasks[0]}`),
      200,
    );
    assertEquals(
      byTask.items.map((link) => link.externalTicketId).sort(),
      [first.id, second.id].sort(),
    );
    assertEquals(
      (await read<Page<LinkView>>(
        await list(`taskId=${tasks[0]}&role=primary`),
        200,
      )).items,
      [],
    );

    // Exactly one side; a developer may read.
    for (
      const query of ["", `externalTicketId=${first.id}&taskId=${tasks[0]}`]
    ) {
      const refused = await list(query);
      assertEquals(refused.status, 422, query);
      assertEquals(
        (await refused.json() as Problem).issues?.[0].code,
        "ticket_task_link_scope_required",
      );
    }
    assertEquals(
      (await list(`taskId=${tasks[0]}`, fx.f.developerCookie)).status,
      200,
    );

    // Another organization's task, and an unknown ticket, are 404.
    const foreignOrganization = crypto.randomUUID();
    await fx.owner.query(
      `insert into bakery.organizations (id, name, slug, created_at, updated_at)
       values ($1, 'Foreign', $2, now(), now())`,
      [foreignOrganization, `foreign-${foreignOrganization}`],
    );
    const foreignApplication = crypto.randomUUID();
    await fx.owner.query(
      `insert into bakery.applications (id, organization_id, slug, name, description)
       values ($1, $2, $3, 'foreign', '')`,
      [foreignApplication, foreignOrganization, `app-${foreignApplication}`],
    );
    const foreignTask = await insertBareTask({
      owner: fx.owner,
      organizationId: foreignOrganization,
      applicationId: foreignApplication,
      adminId: fx.adminId,
    });
    try {
      assertEquals((await list(`taskId=${foreignTask}`)).status, 404);
    } finally {
      // The foreign rows name the fixture's admin; the fixture's teardown
      // removes that principal, so they go first.
      await fx.owner.query(
        `delete from bakery.tasks where organization_id = $1`,
        [foreignOrganization],
      );
      await fx.owner.query(
        `delete from bakery.conversations where organization_id = $1`,
        [foreignOrganization],
      );
      await fx.owner.query(
        `delete from bakery.applications where organization_id = $1`,
        [foreignOrganization],
      );
      await fx.owner.query(
        `delete from bakery.organizations where id = $1`,
        [foreignOrganization],
      );
    }
    assertEquals(
      (await list(`externalTicketId=${crypto.randomUUID()}`)).status,
      404,
    );

    // Pull requests filter by ticket through the links.
    const pull = async (taskId: string, number: number) => {
      await fx.owner.query(
        `insert into bakery.pull_requests (
           id, organization_id, task_id, repository_id, provider_number, url,
           head_sha, base_sha, status, version
         ) values ($1, $2, $3, $4, $5, $6, $7, $7, 'open', 1)`,
        [
          crypto.randomUUID(),
          fx.organizationId,
          taskId,
          fx.repositoryId,
          number,
          `https://example.test/pull/${number}`,
          "a".repeat(40),
        ],
      );
    };
    await pull(tasks[1], 11);
    await pull(tasks[2], 12);
    const unlinked = await fx.createPlainTask();
    await pull(unlinked, 13);
    const pulls = (ticketId: string) =>
      ticketCall(fx, "GET", `/v1/pull-requests?externalTicketId=${ticketId}`)
        .then((response) =>
          read<Page<{ providerNumber: number }>>(response, 200)
        );
    assertEquals(
      (await pulls(first.id)).items.map((item) => item.providerNumber),
      [11, 12],
    );
    assertEquals((await pulls(second.id)).items, []);
    assertEquals((await pulls(crypto.randomUUID())).items, []);
  });
});

/** Inserts a primary link for a fresh task of the source, as an admission would; returns its id. */
async function insertPrimaryLink(fx: TicketFixture, ticketId: string) {
  const taskId = await fx.createPlainTask();
  const id = crypto.randomUUID();
  await fx.owner.query(
    `insert into bakery.ticket_task_links (
       id, organization_id, external_ticket_id, task_id, role
     ) values ($1, $2, $3, $4, 'primary')`,
    [id, fx.organizationId, ticketId, taskId],
  );
  return { id, taskId };
}

type NoteLink = LinkView & { version: number };

Deno.test("issue 69 note: a resync posts Bakery's note, rewrites it in place, re-creates a deleted one and records failures", async () => {
  await withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource();
    seedIssues(fx, 1);
    await previewAll(fx, sourceId);
    const ticket = await ticketOf(fx, sourceId, 1);
    const { id, taskId } = await insertPrimaryLink(fx, ticket.id);
    const path = `/v1/ticket-task-links/${id}/note-syncs`;

    // The writer refuses: the link records failed with the code, version moves twice.
    fx.notes.next.push({ kind: "failed", problemCode: "auth_forbidden" });
    const failed = await read<NoteLink>(
      await post(fx, path, {}, { ifMatch: 1 }),
      201,
    );
    assertEquals(
      [
        failed.syncHealth,
        failed.lastProblemCode,
        failed.statusCommentExternalId,
        failed.version,
      ],
      ["failed", "auth_forbidden", null, 3],
    );
    assertEquals(fx.notes.posts.length, 1);
    const asked = fx.notes.posts[0];
    assertEquals(
      [asked.provider, asked.connectionId, asked.resourceId, asked.issueNumber],
      ["github", fx.connectionId, fx.resource.id, 1],
    );
    assertEquals(asked.actorPrincipalId, fx.adminId);
    assert(asked.body.startsWith("Bakery is working on this issue."));

    // A stale If-Match is refused before any write; none at all is required.
    assertEquals((await post(fx, path, {}, { ifMatch: 1 })).status, 412);
    assertEquals((await post(fx, path, {})).status, 428);
    assertEquals(fx.notes.posts.length, 1);

    // The retry posts: healthy with the provider's comment id.
    const key = crypto.randomUUID();
    const healthy = await read<NoteLink>(
      await post(fx, path, {}, { ifMatch: 3, key }),
      201,
    );
    assertEquals(
      [
        healthy.syncHealth,
        healthy.lastProblemCode,
        healthy.statusCommentExternalId,
        healthy.version,
      ],
      ["healthy", null, "1001", 5],
    );
    assertEquals(fx.notes.posts.length, 2);
    // The same key answers from the stored response without writing again.
    assertEquals(
      await read(await post(fx, path, {}, { ifMatch: 3, key }), 201),
      healthy,
    );
    assertEquals(fx.notes.posts.length, 2);
    // A later resync rewrites the same comment in place with the new text.
    await fx.owner.query(
      `update bakery.tasks set title = 'renamed task' where id = $1`,
      [taskId],
    );
    const rewritten = await read<NoteLink>(
      await post(fx, path, {}, { ifMatch: 5 }),
      201,
    );
    assertEquals(
      [
        rewritten.syncHealth,
        rewritten.statusCommentExternalId,
        rewritten.lastProblemCode,
        rewritten.version,
      ],
      ["healthy", "1001", null, 7],
    );
    assertEquals(fx.notes.posts.at(-1)?.existingExternalId, "1001");
    assert(fx.notes.comments.get("1001")!.includes("Task: `renamed task`"));
    assertEquals(fx.notes.comments.size, 1);

    // A note deleted on the provider is posted again under a new id, and the
    // link says so.
    fx.notes.comments.delete("1001");
    const recreated = await read<NoteLink>(
      await post(fx, path, {}, { ifMatch: 7 }),
      201,
    );
    assertEquals(
      [
        recreated.syncHealth,
        recreated.statusCommentExternalId,
        recreated.lastProblemCode,
        recreated.version,
      ],
      ["healthy", "1002", "note_recreated", 9],
    );
    assert(fx.notes.comments.has("1002"));

    // A provider failure on a rewrite is recorded as failed, the id kept.
    fx.notes.next.push({ kind: "failed", problemCode: "note_failed" });
    const refusedWrite = await read<NoteLink>(
      await post(fx, path, {}, { ifMatch: 9 }),
      201,
    );
    assertEquals(
      [
        refusedWrite.syncHealth,
        refusedWrite.statusCommentExternalId,
        refusedWrite.lastProblemCode,
      ],
      ["failed", "1002", "note_failed"],
    );
    const notesWritten = fx.notes.posts.length;

    // The link list shows the note's state.
    const listed = await read<Page<LinkView>>(
      await ticketCall(fx, "GET", `/v1/ticket-task-links?taskId=${taskId}`),
      200,
    );
    assertEquals(listed.items.map((link) => link.syncHealth), ["failed"]);
    assertEquals(
      (await factsOf(fx, "ticket_task_link", id)).audit,
      Array(5).fill("ticketTaskLinks.resyncNote"),
    );

    // A reference link carries no note.
    const reference = await read<NoteLink>(
      await post(fx, `${TICKETS}/${ticket.id}/links`, {
        taskId: await fx.createPlainTask(),
        role: "reference",
      }),
      201,
    );
    const refused = await post(
      fx,
      `/v1/ticket-task-links/${reference.id}/note-syncs`,
      {},
      { ifMatch: reference.version },
    );
    assertEquals(refused.status, 422);
    assertEquals(
      (await refused.json() as Problem).issues?.[0].code,
      "note_requires_primary_link",
    );
    // Another organization's link (here: none by that id) is 404.
    assertEquals(
      (await post(
        fx,
        `/v1/ticket-task-links/${crypto.randomUUID()}/note-syncs`,
        {},
        { ifMatch: 1 },
      )).status,
      404,
    );
    assertEquals(fx.notes.posts.length, notesWritten);
  });
});

Deno.test("issue 69 note: a resync is refused while a write of the same link is in flight", async () => {
  await withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource();
    seedIssues(fx, 1);
    await previewAll(fx, sourceId);
    const ticket = await ticketOf(fx, sourceId, 1);
    const { id } = await insertPrimaryLink(fx, ticket.id);
    const path = `/v1/ticket-task-links/${id}/note-syncs`;
    let release!: () => void;
    fx.notes.hold = new Promise((resolve) => (release = resolve));
    const first = post(fx, path, {}, { ifMatch: 1 });
    // Wait until the claim committed and the write started.
    for (let tries = 0; fx.notes.posts.length === 0 && tries < 200; tries++) {
      await sleep(25);
    }
    assertEquals(fx.notes.posts.length, 1);
    const claimed = await fx.owner.query<
      { sync_health: string; version: number }
    >(
      `select sync_health, version from bakery.ticket_task_links where id = $1`,
      [id],
    );
    assertEquals(claimed.rows[0], { sync_health: "pending", version: 2 });
    // The second ask, at the claimed version, is refused and writes nothing.
    const second = await post(fx, path, {}, { ifMatch: 2 });
    assertEquals(second.status, 409);
    assertEquals(
      (await second.json() as Problem).reason,
      "note_sync_in_flight",
    );
    assertEquals(fx.notes.posts.length, 1);
    release();
    const done = await read<NoteLink>(await first, 201);
    assertEquals([done.syncHealth, done.version], ["healthy", 3]);
    // A claim older than the in-flight window no longer holds the link.
    await fx.owner.query(
      `update bakery.ticket_task_links
          set sync_health = 'pending', updated_at = now() - interval '1 hour',
              version = version + 1
        where id = $1`,
      [id],
    );
    fx.notes.hold = null;
    const revived = await read<NoteLink>(
      await post(fx, path, {}, { ifMatch: 4 }),
      201,
    );
    assertEquals(revived.syncHealth, "healthy");
  });
});

Deno.test("issue 69 note: only a Developer may resync; a viewer is refused before any write", async () => {
  await withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource();
    seedIssues(fx, 1);
    await previewAll(fx, sourceId);
    const ticket = await ticketOf(fx, sourceId, 1);
    const { id } = await insertPrimaryLink(fx, ticket.id);
    const path = `/v1/ticket-task-links/${id}/note-syncs`;
    try {
      const viewer = await addMember(
        fx.f,
        {
          organizationId: fx.organizationId,
          principalId: fx.adminId,
          cookie: fx.f.adminCookie,
          applicationId: fx.applicationId,
          repositoryId: fx.repositoryId,
          conversationId: "",
          agentVersionId: "",
        },
        "note-viewer",
        "viewer",
      );
      const asViewer = await post(fx, path, {}, {
        ifMatch: 1,
        cookie: viewer.cookie,
      });
      assertEquals(asViewer.status, 403);
      assertEquals(fx.notes.posts.length, 0);
      const untouched = await fx.owner.query<{ sync_health: string }>(
        `select sync_health from bakery.ticket_task_links where id = $1`,
        [id],
      );
      assertEquals(untouched.rows[0].sync_health, "unknown");
      // The developer may, and the write runs as them.
      const asDeveloper = await read<NoteLink>(
        await post(fx, path, {}, { ifMatch: 1, cookie: fx.f.developerCookie }),
        201,
      );
      assertEquals(asDeveloper.syncHealth, "healthy");
      assertEquals(fx.notes.posts[0].actorPrincipalId, fx.developerId);
    } finally {
      await cleanupSeededOrganizations(fx.f);
    }
  });
});

Deno.test("issue 69: an admin looks up a username on the source's repository, a developer may not", async () => {
  await withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    fx.reader.setRole("octo-writer", {
      kind: "present",
      userId: "583231",
      permission: "write",
    });
    fx.reader.setRole("octo-reader", {
      kind: "present",
      userId: "9919",
      permission: "read",
    });
    const lookup = (login: string, cookie?: string) =>
      ticketCall(
        fx,
        "GET",
        `${SOURCES}/${sourceId}/people/${encodeURIComponent(login)}`,
        cookie === undefined ? {} : { cookie },
      );

    // A writer may trigger; the numeric id is what the trigger list stores.
    assertEquals(await read(await lookup("octo-writer"), 200), {
      login: "octo-writer",
      externalUserId: "583231",
      permission: "write",
      canTrigger: true,
    });
    // A reader is found but may not trigger.
    assertEquals(
      (await read<{ canTrigger: boolean }>(await lookup("octo-reader"), 200))
        .canTrigger,
      false,
    );
    // A username GitHub does not know is 404.
    assertEquals((await lookup("nobody-here")).status, 404);
    // A provider outage is DEPENDENCY_UNAVAILABLE.
    fx.reader.failNext("readActorRole");
    const down = await lookup("octo-writer");
    assertEquals(down.status, 503, await down.clone().text());
    // The lookup reads nothing to record: no audit row or event.
    assertEquals(await sourceFacts(fx, sourceId), {
      audit: [],
      events: [],
      outbox: 0,
    });
    // Admin only: a developer is refused before any read.
    const calls = fx.reader.calls.length;
    assertEquals(
      (await lookup("octo-writer", fx.f.developerCookie)).status,
      403,
    );
    assertEquals(fx.reader.calls.length, calls);
  });
});

Deno.test("issue 69: a lookup refuses a malformed username before any read, waits out a rate limit, and hides another organization's source", async () => {
  await withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    fx.reader.setRole("octo-writer", {
      kind: "present",
      userId: "583231",
      permission: "write",
    });
    const lookup = (
      login: string,
      options: { cookie?: string; organizationId?: string; source?: string } =
        {},
    ) =>
      ticketCall(
        fx,
        "GET",
        `${SOURCES}/${options.source ?? sourceId}/people/${
          encodeURIComponent(login)
        }`,
        {
          ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
          ...(options.organizationId === undefined
            ? {}
            : { organizationId: options.organizationId }),
        },
      );

    // Login rules: letters, digits or single hyphens, no hyphen at either
    // end. A login breaking them is 422 login_invalid and reads nothing.
    fx.reader.clearCalls();
    for (
      const bad of [
        "-octo",
        "octo-",
        "oc--to",
        "octo_cat",
        "octo.cat",
        "octo cat",
      ]
    ) {
      const refused = await lookup(bad);
      assertEquals(refused.status, 422, bad);
      const problem = await refused.json() as Problem;
      assertEquals(problem.code, "UNPROCESSABLE", bad);
      assertEquals(problem.issues?.[0].code, "login_invalid", bad);
    }
    // Over 39 characters breaks the schema's length bound: refused, unread.
    const long = await lookup("a".repeat(40));
    assertEquals(long.status, 400);
    assertEquals((await long.json() as Problem).code, "MALFORMED_REQUEST");
    assertEquals(fx.reader.calls.length, 0);
    // The rules' edges are accepted and read: unknown to the provider, so 404.
    for (const edge of ["a", "a-b", "A1-b2-C3", "a".repeat(39)]) {
      assertEquals((await lookup(edge)).status, 404, edge);
    }
    assertEquals(fx.reader.callsOf("readActorRole").length, 4);

    // A provider rate limit is DEPENDENCY_UNAVAILABLE with the provider's wait.
    fx.reader.failNext("readActorRole", {
      kind: "unavailable",
      reason: "rate_limited",
      retryAfterSeconds: 30,
    });
    const limited = await lookup("octo-writer");
    assertEquals(limited.status, 503);
    const wait = await limited.json() as Problem & {
      retryAfterSeconds?: number;
    };
    assertEquals([wait.code, wait.retryAfterSeconds], [
      "DEPENDENCY_UNAVAILABLE",
      30,
    ]);
    assertEquals((await lookup("octo-writer")).status, 200);

    // Another organization's admin naming this source gets the answer an
    // unknown source gets, and nothing is read for it.
    try {
      const other = await seedOrganization(fx.f, "ticket-lookup-other", {
        role: "admin",
        agent: false,
      });
      const asOther = {
        cookie: other.cookie,
        organizationId: other.organizationId,
      };
      fx.reader.clearCalls();
      const named = await lookup("octo-writer", asOther);
      const absent = await lookup("octo-writer", {
        ...asOther,
        source: crypto.randomUUID(),
      });
      assertEquals(named.status, 404);
      const strip = (body: Record<string, unknown>) => {
        for (const key of ["requestId", "traceId", "instance"]) {
          delete body[key];
        }
        return body;
      };
      assertEquals(
        strip(await named.json()),
        strip(await absent.json()),
        "no existence leak",
      );
      assertEquals(absent.status, 404);
      assertEquals(fx.reader.calls.length, 0);
    } finally {
      await cleanupSeededOrganizations(fx.f);
    }
  });
});

Deno.test("issue 82 ops: preview judges every issue when one read fails", async () => {
  await withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource();
    seedIssues(fx, 3);
    fx.reader.failNext("readIssue");
    const judged = await read<PreviewResult>(
      await post(fx, `${SOURCES}/${sourceId}/previews`),
      201,
    );
    // The failed read is judged as waiting on the provider; the others as read.
    assertEquals(judged.issues.length, 3);
    assertEquals(
      judged.issues.filter((issue) =>
        issue.reasons.includes("provider_unavailable")
      ).length,
      1,
    );
    assertEquals(await fx.counts(sourceId), NOTHING_STORED);
  });
});

Deno.test("issue 82 ops: a preview of 25 issues against a slow provider finishes inside the deadline with no transaction held open", async () => {
  await withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource();
    seedIssues(fx, 30);
    const observed: number[] = [];
    fx.reader.pause = async () => {
      observed.push(await idleInTransaction(fx));
      await sleep(20);
    };
    const started = performance.now();
    const judged = await read<PreviewResult>(
      await post(fx, `${SOURCES}/${sourceId}/previews`),
      201,
    );
    assert(performance.now() - started < 30_000);
    assertEquals(judged.issues.length, 25, "the page is cut at 25");
    assertEquals(await fx.counts(sourceId), NOTHING_STORED);
    // The watch saw the list and each issue read, and none had a transaction open.
    assert(observed.length >= 50, `${observed.length} reads watched`);
    assertEquals(Math.max(...observed), 0);

    // Control: the same observation does see a transaction held open across a wait.
    const held = await withPgTransaction(fx.runtime, async (transaction) => {
      await transaction.query("select 1");
      return await idleInTransaction(fx);
    });
    assert(held >= 1, "the observer sees an idle transaction");
  });
});

const APPLICATION_LOCK =
  "select id from bakery.applications where organization_id = $1 and id = $2 for update";

Deno.test("issue 82 ops locks: a preview and a single-ticket operation on a later ticket of its page never deadlock, in either order", async () => {
  await withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource();
    seedIssues(fx, 3);
    await previewAll(fx, sourceId);
    // A preview stores nothing (#69) and takes no row `for update`, so it no
    // longer queues on the application row the way a writer does. It must
    // still finish beside a single-ticket operation on the last ticket of its
    // page, whichever starts first, with neither a deadlock victim.
    const last = await ticketOf(fx, sourceId, 3);
    const preview = () => post(fx, `${SOURCES}/${sourceId}/previews`);
    const single: [string, () => Promise<Response>][] = [
      ["readiness", () =>
        post(fx, `${TICKETS}/${last.id}/readiness-checks`, {
          expectedSourcePolicyRevision: 1,
        })],
      [
        "request",
        () => post(fx, `${TICKETS}/${last.id}/requests`, requestBody(last)),
      ],
    ];
    const failures: string[] = [];
    const stop = installProblemErrorReporter((error) => {
      const cause = (error as { cause?: unknown })?.cause;
      failures.push(`${error} ${cause ?? ""}`);
    });
    try {
      for (const [name, operation] of single) {
        for (const previewFirst of [true, false]) {
          const label = `${name}, ${previewFirst ? "preview" : name} first`;
          const hold = await holdRow(fx.owner, APPLICATION_LOCK, [
            fx.organizationId,
            fx.applicationId,
          ]);
          const first = previewFirst ? preview() : operation();
          await sleep(200);
          const second = previewFirst ? operation() : preview();
          await sleep(200);
          hold.release();
          await hold.done;
          const outcomes = await Promise.allSettled([first, second]);
          assertEquals(failures, [], label);
          for (const outcome of outcomes) assertNoDeadlock(outcome);
          assertEquals(
            outcomes.map((outcome) =>
              outcome.status === "fulfilled" ? outcome.value.status : "rejected"
            ),
            [201, 201],
            label,
          );
        }
      }
    } finally {
      stop();
    }
  }, { budget: true });
});

Deno.test("issue 82 ops: create, update and sync leave labeled issues unadmitted", async () => {
  await withTicketFixture(async (fx) => {
    seedLabeler(fx);
    seedIssues(fx, 2, 2);
    const created = await read<SourceView>(
      await post(
        fx,
        SOURCES,
        sourceBody(fx, {
          policy: {
            ...fx.policy({ delegation: true }),
            automatic: { enabled: true },
          },
        }),
      ),
      201,
    );
    assertEquals((await fx.counts(created.id)).tickets, 0);
    const sync = `${SOURCES}/${created.id}/syncs`;
    const receipt = await read<Receipt>(await post(fx, sync), 201);
    assertEquals(receipt.status, "completed");
    // Both issues were looked at and recorded as waiting for adoption; nothing was admitted.
    const counts = await fx.counts(created.id);
    assertEquals(
      [
        counts.tickets,
        counts.reports,
        counts.requests,
        counts.tasks,
        counts.runs,
      ],
      [2, 2, 0, 0, 0],
    );
    const verdicts = await fx.owner.query<{ verdict: string }>(
      `select verdict from bakery.ticket_readiness_reports
        where organization_id = $1`,
      [fx.organizationId],
    );
    assertEquals(verdicts.rows.map((row) => row.verdict), [
      "waiting",
      "waiting",
    ]);
    await read(
      await ticketCall(fx, "PATCH", `${SOURCES}/${created.id}`, {
        ifMatch: 1,
        body: {
          policy: {
            ...fx.policy({ delegation: true }),
            approval: { plan: "human_approval" },
            automatic: { enabled: true },
          },
        },
      }),
      200,
    );
    await read<Receipt>(await post(fx, sync), 201);
    assertEquals((await fx.counts(created.id)).requests, 0);
    const health = await read<SourceView>(
      await ticketCall(fx, "GET", `${SOURCES}/${created.id}`),
      200,
    );
    assertEquals(health.syncHealth, "healthy");
    assert(health.lastSyncedAt !== null);
    assertEquals((await sourceFacts(fx, created.id)).audit, [
      "ticketSources.create",
      "ticketSources.sync",
      "ticketSources.update",
      "ticketSources.sync",
    ]);

    // A disabled source is not synced, and the refusal writes no audit row.
    await read(
      await ticketCall(fx, "PATCH", `${SOURCES}/${created.id}`, {
        ifMatch: 2,
        body: { enabled: false },
      }),
      200,
    );
    const refused = await post(fx, sync);
    assertEquals(refused.status, 409);
    assertEquals((await refused.json() as Problem).reason, "source_disabled");
    assertEquals((await sourceFacts(fx, created.id)).audit.length, 5);
  });
});

Deno.test("issue 82 ops: enabling a disabled source restamps the automatic window, so an issue labeled while it was off waits for adoption", async () => {
  await withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    seedLabeler(fx);
    seedIssues(fx, 1, 1);
    const patch = (ifMatch: number, body: unknown) =>
      ticketCall(fx, "PATCH", `${SOURCES}/${sourceId}`, { body, ifMatch });
    const enabledPolicy = (approval: "automatic" | "human_approval") => ({
      ...fx.policy({ delegation: true, approval }),
      automatic: { enabled: true },
    });

    // Off: the revision stays. An allowlisted writer labels the issue inside
    // the old window while the source is off.
    const off = await read<SourceView>(await patch(1, { enabled: false }), 200);
    assertEquals([off.policyRevision, off.policy.automatic.since], [
      1,
      automaticPolicy(fx).automatic.since,
    ]);
    fx.reader.setLabelApplied(1, EXECUTE_LABEL, { appliedAt: AFTER_SINCE });

    // On again: the window restarts at the server clock and the policy changed.
    const before = Date.now();
    const on = await read<SourceView>(await patch(2, { enabled: true }), 200);
    const restamped = Date.parse(on.policy.automatic.since!);
    assert(restamped >= before - 1000, on.policy.automatic.since!);
    assert(restamped > Date.parse(AFTER_SINCE), "after the label was applied");
    assertEquals([on.version, on.policyRevision], [3, 2]);

    // The next sync records the issue as waiting and admits nothing.
    await read<Receipt>(await post(fx, `${SOURCES}/${sourceId}/syncs`), 201);
    assertEquals(await fx.counts(sourceId), {
      tickets: 1,
      reports: 1,
      links: 0,
      requests: 0,
      nonterminalRequests: 0,
      tasks: 0,
      conversations: 0,
      runs: 0,
    });
    // A person can still adopt it.
    const adopted = await read<RequestView>(
      await post(
        fx,
        `${TICKETS}/${(await ticketOf(fx, sourceId, 1)).id}/requests`,
        requestBody(await ticketOf(fx, sourceId, 1), {
          expectedSourcePolicyRevision: 2,
        }),
      ),
      201,
    );
    assertEquals(adopted.origin, "adoption");

    // Enabling a source that is already on changes nothing.
    const same = await read<SourceView>(await patch(3, { enabled: true }), 200);
    assertEquals(same.policy.automatic.since, on.policy.automatic.since);
    assertEquals(same.policyRevision, 2);
    // Enabling it with an edited policy restamps once and moves the revision once.
    await read(await patch(4, { enabled: false }), 200);
    const edited = await read<SourceView>(
      await patch(5, {
        enabled: true,
        policy: enabledPolicy("human_approval"),
      }),
      200,
    );
    assert(
      Date.parse(edited.policy.automatic.since!) >= restamped,
      edited.policy.automatic.since!,
    );
    assertNotEquals(edited.policy.automatic.since, on.policy.automatic.since);
    assertEquals(edited.policyRevision, 3);
  }, { budget: true });
});

Deno.test("issue 82 ops: re-enabling a source with automatic admission re-checks its delegation principal, and the request may replace it", async () => {
  await withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    const patch = (ifMatch: number, body: unknown) =>
      ticketCall(fx, "PATCH", `${SOURCES}/${sourceId}`, { body, ifMatch });
    const current = async () =>
      await read<SourceView>(
        await ticketCall(fx, "GET", `${SOURCES}/${sourceId}`),
        200,
      );
    const off = await read<SourceView>(await patch(1, { enabled: false }), 200);

    // The Developer the source delegates to leaves the organization while it is off.
    await fx.owner.query(
      `update bakery.organization_memberships set status = 'inactive'
        where organization_id = $1 and principal_id = $2`,
      [fx.organizationId, fx.developerId],
    );

    // A plain re-enable restamps the window, so the policy changes and the
    // principal is vetted: refused, and nothing moves.
    const refused = await patch(2, { enabled: true });
    assertEquals(refused.status, 422, await refused.clone().text());
    const problem = await refused.json() as Problem;
    assertEquals(
      problem.reason ?? problem.issues?.[0].code,
      "delegation_principal_unknown",
    );
    assertEquals(await current(), off);
    assertEquals((await sourceFacts(fx, sourceId)).audit, [
      "ticketSources.update",
    ]);

    // The same request with a live member as the delegation succeeds.
    const replaced = await read<SourceView>(
      await patch(2, {
        enabled: true,
        policy: {
          ...fx.policy({ delegation: { principalId: fx.adminId } }),
          automatic: { enabled: true },
        },
      }),
      200,
    );
    assertEquals(
      [replaced.enabled, replaced.version, replaced.policyRevision],
      [true, 3, 2],
    );
    assertEquals(
      (replaced.policy.delegation as { principalId: string }).principalId,
      fx.adminId,
    );
    assertNotEquals(
      replaced.policy.automatic.since,
      off.policy.automatic.since,
    );
  });
});

Deno.test("issue 82 ops: a sync with one failing candidate records the others and marks the source degraded", async () => {
  await withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource();
    seedIssues(fx, 3, 3);
    fx.reader.failNext("readIssue");
    const receipt = await read<Receipt>(
      await post(fx, `${SOURCES}/${sourceId}/syncs`),
      201,
    );
    assertEquals(receipt.status, "completed");
    assertEquals((await fx.counts(sourceId)).tickets, 2);
    const source = await read<SourceView>(
      await ticketCall(fx, "GET", `${SOURCES}/${sourceId}`),
      200,
    );
    assertEquals(source.syncHealth, "degraded");
    assertEquals(source.lastProblemCode, "provider_unavailable");
  });
});

Deno.test("issue 82 ops: a sync against a slow provider holds no transaction open and admits a ready issue with the server budget", async () => {
  await withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    seedLabeler(fx);
    seedIssues(fx, 6, 6);
    // One step takes four new issues from the fact index (a share of ten).
    // Issue 1 was labeled inside the automatic window, so the sync admits it.
    fx.reader.setLabelApplied(1, EXECUTE_LABEL, { appliedAt: AFTER_SINCE });
    const observed: number[] = [];
    fx.reader.pause = async () => {
      observed.push(await idleInTransaction(fx));
      await sleep(10);
    };
    await read<Receipt>(await post(fx, `${SOURCES}/${sourceId}/syncs`), 201);
    assert(observed.length >= 6, `${observed.length} reads watched`);
    assertEquals(Math.max(...observed), 0);
    const counts = await fx.counts(sourceId);
    assertEquals(
      [counts.tickets, counts.nonterminalRequests, counts.tasks, counts.runs],
      [4, 1, 1, 1],
    );

    // The cached tickets show each one's newest report and the request it owns.
    const tickets = (query: string) =>
      ticketCall(fx, "GET", `/v1/external-tickets?${query}`).then((response) =>
        read<Page<TicketView>>(response, 200)
      );
    const linked = await tickets("linked=true");
    assertEquals(linked.items.map((item) => item.number), ["1"]);
    assertEquals(linked.items[0].latestReadiness?.verdict, "ready");
    assertEquals(linked.items[0].activeRequest?.intent, "start");
    const unlinked = await tickets("linked=false");
    assertEquals(unlinked.items.length, 3);
    for (const item of unlinked.items) {
      assertEquals(item.activeRequest, null);
      assert(item.latestReadiness !== null);
    }
    assertEquals((await tickets("state=closed")).items, []);
    const firstPage = await tickets(`sourceId=${sourceId}&limit=3`);
    assertEquals(firstPage.items.length, 3);
    const lastPage = await tickets(
      `sourceId=${sourceId}&limit=3&cursor=${firstPage.nextCursor}`,
    );
    assertEquals(lastPage.items.length, 1);
    assertEquals(lastPage.nextCursor, null);
    const one = linked.items[0];
    assertEquals(
      await read<TicketView>(
        await ticketCall(fx, "GET", `/v1/external-tickets/${one.id}`),
        200,
      ),
      one,
    );
  }, { budget: true });
});

Deno.test("issue 82 ops: a sync reads the stored fact index", async () => {
  await withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource();
    // The reader is never asked to list: candidates come from stored facts.
    fx.reader.setIssue({ number: 1, labels: [EXECUTE_LABEL] });
    fx.reader.setIssue({ number: 2, labels: [EXECUTE_LABEL] });
    fx.reader.setIssue({ number: 3, labels: [] });
    const fact = (number: number): RemoteFact => ({
      organizationId: fx.organizationId,
      resourceId: fx.resource.id,
      kind: "issue",
      externalId: String(1000 + number),
      number,
      headSha: null,
      state: "open",
      conclusion: null,
      providerUpdatedAt: new Date(Date.parse("2026-06-01T00:00:00Z") + number),
      observedStartedAt: new Date(Date.parse("2026-06-01T00:00:05Z") + number),
      summary: { labels: [], locked: false, stateReason: null },
    });
    await withPgTransaction(fx.owner, async (transaction) => {
      for (const number of [1, 2, 3]) {
        await upsertFact(transaction, fact(number));
      }
    });
    await read<Receipt>(await post(fx, `${SOURCES}/${sourceId}/syncs`), 201);
    // The two labeled issues were read and recorded; the unlabeled one was left alone.
    assertEquals((await fx.counts(sourceId)).tickets, 2);
    assertEquals(fx.reader.callsOf("listIssues").length, 0);
    const checkpoint = await fx.owner.query<{ marker_number: number }>(
      `select (sync_checkpoint->>'markerNumber')::int as marker_number
         from bakery.ticket_sources where id = $1`,
      [sourceId],
    );
    assertEquals(checkpoint.rows[0].marker_number, 3);
  }, { liveFactIndex: true });
});

/** The cached ticket of `number`, as `externalTickets.list` shows it. */
async function ticketOf(
  fx: TicketFixture,
  sourceId: string,
  number: number,
): Promise<TicketView> {
  const page = await read<Page<TicketView>>(
    await ticketCall(fx, "GET", `${TICKETS}?sourceId=${sourceId}&limit=100`),
    200,
  );
  const found = page.items.find((item) => item.number === String(number));
  assert(found, `ticket ${number} is cached`);
  return found;
}

/** Records every open seeded issue, so each has a ticket row. */
async function previewAll(fx: TicketFixture, sourceId: string) {
  await recordOpenIssues(fx, sourceId);
}

/** The body `ticketRequests.create` takes for a ticket as the caller last saw it. */
function requestBody(
  ticket: TicketView,
  overrides: Record<string, unknown> = {},
) {
  return {
    intent: "start",
    expectedSourcePolicyRevision: 1,
    requirementsDigest: ticket.requirementsDigest,
    ...overrides,
  };
}

const EDITED_BODY = (criterion: string) =>
  `Edited.\n\n## Acceptance criteria\n- ${criterion}\n`;

Deno.test("issue 82 ops: ticketReadiness.create records a report, refreshes an edited issue and admits nothing", async () => {
  await withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    seedLabeler(fx);
    seedIssues(fx, 2);
    // Issue 2 was labeled by an allowlisted writer inside the automatic window.
    fx.reader.setIssue({ number: 2, labels: [EXECUTE_LABEL] });
    fx.reader.setLabelApplied(2, EXECUTE_LABEL, { appliedAt: AFTER_SINCE });
    await previewAll(fx, sourceId);
    const ticket = await ticketOf(fx, sourceId, 1);
    const path = `${TICKETS}/${ticket.id}/readiness-checks`;
    const body = { expectedSourcePolicyRevision: 1 };
    const key = crypto.randomUUID();
    const receipt = await read<Receipt>(
      await post(fx, path, body, {
        key,
        headers: { "X-Request-Id": "not-a-uuid" },
      }),
      201,
    );
    assert(UUID_PATTERN.test(receipt.operationId), receipt.operationId);
    assertNotEquals(receipt.operationId, "not-a-uuid");
    assertEquals(receipt.status, "completed");
    // An unchanged issue has an unchanged basis, so no new report (one per ticket).
    assertEquals((await fx.counts(sourceId)).reports, 2);
    assertEquals(await factsOf(fx, "external_ticket", ticket.id), {
      audit: ["ticketReadiness.create"],
      events: ["ticket.readiness_requested"],
      outbox: 0,
    });
    // The same key answers from the stored response without asking GitHub.
    const calls = fx.reader.calls.length;
    assertEquals(
      await read<Receipt>(await post(fx, path, body, { key }), 201),
      receipt,
    );
    assertEquals(fx.reader.calls.length, calls);
    assertEquals(
      (await factsOf(fx, "external_ticket", ticket.id)).audit.length,
      1,
    );

    // An edit after the last read: the report and the cached digest move together.
    fx.reader.setIssue({ number: 1, body: EDITED_BODY("a new criterion") });
    await read(await post(fx, path, body), 201);
    const refreshed = await ticketOf(fx, sourceId, 1);
    assertNotEquals(refreshed.requirementsDigest, ticket.requirementsDigest);
    assertEquals(refreshed.latestReadiness?.version, 2);

    // A provider that cannot answer is recorded as a report, not refused.
    fx.reader.failNext("readIssue");
    await read(await post(fx, path, body), 201);
    const down = await ticketOf(fx, sourceId, 1);
    assertEquals(down.latestReadiness?.version, 3);
    assert(
      down.latestReadiness?.checks.some((check) =>
        check.reason === "provider_unavailable"
      ),
    );

    // A labeled issue is judged as a poll judges it: the labeling actor is read.
    const labeled = await ticketOf(fx, sourceId, 2);
    const provenance = fx.reader.callsOf("readLabelProvenance").length;
    await read(
      await post(fx, `${TICKETS}/${labeled.id}/readiness-checks`, body),
      201,
    );
    assert(fx.reader.callsOf("readLabelProvenance").length > provenance);
    assertEquals(
      (await ticketOf(fx, sourceId, 2)).latestReadiness?.verdict,
      "ready",
    );

    // A stale policy revision is refused before GitHub is asked, with no audit row.
    const asked = fx.reader.calls.length;
    assertEquals(
      (await post(fx, path, { expectedSourcePolicyRevision: 9 })).status,
      412,
    );
    assertEquals(fx.reader.calls.length, asked);
    assertEquals(
      (await factsOf(fx, "external_ticket", ticket.id)).audit.length,
      3,
    );
    const counts = await fx.counts(sourceId);
    assertEquals([counts.links, counts.requests, counts.tasks, counts.runs], [
      0,
      0,
      0,
      0,
    ]);
  }, { budget: true });
});

Deno.test("issue 82 ops: ticketTaskLinks.create makes reference links only and refuses every conflict", async () => {
  await withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource();
    seedIssues(fx, 1);
    await previewAll(fx, sourceId);
    const ticket = await ticketOf(fx, sourceId, 1);
    const path = `${TICKETS}/${ticket.id}/links`;
    const taskId = await fx.createPlainTask();
    const link = await read<
      {
        id: string;
        taskId: string;
        role: string;
        syncHealth: string;
        version: number;
      }
    >(await post(fx, path, { taskId, role: "reference" }), 201);
    assertEquals(
      [link.taskId, link.role, link.syncHealth, link.version],
      [taskId, "reference", "unknown", 1],
    );
    assertEquals(await factsOf(fx, "ticket_task_link", link.id), {
      audit: ["ticketTaskLinks.create"],
      events: ["ticket.link_changed"],
      outbox: 0,
    });
    assertEquals((await fx.counts(sourceId)).links, 1);

    // A task of another application of the organization.
    const otherApplication = crypto.randomUUID();
    await fx.owner.query(
      `insert into bakery.applications (id, organization_id, slug, name, description)
       values ($1, $2, $3, 'other', '')`,
      [otherApplication, fx.organizationId, `other-${otherApplication}`],
    );
    const elsewhere = await insertBareTask({
      owner: fx.owner,
      organizationId: fx.organizationId,
      applicationId: otherApplication,
      adminId: fx.adminId,
    });
    const refusals: [string, Record<string, unknown>, number, string][] = [
      ["duplicate", { taskId, role: "reference" }, 409, "ticket_link_exists"],
      [
        "primary",
        { taskId, role: "primary" },
        422,
        "primary_link_requires_admission",
      ],
      [
        "application",
        { taskId: elsewhere, role: "reference" },
        422,
        "task_not_in_source_application",
      ],
    ];
    for (const [name, refused, status, code] of refusals) {
      const response = await post(fx, path, refused);
      assertEquals(response.status, status, name);
      const problem = await response.json() as Problem;
      assertEquals(problem.reason ?? problem.issues?.[0].code, code, name);
    }
    const unknown = await post(fx, path, {
      taskId: crypto.randomUUID(),
      role: "reference",
    });
    assertEquals(unknown.status, 404);
    // Refusals wrote nothing, and a link starts no work.
    assertEquals(
      (await factsOf(fx, "ticket_task_link", link.id)).audit.length,
      1,
    );
    const counts = await fx.counts(sourceId);
    assertEquals([counts.links, counts.requests, counts.runs], [1, 0, 0]);
    const linked = await read<Page<TicketView>>(
      await ticketCall(fx, "GET", `${TICKETS}?linked=true`),
      200,
    );
    assertEquals(linked.items.map((item) => item.id), [ticket.id]);
    // #57: the ticket serves its linked tasks, newest link first, on both
    // reads; an unlinked ticket serves none.
    assertEquals(linked.items[0].linkedTaskIds, [taskId]);
    assertEquals(linked.items[0].linkedTaskCount, 1);
    const second = await fx.createPlainTask();
    await read(
      await post(fx, path, { taskId: second, role: "reference" }),
      201,
    );
    const got = await read<TicketView>(
      await ticketCall(fx, "GET", `${TICKETS}/${ticket.id}`),
      200,
    );
    assertEquals(got.linkedTaskIds, [second, taskId]);
    assertEquals(got.linkedTaskCount, 2);
    const unlinked = await read<Page<TicketView>>(
      await ticketCall(fx, "GET", `${TICKETS}?linked=false`),
      200,
    );
    for (const item of unlinked.items) {
      assertEquals([item.linkedTaskIds, item.linkedTaskCount], [[], 0]);
    }
  });
});

Deno.test("issue 82 ops: ticketRequests.create admits a ready issue as its caller, once, and answers a replay from the stored response", async () => {
  await withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource();
    // Issue 1 carries the request label (a person adopts it); issue 2 does not.
    seedIssues(fx, 2, 1);
    await previewAll(fx, sourceId);
    const plain = await ticketOf(fx, sourceId, 2);
    const key = crypto.randomUUID();
    const path = `${TICKETS}/${plain.id}/requests`;
    const created = await read<RequestView>(
      await post(fx, path, requestBody(plain), { key }),
      201,
    );
    // The server budget policy the mount passes makes the fixed preset ready, so a run starts.
    assertEquals(
      [created.origin, created.intent, created.generation, created.disposition],
      ["manual", "start", 1, "admitted"],
    );
    assertEquals(created.authorityPrincipalId, fx.adminId);
    assertEquals(created.requirementsDigest, plain.requirementsDigest);
    assert(created.workflowRunId !== null);
    const counts = await fx.counts(sourceId);
    assertEquals(
      [counts.links, counts.nonterminalRequests, counts.tasks, counts.runs],
      [1, 1, 1, 1],
    );
    assertEquals(await fx.requestFacts(created.id), {
      audit: ["ticketRequests.create"],
      events: [{ resourceId: created.id, resourceVersion: created.version }],
      outbox: 0,
    });

    // The same key answers from the stored response: GitHub is not asked again.
    const calls = fx.reader.calls.length;
    assertEquals(
      await read(await post(fx, path, requestBody(plain), { key }), 201),
      created,
    );
    assertEquals(fx.reader.calls.length, calls);
    // The same ask under a new key converges on the request that exists.
    const again = await read<RequestView>(
      await post(fx, path, requestBody(plain)),
      201,
    );
    assertEquals(again.id, created.id);
    assertEquals((await fx.counts(sourceId)).nonterminalRequests, 1);

    // The label on issue 1 makes the caller's request an adoption.
    const labeled = await ticketOf(fx, sourceId, 1);
    const adopted = await read<RequestView>(
      await post(
        fx,
        `${TICKETS}/${labeled.id}/requests`,
        requestBody(labeled, { intent: "plan" }),
      ),
      201,
    );
    assertEquals(
      [
        adopted.origin,
        adopted.intent,
        adopted.disposition,
        adopted.workflowRunId,
      ],
      ["adoption", "plan", "waiting", null],
    );
    assertEquals((await fx.counts(sourceId)).runs, 1);
  }, { budget: true });
});

Deno.test("issue 82 ops: ticketRequests.create refuses a stale revision or digest and writes nothing", async () => {
  await withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource();
    seedIssues(fx, 2);
    await previewAll(fx, sourceId);
    const [first, second] = [
      await ticketOf(fx, sourceId, 1),
      await ticketOf(fx, sourceId, 2),
    ];
    const ask = (ticket: TicketView, overrides: Record<string, unknown> = {}) =>
      post(
        fx,
        `${TICKETS}/${ticket.id}/requests`,
        requestBody(ticket, overrides),
      );
    const before = await fx.counts(sourceId);

    // Stale against the cached ticket: refused before GitHub is asked.
    const calls = fx.reader.calls.length;
    for (
      const overrides of [
        { expectedSourcePolicyRevision: 7 },
        { requirementsDigest: "0".repeat(64) },
      ]
    ) {
      const refused = await ask(first, overrides);
      assertEquals(refused.status, 412, JSON.stringify(overrides));
      assertEquals(
        (await refused.json() as Problem).code,
        "PRECONDITION_FAILED",
      );
    }
    assertEquals(fx.reader.calls.length, calls);

    // The issue was edited after the last sync: the caller's digest matches the
    // cache but not the text admission just read. Refused, and the snapshot
    // admission upserted rolls back with it.
    fx.reader.setIssue({
      number: 1,
      body: EDITED_BODY("edited after the sync"),
    });
    assertEquals((await ask(first)).status, 412);
    assertEquals(await fx.counts(sourceId), before);
    assertEquals(
      (await ticketOf(fx, sourceId, 1)).requirementsDigest,
      first.requirementsDigest,
    );
    // Refreshing through a readiness check gives the caller the digest that admits.
    await read(
      await post(fx, `${TICKETS}/${first.id}/readiness-checks`, {
        expectedSourcePolicyRevision: 1,
      }),
      201,
    );
    const refreshed = await ticketOf(fx, sourceId, 1);
    assertNotEquals(refreshed.requirementsDigest, first.requirementsDigest);
    const admitted = await read<RequestView>(await ask(refreshed), 201);
    assertEquals(admitted.requirementsDigest, refreshed.requirementsDigest);

    // The policy moves on while GitHub is being read: the revision is checked
    // again under the source lock, so the stale ask admits nothing.
    const moving = await fx.counts(sourceId);
    fx.reader.pause = async () => {
      fx.reader.pause = null;
      await fx.owner.query(
        `update bakery.ticket_sources set policy_revision = policy_revision + 1
          where id = $1`,
        [sourceId],
      );
    };
    assertEquals((await ask(second)).status, 412);
    assertEquals(await fx.counts(sourceId), moving);
  }, { budget: true });
});

Deno.test("issue 82 ops: ticketRequests.create answers an unready issue with ticket_not_ready and an outage with DEPENDENCY_UNAVAILABLE, writing nothing", async () => {
  await withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource();
    seedIssues(fx, 2);
    fx.reader.setIssue({ number: 1, body: "No acceptance criteria here." });
    await previewAll(fx, sourceId);
    const [unready, ready] = [
      await ticketOf(fx, sourceId, 1),
      await ticketOf(fx, sourceId, 2),
    ];
    const before = await fx.counts(sourceId);

    const refused = await post(
      fx,
      `${TICKETS}/${unready.id}/requests`,
      requestBody(unready),
    );
    assertEquals(refused.status, 409);
    const notReady = await refused.json() as Problem;
    assertEquals(notReady.reason, "ticket_not_ready");

    fx.reader.failNext("readIssue", {
      kind: "unavailable",
      reason: "rate_limited",
      retryAfterSeconds: 30,
    });
    const down = await post(
      fx,
      `${TICKETS}/${ready.id}/requests`,
      requestBody(ready),
    );
    assertEquals(down.status, 503);
    const problem = await down.json() as Problem & {
      retryAfterSeconds?: number;
    };
    assertEquals([problem.code, problem.retryAfterSeconds], [
      "DEPENDENCY_UNAVAILABLE",
      30,
    ]);

    // An issue with more labels than the reader keeps is a fact about the
    // issue, not an outage: a conflict of its own, with nothing to retry after.
    fx.reader.failNext("readIssue", {
      kind: "unavailable",
      reason: "labels_truncated",
      retryAfterSeconds: null,
    });
    const cut = await post(
      fx,
      `${TICKETS}/${ready.id}/requests`,
      requestBody(ready),
    );
    assertEquals(cut.status, 409);
    const truncated = await cut.json() as Problem & {
      retryAfterSeconds?: number;
    };
    assertEquals(
      [truncated.code, truncated.reason, truncated.retryAfterSeconds],
      ["STATE_CONFLICT", "labels_truncated", undefined],
    );

    // None of them wrote a report, a snapshot, a request or an audit row.
    assertEquals(await fx.counts(sourceId), before);
    const audit = await fx.owner.query(
      `select 1 from bakery.audit_events
        where organization_id = $1 and operation like 'ticketRequests.%'`,
      [fx.organizationId],
    );
    assertEquals(audit.rows.length, 0);

    // The wire problem lists the failing checks; the error also carries all
    // of them for the log, and a readiness check records them.
    const result = await fx.admit(sourceId, { number: 1 });
    assertEquals(
      notReady.issues,
      result.report.checks.filter((check) => check.status !== "pass").map(
        (check) => ({
          path: ["checks", check.id],
          code: check.reason,
          message: check.status === "wait"
            ? "The check is waiting."
            : "The check rejects.",
        }),
      ),
    );
    const error = unadmittedError(result.report, {
      issue: { kind: "gone" },
      links: null,
      statuses: null,
      proofs: [],
      provenance: null,
      actorRole: null,
      provenanceLabel: null,
    });
    assertEquals([error.code, error.params?.reason], [
      "STATE_CONFLICT",
      "ticket_not_ready",
    ]);
    assertEquals(error.params?.checks, result.report.checks);
    assert(
      result.report.checks.some((check) =>
        check.id === "acceptance_present" && check.status !== "pass"
      ),
    );
  }, { budget: true });
});

Deno.test("issue 82 ops: a suspended request is refused a stale digest and re-pinned to the current one", async () => {
  await withTicketFixture(async (fx) => {
    // A human plan approval leaves the request waiting with no run, so a re-pin is allowed.
    const sourceId = await fx.insertSource({
      policy: fx.policy({ approval: "human_approval" }),
    });
    seedIssues(fx, 1);
    await previewAll(fx, sourceId);
    const ticket = await ticketOf(fx, sourceId, 1);
    const path = `${TICKETS}/${ticket.id}/requests`;
    const admitted = await read<RequestView>(
      await post(fx, path, requestBody(ticket)),
      201,
    );
    assertEquals([admitted.disposition, admitted.workflowRunId], [
      "waiting",
      null,
    ]);

    // The acceptance text changes (criteria still present): the recheck suspends it.
    fx.reader.setIssue({ number: 1, body: EDITED_BODY("second wording") });
    const rechecked = await fx.recheck(ticket.id);
    assertEquals(rechecked.request?.dispositionReason, "acceptance_changed");
    const suspended = await ticketOf(fx, sourceId, 1);
    assertEquals(suspended.activeRequest?.disposition, "suspended");

    // It changes again before the client looks: its digest matches the cache, not the issue.
    fx.reader.setIssue({ number: 1, body: EDITED_BODY("third wording") });
    assertEquals((await post(fx, path, requestBody(suspended))).status, 412);
    assertEquals(
      (await ticketOf(fx, sourceId, 1)).activeRequest?.dispositionReason,
      "acceptance_changed",
    );

    // After a readiness check the client holds the live digest, and the request is re-pinned.
    await read(
      await post(fx, `${TICKETS}/${ticket.id}/readiness-checks`, {
        expectedSourcePolicyRevision: 1,
      }),
      201,
    );
    const current = await ticketOf(fx, sourceId, 1);
    const repinned = await read<RequestView>(
      await post(fx, path, requestBody(current)),
      201,
    );
    assertEquals(
      [
        repinned.id,
        repinned.disposition,
        repinned.dispositionReason,
        repinned.requirementsDigest,
      ],
      [admitted.id, "waiting", null, current.requirementsDigest],
    );
    assertEquals(
      (await fx.requestFacts(admitted.id)).audit.includes(
        "ticketRequests.repin",
      ),
      true,
    );
  }, { budget: true });
});

Deno.test("issue 82 ops: readiness and request operations hold no transaction open across a slow provider", async () => {
  await withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource();
    seedIssues(fx, 1);
    await previewAll(fx, sourceId);
    const ticket = await ticketOf(fx, sourceId, 1);
    const observed: number[] = [];
    fx.reader.pause = async () => {
      observed.push(await idleInTransaction(fx));
      await sleep(10);
    };
    // One call at a time: the observer reads the whole database's sessions.
    await read(
      await post(fx, `${TICKETS}/${ticket.id}/readiness-checks`, {
        expectedSourcePolicyRevision: 1,
      }),
      201,
    );
    const readiness = observed.length;
    assert(readiness >= 2, `${readiness} reads watched`);
    await read(
      await post(fx, `${TICKETS}/${ticket.id}/requests`, requestBody(ticket)),
      201,
    );
    assert(
      observed.length - readiness >= 2,
      `${observed.length - readiness} reads watched`,
    );
    assertEquals(Math.max(...observed), 0);

    // Control: the observer does see a transaction held open across a wait.
    const held = await withPgTransaction(fx.runtime, async (transaction) => {
      await transaction.query("select 1");
      return await idleInTransaction(fx);
    });
    assert(held >= 1, "the observer sees an idle transaction");
  }, { budget: true });
});

type RequestRead = {
  id: string;
  externalTicketId: string;
  origin: string;
  requestedByPrincipalId: string | null;
  triggerLabelName: string | null;
  disposition: string;
  dispositionReasonCode: string | null;
  pausedAt: string | null;
  pausedReason: string | null;
  progress: string;
  targets: {
    repositoryId: string;
    role: string;
    routingRuleId: string | null;
  }[];
};

Deno.test("issue 69 reads: a ticket's requests list newest first with progress, pause state and targets, and another organization's ids are 404", async () => {
  await withTicketFixture(async (fx) => {
    // Human approval leaves a request waiting with no run.
    const sourceId = await fx.insertSource({
      policy: fx.policy({ approval: "human_approval" }),
    });
    // Issue 1 carries the request label, so a person's request adopts it.
    seedIssues(fx, 2, 1);
    await previewAll(fx, sourceId);
    const plain = await ticketOf(fx, sourceId, 2);
    const path = `${TICKETS}/${plain.id}/requests`;
    const first = await read<RequestView>(
      await post(fx, path, requestBody(plain)),
      201,
    );
    // The first generation ends; a second one is admitted on the same ticket.
    await withPgTransaction(fx.owner, async (transaction) => {
      await transaction.query(
        `update bakery.ticket_requests set disposition = 'canceled',
           disposition_reason = 'task_canceled' where id = $1`,
        [first.id],
      );
    });
    const second = await read<RequestView>(
      await post(fx, path, requestBody(await ticketOf(fx, sourceId, 2))),
      201,
    );
    // The acceptance text changes: the recheck suspends it, and its run pause
    // is recorded as the pause step would.
    fx.reader.setIssue({ number: 2, body: EDITED_BODY("second wording") });
    await fx.recheck(plain.id);
    await withPgTransaction(fx.owner, async (transaction) => {
      await transaction.query(
        `update bakery.ticket_requests set pause_requested_at = now()
          where id = $1`,
        [second.id],
      );
    });

    const list = (query: string) =>
      ticketCall(fx, "GET", `/v1/ticket-requests?${query}`);
    const page1 = await read<Page<RequestRead>>(
      await list(`externalTicketId=${plain.id}&limit=1`),
      200,
    );
    assertEquals(page1.items.map((item) => item.id), [second.id]);
    const newest = page1.items[0];
    assertEquals(
      [
        newest.origin,
        newest.requestedByPrincipalId,
        newest.triggerLabelName,
        newest.disposition,
        newest.dispositionReasonCode,
        newest.pausedReason,
        newest.progress,
      ],
      [
        "manual",
        fx.adminId,
        null,
        "suspended",
        "acceptance_changed",
        "edited_after_setup",
        "suspended",
      ],
    );
    assert(newest.pausedAt !== null);
    // The fallback target: the source's own repository, no rule.
    assertEquals(newest.targets.length, 1);
    assertEquals(newest.targets[0].routingRuleId, null);
    assert(page1.nextCursor !== null);
    const page2 = await read<Page<RequestRead>>(
      await list(
        `externalTicketId=${plain.id}&limit=1&cursor=${
          encodeURIComponent(page1.nextCursor)
        }`,
      ),
      200,
    );
    assertEquals(page2.items.map((item) => item.id), [first.id]);
    assertEquals(
      [
        page2.items[0].progress,
        page2.items[0].dispositionReasonCode,
        page2.items[0].pausedAt,
        page2.items[0].pausedReason,
      ],
      ["canceled", "task_canceled", null, null],
    );
    assertEquals(page2.nextCursor, null);
    // A cursor is bound to its ticket.
    const labeled = await ticketOf(fx, sourceId, 1);
    assertEquals(
      (await list(
        `externalTicketId=${labeled.id}&cursor=${
          encodeURIComponent(page1.nextCursor)
        }`,
      )).status,
      400,
    );

    // An adoption names the label it rested on and the person who asked.
    const adopted = await read<RequestView>(
      await post(
        fx,
        `${TICKETS}/${labeled.id}/requests`,
        requestBody(labeled, { intent: "plan" }),
      ),
      201,
    );
    const got = await read<RequestRead>(
      await ticketCall(fx, "GET", `/v1/ticket-requests/${adopted.id}`),
      200,
    );
    assertEquals(
      [
        got.origin,
        got.triggerLabelName,
        got.requestedByPrincipalId,
        got.progress,
        got.pausedAt,
      ],
      ["adoption", EXECUTE_LABEL, fx.adminId, "waiting", null],
    );

    // Another organization gets what an unknown id gets.
    try {
      const other = await seedOrganization(fx.f, "ticket-requests-other", {
        role: "admin",
        agent: false,
      });
      const asOther = {
        cookie: other.cookie,
        organizationId: other.organizationId,
      };
      assertEquals(
        (await ticketCall(
          fx,
          "GET",
          `/v1/ticket-requests/${adopted.id}`,
          asOther,
        )).status,
        404,
      );
      assertEquals(
        (await ticketCall(
          fx,
          "GET",
          `/v1/ticket-requests?externalTicketId=${plain.id}`,
          asOther,
        )).status,
        404,
      );
      assertEquals(
        (await ticketCall(
          fx,
          "GET",
          `/v1/ticket-requests/${crypto.randomUUID()}`,
        )).status,
        404,
      );
    } finally {
      await cleanupSeededOrganizations(fx.f);
    }
  }, { budget: true });
});

Deno.test("issue 69 reads: a source's provider labels are read live, paged by the provider, and an outage is 503", async () => {
  await withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource();
    fx.reader.setLabels([
      { id: "101", name: "bakery:execute", color: "0e8a16" },
      { id: "102", name: "bakery:hold", color: null },
      { id: "103", name: "area:web", color: "1d76db" },
    ], 2);
    const labels = (query = "") =>
      ticketCall(fx, "GET", `${SOURCES}/${sourceId}/labels${query}`);
    type LabelPage = Page<{ id: string; name: string; color: string | null }>;
    const page1 = await read<LabelPage>(await labels(), 200);
    assertEquals(page1.items, [
      { id: "101", name: "bakery:execute", color: "0e8a16" },
      { id: "102", name: "bakery:hold", color: null },
    ]);
    assert(page1.nextCursor !== null);
    const page2 = await read<LabelPage>(
      await labels(`?cursor=${encodeURIComponent(page1.nextCursor)}`),
      200,
    );
    assertEquals(page2.items.map((label) => label.id), ["103"]);
    assertEquals(page2.nextCursor, null);
    // A limit below the provider page continues inside that page.
    const cut = await read<LabelPage>(await labels("?limit=1"), 200);
    assertEquals(cut.items.map((label) => label.id), ["101"]);
    const rest = await read<LabelPage>(
      await labels(`?limit=1&cursor=${encodeURIComponent(cut.nextCursor!)}`),
      200,
    );
    assertEquals(rest.items.map((label) => label.id), ["102"]);
    assertEquals(
      fx.reader.callsOf("readLabels").map((call) => call.number),
      [1, 2, 1, 1],
    );

    fx.reader.failNext("readLabels", {
      kind: "unavailable",
      reason: "rate_limited",
      retryAfterSeconds: 20,
    });
    const down = await labels();
    assertEquals(down.status, 503);
    const problem = await down.json() as Problem & {
      retryAfterSeconds?: number;
    };
    assertEquals([problem.code, problem.retryAfterSeconds], [
      "DEPENDENCY_UNAVAILABLE",
      20,
    ]);

    fx.reader.setLabels({ kind: "unsupported" });
    const unsupported = await labels();
    assertEquals(unsupported.status, 422);
    assertEquals(
      (await unsupported.json() as Problem).issues?.[0].code,
      "labels_unsupported",
    );
    // An unknown source reads nothing.
    fx.reader.clearCalls();
    assertEquals(
      (await ticketCall(
        fx,
        "GET",
        `${SOURCES}/${crypto.randomUUID()}/labels`,
      )).status,
      404,
    );
    assertEquals(fx.reader.calls.length, 0);
  });
});
