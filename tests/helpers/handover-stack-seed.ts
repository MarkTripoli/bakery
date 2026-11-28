import { authTestOrigin, openAuthFixture } from "./auth.ts";
import {
  COMMIT,
  liveAttempt,
  manifestFor,
  post,
  SHA,
} from "./handoff-manifests.ts";
import {
  openWorkerFixture,
  type WorkerFixture,
  workerFixtureCapabilities,
  type WorkerRegistration,
  workerRequest,
} from "./worker-execution.ts";

export type HandoverStackState = Readonly<{
  adminCookie: string;
  organizationId: string;
  taskId: string;
  runId: string;
  manifestId: string;
  worker: Readonly<{
    credential: string;
    registration: WorkerRegistration;
  }>;
}>;

export async function seedHandoverOnStack(
  fixture: WorkerFixture,
): Promise<HandoverStackState> {
  const live = await liveAttempt(fixture, "handover-stack");
  const host = await fixture.pgDatabase.query<{ worker_host_id: string }>(
    "select worker_host_id from bakery.job_attempts where id = $1",
    [live.assignment.attemptId],
  );
  await fixture.pgDatabase.query(
    "update bakery.agent_sessions set status = 'active', resume_ref = $2::jsonb where id = $1",
    [
      live.job.sessionId,
      JSON.stringify({
        nativeSessionId: "native-handover-stack",
        checkpointId: SHA,
        worktreeRevision: COMMIT,
        harnessVersion: "codex-1.2.3",
        workerHostId: host.rows[0]!.worker_host_id,
      }),
    ],
  );
  const stored = await post(
    fixture,
    live,
    await manifestFor(fixture, live.job, { mode: "exact_harness_resume" }),
  );
  if (stored.status !== 201) {
    throw new Error(`HANDOVER_MANIFEST_NOT_STORED:${stored.status}`);
  }
  const manifest = await stored.json() as { id: string };
  return {
    adminCookie: fixture.adminCookie,
    organizationId: fixture.organizationId,
    taskId: live.job.taskId,
    runId: live.job.runId,
    manifestId: manifest.id,
    worker: live.worker,
  };
}

export function throughServer(
  fixture: WorkerFixture,
  serverOrigin: string,
): WorkerFixture {
  return {
    ...fixture,
    app: {
      ...fixture.app,
      fetch: (request: Request) => {
        const url = new URL(request.url);
        const target = new URL(url.pathname + url.search, serverOrigin);
        return fetch(new Request(target, request));
      },
    } as WorkerFixture["app"],
  };
}

export async function claimOnStack(
  fixture: WorkerFixture,
  state: HandoverStackState,
): Promise<number> {
  const claimKey = crypto.randomUUID();
  const response = await workerRequest(
    fixture,
    state.worker.credential,
    "/v1/worker/claims",
    {
      claimKey,
      workerHostId: state.worker.registration.workerHostId,
      capabilities: workerFixtureCapabilities,
    },
    { idempotencyKey: claimKey },
  );
  await response.body?.cancel();
  return response.status;
}

if (import.meta.main) {
  const [command, statePath] = Deno.args;
  const serverOrigin = Deno.env.get("BAKERY_STACK_SERVER_ORIGIN") ??
    authTestOrigin;
  if (command === "seed" && statePath) {
    const state = await seedHandoverOnStack(await openWorkerFixture());
    await Deno.writeTextFile(statePath, JSON.stringify(state), { mode: 0o600 });
    console.log(
      JSON.stringify({ taskId: state.taskId, manifestId: state.manifestId }),
    );
  } else if (command === "claim" && statePath) {
    const state = JSON.parse(
      await Deno.readTextFile(statePath),
    ) as HandoverStackState;
    const base = await openAuthFixture();
    const status = await claimOnStack(
      throughServer(base as unknown as WorkerFixture, serverOrigin),
      state,
    );
    console.log(String(status));
  } else {
    console.error("usage: handover-stack-seed.ts seed|claim <state-file>");
    Deno.exit(2);
  }
  Deno.exit(0);
}
