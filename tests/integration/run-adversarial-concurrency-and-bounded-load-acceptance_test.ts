import { assert, assertEquals } from "@std/assert";
import {
  closeWorkerFixture,
  closeWorkerScope,
  createWorkerScope,
  openWorkerFixture,
  type WorkerScope,
} from "../helpers/worker-execution.ts";
import {
  admitFundedModelRun as admit,
  fundedModelPolicy,
  seedAdmissibleRun as seedRun,
  seedProviderPricingSnapshot,
} from "../helpers/funded-model-job.ts";

// Issue #48 AC1: simultaneous work keeps capacity, budget, immutability and
// authority invariants. Each test races real production paths against one
// shared limit and reads the stored truth afterwards, never a counter the
// test kept itself.

const CONTENDERS = 16;

Deno.test("AC1: sixteen admissions racing for one installation cap never hold more than the cap", async () => {
  const fixture = await openWorkerFixture();
  const database = fixture.pgDatabase;
  let second: WorkerScope | undefined;
  try {
    await seedProviderPricingSnapshot(database);
    second = await createWorkerScope(fixture, "race-second-tenant", fixture);
    // 0.1 each against a 1.0 installation cap: exactly ten fit, whichever
    // organization's transaction gets there first.
    const runs = await Promise.all(
      Array.from({ length: CONTENDERS }, (_, index) =>
        seedRun(
          database,
          index % 2 === 0 ? fixture.organizationId : second!.organizationId,
          fixture.principalId,
          { reservationUsd: "0.1", stepKey: `cap-race-${index}` },
        )),
    );
    const raced = await Promise.allSettled(
      runs.map((run) => admit(database, run)),
    );
    const capUsd = Number(fundedModelPolicy.installationMonthlyLimitUsd);
    const winners = raced.filter((result) => result.status === "fulfilled");
    assertEquals(winners.length, Math.round(capUsd / 0.1));

    const held = (await database.query<{ total: string; holds: string }>(
      `select coalesce(sum(reservation.reserved_usd), 0)::text as total,
              count(*)::text as holds
         from bakery.budget_reservations as reservation
         join bakery.budget_accounts as account
           on account.id = reservation.budget_account_id
        where account.scope = 'installation' and reservation.status = 'held'`,
    )).rows[0];
    assert(held);
    assert(
      Number(held.total) <= capUsd,
      `installation holds ${held.total} exceed the ${capUsd} cap`,
    );
    assertEquals(Number(held.holds), winners.length);
    const account = (await database.query<{ reserved: string }>(
      `select reserved_usd::text as reserved from bakery.budget_accounts
        where scope = 'installation' and organization_id is null`,
    )).rows;
    assertEquals(account.map((row) => Number(row.reserved)), [capUsd]);
  } finally {
    if (second) await closeWorkerScope(fixture, second);
    await closeWorkerFixture(fixture);
  }
});
