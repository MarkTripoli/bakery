import { assert, assertEquals } from "@std/assert";
import {
  call,
  openInstallationFixture,
} from "../helpers/installation-settings.ts";
import { authTestOrigin } from "../helpers/auth.ts";

/**
 * #80 slice S1a: the runner credential and the lease token are the only
 * proofs the host runner holds, and the server never takes backup bytes or key
 * material from it. The two kinds of caller (a signed-in administrator, the
 * runner) reach different routes and neither reaches the other's.
 */

type Problem = { code: string };

async function open() {
  const f = await openInstallationFixture(true);
  await f.pgDatabase.query("delete from bakery.backup_runs");
  await f.pgDatabase.query("delete from bakery.backup_runner_credentials");
  const bearer = (
    credential: string | null,
    method: string,
    path: string,
    body?: unknown,
    cookie?: string,
  ) => {
    const headers = new Headers({
      "content-type": "application/json",
      origin: authTestOrigin,
    });
    if (credential !== null) {
      headers.set("authorization", `Bearer ${credential}`);
    }
    if (cookie) headers.set("cookie", cookie);
    return f.app.fetch(
      new Request(`${authTestOrigin}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  };
  const issue = async () => {
    const response = await call(
      f,
      "POST",
      "/v1/installation/backup-runner/credential",
      f.adminCookie,
      { body: {} },
    );
    assertEquals(response.status, 201, await response.clone().text());
    return (await response.json() as { credential: string }).credential;
  };
  return {
    f,
    bearer,
    issue,
    finish: async () => {
      await f.pgDatabase.query("delete from bakery.backup_runs");
      await f.pgDatabase.query("delete from bakery.backup_runner_credentials");
      await f.finish();
    },
  };
}

Deno.test("the runner credential reaches no administrator route, and a session reaches no runner route", async () => {
  const o = await open();
  try {
    const credential = await o.issue();
    for (
      const [method, path, body] of [
        ["GET", "/v1/installation/backups", undefined],
        ["GET", "/v1/installation/backups/status", undefined],
        ["POST", "/v1/installation/backups", {}],
        ["POST", "/v1/installation/backup-runner/credential", {}],
      ] as const
    ) {
      const response = await o.bearer(credential, method, path, body);
      assert(
        response.status === 401 || response.status === 403,
        `${method} ${path} answered ${response.status}`,
      );
      await response.body?.cancel();
    }

    // An administrator's session without the credential is not the runner.
    const runId = crypto.randomUUID();
    for (
      const [path, body] of [
        ["/v1/backup-runner/claims", {}],
        [`/v1/backup-runner/runs/${runId}/reports`, {
          leaseToken: "a".repeat(43),
          sequence: 1,
          status: "running",
        }],
      ] as const
    ) {
      const noBearer = await o.bearer(
        null,
        "POST",
        path,
        body,
        o.f.adminCookie,
      );
      assertEquals(noBearer.status, 401, path);
      assertEquals((await noBearer.json() as Problem).code, "AUTH_REQUIRED");
      const wrong = await o.bearer(
        "not-the-credential",
        "POST",
        path,
        body,
        o.f.adminCookie,
      );
      assertEquals(wrong.status, 403, path);
      assertEquals((await wrong.json() as Problem).code, "AUTH_FORBIDDEN");
    }

    // An administrator's session token offered as the bearer is not the credential.
    const session = o.f.adminCookie.split(";")[0].split("=").slice(1).join("=");
    const asBearer = await o.bearer(
      session,
      "POST",
      "/v1/backup-runner/claims",
      {},
    );
    assertEquals(asBearer.status, 403);
    await asBearer.body?.cancel();

    // A developer may not issue the credential.
    const developer = await call(
      o.f,
      "POST",
      "/v1/installation/backup-runner/credential",
      o.f.developerCookie,
      { body: {} },
    );
    assertEquals(developer.status, 403);
    await developer.body?.cancel();
  } finally {
    await o.finish();
  }
});

Deno.test("the credential and the lease token are stored only as hashes and never echoed", async () => {
  const o = await open();
  try {
    const credential = await o.issue();
    const ask = await call(
      o.f,
      "POST",
      "/v1/installation/backups",
      o.f.adminCookie,
      {
        body: {},
        headers: { "Idempotency-Key": crypto.randomUUID() },
      },
    );
    assertEquals(ask.status, 202);
    const run = await ask.json() as { id: string };
    const claim = await o.bearer(
      credential,
      "POST",
      "/v1/backup-runner/claims",
      {},
    );
    assertEquals(claim.status, 200);
    assertEquals(claim.headers.get("cache-control"), "no-store");
    const claimed = await claim.json() as { leaseToken: string };

    const finished = await o.bearer(
      credential,
      "POST",
      `/v1/backup-runner/runs/${run.id}/reports`,
      {
        leaseToken: claimed.leaseToken,
        sequence: 1,
        status: "completed",
        sizeBytes: "10",
        locations: ["server-host"],
      },
    );
    assertEquals(finished.status, 200);
    assertEquals(finished.headers.get("cache-control"), "no-store");
    const answers = [
      await finished.text(),
      await (await call(
        o.f,
        "GET",
        "/v1/installation/backups",
        o.f.adminCookie,
      )).text(),
      await (await call(
        o.f,
        "GET",
        "/v1/installation/backups/status",
        o.f.adminCookie,
      ))
        .text(),
    ];
    for (const text of answers) {
      assert(!text.includes(credential), "the credential is never echoed");
      assert(
        !text.includes(claimed.leaseToken),
        "the lease token is not echoed",
      );
    }

    // Everything the database holds about either secret is a hash.
    const dump = await o.f.pgDatabase.query<{ text: string }>(
      `select (select coalesce(string_agg(t::text, ' '), '') from bakery.backup_runs t) ||
              (select coalesce(string_agg(t::text, ' '), '') from bakery.backup_runner_credentials t) ||
              (select coalesce(string_agg(t::text, ' '), '') from bakery.audit_events t) ||
              (select coalesce(string_agg(t::text, ' '), '') from bakery.idempotency_records t) as text`,
    );
    assert(
      !dump.rows[0].text.includes(credential),
      "no stored copy of the credential",
    );
    assert(
      !dump.rows[0].text.includes(claimed.leaseToken),
      "no stored copy of the lease token",
    );
  } finally {
    await o.finish();
  }
});

Deno.test("a report that carries bytes or key material is refused, whatever the status", async () => {
  const o = await open();
  try {
    const credential = await o.issue();
    const ask = await call(
      o.f,
      "POST",
      "/v1/installation/backups",
      o.f.adminCookie,
      {
        body: {},
        headers: { "Idempotency-Key": crypto.randomUUID() },
      },
    );
    const run = await ask.json() as { id: string };
    const claim = await (await o.bearer(
      credential,
      "POST",
      "/v1/backup-runner/claims",
      {},
    )).json() as { leaseToken: string };
    const base = {
      leaseToken: claim.leaseToken,
      sequence: 1,
      status: "running",
    };
    const send = (body: Record<string, unknown>) =>
      o.bearer(
        credential,
        "POST",
        `/v1/backup-runner/runs/${run.id}/reports`,
        body,
      );
    for (
      const extra of [
        { ageIdentity: "AGE-SECRET-KEY-1ABC" },
        { privateKey: "-----BEGIN PRIVATE KEY-----" },
        { identity: { file: "x" } },
        { bytes: "AAAA" },
        { content: "AAAA" },
        { dump: "AAAA" },
        { archive: "AAAA" },
        { files: [{ name: "x", data: "AAAA" }] },
        { secretAccessKey: "x" },
      ]
    ) {
      const response = await send({ ...base, ...extra });
      assertEquals(response.status, 422, JSON.stringify(Object.keys(extra)));
      assertEquals((await response.json() as Problem).code, "UNPROCESSABLE");
    }
    // Free text is bounded, and a body larger than the report ever needs is refused.
    const long = await send({
      ...base,
      sequence: 1,
      status: "failed",
      failureCode: "runner_error",
      failureDetail: "x".repeat(1001),
    });
    assertEquals(long.status, 422);
    await long.body?.cancel();
    const huge = await send({ ...base, failureDetail: "y".repeat(600 * 1024) });
    assert(
      huge.status === 413 || huge.status === 422,
      `huge answered ${huge.status}`,
    );
    await huge.body?.cancel();

    // None of it changed the run.
    const row = await o.f.pgDatabase.query<
      { status: string; report_sequence: number }
    >(
      "select status, report_sequence from bakery.backup_runs where id = $1",
      [run.id],
    );
    assertEquals(row.rows[0], { status: "claimed", report_sequence: 0 });
  } finally {
    await o.finish();
  }
});

Deno.test("the report route authenticates before it reads the body", async () => {
  const o = await open();
  try {
    const credential = await o.issue();
    const path = `/v1/backup-runner/runs/${crypto.randomUUID()}/reports`;
    // A body that fails every schema rule, and an oversized one: an
    // unauthenticated caller must be refused on the credential alone, never
    // answered with a validation error and never made to be read and parsed.
    const bodies = [
      { sequence: "not-a-number", status: 7, extra: { nested: true } },
      { padding: "x".repeat(200_000) },
    ];
    for (const body of bodies) {
      const wrong = await o.bearer("not-the-credential", "POST", path, body);
      assertEquals(wrong.status, 403, JSON.stringify(body).slice(0, 40));
      assertEquals((await wrong.json() as Problem).code, "AUTH_FORBIDDEN");
      const none = await o.bearer(null, "POST", path, body);
      assertEquals(none.status, 401);
      await none.body?.cancel();
    }
    // The control: with the real credential the same body IS validated, so the
    // 403 above is the credential check running first, not validation being off.
    const real = await o.bearer(credential, "POST", path, bodies[0]);
    assert(
      real.status === 400 || real.status === 422,
      `a bad body with the real credential answered ${real.status}`,
    );
    await real.body?.cancel();
  } finally {
    await o.finish();
  }
});
