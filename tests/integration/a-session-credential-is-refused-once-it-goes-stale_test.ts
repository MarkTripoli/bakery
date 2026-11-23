/**
 * A session credential is the whole of what the credential-only route trusts.
 *
 * `GET /v1/session/tools` and `POST /v1/session/call` carry no host bearer and no
 * attempt id, so every check that used to be made against a presented worker
 * credential is now made against this one token and the rows behind it. That
 * makes the refusal cases the important ones: a credential whose lease moved, was
 * replaced or expired, an attempt that ended, a credential that was revoked or
 * timed out, a host that was revoked or whose session rotated, and the shapes a
 * caller might reach for instead of a credential (nothing at all, a forged token,
 * the host bearer).
 *
 * Each case first proves the same credential reaches the tools while it is live,
 * so a later refusal is the change rather than a broken baseline.
 */

import { assert, assertEquals } from "@std/assert";
import { registeredWorker } from "../helpers/worker-execution.ts";
import { seedEligibleNonmodelJob } from "../helpers/worker-execution/nonmodel-job.ts";
import {
  claimAssignment,
  withWorkerFixture,
} from "../helpers/worker-execution/scenarios.ts";
import {
  SESSION_CALL_PATH,
  SESSION_CREDENTIAL_HEADER,
  SESSION_TOOLS_PATH,
} from "../../apps/server/src/modules/execution/session-routes.ts";

type Fixture = Parameters<Parameters<typeof withWorkerFixture>[0]>[0];

async function openSession(fixture: Fixture) {
  const worker = await registeredWorker(fixture, { slots: 1 });
  await seedEligibleNonmodelJob(
    fixture.pgDatabase,
    fixture.organizationId,
    fixture.principalId,
  );
  const assignment = await claimAssignment(fixture, worker);
  return {
    worker,
    attemptId: assignment.attemptId,
    token: String(assignment.sessionCredential ?? ""),
  };
}

/** The credential header alone: no authorization, no protocol header. */
function listTools(
  fixture: Fixture,
  token: string | null,
  extra: Readonly<Record<string, string>> = {},
): Response | Promise<Response> {
  const headers: Record<string, string> = { ...extra };
  if (token !== null) headers[SESSION_CREDENTIAL_HEADER] = token;
  return fixture.app.fetch(
    new Request(
      `${fixture.config.publicBaseUrl}${SESSION_TOOLS_PATH}`,
      { headers },
    ),
  );
}

function callTool(
  fixture: Fixture,
  token: string,
): Response | Promise<Response> {
  return fixture.app.fetch(
    new Request(`${fixture.config.publicBaseUrl}${SESSION_CALL_PATH}`, {
      method: "POST",
      headers: {
        [SESSION_CREDENTIAL_HEADER]: token,
        "content-type": "application/json",
      },
      body: JSON.stringify({ tool: "runs.get", arguments: {} }),
    }),
  );
}

async function shown(response: Response): Promise<string> {
  const text = await response.text();
  return `${response.status} ${text.slice(0, 160)}`;
}

/** Awaits a fixture answer, which may be a response or a promise of one. */
async function answer(
  response: Response | Promise<Response>,
): Promise<Response> {
  return await response;
}

Deno.test("a live credential alone reaches the tools", () =>
  withWorkerFixture(async (fixture) => {
    const session = await openSession(fixture);
    const response = await answer(listTools(fixture, session.token));
    assertEquals(response.status, 200, await shown(response));
  }));

Deno.test("no credential, a forged one, or the host bearer alone is refused", () =>
  withWorkerFixture(async (fixture) => {
    const session = await openSession(fixture);
    const cases: Record<string, Response> = {
      none: await answer(listTools(fixture, null)),
      forged: await answer(listTools(
        fixture,
        `bsc_${crypto.randomUUID().replaceAll("-", "")}`,
      )),
      // The machine's own credential is not a session's. The route reads one
      // header, so a bearer is simply not a credential.
      hostBearer: await answer(listTools(fixture, null, {
        authorization: `Bearer ${session.worker.credential}`,
      })),
    };
    for (const [name, response] of Object.entries(cases)) {
      const text = await shown(response);
      assert(response.status >= 400, `${name} was served: ${text}`);
      assert(response.status !== 500, `${name} was a fault: ${text}`);
    }
  }));

/**
 * Each of these leaves the token in place and changes the world under it.
 *
 * A case is one statement so the reason for a refusal is unambiguous, and the
 * closed set means a new way for a session to go stale has to be named here.
 */
const STALE_STATES: readonly (readonly [string, string])[] = [
  [
    "fence bumped (the lease moved)",
    "update bakery.job_attempts set fence = fence + 1 where id = $1",
  ],
  [
    "lease token replaced",
    "update bakery.job_attempts set lease_token_hash = 'x' || lease_token_hash where id = $1",
  ],
  [
    "lease expired",
    "update bakery.job_attempts set lease_expires_at = now() - interval '1 minute' where id = $1",
  ],
  [
    "attempt no longer active",
    "update bakery.job_attempts set status = 'failed' where id = $1",
  ],
  [
    "credential revoked",
    "update bakery.session_operation_credentials set revoked_at = now() where attempt_id = $1",
  ],
  [
    "credential expired",
    "update bakery.session_operation_credentials set expires_at = now() - interval '1 minute' where attempt_id = $1",
  ],
  [
    "host revoked",
    `update bakery.worker_hosts set status = 'revoked'
      where id = (select worker_host_id from bakery.job_attempts where id = $1)`,
  ],
  [
    "host worker session rotated",
    `update bakery.worker_hosts set worker_session_id = gen_random_uuid()
      where id = (select worker_host_id from bakery.job_attempts where id = $1)`,
  ],
  [
    "host worker generation bumped",
    `update bakery.worker_hosts
        set worker_session_generation = worker_session_generation + 1
      where id = (select worker_host_id from bakery.job_attempts where id = $1)`,
  ],
];

for (const [reason, statement] of STALE_STATES) {
  Deno.test(`a credential is refused once ${reason}`, () =>
    withWorkerFixture(async (fixture) => {
      const session = await openSession(fixture);
      const before = await answer(listTools(fixture, session.token));
      assertEquals(before.status, 200, `baseline: ${await shown(before)}`);
      await fixture.pgDatabase.query(statement, [session.attemptId]);
      const listed = await answer(listTools(fixture, session.token));
      const called = await answer(callTool(fixture, session.token));
      assert(
        listed.status >= 400 && listed.status !== 500,
        `tools served after ${reason}: ${await shown(listed)}`,
      );
      assert(
        called.status >= 400 && called.status !== 500,
        `call served after ${reason}: ${await shown(called)}`,
      );
    }));
}

/**
 * A host row that the worker routes would refuse is refused here as well.
 *
 * The session route loads the host by id from the attempt's own row rather than
 * from a presented bearer, so the check `workerTransaction` runs on that row has
 * to run here too. Without it a session could act under a host record that every
 * worker route rejects — the machine's own credential path would be safe and this
 * one would not.
 *
 * Each corruption is one field. The digest case is the one that pins this check:
 * with `assertHostRowIntegrity` removed, it is the case that fails, because
 * nothing else in the path looks at the hash. The generation case is refused by
 * the session check as well, so it would pass with or without this line; it stays
 * because a corrupt row must not serve either way.
 */
const CORRUPT_HOSTS: readonly (readonly [string, string])[] = [
  [
    "the host's credential hash is not a digest",
    `update bakery.worker_hosts set credential_hash = 'not-a-digest'
      where id = (select worker_host_id from bakery.job_attempts where id = $1)`,
  ],
  [
    "the host has a session but no generation",
    `update bakery.worker_hosts
        set worker_session_id = gen_random_uuid(), worker_session_generation = 0
      where id = (select worker_host_id from bakery.job_attempts where id = $1)`,
  ],
];

for (const [condition, statement] of CORRUPT_HOSTS) {
  Deno.test(`a session is refused when ${condition}`, () =>
    withWorkerFixture(async (fixture) => {
      const session = await openSession(fixture);
      const before = await answer(listTools(fixture, session.token));
      assertEquals(before.status, 200, `baseline: ${await shown(before)}`);
      await fixture.pgDatabase.query(statement, [session.attemptId]);
      const listed = await answer(listTools(fixture, session.token));
      const called = await answer(callTool(fixture, session.token));
      assert(
        listed.status >= 400 && listed.status !== 500,
        `tools served on a corrupt host row (${condition}): ${await shown(
          listed,
        )}`,
      );
      assert(
        called.status >= 400 && called.status !== 500,
        `call served on a corrupt host row (${condition}): ${await shown(
          called,
        )}`,
      );
    }));
}

Deno.test("the attempt-id session routes are gone", () =>
  withWorkerFixture(async (fixture) => {
    const session = await openSession(fixture);
    // Both credentials and the protocol header, which is what the removed route
    // required: it must still answer nothing, because the route no longer exists
    // rather than because a header was missing.
    const response = await answer(fixture.app.fetch(
      new Request(
        `${fixture.config.publicBaseUrl}/v1/worker/attempts/${session.attemptId}/session-tools`,
        {
          headers: {
            [SESSION_CREDENTIAL_HEADER]: session.token,
            authorization: `Bearer ${session.worker.credential}`,
            "bakery-worker-protocol-version": "1",
          },
        },
      ),
    ));
    assertEquals(response.status, 404, await shown(response));
  }));
