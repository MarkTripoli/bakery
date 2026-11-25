import { assertEquals, assertNotEquals } from "@std/assert";
import { cleanupAuthFixture } from "../helpers/auth.ts";
import { openSocketFixture } from "../helpers/events-socket.ts";
import { addMember, api, seedRun } from "../helpers/run-requests.ts";

/**
 * #456 slice 1: a request is one person asking another, on one run, for one
 * thing. It gives the person asked the right to see that run, ends by
 * withdrawal or expiry, and falls back to the run's starter when the person
 * asked cannot be found. Real routes and real Postgres.
 */

type Request = {
  id: string;
  status: string;
  intent: string;
  version: number;
  ownerFallback: boolean;
  fallbackForName: string | null;
  recipient: { principalId: string; displayName: string };
  askedBy: { principalId: string } | null;
};

type RunAccess = {
  projectCount: number;
  totalCount: number;
  items: {
    id: string;
    principal: { principalId: string; displayName: string };
    via: string;
    grantedBy: { principalId: string; displayName: string } | null;
    powers: { intent: string; stepKey: string | null }[];
    version: number;
  }[];
  nextCursor: string | null;
};

type RunAccessRemoval = {
  principalId: string;
  version: number;
  withdrawnRequestCount: number;
};

async function body<T>(response: Response, status: number): Promise<T> {
  const text = await response.text();
  assertEquals(response.status, status, text);
  return JSON.parse(text) as T;
}

async function open() {
  const fixture = await openSocketFixture();
  const dev = await addMember(fixture, "Dana", "developer");
  const guest = await addMember(fixture, "Gus", "guest");
  const other = await addMember(fixture, "Olive", "guest");
  const run = await seedRun(fixture);
  const grants = async () =>
    (await fixture.pgDatabase.query<{ principal_id: string }>(
      `select principal_id from bakery.run_access_grants
        where organization_id = $1 and run_id = $2 and revoked_at is null`,
      [fixture.organizationId, run.runId],
    )).rows.map((row) => row.principal_id);
  return {
    fixture,
    dev,
    guest,
    other,
    run,
    grants,
    ask: (cookie: string, payload: Record<string, unknown>) =>
      api(fixture, cookie, "POST", `/v1/runs/${run.runId}/requests`, payload),
    finish: async () => {
      await cleanupAuthFixture(fixture.pgDatabase, [
        fixture.email,
        dev.email,
        guest.email,
        other.email,
      ]);
      await fixture.close();
    },
  };
}

Deno.test("asking someone gives them the run to see, and nothing else", async () => {
  const o = await open();
  try {
    const path = `/v1/runs/${o.run.runId}`;
    // Before: a guest holds nothing, and is answered as if the run were not there.
    assertEquals(
      (await api(o.fixture, o.guest.cookie, "GET", path)).status,
      404,
    );
    const made = await body<Request>(
      await o.ask(o.fixture.cookie, {
        recipientId: o.guest.principalId,
        intent: "fyi",
        note: "Have a look.",
      }),
      201,
    );
    assertEquals(made.status, "open");
    assertEquals(made.recipient.displayName, "Gus");
    assertEquals(made.ownerFallback, false);
    assertEquals(await o.grants(), [o.guest.principalId]);
    // After: the run, its steps and its task read; the asked person sees their
    // own request, and nobody else's.
    assertEquals(
      (await api(o.fixture, o.guest.cookie, "GET", path)).status,
      200,
    );
    const mine = await body<{ requests: Request[] }>(
      await api(o.fixture, o.guest.cookie, "GET", `${path}/requests/mine`),
      200,
    );
    assertEquals(mine.requests.map((request) => request.id), [made.id]);
    const theirs = await body<{ requests: Request[] }>(
      await api(o.fixture, o.other.cookie, "GET", `${path}/requests/mine`),
      200,
    );
    assertEquals(theirs.requests.length, 0);
    // The list of everyone asked is for those who can share the run.
    assertEquals(
      (await api(o.fixture, o.guest.cookie, "GET", `${path}/requests`)).status,
      404,
    );
    const list = await body<{ requests: Request[] }>(
      await api(o.fixture, o.dev.cookie, "GET", `${path}/requests`),
      200,
    );
    assertEquals(list.requests.length, 1);
  } finally {
    await o.finish();
  }
});

Deno.test("run access lists direct people separately from project access", async () => {
  const o = await open();
  try {
    assertEquals(
      (await api(o.fixture, o.fixture.cookie, "POST", "/v1/access-bindings", {
        principalId: o.other.principalId,
        roleKey: "viewer",
        scopeType: "application",
        scopeId: o.fixture.applicationId,
      })).status,
      201,
    );
    await body<Request>(
      await o.ask(o.dev.cookie, {
        recipientId: o.other.principalId,
        intent: "fyi",
      }),
      201,
    );
    await body<Request>(
      await o.ask(o.dev.cookie, {
        recipientId: o.guest.principalId,
        intent: "take_over",
        stepKey: o.run.stepKey,
      }),
      201,
    );
    const path = `/v1/runs/${o.run.runId}/access`;
    const access = await body<RunAccess>(
      await api(o.fixture, o.dev.cookie, "GET", path),
      200,
    );
    assertEquals(access.projectCount, 3);
    assertEquals(access.totalCount, 4);
    assertEquals(access.items.length, 1);
    assertEquals(access.items[0]?.principal, {
      principalId: o.guest.principalId,
      displayName: "Gus",
    });
    assertEquals(access.items[0]?.via, "request");
    assertEquals(access.items[0]?.grantedBy?.principalId, o.dev.principalId);
    assertEquals(
      access.items[0]?.powers.map(({ intent, stepKey }) => ({
        intent,
        stepKey,
      })),
      [{ intent: "take_over", stepKey: o.run.stepKey }],
    );
    assertEquals(access.nextCursor, null);
    assertEquals(
      (await api(o.fixture, o.other.cookie, "GET", path)).status,
      200,
    );
    assertEquals(
      (await api(o.fixture, o.guest.cookie, "GET", path)).status,
      200,
    );
    await o.fixture.pgDatabase.query(
      `update bakery.organization_memberships
          set status = 'inactive', updated_at = now(), version = version + 1
        where organization_id = $1 and principal_id = $2`,
      [o.fixture.organizationId, o.guest.principalId],
    );
    const inactiveAccess = await body<RunAccess>(
      await api(o.fixture, o.dev.cookie, "GET", path),
      200,
    );
    assertEquals(inactiveAccess.projectCount, 3);
    assertEquals(inactiveAccess.totalCount, 3);
    assertEquals(inactiveAccess.items, []);
    assertEquals(inactiveAccess.nextCursor, null);
  } finally {
    await o.finish();
  }
});

Deno.test("run access pages every direct person beyond the first twenty", async () => {
  const o = await open();
  const userIds = Array.from({ length: 51 }, () => crypto.randomUUID());
  const principalIds = Array.from({ length: 51 }, () => crypto.randomUUID());
  const membershipIds = Array.from({ length: 51 }, () => crypto.randomUUID());
  try {
    await o.fixture.pgDatabase.query(
      `insert into public."user" (
         id, name, email, "emailVerified", "createdAt", "updatedAt"
       )
       select user_id, 'Page person ' || ordinality,
              'page-' || user_id || '@example.test', true, now(), now()
         from unnest($1::uuid[]) with ordinality as seed(user_id, ordinality)`,
      [userIds],
    );
    await o.fixture.pgDatabase.query(
      `insert into bakery.principals (
         id, provider_user_id, display_name, principal_type
       )
       select principal_id, user_id, 'Page person ' || ordinality, 'human'
         from unnest($1::uuid[], $2::uuid[]) with ordinality
              as seed(principal_id, user_id, ordinality)`,
      [principalIds, userIds],
    );
    await o.fixture.pgDatabase.query(
      `insert into bakery.organization_memberships (
         id, organization_id, principal_id, role, status, joined_at,
         created_at, updated_at, version
       )
       select membership_id, $3, principal_id, 'guest', 'active', now(),
              now(), now(), 1
         from unnest($1::uuid[], $2::uuid[]) as seed(membership_id, principal_id)`,
      [membershipIds, principalIds, o.fixture.organizationId],
    );
    await o.fixture.pgDatabase.query(
      `insert into bakery.run_access_grants (
         organization_id, run_id, task_id, principal_id, via, granted_by,
         granted_by_kind
       )
       select $1, $2, $3, principal_id, 'request', $4, 'person'
         from unnest($5::uuid[]) as seed(principal_id)`,
      [
        o.fixture.organizationId,
        o.run.runId,
        o.run.taskId,
        o.dev.principalId,
        principalIds,
      ],
    );
    const path = `/v1/runs/${o.run.runId}/access?limit=20`;
    const first = await body<RunAccess>(
      await api(o.fixture, o.dev.cookie, "GET", path),
      200,
    );
    assertEquals(first.projectCount, 2);
    assertEquals(first.totalCount, 53);
    assertEquals(first.items.length, 20);
    assertNotEquals(first.nextCursor, null);
    const second = await body<RunAccess>(
      await api(
        o.fixture,
        o.dev.cookie,
        "GET",
        `${path}&cursor=${encodeURIComponent(first.nextCursor!)}`,
      ),
      200,
    );
    assertEquals(second.totalCount, 53);
    assertEquals(second.items.length, 20);
    assertNotEquals(second.nextCursor, null);
    const third = await body<RunAccess>(
      await api(
        o.fixture,
        o.dev.cookie,
        "GET",
        `${path}&cursor=${encodeURIComponent(second.nextCursor!)}`,
      ),
      200,
    );
    assertEquals(third.totalCount, 53);
    assertEquals(third.items.length, 11);
    assertEquals(third.nextCursor, null);
    assertEquals(
      new Set(
        [...first.items, ...second.items, ...third.items].map(
          (item) => item.principal.principalId,
        ),
      ).size,
      51,
    );
  } finally {
    await o.fixture.pgDatabase.query(
      `delete from bakery.run_access_grants
        where organization_id = $1 and principal_id = any($2::uuid[])`,
      [o.fixture.organizationId, principalIds],
    );
    await o.fixture.pgDatabase.query(
      `delete from bakery.organization_memberships
        where organization_id = $1 and principal_id = any($2::uuid[])`,
      [o.fixture.organizationId, principalIds],
    );
    await o.fixture.pgDatabase.query(
      "delete from bakery.principals where id = any($1::uuid[])",
      [principalIds],
    );
    await o.fixture.pgDatabase.query(
      `delete from public."user" where id = any($1::uuid[])`,
      [userIds],
    );
    await o.finish();
  }
});

Deno.test("a reopened request stays in the open group across access pages", async () => {
  const o = await open();
  const fillers = [];
  for (let index = 0; index < 20; index += 1) {
    fillers.push(await addMember(o.fixture, `Closed ${index}`, "guest"));
  }
  const fillerPrincipalIds = fillers.map((member) => member.principalId);
  try {
    const first = await body<Request>(
      await o.ask(o.dev.cookie, {
        recipientId: o.guest.principalId,
        intent: "fyi",
      }),
      201,
    );
    await body<Request>(
      await api(
        o.fixture,
        o.dev.cookie,
        "POST",
        `/v1/run-requests/${first.id}/withdraw`,
        {},
        first.version,
      ),
      200,
    );
    await body<Request>(
      await o.ask(o.dev.cookie, {
        recipientId: o.guest.principalId,
        intent: "fyi",
      }),
      201,
    );
    await o.fixture.pgDatabase.query(
      `insert into bakery.run_access_grants (
         organization_id, run_id, task_id, principal_id, via, granted_by,
         granted_by_kind
       )
       select $1, $2, $3, principal_id, 'request', $4, 'person'
         from unnest($5::uuid[]) as seed(principal_id)`,
      [
        o.fixture.organizationId,
        o.run.runId,
        o.run.taskId,
        o.dev.principalId,
        fillerPrincipalIds,
      ],
    );
    await o.fixture.pgDatabase.query(
      `update bakery.run_access_grants
          set created_at = case when principal_id = $3
            then now() - interval '2 days'
            else now() - interval '1 day'
          end
        where organization_id = $1 and run_id = $2
          and principal_id = any($4::uuid[])`,
      [
        o.fixture.organizationId,
        o.run.runId,
        o.guest.principalId,
        [o.guest.principalId, ...fillerPrincipalIds],
      ],
    );
    const path = `/v1/runs/${o.run.runId}/access?limit=20`;
    const firstPage = await body<RunAccess>(
      await api(o.fixture, o.dev.cookie, "GET", path),
      200,
    );
    const secondPage = await body<RunAccess>(
      await api(
        o.fixture,
        o.dev.cookie,
        "GET",
        `${path}&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
      ),
      200,
    );
    assertEquals(
      firstPage.items[0]?.principal.principalId,
      o.guest.principalId,
    );
    assertEquals(
      secondPage.items.some((item) =>
        item.principal.principalId === o.guest.principalId
      ),
      false,
    );
  } finally {
    await o.fixture.pgDatabase.query(
      `delete from bakery.run_access_grants
        where organization_id = $1 and principal_id = any($2::uuid[])`,
      [o.fixture.organizationId, fillerPrincipalIds],
    );
    await cleanupAuthFixture(
      o.fixture.pgDatabase,
      fillers.map((member) => member.email),
    );
    await o.finish();
  }
});

Deno.test("removing direct access withdraws every open request atomically", async () => {
  const o = await open();
  try {
    const made = await body<Request>(
      await o.ask(o.dev.cookie, {
        recipientId: o.guest.principalId,
        intent: "take_over",
        stepKey: o.run.stepKey,
      }),
      201,
    );
    const accessPath = `/v1/runs/${o.run.runId}/access`;
    const access = await body<RunAccess>(
      await api(o.fixture, o.dev.cookie, "GET", accessPath),
      200,
    );
    const grant = access.items[0]!;
    const removePath = `${accessPath}/${o.guest.principalId}/remove`;
    assertEquals(
      (await api(
        o.fixture,
        o.guest.cookie,
        "POST",
        removePath,
        {},
        grant.version,
      )).status,
      404,
    );
    const removed = await body<RunAccessRemoval>(
      await api(
        o.fixture,
        o.dev.cookie,
        "POST",
        removePath,
        {},
        grant.version,
      ),
      200,
    );
    assertEquals(removed, {
      principalId: o.guest.principalId,
      version: grant.version + 1,
      withdrawnRequestCount: 1,
    });
    assertEquals(
      (await api(
        o.fixture,
        o.dev.cookie,
        "POST",
        removePath,
        {},
        grant.version,
      )).status,
      412,
    );
    assertEquals(
      (await api(o.fixture, o.guest.cookie, "GET", `/v1/runs/${o.run.runId}`))
        .status,
      404,
    );
    const requests = await body<{ requests: Request[] }>(
      await api(
        o.fixture,
        o.dev.cookie,
        "GET",
        `/v1/runs/${o.run.runId}/requests`,
      ),
      200,
    );
    assertEquals(
      requests.requests.find((item) => item.id === made.id)?.status,
      "withdrawn",
    );
    const powers = await o.fixture.pgDatabase.query(
      `select 1 from bakery.run_power_grants
        where organization_id = $1 and run_id = $2 and principal_id = $3
          and revoked_at is null`,
      [o.fixture.organizationId, o.run.runId, o.guest.principalId],
    );
    assertEquals(powers.rows, []);
    const ledger = await o.fixture.pgDatabase.query<{ kind: string }>(
      `select kind from bakery.decisions_ledger
        where organization_id = $1 and run_id = $2
          and kind = 'run_access_removed'`,
      [o.fixture.organizationId, o.run.runId],
    );
    assertEquals(ledger.rows.map((row) => row.kind), ["run_access_removed"]);
  } finally {
    await o.finish();
  }
});

Deno.test("a request is refused where it cannot be honoured, and names why", async () => {
  const o = await open();
  try {
    const refused = async (payload: Record<string, unknown>, status: number) =>
      assertEquals((await o.ask(o.fixture.cookie, payload)).status, status);
    // Powers that do not exist yet are not promised.
    await refused({ recipientId: o.guest.principalId, intent: "approve" }, 422);
    await refused(
      { recipientId: o.guest.principalId, intent: "take_over" },
      422,
    );
    // Not oneself, not a step that is not there, not a note that is too long,
    // not a deadline after the request would expire.
    await refused({ recipientId: o.fixture.principalId, intent: "fyi" }, 422);
    await refused({
      recipientId: o.guest.principalId,
      intent: "fyi",
      stepKey: "no-such-step",
    }, 422);
    await refused({
      recipientId: o.guest.principalId,
      intent: "fyi",
      note: "x".repeat(281),
    }, 400);
    await refused({
      recipientId: o.guest.principalId,
      intent: "fyi",
      neededBy: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    }, 422);
    // A guest cannot ask anyone: asking needs to be able to see and share.
    assertEquals(
      (await o.ask(o.guest.cookie, {
        recipientId: o.other.principalId,
        intent: "fyi",
      })).status,
      404,
    );
    assertEquals(await o.grants(), []);
  } finally {
    await o.finish();
  }
});

Deno.test("asking again reminds instead of stacking, and a developer gets no extra grant", async () => {
  const o = await open();
  try {
    const first = await body<Request>(
      await o.ask(o.fixture.cookie, {
        recipientId: o.guest.principalId,
        intent: "fyi",
      }),
      201,
    );
    const again = await body<Request>(
      await o.ask(o.fixture.cookie, {
        recipientId: o.guest.principalId,
        intent: "fyi",
      }),
      201,
    );
    assertEquals(again.id, first.id);
    assertEquals(again.version, first.version + 1);
    // A reminder is recorded like the request itself: ledger, audit and event.
    const ledger = await o.fixture.pgDatabase.query<{ kind: string }>(
      `select kind from bakery.decisions_ledger
        where organization_id = $1 and run_id = $2
          and kind in ('request', 'request_reminded') order by created_at, id`,
      [o.fixture.organizationId, o.run.runId],
    );
    assertEquals(ledger.rows.map((row) => row.kind), [
      "request",
      "request_reminded",
    ]);
    const audit = await o.fixture.pgDatabase.query<{ reminded: string | null }>(
      `select details ->> 'reminded' as reminded from bakery.audit_events
        where organization_id = $1 and operation = 'runRequests.create'
          and resource_id = $2 order by created_at, id`,
      [o.fixture.organizationId, first.id],
    );
    assertEquals(audit.rows.map((row) => row.reminded), [null, "true"]);
    const events = await o.fixture.pgDatabase.query<{ version: number }>(
      `select aggregate_version as version from bakery.domain_events
        where organization_id = $1 and event_type = 'runRequest.created'
          and aggregate_id = $2 order by aggregate_version`,
      [o.fixture.organizationId, first.id],
    );
    assertEquals(events.rows.map((row) => row.version), [1, again.version]);
    const rows = await o.fixture.pgDatabase.query(
      `select 1 from bakery.person_requests where organization_id = $1`,
      [o.fixture.organizationId],
    );
    assertEquals(rows.rows.length, 1);
    assertEquals((await o.grants()).length, 1);

    // A developer already reads every run: the request is made, no grant is.
    await body<Request>(
      await o.ask(o.fixture.cookie, {
        recipientId: o.dev.principalId,
        intent: "fyi",
      }),
      201,
    );
    assertEquals(await o.grants(), [o.guest.principalId]);
  } finally {
    await o.finish();
  }
});

Deno.test("a person who cannot be found is replaced by whoever started the run, visibly", async () => {
  const o = await open();
  try {
    // The asker is a developer; the run was started by the fixture's admin.
    const gone = await addMember(o.fixture, "Gone", "guest");
    await o.fixture.pgDatabase.query(
      `update bakery.principals set disabled_at = now() where id = $1`,
      [gone.principalId],
    );
    const made = await body<Request>(
      await o.ask(o.dev.cookie, {
        recipientId: gone.principalId,
        intent: "fyi",
      }),
      201,
    );
    assertEquals(made.ownerFallback, true);
    assertEquals(made.fallbackForName, "Gone");
    assertEquals(made.recipient.principalId, o.fixture.principalId);
    // Nobody to fall back to when the starter is the asker.
    assertEquals(
      (await o.ask(o.fixture.cookie, {
        recipientId: gone.principalId,
        intent: "fyi",
      })).status,
      422,
    );
    await cleanupAuthFixture(o.fixture.pgDatabase, [gone.email]);
  } finally {
    await o.finish();
  }
});

Deno.test("withdrawing ends the request but not the right to see the run", async () => {
  const o = await open();
  try {
    const made = await body<Request>(
      await o.ask(o.dev.cookie, {
        recipientId: o.guest.principalId,
        intent: "fyi",
      }),
      201,
    );
    const path = `/v1/run-requests/${made.id}/withdraw`;
    // Only the asker or an Admin; a version is required and must be current.
    assertEquals(
      (await api(o.fixture, o.other.cookie, "POST", path, {}, made.version))
        .status,
      404,
    );
    assertEquals(
      (await api(o.fixture, o.dev.cookie, "POST", path, {})).status,
      428,
    );
    assertEquals(
      (await api(o.fixture, o.dev.cookie, "POST", path, {}, made.version + 4))
        .status,
      412,
    );
    const withdrawn = await body<Request>(
      await api(o.fixture, o.dev.cookie, "POST", path, {}, made.version),
      200,
    );
    assertEquals(withdrawn.status, "withdrawn");
    assertEquals(
      (await api(o.fixture, o.guest.cookie, "GET", `/v1/runs/${o.run.runId}`))
        .status,
      200,
    );
    // Twice is a conflict, not a second withdrawal.
    assertEquals(
      (await api(
        o.fixture,
        o.dev.cookie,
        "POST",
        path,
        {},
        withdrawn.version,
      )).status,
      409,
    );
    // The ledger tells the story, in order.
    const ledger = await o.fixture.pgDatabase.query<{ kind: string }>(
      `select kind from bakery.decisions_ledger
        where organization_id = $1 and run_id = $2
          and kind in ('request', 'request_withdrawn') order by created_at`,
      [o.fixture.organizationId, o.run.runId],
    );
    assertEquals(ledger.rows.map((row) => row.kind), [
      "request",
      "request_withdrawn",
    ]);
  } finally {
    await o.finish();
  }
});

Deno.test("an expired request reads as expired and asking again makes a new one", async () => {
  const o = await open();
  try {
    const made = await body<Request>(
      await o.ask(o.fixture.cookie, {
        recipientId: o.guest.principalId,
        intent: "fyi",
      }),
      201,
    );
    await o.fixture.pgDatabase.query(
      `update bakery.person_requests set expires_at = now() - interval '1 minute'
        where id = $1`,
      [made.id],
    );
    const mine = await body<{ requests: Request[] }>(
      await api(
        o.fixture,
        o.guest.cookie,
        "GET",
        `/v1/runs/${o.run.runId}/requests/mine`,
      ),
      200,
    );
    assertEquals(mine.requests[0].status, "expired");
    const fresh = await body<Request>(
      await o.ask(o.fixture.cookie, {
        recipientId: o.guest.principalId,
        intent: "fyi",
      }),
      201,
    );
    assertNotEquals(fresh.id, made.id);
    assertEquals(fresh.status, "open");
    // Seeing the run did not lapse with the request.
    assertEquals(
      (await api(o.fixture, o.guest.cookie, "GET", `/v1/runs/${o.run.runId}`))
        .status,
      200,
    );
  } finally {
    await o.finish();
  }
});
