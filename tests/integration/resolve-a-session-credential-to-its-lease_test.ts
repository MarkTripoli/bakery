import { assertEquals } from "@std/assert";
import { withPgTransaction } from "@bakery/persistence";
import { sha256Hex } from "../../apps/server/src/platform/canonical-json.ts";
import {
  issueStoredSessionCredential,
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

// #401. A session credential is only useful if resolving it returns the lease it
// was issued against: liveness is delegated to `assertActiveLease`, which
// compares the attempt's current lease token with the one the credential
// claims. The row type declared `leaseTokenHash` and the table never had the
// column, so every resolved claim carried `undefined` and every call was
// refused as fence-stale - while every unit test passed, because none of them
// drove issue-then-resolve through the store.
//
// This is the composition-root proof: it writes through the real store and
// reads back through the real resolver, so a column that is declared but not
// selected cannot pass.

Deno.test("a resolved credential carries the lease it was issued against", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, { slots: 1 });
    await seedFundedModelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const assignment = await claimAssignment(fixture, worker);

    const leaseTokenHash = await sha256Hex(assignment.leaseToken);
    const issued = await withPgTransaction(
      fixture.pgDatabase,
      (tx) =>
        issueStoredSessionCredential(tx, {
          organizationId: fixture.organizationId,
          attemptId: assignment.attemptId,
          actsForPrincipalId: fixture.principalId,
          actsForPrincipalType: "human",
          workerSessionId: String(assignment.workerSessionId),
          workerSessionGeneration: BigInt(
            String(assignment.workerSessionGeneration),
          ),
          fence: BigInt(assignment.fence),
          leaseTokenHash,
          scopes: ["artifacts.read"],
          leaseExpiresAt: new Date(Date.now() + 60_000),
        }),
    );

    const resolved = await withPgTransaction(
      fixture.pgDatabase,
      (tx) => resolveSessionCredential(tx, issued.token),
    );

    // The value written is the value read. Before the column existed this was
    // `undefined`, and the comparison it feeds could never succeed.
    assertEquals(resolved.claim.leaseTokenHash, leaseTokenHash);
    assertEquals(resolved.claim.attemptId, assignment.attemptId);
    assertEquals(resolved.claim.fence, BigInt(assignment.fence));
  }));
