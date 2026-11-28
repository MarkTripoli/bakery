import type { BakeryApiClient } from "../api/client.ts";
import { failureStatus } from "../app/async-state.ts";

type RepairApi = Readonly<{
  workers: Pick<BakeryApiClient["workers"], "repairEnrollment">;
  workerEnrollments: Pick<
    BakeryApiClient["workerEnrollments"],
    "list" | "cancel"
  >;
}>;

export async function issueRepair(
  api: RepairApi,
  organizationId: string,
  machineId: string,
) {
  const issue = () =>
    api.workers.repairEnrollment({
      organizationId,
      id: machineId,
      idempotencyKey: crypto.randomUUID(),
    });
  const first = await issue();
  if (
    first.ok || failureStatus(first.error) !== 409 ||
    !await cancelPendingRepair(api, organizationId, machineId)
  ) return first;
  return await issue();
}

async function pendingRepair(
  api: RepairApi,
  organizationId: string,
  machineId: string,
) {
  let cursor: string | undefined;
  do {
    const listed = await api.workerEnrollments.list({
      organizationId,
      cursor,
      limit: 100,
    });
    if (!listed.ok) return undefined;
    const match = listed.data.items.find((item) =>
      item.targetWorkerHostId === machineId && item.state === "pending"
    );
    if (match) return match;
    cursor = listed.data.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return undefined;
}

async function cancelPendingRepair(
  api: RepairApi,
  organizationId: string,
  machineId: string,
): Promise<boolean> {
  const pending = await pendingRepair(api, organizationId, machineId);
  if (!pending) return false;
  const canceled = await api.workerEnrollments.cancel({
    organizationId,
    id: pending.enrollmentId,
    version: pending.version,
    idempotencyKey: crypto.randomUUID(),
  });
  return canceled.ok;
}
