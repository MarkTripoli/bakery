import { assert, assertEquals } from "@std/assert";
import type { PgDatabase } from "../../../apps/server/src/platform/database.ts";
import { sha256Hex } from "../../../apps/server/src/platform/canonical-json.ts";
import { WorkerApiClient } from "../../../apps/worker/src/client.ts";
import { seedEligibleNonmodelJob } from "../../helpers/worker-execution/nonmodel-job.ts";
import { workerFixtureCapabilities } from "../../helpers/worker-execution.ts";

export async function seedArchiveProducer(
  database: PgDatabase,
  origin: string,
  scope: {
    readonly organizationId: string;
    readonly principalId: string;
  },
) {
  const job = await seedEligibleNonmodelJob(
    database,
    scope.organizationId,
    scope.principalId,
  );
  const principalId = crypto.randomUUID();
  const workerHostId = crypto.randomUUID();
  const workerSessionId = crypto.randomUUID();
  const credential = crypto.randomUUID();
  await database.query(
    "insert into bakery.principals(id,display_name,principal_type) values($1,'Archive acceptance worker','worker')",
    [principalId],
  );
  await database.query(
    `insert into bakery.worker_hosts(id,organization_id,principal_id,principal_type,name,os,architecture,capabilities,slots,
      credential_hash,protocol_version,worker_session_id,worker_session_generation,last_heartbeat_at)
      values($1,$2,$3,'worker','archive-worker','linux','x64',$4::jsonb,1,$5,2,$6,1,now())`,
    [
      workerHostId,
      scope.organizationId,
      principalId,
      JSON.stringify(workerFixtureCapabilities),
      await sha256Hex(credential),
      workerSessionId,
    ],
  );
  const client = new WorkerApiClient({ baseUrl: origin, credential });
  const session = { workerSessionId, workerSessionGeneration: "1" };
  const assignment = (await client.claim({
    claimKey: crypto.randomUUID(),
    workerHostId,
    capabilities: workerFixtureCapabilities,
    ...session,
  })).value;
  assert(assignment);
  assertEquals(assignment.jobId, job.jobId);
  const open = {
    leaseToken: assignment.leaseToken,
    fence: assignment.fence,
    ...session,
  };
  const binding =
    (await client.openOutput(assignment.attemptId, open, crypto.randomUUID()))
      .value;
  return { job, assignment, client, open, binding };
}
