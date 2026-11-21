import { assert, assertEquals } from "@std/assert";
import {
  readScopesForSession,
  sessionCredentialForClaim,
} from "../../apps/server/src/modules/execution/session-claim-credential.ts";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";
import { assignmentFromJob } from "../../apps/server/src/modules/execution/claim-application.ts";

/**
 * Slice 1 of #401: issuing the session operation credential at claim time.
 *
 * Before this, everything the credential needed existed - the tables, the
 * resolution, the audit, the gateway that lists tools for it - and nothing
 * minted one. `issueStoredSessionCredential` had exactly one caller in the
 * repository, an integration test, so the whole chain was reachable only from
 * tests. A credential that is never issued cannot die with a lease.
 */

const ATTEMPT = "0195f000-0000-7000-8000-000000000001";
const ORGANIZATION = "0195f000-0000-7000-8000-000000000002";
const PRINCIPAL = "0195f000-0000-7000-8000-000000000003";
const SESSION = "0195f000-0000-7000-8000-000000000004";

const base = {
  organizationId: ORGANIZATION,
  attemptId: ATTEMPT,
  actsForPrincipalId: PRINCIPAL,
  workerSessionId: SESSION,
  workerSessionGeneration: 1n,
  fence: 7n,
  leaseTokenHash: "a".repeat(64),
  leaseExpiresAt: new Date("2026-01-01T00:10:00Z"),
  now: new Date("2026-01-01T00:00:00Z"),
};

Deno.test("a claim gets a credential bound to its attempt, fence and principal", () => {
  const credential = sessionCredentialForClaim(base);
  assertEquals(credential.claim.attemptId, ATTEMPT);
  assertEquals(credential.claim.fence, 7n);
  assertEquals(credential.claim.actsForPrincipalId, PRINCIPAL);
  assertEquals(credential.claim.leaseTokenHash, "a".repeat(64));
  // The token is handed back once and never stored in the clear.
  assert(credential.token.length > 20, "the token is too short to be secret");
});

Deno.test("a credential never outlives the lease it was minted under", () => {
  // The lease is what bounds the credential's life, so an expiry past it would
  // make "dies with the lease" a comment rather than a fact.
  const shortLease = new Date("2026-01-01T00:00:30Z");
  const credential = sessionCredentialForClaim({
    ...base,
    leaseExpiresAt: shortLease,
  });
  assertEquals(credential.claim.expiresAt.getTime(), shortLease.getTime());
});

Deno.test("an attempt with no person to act for cannot be minted", () => {
  // O50: the audit names the principal the agent acted for. A credential with
  // no principal would produce audit rows nobody can attribute, so it is a
  // refusal rather than a credential with a null in it.
  let threw = false;
  try {
    sessionCredentialForClaim({ ...base, actsForPrincipalId: null });
  } catch (error) {
    threw = true;
    assertEquals(
      (error as { code?: string }).code,
      "SESSION_CREDENTIAL_NO_PRINCIPAL",
    );
  }
  assert(threw, "a claim with no principal was given a credential");
});

Deno.test("a session gets read scopes and no write scope", () => {
  // AC3: read operations first. A write tool appears only where a definition
  // granted the scope, and no definition grants one yet - so minting a write
  // scope here would hand every session an authority nobody granted.
  const scopes = readScopesForSession();
  assert(scopes.length > 0, "no read scopes were offered");
  for (const scope of scopes) {
    assert(
      scope.endsWith(".read"),
      `${scope} is not a read scope, so nothing should grant it by default`,
    );
  }
  assertEquals([...scopes].sort(), [...scopes], "scopes are not ordered");
  assertEquals(new Set(scopes).size, scopes.length, "scopes repeat");
});

Deno.test("the claim response carries the token and the wire type accepts it", () => {
  // The token has to reach the worker through the assignment it already parses,
  // or the credential exists and nobody can present it - the same "built and
  // never called" shape that had to be fixed for the gateway itself.
  const shape = (contractSchemas.JobAssignment as unknown as {
    shape: Record<string, { safeParse(v: unknown): { success: boolean } }>;
  }).shape;
  assert(
    shape.sessionCredential !== undefined,
    "the assignment has no sessionCredential field, so the token cannot travel",
  );
  const credential = sessionCredentialForClaim(base);
  assert(
    shape.sessionCredential.safeParse(credential.token).success,
    "the wire type refused the token this server minted",
  );

  // The schema accepting it is not the same as the server putting it there:
  // the field could be declared and never filled in. Asserted on the envelope
  // the claim actually builds.
  const repositoryId = "77777777-7777-4777-8777-777777777777";
  const built = assignmentFromJob(
    {
      id: "11111111-1111-4111-8111-111111111111",
      action: "quality.check",
      requirements: {},
      input: { repositoryId, revision: "base", checks: ["test"] },
      currentCheckpoints: [],
      agentConfig: {},
      skillRefs: [],
      agentVersionId: "44444444-4444-4444-8444-444444444444",
      billing: null,
      installationReservationId: null,
      agentSessionId: null,
      actsForPrincipalId: PRINCIPAL,
      currentFence: "1",
    } as never,
    ATTEMPT,
    "33333333-3333-4333-8333-333333333333",
    SESSION,
    "1",
    "lease-token-fixture",
    1n,
    new Date("2026-01-01T00:00:00Z"),
    30,
    new Date("2026-01-01T00:00:00Z"),
    null,
    credential,
    "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
  );
  assertEquals(
    (built as { sessionCredential?: string }).sessionCredential,
    credential.token,
    "the built assignment does not carry the token",
  );
});

Deno.test("the token is returned once and never stored in the clear", () => {
  // Only the digest is stored, so a leak of the table is not a leak of live
  // credentials. Asserted on the claim the store writes, not on a log line.
  const credential = sessionCredentialForClaim(base);
  const stored = JSON.stringify(
    credential.claim,
    (_k, v) => typeof v === "bigint" ? v.toString() : v,
  );
  assert(
    !stored.includes(credential.token),
    "the token itself appears in the claim the store would write",
  );
  assertEquals(
    credential.claim.leaseTokenHash,
    base.leaseTokenHash,
    "the credential does not remember the lease it was issued under",
  );
});
