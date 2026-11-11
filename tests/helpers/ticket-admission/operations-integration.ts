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
  insertBareTask,
  seedLabeler,
  type TicketFixture,
  withTicketFixture,
} from "./fixtures.ts";
import { assertNoDeadlock, holdRow, raceInOrder } from "../lock-race.ts";
import {
  factsOf,
  idleInTransaction,
  type Problem,
  read,
  sourceBody,
  sourceFacts,
  type SourceView,
  ticketCall,
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
type TicketView = {
  id: string;
  number: string | null;
  requirementsDigest: string;
  latestReadiness: {
    verdict: string;
    version: number;
    checks: { reason: string }[];
  } | null;
  activeRequest: {
    id: string;
    intent: string;
    disposition: string;
    dispositionReason: string | null;
  } | null;
};
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
              githubActorIds: ["1"],
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

Deno.test("issue 82 ops: preview records snapshots and reports and never a link, request, task or run", async () => {
  await withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    seedLabeler(fx);
    seedIssues(fx, 3);
    // Issue 1 would be admitted by a poll: labeled inside the window by an allowlisted writer.
    fx.reader.setIssue({ number: 1, labels: [EXECUTE_LABEL] });
    fx.reader.setLabelApplied(1, EXECUTE_LABEL, { appliedAt: AFTER_SINCE });
    const path = `${SOURCES}/${sourceId}/previews`;

    const requestId = "not-a-uuid";
    const key = crypto.randomUUID();
    const receipt = await read<Receipt>(
      await post(fx, path, {}, { key, headers: { "X-Request-Id": requestId } }),
      201,
    );
    assert(UUID_PATTERN.test(receipt.operationId), receipt.operationId);
    assertNotEquals(receipt.operationId, requestId);
    assertEquals(receipt.status, "completed");
    assertEquals(await fx.counts(sourceId), {
      tickets: 3,
      reports: 3,
      links: 0,
      requests: 0,
      nonterminalRequests: 0,
      tasks: 0,
      conversations: 0,
      runs: 0,
    });
    assertEquals(await sourceFacts(fx, sourceId), {
      audit: ["ticketSources.preview"],
      events: ["ticket.preview_requested"],
      outbox: 0,
    });

    // The same key answers from the stored response without asking GitHub again.
    const calls = fx.reader.calls.length;
    const replay = await read<Receipt>(await post(fx, path, {}, { key }), 201);
    assertEquals(replay, receipt);
    assertEquals(fx.reader.calls.length, calls);

    // `filters` is accepted only when absent or empty, and a refusal reads nothing.
    assertEquals((await post(fx, path, { filters: {} })).status, 201);
    const filtered = await post(fx, path, { filters: { labels: ["x"] } });
    assertEquals(filtered.status, 422);
    assertEquals(
      (await filtered.json() as Problem).issues?.[0].code,
      "filters_unsupported",
    );
    const afterFilters = fx.reader.calls.length;
    assertEquals((await sourceFacts(fx, sourceId)).audit.length, 2);

    // A page the provider cannot list is DEPENDENCY_UNAVAILABLE and writes nothing.
    fx.reader.failNext("listIssues");
    const down = await post(fx, path);
    assertEquals(down.status, 503, await down.clone().text());
    assertEquals((await down.json() as Problem).code, "DEPENDENCY_UNAVAILABLE");
    assertEquals((await sourceFacts(fx, sourceId)).audit.length, 2);
    assert(fx.reader.calls.length > afterFilters);
  });
});

Deno.test("issue 82 ops: preview keeps the issues it could read when one read fails", async () => {
  await withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource();
    seedIssues(fx, 3);
    fx.reader.failNext("readIssue");
    const receipt = await read<Receipt>(
      await post(fx, `${SOURCES}/${sourceId}/previews`),
      201,
    );
    assertEquals(receipt.status, "completed");
    const counts = await fx.counts(sourceId);
    assertEquals([counts.tickets, counts.reports], [2, 2]);
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
    const receipt = await read<Receipt>(
      await post(fx, `${SOURCES}/${sourceId}/previews`),
      201,
    );
    assert(performance.now() - started < 30_000);
    assertEquals(receipt.status, "completed");
    assertEquals(
      (await fx.counts(sourceId)).tickets,
      25,
      "the page is cut at 25",
    );
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
    // Ticket 3 is the last of the page: the preview reaches it after it holds
    // the application row, while the other operation holds it and wants the row.
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
    // A deadlock victim answers 500 and the app reports the error with its cause.
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
          const [first, second] = previewFirst
            ? await raceInOrder(fx.owner, hold, preview, operation)
            : await raceInOrder(fx.owner, hold, operation, preview);
          assertEquals(failures, [], label);
          assertNoDeadlock(first);
          assertNoDeadlock(second);
          const answers = [first, second].map((outcome) =>
            outcome.status === "fulfilled" ? outcome.value.status : "rejected"
          );
          assertEquals(answers, [201, 201], label);
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

/** Records every seeded issue through a preview, so each has a ticket row. */
async function previewAll(fx: TicketFixture, sourceId: string) {
  await read(await post(fx, `${SOURCES}/${sourceId}/previews`), 201);
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
