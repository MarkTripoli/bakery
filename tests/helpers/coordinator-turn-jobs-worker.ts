import { withWorkerFixture } from "./worker-execution/scenarios.ts";
import { type registeredWorker, workerRequest } from "./worker-execution.ts";
import { cleanupCoordinatorScopes } from "./coordinator-turn-jobs.ts";

export type WorkerFx = Parameters<Parameters<typeof withWorkerFixture>[0]>[0];

/** Worker fixture whose coordinator rows are removed before the org delete. */
export function withCoordinatorWorker(
  work: (fixture: WorkerFx) => Promise<void>,
): Promise<void> {
  return withWorkerFixture(async (fixture) => {
    try {
      await work(fixture);
    } finally {
      await cleanupCoordinatorScopes(
        fixture.pgDatabase,
        fixture.organizationId,
      );
    }
  });
}

export async function rawClaim(
  fixture: WorkerFx,
  worker: Awaited<ReturnType<typeof registeredWorker>>,
  body: { capabilities: string[]; supportedActions?: string[] },
): Promise<Response> {
  const claimKey = crypto.randomUUID();
  return await workerRequest(
    fixture,
    worker.credential,
    "/v1/worker/claims",
    {
      claimKey,
      workerHostId: worker.registration.workerHostId,
      ...body,
    },
    { idempotencyKey: claimKey },
  );
}
