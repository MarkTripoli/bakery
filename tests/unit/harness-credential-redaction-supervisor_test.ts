import { assert, assertEquals, assertFalse } from "@std/assert";
import { publicationAuthorityForAssignment } from "../../apps/worker/src/supervisor-recovery.ts";
import { WorkerApiClient } from "../../apps/worker/src/client.ts";
import { RegistrationStore } from "../../apps/worker/src/registration.ts";
import type { NativeOutputCapture } from "../../apps/worker/src/native-output.ts";
import type { ExecutionOutcome } from "../../apps/worker/src/executor.ts";
import {
  EventSpool,
  terminalReservationBytes,
} from "../../apps/worker/src/spool.ts";
import {
  executeAssignment,
  releaseAttempt,
} from "../../apps/worker/src/supervisor-execution.ts";
import { createSupervisorState } from "../../apps/worker/src/supervisor-state.ts";
import type { ActiveAssignment } from "../../apps/worker/src/supervisor-support.ts";
import type { WorkerOutputBinding } from "../../apps/worker/src/types.ts";
import {
  localAssignment,
  protocolResponse,
  supervisorConfig,
} from "../helpers/worker-execution/recovery-support.ts";

/**
 * The supervisor asks the executor for per-attempt credential values before it
 * opens the native output capture (#430), so a token the harness child can
 * read never reaches the stored output, and a credential that cannot be
 * redacted fails the attempt before the executor runs.
 */

const encoder = new TextEncoder();
const TOKEN = "sk-ant-oat01-SYNTHETIC-supervisor-0123456789abcdef";

function outputBinding(
  a: ReturnType<typeof localAssignment>,
): WorkerOutputBinding {
  return {
    sessionId: crypto.randomUUID(),
    organizationId: crypto.randomUUID(),
    applicationId: crypto.randomUUID(),
    jobId: a.jobId,
    taskId: null,
    runStepId: null,
    conversationId: null,
    logicalActor: "harness.implement:native",
    attemptId: a.attemptId,
    workerHostId: a.workerHostId,
    workerSessionId: a.workerSessionId!,
    workerSessionGeneration: "1",
    fence: "1",
    writerGeneration: "1",
    highwater: "0",
    nextSequence: "1",
    closed: false,
    capture: "capturing",
    reason: null,
    archive: "pending",
  };
}

async function supervised(
  hook: ((abort: () => void) => Promise<readonly string[]>) | undefined,
): Promise<{ executed: number; persisted: string }> {
  const directory = await Deno.makeTempDir({
    prefix: "bakery-credential-redaction-",
  });
  try {
    const a = localAssignment();
    const spool = await EventSpool.open({
      path: `${directory}/spool.json`,
      maxRecords: 1000,
      maxBytes: 1024 * 1024,
    });
    await spool.restoreJournalState(a.attemptId, "3", "2");
    await spool.reserveTerminal(a.attemptId, terminalReservationBytes(a));
    const binding = outputBinding(a);
    const store = new RegistrationStore(`${directory}/registration.json`);
    await store.saveRegistered("synthetic", {
      workerHostId: a.workerHostId,
      principalId: crypto.randomUUID(),
      status: "registered",
      registrationGeneration: 1,
      workerSessionId: a.workerSessionId,
      workerSessionGeneration: "1",
    });
    await store.saveActiveAssignment({
      assignment: a,
      nextLocalSeq: "3",
      ackedLocalSeq: "2",
    });
    const exitedAt = new Date().toISOString();
    const client = new WorkerApiClient({
      baseUrl: "http://127.0.0.1:8788",
      credential: "synthetic",
      fetcher: (input) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/output-bindings")) {
          return Promise.resolve(protocolResponse(binding));
        }
        if (path.endsWith("/cleanup")) {
          return Promise.resolve(protocolResponse({
            attemptId: a.attemptId,
            status: "canceled",
            cancellation: {
              processExited: true,
              cleanupStatus: "complete",
              terminationStatus: "confirmed",
              exitedAt,
              cleanupObserver: {
                observedBy: {
                  workerSessionId: a.workerSessionId,
                  workerSessionGeneration: "1",
                },
                attestedBy: {
                  workerSessionId: a.workerSessionId,
                  workerSessionGeneration: "1",
                },
              },
            },
          }));
        }
        throw new Error(`UNEXPECTED_REQUEST:${path}`);
      },
    });
    const active: ActiveAssignment = {
      assignment: a,
      controller: new AbortController(),
      renewalController: new AbortController(),
      leaseSeconds: 45,
      leaseDeadline: performance.now() + 60000,
      renewalLoopStarted: false,
      terminalAcked: false,
      executionStarted: true,
      restored: false,
    };
    let executed = 0;
    let stored = "";
    const state = createSupervisorState({
      config: supervisorConfig(directory),
      client,
      registrationStore: store,
      spool,
      executor: {
        capturesNativeOutput: true,
        ...(hook === undefined ? {} : {
          credentialRedactionSecrets: () =>
            hook(() => active.controller.abort()),
        }),
        execute: async (_assignment, _signal, output) => {
          executed++;
          await output!.write("stdout", encoder.encode(`leak ${TOKEN}\n`));
          await output!.write("stderr", encoder.encode(`leak ${TOKEN}\n`));
          // The redactor holds a tail back until finish(), which is idempotent,
          // so the supervisor's own later finish is a no-op.
          await (output as NativeOutputCapture).finish();
          // What the capture admitted to the durable spool.
          stored = JSON.stringify(spool.records());
          active.controller.abort();
          return {
            status: "canceled",
            cancellation: {
              processExited: true,
              exitedAt,
              cleanupStatus: "complete",
              terminationStatus: "confirmed",
            },
          } satisfies ExecutionOutcome;
        },
      },
      sleep: () => Promise.resolve(),
    });
    state.registration = await store.load();
    state.processSessionId = a.workerSessionId!;
    state.processSessionGeneration = "1";
    state.processSessionAcquired = true;
    state.freshHeartbeatReady = true;
    state.active.set(a.attemptId, active);
    state.publicationAuthorities.set(
      a.attemptId,
      publicationAuthorityForAssignment(
        a,
        state.processSessionId,
        "1",
        active.leaseDeadline,
      )!,
    );
    await executeAssignment(state, a, active.controller.signal, {
      failFatal: () => {},
      startLeaseRenewal: () => {},
    }, async (id, reason, options) => {
      await releaseAttempt(state, id, reason, options);
    });
    return { executed, persisted: stored };
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}

Deno.test("a credential value from the executor hook is stored as [REDACTED] (#430)", async () => {
  const control = await supervised(undefined);
  assertEquals(control.executed, 1);
  assert(
    control.persisted.includes(TOKEN),
    "control: without the hook the token is stored",
  );
  const redacted = await supervised(() => Promise.resolve([TOKEN]));
  assertEquals(redacted.executed, 1);
  assertFalse(redacted.persisted.includes(TOKEN));
  assert(redacted.persisted.includes("[REDACTED]"));
});

Deno.test("a credential the hook cannot read fails the attempt before the executor runs (#430)", async () => {
  // The hook aborts the attempt as it throws, only so the test does not wait
  // out the unacknowledged terminal drain.
  const failed = await supervised((abort) => {
    abort();
    return Promise.reject(new Error("HARNESS_CREDENTIAL_FILE_INVALID"));
  });
  assertEquals(failed.executed, 0);
  assertFalse(failed.persisted.includes(TOKEN));
});
