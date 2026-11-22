import { assertEquals, assertInstanceOf } from "@std/assert";
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
import {
  rawClaim,
  withCoordinatorWorker,
} from "../helpers/coordinator-turn-jobs-worker.ts";
import {
  billing as coordinatorBilling,
  fund,
  seedAgentAndTurn,
  seedConversation,
} from "../helpers/coordinator-turn-jobs.ts";
import { withPgTransaction } from "@bakery/persistence/postgres";
import {
  type HostRow,
  rebindLiveClaimAttempt,
} from "../../packages/persistence/src/index.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";

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

// #52 (B15.06) AC2, past the claim query: an attempt already leased to a Mac
// host is rebound (pending-claim heartbeat, claim replay) only while that host
// still meets the job's platform. The claim SQL cannot see this case, so the
// recheck in the rebind path is the only guard: a host whose enrolled OS no
// longer matches `requirements.platform` is refused with AUTH_FORBIDDEN.
Deno.test("rebinding a macOS-only attempt is refused once the host's enrolled OS is not macOS", async () => {
  await withWorkerFixture(async (fixture) => {
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
    const mac = await registeredWorker(fixture, {
      os: "macos",
      architecture: "arm64",
    });
    const assignment = await claimAssignment(fixture, mac);
    assertEquals(assignment.jobId, job.jobId);

    const rebind = (os: string) =>
      withPgTransaction(fixture.pgDatabase, async (transaction) => {
        const host = await transaction.query<HostRow>(
          `select id, organization_id as "organizationId",
                  principal_id as "principalId", principal_type as "principalType",
                  name, $2::text as os, architecture, capabilities, slots, status,
                  desired_mode as "desiredMode", credential_hash as "credentialHash",
                  credential_generation as "credentialGeneration",
                  protocol_version as "protocolVersion",
                  inventory_revision as "inventoryRevision",
                  readiness_revision as "readinessRevision",
                  worker_session_id as "workerSessionId",
                  worker_session_generation as "workerSessionGeneration",
                  last_heartbeat_at as "lastHeartbeatAt"
             from bakery.worker_hosts where id = $1`,
          [mac.registration.workerHostId, os],
        );
        return await rebindLiveClaimAttempt(
          transaction,
          { tokenHash: host.rows[0].credentialHash, host: host.rows[0] },
          assignment.attemptId,
        );
      });

    // Control: the same host, still on macOS, passes the recheck.
    await rebind("macos");
    const refused = await rebind("linux").then(
      () => undefined,
      (error: unknown) => error,
    );
    assertInstanceOf(refused, StandardError);
    assertEquals(refused.code, "AUTH_FORBIDDEN");
  });
});

// #52 (B15.06) AC2, inside the claim: the claim query matches only the job's
// stored requirements, while the claim's admission recheck matches the
// admitted ones. A coordinator turn is admitted as needing "model" whatever
// its stored requirements say, so a turn job whose stored requirements were
// emptied passes the SQL for a host without "model"; the recheck in claims.ts
// is the only guard that keeps it queued. A host that has "model" gets it.
Deno.test("a claim is refused when the host lacks a capability the admitted job needs but its stored requirements omit", () =>
  withCoordinatorWorker(async (fixture) => {
    const seed = await seedConversation(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
      "b1506-claim-recheck",
    );
    const scope = await seedAgentAndTurn(fixture.pgDatabase, seed, {
      ...coordinatorBilling,
      maxUsdReservation: 0.02,
      pricingMetadataSnapshot: "b1506-claim-recheck-price",
    });
    const { job } = await fund(fixture.runtimePgDatabase, scope);
    await fixture.pgDatabase.query(
      `update bakery.jobs set requirements = '{"capabilities":[]}'::jsonb
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, job.jobId],
    );
    const jobState = async () =>
      (await fixture.pgDatabase.query<{ status: string; attempts: number }>(
        `select job.status,
                (select count(*)::int from bakery.job_attempts attempt
                  where attempt.job_id = job.id) as attempts
           from bakery.jobs job where job.id = $1`,
        [job.jobId],
      )).rows[0];

    const noModel = await registeredWorker(fixture, {
      capabilities: ["git", "shell"],
      slots: 4,
    });
    const refused = await rawClaim(fixture, noModel, {
      capabilities: ["git", "shell"],
      supportedActions: ["coordinator.turn"],
    });
    assertEquals(refused.status, 204);
    await refused.body?.cancel();
    assertEquals(await jobState(), { status: "queued", attempts: 0 });

    // Control: a host enrolled with "model" claims the same job.
    const withModel = await registeredWorker(fixture, {
      capabilities: ["model"],
    });
    const assignment = await claimAssignment(fixture, withModel, {
      capabilities: ["model"],
      supportedActions: ["coordinator.turn"],
    });
    assertEquals(assignment.jobId, job.jobId);
    assertEquals(assignment.workerHostId, withModel.registration.workerHostId);
  }));
