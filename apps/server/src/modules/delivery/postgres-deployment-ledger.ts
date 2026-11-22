import { type PgDatabase, withPgTransaction } from "../../platform/database.ts";
import type { DeploymentLedger } from "./deployment-driver.ts";
import {
  advanceDeployment,
  readDeployment,
  rollbackDeployment,
} from "./deployments.ts";

/**
 * The deployment ledger over the `bakery.deployments` table (#43): each call
 * is one short transaction, so a move commits before the next adapter call and
 * a crash between them leaves the record at the last move the adapter was told
 * about. The state machine and the version check live in the store, not here.
 */
export function createPostgresDeploymentLedger(
  deps: Readonly<{
    database: PgDatabase;
    organizationId: string;
    /** Who a rollback the driver starts is recorded as. */
    principalId: string;
    requestId: string;
    traceId: string;
  }>,
): DeploymentLedger {
  const { database, organizationId } = deps;
  return {
    read: (deploymentId) =>
      withPgTransaction(
        database,
        (transaction) =>
          readDeployment(transaction, organizationId, deploymentId),
      ),
    advance: (deploymentId, move) =>
      withPgTransaction(
        database,
        (transaction) =>
          advanceDeployment(transaction, organizationId, deploymentId, move),
      ),
    startRollback: (deploymentId, reason) =>
      withPgTransaction(
        database,
        (transaction) =>
          rollbackDeployment(
            transaction,
            organizationId,
            deps.principalId,
            deploymentId,
            {
              requestId: deps.requestId,
              traceId: deps.traceId,
              reason,
            },
          ),
      ),
  };
}
