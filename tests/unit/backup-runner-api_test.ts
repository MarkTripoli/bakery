import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  ApiFatal,
  ApiUnavailable,
  createRunnerApi,
  LeaseLost,
  REPORT_BACKOFF_MS,
  ReportUndelivered,
} from "../../scripts/deploy/backup-runner/api.ts";
import { createSecrets } from "../../scripts/deploy/backup-runner/redact.ts";

const TOKEN = "runner-credential-0123456789abcdef0123456789";
const RUN = "11111111-1111-4111-8111-111111111111";
const LEASE = "lease-token-0123456789abcdef0123456789abcd";

type Call = {
  method: string;
  url: string;
  auth: string | null;
  body: string | null;
};

function fakeFetch(answers: (call: Call, n: number) => Response | Error) {
  const calls: Call[] = [];
  const fetcher: typeof fetch = (input, init) => {
    const call: Call = {
      method: String(init?.method),
      url: String(input),
      auth: new Headers(init?.headers).get("authorization"),
      body: typeof init?.body === "string" ? init.body : null,
    };
    calls.push(call);
    const answer = answers(call, calls.length);
    return answer instanceof Error
      ? Promise.reject(answer)
      : Promise.resolve(answer);
  };
  return { fetcher, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function api(fetcher: typeof fetch, sleeps: number[] = []) {
  return createRunnerApi({
    baseUrl: "http://bakery.test/",
    token: TOKEN,
    secrets: createSecrets([TOKEN, LEASE]),
    fetch: fetcher,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
}

Deno.test("claim and settings are authenticated reads; an idle claim carries nothing", async () => {
  const { fetcher, calls } = fakeFetch((call) =>
    call.url.endsWith("/claims")
      ? json(200, {
        claimed: false,
        runId: null,
        leaseToken: null,
        leaseExpiresAt: null,
        triggerKind: null,
      })
      : json(200, { offsiteConfigured: false })
  );
  const client = api(fetcher);
  assertEquals(await client.claim(), { claimed: false });
  await client.settings();
  assertEquals(calls.map((c) => `${c.method} ${c.url}`), [
    "POST http://bakery.test/v1/backup-runner/claims",
    "GET http://bakery.test/v1/backup-runner/settings",
  ]);
  for (const call of calls) assertEquals(call.auth, `Bearer ${TOKEN}`);
});

Deno.test("a claim that names a run carries its lease token", async () => {
  const { fetcher } = fakeFetch(() =>
    json(200, {
      claimed: true,
      runId: RUN,
      leaseToken: LEASE,
      leaseExpiresAt: "2026-11-20T12:05:00.000Z",
      triggerKind: "manual",
    })
  );
  assertEquals(await api(fetcher).claim(), {
    claimed: true,
    runId: RUN,
    leaseToken: LEASE,
    leaseExpiresAt: "2026-11-20T12:05:00.000Z",
  });
});

Deno.test("a 5xx or a network error retries the very same report, then succeeds", async () => {
  const sleeps: number[] = [];
  const { fetcher, calls } = fakeFetch((_, n) =>
    n === 1
      ? json(503, { code: "INTERNAL" })
      : n === 2
      ? new TypeError("connection reset")
      : json(200, {})
  );
  await api(fetcher, sleeps).report(RUN, LEASE, 3, {
    status: "running",
    progressPercent: 40,
  });
  assertEquals(calls.length, 3);
  // The same body every time, with the same sequence.
  assertEquals(new Set(calls.map((c) => c.body)).size, 1);
  assertEquals(JSON.parse(calls[0].body!), {
    leaseToken: LEASE,
    sequence: 3,
    status: "running",
    progressPercent: 40,
  });
  assertEquals(
    calls[0].url,
    `http://bakery.test/v1/backup-runner/runs/${RUN}/reports`,
  );
  assertEquals(sleeps, REPORT_BACKOFF_MS.slice(0, 2));
});

Deno.test("a report that never gets through is undelivered after a bounded number of tries", async () => {
  const sleeps: number[] = [];
  const { fetcher, calls } = fakeFetch(() => json(502, {}));
  await assertRejects(
    () =>
      api(fetcher, sleeps).report(RUN, LEASE, 1, {
        status: "running",
        progressPercent: 0,
      }),
    ReportUndelivered,
  );
  assertEquals(calls.length, REPORT_BACKOFF_MS.length + 1);
  assertEquals(sleeps, [...REPORT_BACKOFF_MS]);
});

Deno.test("a 409 is a lost lease and is never retried", async () => {
  for (const reason of ["lease_expired", "run_finished", "sequence_gap"]) {
    const { fetcher, calls } = fakeFetch(() =>
      json(409, { code: "STATE_CONFLICT", reason })
    );
    const error = await assertRejects(
      () =>
        api(fetcher).report(RUN, LEASE, 2, {
          status: "running",
          progressPercent: 1,
        }),
      LeaseLost,
    );
    assertEquals(error.reason, reason);
    assertEquals(calls.length, 1);
  }
});

Deno.test("a refused credential or a malformed request is fatal and never retried", async () => {
  for (const status of [400, 401, 403, 422]) {
    const { fetcher, calls } = fakeFetch(() =>
      json(status, { code: "AUTH_FORBIDDEN" })
    );
    const error = await assertRejects(
      () =>
        api(fetcher).report(RUN, LEASE, 1, {
          status: "running",
          progressPercent: 0,
        }),
      ApiFatal,
    );
    assertEquals(error.status, status);
    assertEquals(calls.length, 1);
  }
  const { fetcher } = fakeFetch(() => json(403, { code: "AUTH_FORBIDDEN" }));
  await assertRejects(() => api(fetcher).claim(), ApiFatal);
  await assertRejects(() => api(fetcher).settings(), ApiFatal);
});

Deno.test("an unreachable server on claim is a retry-later error, not a failure of a run", async () => {
  const { fetcher } = fakeFetch(() => new TypeError("connect ECONNREFUSED"));
  await assertRejects(() => api(fetcher).claim(), ApiUnavailable);
  const { fetcher: five } = fakeFetch(() => json(500, {}));
  await assertRejects(() => api(five).settings(), ApiUnavailable);
});

Deno.test("no error message carries the runner credential or the lease token", async () => {
  const { fetcher } = fakeFetch(() =>
    new TypeError(`fetch failed for Bearer ${TOKEN} and ${LEASE}`)
  );
  const error = await assertRejects(() => api(fetcher).claim(), ApiUnavailable);
  assert(!error.message.includes(TOKEN));
  assert(!error.message.includes(LEASE));
  assert(!error.message.includes("Bearer " + TOKEN));
});

const maintenanceAnswer = {
  state: "draining",
  runId: RUN,
  leaseExpiresAt: "2026-11-20T12:05:00.000Z",
  liveAttempts: 2,
  openTransactions: 0,
  retryAfterSeconds: 2,
};

Deno.test("maintain asks the server to hold the installation for this run, with the runner credential and the lease token", async () => {
  const { fetcher, calls } = fakeFetch(() => json(200, maintenanceAnswer));
  const answer = await api(fetcher).maintain(RUN, LEASE);
  assertEquals(answer, maintenanceAnswer);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, "POST");
  assertEquals(
    calls[0].url,
    `http://bakery.test/v1/backup-runner/runs/${RUN}/maintenance`,
  );
  assertEquals(calls[0].auth, `Bearer ${TOKEN}`);
  // Nothing but the lease token: no bytes, no key material.
  assertEquals(JSON.parse(calls[0].body ?? "{}"), { leaseToken: LEASE });
});

Deno.test("maintain maps each refusal: a lost claim stops, anything else is a fatal request, a 5xx is worth asking again", async () => {
  const answerWith = (status: number, body: unknown) => {
    const { fetcher } = fakeFetch(() => json(status, body));
    return api(fetcher).maintain(RUN, LEASE);
  };
  // The claim is gone: the run must stop.
  for (const reason of ["lease_expired", "run_not_claimed"]) {
    const error = await assertRejects(
      () => answerWith(409, { code: "STATE_CONFLICT", reason }),
      LeaseLost,
    );
    assertEquals(error.reason, reason);
  }
  // Another run holds the installation, or the credential was refused.
  const held = await assertRejects(
    () =>
      answerWith(409, { code: "STATE_CONFLICT", reason: "maintenance_held" }),
    ApiFatal,
  );
  assertEquals(held.code, "maintenance_held");
  await assertRejects(
    () => answerWith(403, { code: "AUTH_FORBIDDEN" }),
    ApiFatal,
  );
  // A server that is busy or unreachable is asked again.
  await assertRejects(
    () => answerWith(503, { code: "DEPENDENCY_UNAVAILABLE" }),
    ApiUnavailable,
  );
  await assertRejects(() => answerWith(429, {}), ApiUnavailable);
  const { fetcher } = fakeFetch(() => new Error("connect ECONNREFUSED"));
  await assertRejects(() => api(fetcher).maintain(RUN, LEASE), ApiUnavailable);
});

Deno.test("maintain never puts the credential or the lease token in an error", async () => {
  const { fetcher } = fakeFetch(() =>
    new Error(`connect failed for ${TOKEN} with ${LEASE}`)
  );
  const error = await assertRejects(
    () => api(fetcher).maintain(RUN, LEASE),
    ApiUnavailable,
  );
  assert(!error.message.includes(TOKEN));
  assert(!error.message.includes(LEASE));
});
