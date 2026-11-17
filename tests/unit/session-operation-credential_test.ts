import { assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import type {
  AttemptRow,
  WorkerIdentity,
} from "../../apps/server/src/modules/execution/shared.ts";
import {
  assertOperationScope,
  assertSessionOperationLive,
  issueSessionOperationCredential,
  SessionOperationError,
} from "../../apps/server/src/modules/execution/session-credential.ts";

const ORG = "11111111-1111-4111-8111-111111111111";
const FUTURE = new Date(Date.now() + 60_000);

const code = (error: unknown): string | undefined =>
  error instanceof SessionOperationError ? error.code : undefined;

function issued(overrides: Partial<
  Parameters<
    typeof issueSessionOperationCredential
  >[0]
> = {}) {
  return issueSessionOperationCredential({
    organizationId: ORG,
    attemptId: "attempt-1",
    actsForPrincipalId: "principal-1",
    workerSessionId: "session-1",
    workerSessionGeneration: 3n,
    fence: 7n,
    leaseTokenHash: "hash-1",
    scopes: ["artifacts.read", "workflows.read"],
    leaseExpiresAt: FUTURE,
    ...overrides,
  });
}

// A real AttemptRow, because liveness now delegates to assertActiveLease and a
// hand-shaped stand-in would not exercise the status check that was missing.
const liveAttempt = (overrides: Partial<AttemptRow> = {}): AttemptRow => ({
  id: "attempt-1",
  organization_id: ORG,
  job_id: "job-1",
  worker_host_id: "host-1",
  worker_session_id: "session-1",
  worker_session_generation: "3",
  fence: "7",
  lease_token_hash: "hash-1",
  lease_expires_at: new Date(Date.now() + 60_000),
  lease_expired: false,
  job_current_fence: "7",
  status: "running",
  last_event_seq: "1",
  ...overrides,
});

const identity = (overrides: Record<string, unknown> = {}): WorkerIdentity => ({
  tokenHash: "hash-1",
  host: {
    id: "host-1",
    organization_id: ORG,
    principal_id: "principal-1",
    principal_type: "worker",
    name: "host",
    os: "linux",
    architecture: "x86_64",
    capabilities: {},
    slots: 1,
    status: "active",
    desired_mode: "active",
    credential_hash: "hash-1",
    credential_generation: 1,
    protocol_version: 2,
    inventory_revision: 1,
    readiness_revision: 1,
    worker_session_id: "session-1",
    worker_session_generation: "3",
    last_heartbeat_at: null,
    ...overrides,
  },
});

Deno.test("a credential records who is acting for whom, and under what scopes", () => {
  const { token, claim } = issued();
  assertEquals(token.length > 0, true);
  assertEquals(claim.actsForPrincipalId, "principal-1");
  assertEquals(claim.attemptId, "attempt-1");
  // Ordered and deduplicated, so an audit line does not depend on the order a
  // definition happened to list its scopes.
  assertEquals(claim.scopes, ["artifacts.read", "workflows.read"]);
  assertEquals(issued({ scopes: ["b", "a", "b"] }).claim.scopes, ["a", "b"]);
});

Deno.test("two credentials for one attempt are different tokens", () => {
  assertNotEquals(issued().token, issued().token);
});

Deno.test("a credential never outlives its lease", () => {
  // Passing a later expiry must not extend the credential past the lease; a
  // credential that outlived its lease would let work keep acting after it was
  // reassigned, which is exactly what the fence prevents.
  const leaseExpiresAt = new Date(Date.now() + 5_000);
  const { claim } = issued({ leaseExpiresAt });
  assertEquals(claim.expiresAt.getTime(), leaseExpiresAt.getTime());
});

Deno.test("issuing a credential for an expired lease is refused, not issued dead", () => {
  const error = assertThrows(() =>
    issued({ leaseExpiresAt: new Date(Date.now() - 1_000) })
  );
  assertEquals(code(error), "SESSION_CREDENTIAL_EXPIRED");
});

Deno.test("a credential dies when the lease expires", () => {
  const { claim } = issued();
  const error = assertThrows(() =>
    assertSessionOperationLive(
      claim,
      liveAttempt({ lease_expired: true }),
      identity(),
    )
  );
  assertEquals(code(error), "SESSION_CREDENTIAL_EXPIRED");
});

Deno.test("a credential dies when the attempt itself is no longer live", () => {
  // QA found this: the first version compared the fence columns by hand and
  // never looked at the attempt's status, so a finished attempt whose lease had
  // not yet expired sailed through. Liveness delegates to assertActiveLease now,
  // which is where the status check already lived.
  const { claim } = issued();
  for (const status of ["completed", "failed", "canceled"]) {
    assertEquals(
      code(
        assertThrows(() =>
          assertSessionOperationLive(claim, liveAttempt({ status }), identity())
        ),
      ),
      "SESSION_CREDENTIAL_FENCE_STALE",
      status,
    );
  }
});

Deno.test("a credential dies when its own deadline passes", () => {
  const { claim } = issued();
  const later = new Date(claim.expiresAt.getTime() + 1_000);
  const error = assertThrows(() =>
    assertSessionOperationLive(claim, liveAttempt(), identity(), later)
  );
  assertEquals(code(error), "SESSION_CREDENTIAL_EXPIRED");
});

Deno.test("a credential dies when the fence moves, in either column", () => {
  const { claim } = issued();
  // The attempt's own fence moving is a reassignment.
  assertEquals(
    code(
      assertThrows(() =>
        assertSessionOperationLive(
          claim,
          liveAttempt({ fence: "8" }),
          identity(),
        )
      ),
    ),
    "SESSION_CREDENTIAL_FENCE_STALE",
  );
  // So is the job's current fence moving without the attempt's: that is the
  // case where a newer attempt exists and this one has not noticed.
  assertEquals(
    code(
      assertThrows(() =>
        assertSessionOperationLive(
          claim,
          liveAttempt({ job_current_fence: "8" }),
          identity(),
        )
      ),
    ),
    "SESSION_CREDENTIAL_FENCE_STALE",
  );
});

Deno.test("a credential dies when its session is recycled with a new generation", () => {
  const { claim } = issued();
  const error = assertThrows(() =>
    assertSessionOperationLive(
      claim,
      liveAttempt({ worker_session_generation: "4" }),
      identity(),
    )
  );
  assertEquals(code(error), "SESSION_CREDENTIAL_FENCE_STALE");
});

Deno.test("a credential does not answer for another attempt or organization", () => {
  const { claim } = issued();
  for (
    const attempt of [
      liveAttempt({ id: "attempt-2" }),
      liveAttempt({ organization_id: "22222222-2222-4222-8222-222222222222" }),
    ]
  ) {
    assertEquals(
      code(
        assertThrows(() =>
          assertSessionOperationLive(claim, attempt, identity())
        ),
      ),
      "SESSION_CREDENTIAL_FENCE_STALE",
    );
  }
});

Deno.test("a live credential passes the check it was issued for", () => {
  const { claim } = issued();
  // The positive control: if this refused, every case above would pass for the
  // wrong reason.
  assertSessionOperationLive(claim, liveAttempt(), identity());
});

Deno.test("a scope the session was not granted is refused", () => {
  const { claim } = issued();
  const error = assertThrows(() =>
    assertOperationScope(claim, "workflows.publish")
  );
  assertEquals(code(error), "SESSION_SCOPE_DENIED");
  // A granted one passes.
  assertOperationScope(claim, "artifacts.read");
});

Deno.test("a wildcard is never grantable, by either side", () => {
  // A scope that expands is a promise the issuer cannot keep once a new
  // operation is added, so it is refused even when the claim looks like it
  // would match.
  const { claim } = issued({ scopes: ["*", "workflows.*"] });
  for (const required of ["*", "workflows.*", "workflows.publish"]) {
    assertEquals(
      code(assertThrows(() => assertOperationScope(claim, required))),
      "SESSION_SCOPE_DENIED",
      required,
    );
  }
});

Deno.test("several required scopes must all be held", () => {
  const { claim } = issued();
  assertOperationScope(claim, ["artifacts.read", "workflows.read"]);
  assertEquals(
    code(
      assertThrows(() =>
        assertOperationScope(claim, ["artifacts.read", "agents.publish"])
      ),
    ),
    "SESSION_SCOPE_DENIED",
  );
});
