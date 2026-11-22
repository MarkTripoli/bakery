import { assertEquals } from "@std/assert";
import { createSuperuser } from "../../apps/server/src/modules/auth/index.ts";
import {
  authRequest,
  authTestOrigin,
  cleanupAuthFixture,
  get,
  openAuthFixture,
  sessionCookie,
  userIdFor,
} from "../helpers/auth.ts";
import {
  challengeCookie,
  createSoftwareAuthenticator,
  type SoftwareAuthenticator,
} from "../helpers/webauthn.ts";
import type { PgDatabase } from "../../apps/server/src/platform/database.ts";
import {
  readExecutionState,
  registeredWorker,
  workerFixtureCapabilities,
} from "../helpers/worker-execution.ts";
import { seedFundedModelJob } from "../helpers/funded-model-job.ts";
import {
  claimAssignment,
  withWorkerFixture,
} from "../helpers/worker-execution/scenarios.ts";
import { rawClaim } from "../helpers/coordinator-turn-jobs-worker.ts";

type AppFixture = Awaited<ReturnType<typeof openAuthFixture>>;

// #52 (B15.06) AC3 at the API: a passkey assertion is good for exactly one
// ceremony on exactly this origin. Replays across challenges and requests from
// another origin (by header or inside the signed client data, including a
// sibling port on the same host) are refused, and nothing a refusal touches
// changes: no session, no counter bump.

const PASSKEY_RP_ID = "127.0.0.1";
const FOREIGN = "http://evil.example.test";

type Person = {
  fixture: AppFixture;
  email: string;
  userId: string;
  authenticator: SoftwareAuthenticator;
};

async function state(pgDatabase: PgDatabase, userId: string) {
  const passkeys = await pgDatabase.query<{ counter: number }>(
    'select counter from public.passkey where "userId" = $1 order by id',
    [userId],
  );
  const sessions = await pgDatabase.query<{ count: number }>(
    'select count(*)::int as count from public.session where "userId" = $1',
    [userId],
  );
  return {
    counters: passkeys.rows.map((row) => row.counter),
    sessions: sessions.rows[0].count,
  };
}

/** A person with one registered software passkey, signed out of the ceremony. */
async function withPerson(run: (person: Person) => Promise<void>) {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const email = `passkey-native-${suffix}@example.test`;
  const password = `Passkey-Native-${suffix}`;
  try {
    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, { email, displayName: "Passkey Native", password });
    const authenticator = await createSoftwareAuthenticator({
      origin: authTestOrigin,
      rpId: PASSKEY_RP_ID,
    });
    const cookie = sessionCookie(
      await fixture.app.fetch(
        authRequest("/api/auth/sign-in/email", { email, password }),
      ),
    );
    const options = await fixture.app.fetch(
      get("/api/auth/passkey/generate-register-options", cookie),
    );
    const { challenge } = await options.json() as { challenge: string };
    const registered = await fixture.app.fetch(authRequest(
      "/api/auth/passkey/verify-registration",
      {
        response: await authenticator.register({ challenge }),
        name: "Laptop",
      },
      { cookie: `${cookie}; ${challengeCookie(options)}` },
    ));
    assertEquals(registered.status, 200);
    const userId = await userIdFor(fixture.pgDatabase, email);
    await run({ fixture, email, userId, authenticator });
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
  }
}

async function ceremony(fixture: AppFixture) {
  const response = await fixture.app.fetch(
    get("/api/auth/passkey/generate-authenticate-options"),
  );
  assertEquals(response.status, 200);
  const { challenge } = await response.json() as { challenge: string };
  return { challenge, cookie: challengeCookie(response) };
}

function verify(
  fixture: AppFixture,
  assertion: Record<string, unknown>,
  cookie: string,
  origin?: string,
) {
  return fixture.app.fetch(authRequest(
    "/api/auth/passkey/verify-authentication",
    { response: assertion },
    { cookie, origin },
  ));
}

Deno.test("an assertion signed for one challenge is refused under another ceremony's challenge", async () => {
  await withPerson(async ({ fixture, userId, authenticator }) => {
    const first = await ceremony(fixture);
    const second = await ceremony(fixture);
    const before = await state(fixture.pgDatabase, userId);
    const crossed = await verify(
      fixture,
      await authenticator.authenticate({ challenge: first.challenge }),
      second.cookie,
    );
    assertEquals(crossed.status, 400);
    assertEquals((await crossed.json()).code, "AUTHENTICATION_FAILED");
    assertEquals(await state(fixture.pgDatabase, userId), before);
  });
});

Deno.test("an assertion that already signed in is refused when replayed under a fresh challenge", async () => {
  await withPerson(async ({ fixture, userId, authenticator }) => {
    const first = await ceremony(fixture);
    const assertion = await authenticator.authenticate({
      challenge: first.challenge,
    });
    assertEquals((await verify(fixture, assertion, first.cookie)).status, 200);
    const signedIn = await state(fixture.pgDatabase, userId);

    const again = await ceremony(fixture);
    const replayed = await verify(fixture, assertion, again.cookie);
    assertEquals(replayed.status, 400);
    assertEquals((await replayed.json()).code, "AUTHENTICATION_FAILED");
    assertEquals(await state(fixture.pgDatabase, userId), signedIn);
  });
});

Deno.test("a sign-in request from another origin is refused and changes nothing", async () => {
  await withPerson(async ({ fixture, userId, authenticator }) => {
    const before = await state(fixture.pgDatabase, userId);
    const options = await ceremony(fixture);
    const assertion = await authenticator.authenticate({
      challenge: options.challenge,
    });
    const foreign = await verify(fixture, assertion, options.cookie, FOREIGN);
    assertEquals(foreign.status, 403);
    assertEquals(await state(fixture.pgDatabase, userId), before);
  });
});

Deno.test("client data from a sibling port on the same host is a different origin and is refused", async () => {
  await withPerson(async ({ fixture, userId, authenticator }) => {
    const before = await state(fixture.pgDatabase, userId);
    const sibling = new URL(authTestOrigin);
    sibling.port = String(Number(sibling.port) + 1);
    const options = await ceremony(fixture);
    const refused = await verify(
      fixture,
      await authenticator.authenticate({ challenge: options.challenge }, {
        origin: sibling.origin,
      }),
      options.cookie,
    );
    assertEquals(refused.status, 400);
    assertEquals((await refused.json()).code, "AUTHENTICATION_FAILED");
    assertEquals(await state(fixture.pgDatabase, userId), before);
  });
});

// #52 (B15.06) AC2: a job that must run on a Mac (an iOS build) is never
// claimed by a Linux host, however much free capacity it has. With no Mac
// online the job stays queued with no attempt; once a Mac host claims, it gets
// exactly that job. The rule is the job's stored `requirements.platform`
// matched against the host's enrolled OS, in the claim query and again in the
// claim's admission recheck.
Deno.test("an iOS-only job stays queued while only a Linux host with free capacity claims, and a Mac host gets it", async () => {
  await withWorkerFixture(async (fixture) => {
    // Admitted through the production path, then pinned to macOS the way an
    // iOS build step's stored requirements name it.
    const job = await seedFundedModelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    await fixture.pgDatabase.query(
      `update bakery.jobs
          set requirements = requirements || '{"platform":"macos"}'::jsonb
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, job.jobId],
    );
    const linux = await registeredWorker(fixture, { slots: 4 });

    const refused = await rawClaim(fixture, linux, {
      capabilities: workerFixtureCapabilities,
    });
    assertEquals(refused.status, 204);
    const queued = await readExecutionState(fixture.pgDatabase, job.jobId);
    assertEquals(queued.job.status, "queued");
    assertEquals(queued.attempts, []);

    const mac = await registeredWorker(fixture, {
      os: "macos",
      architecture: "arm64",
    });
    const assignment = await claimAssignment(fixture, mac);
    assertEquals(assignment.jobId, job.jobId);
    assertEquals(assignment.workerHostId, mac.registration.workerHostId);
    assertEquals(
      (assignment.requirements as { platform?: string }).platform,
      "macos",
    );

    // Control: the same Linux host claims the same kind of job when no
    // platform is required, so its refusal above was the platform rule.
    const anywhere = await seedFundedModelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const linuxAssignment = await claimAssignment(fixture, linux);
    assertEquals(linuxAssignment.jobId, anywhere.jobId);
  });
});
