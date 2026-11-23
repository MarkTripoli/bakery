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
    assertEquals(
      (await api(o.fixture, o.guest.cookie, "GET", `${path}/feed`)).status,
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
    // The run's tool feed reads like its steps: with the grant, not without.
    assertEquals(
      (await api(o.fixture, o.guest.cookie, "GET", `${path}/feed`)).status,
      200,
    );
    assertEquals(
      (await api(o.fixture, o.other.cookie, "GET", `${path}/feed`)).status,
      404,
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
