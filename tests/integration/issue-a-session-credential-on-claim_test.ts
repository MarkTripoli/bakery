import { assert, assertEquals } from "@std/assert";
import { withPgTransaction } from "@bakery/persistence";
import {
  resolveSessionCredential,
} from "../../apps/server/src/modules/execution/session-credential-store.ts";
import {
  registeredWorker,
  seedFundedModelJob,
} from "../helpers/worker-execution.ts";
import {
  claimAssignment,
  withWorkerFixture,
} from "../helpers/worker-execution/scenarios.ts";

// #401 slice 1, driven through the real claim route.
//
// The existing integration test for this module *manually* calls
// `issueStoredSessionCredential` and then resolves it, which proves the store
// round-trips - and proves nothing about whether a claim ever issues one. That
// gap is the whole defect: the tables, the resolver, the audit and the gateway
// were all merged and tested, and no production path minted a credential. So
// this one claims through the route and asserts the response carries it.

Deno.test("a real claim hands back a credential bound to its attempt", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, { slots: 1 });
    await seedFundedModelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const assignment = await claimAssignment(fixture, worker) as unknown as {
      attemptId: string;
      sessionCredential?: string | null;
    };

    const token = assignment.sessionCredential;
    assert(
      typeof token === "string" && token.length > 20,
      "the claim route returned no session credential, so no session can call anything",
    );

    const resolved = await withPgTransaction(
      fixture.pgDatabase,
      (tx) => resolveSessionCredential(tx, token),
    );

    // Bound to this attempt and to the person it acts for.
    assertEquals(resolved.claim.attemptId, assignment.attemptId);
    assertEquals(resolved.claim.actsForPrincipalId, fixture.principalId);
    // And specifically NOT the worker host. The fixture's human and the enrolled
    // worker are different principals, so this catches the fallback that used to
    // be here: `job.actsForPrincipalId ?? identity.host.principalId`. A host
    // principal is a worker, and a credential acting for one would let a session
    // speak as the machine rather than as the person who asked for the work.
    assertEquals(resolved.claim.actsForPrincipalType, "human");
    // The dispatch principal carries the person's real name from
    // bakery.principals, because the action guard refuses a subject it cannot
    // name.
    const principal = await fixture.pgDatabase.query<{ displayName: string }>(
      `select display_name as "displayName" from bakery.principals where id = $1`,
      [fixture.principalId],
    );
    assert(principal.rows[0].displayName.trim() !== "");
    assertEquals(
      resolved.claim.actsForPrincipalDisplayName,
      principal.rows[0].displayName,
    );
    assert(
      resolved.claim.scopes.length > 0,
      "the credential was issued with no scopes, so it can call nothing",
    );
    // AC3: read operations first. No definition grants a write yet, so minting
    // one here would hand every session an authority nobody granted.
    for (const scope of resolved.claim.scopes) {
      assert(
        scope.endsWith(".read"),
        `the claim minted ${scope}, which no definition granted`,
      );
    }
  }));

Deno.test("only the digest is stored, never the token", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, { slots: 1 });
    await seedFundedModelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const assignment = await claimAssignment(fixture, worker) as unknown as {
      attemptId: string;
      sessionCredential?: string | null;
    };

    const rows = await withPgTransaction(
      fixture.pgDatabase,
      (tx) =>
        tx.query<{ token_hash: string; revoked_at: Date | null }>(
          `select token_hash, revoked_at
             from bakery.session_operation_credentials
            where attempt_id = $1`,
          [assignment.attemptId],
        ),
    );
    assertEquals(
      rows.rows.length,
      1,
      "no credential row was written for the attempt",
    );
    const stored = rows.rows[0].token_hash;
    // A leak of this table must not be a leak of live credentials.
    assert(
      !stored.includes(assignment.sessionCredential!),
      "the token itself was stored instead of its digest",
    );
    assertEquals(stored.length, 64, "the stored value is not a sha-256 digest");
  }));

Deno.test("a replayed claim revokes the old token and mints a fresh one", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, { slots: 1 });
    await seedFundedModelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const claimKey = crypto.randomUUID();
    const first = await claimAssignment(fixture, worker, {
      claimKey,
    }) as unknown as { attemptId?: string; sessionCredential?: string };
    assert(
      typeof first.sessionCredential === "string",
      "first claim: no token",
    );

    const replay = await claimAssignment(fixture, worker, {
      claimKey,
    }) as unknown as { attemptId?: string; sessionCredential?: string };
    // The stored ciphertext carries the first token, so re-serving it would make
    // "returned once" false. A worker whose first response was lost still needs
    // a working credential, so the replay mints a new one for this response only.
    assert(
      typeof replay.sessionCredential === "string" &&
        replay.sessionCredential !== first.sessionCredential,
      "a replayed claim must carry a fresh token, not the old one or none",
    );
    assertEquals(replay.attemptId, first.attemptId);

    const resolveToken = (token: string) =>
      withPgTransaction(fixture.pgDatabase, async (transaction) => {
        try {
          return await resolveSessionCredential(transaction, token);
        } catch (error) {
          return error as Error;
        }
      });
    assert(
      (await resolveToken(first.sessionCredential)) instanceof Error,
      "the token from the first claim still resolves after a replay",
    );
    const fresh = await resolveToken(replay.sessionCredential);
    assert(!(fresh instanceof Error), "the replay's token does not resolve");
    assertEquals(fresh.claim.attemptId, first.attemptId);
  }));
