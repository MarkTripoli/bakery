import { publicationAuthorityForAssignment } from "../../apps/worker/src/supervisor-recovery.ts";
import { assertEquals, assertRejects } from "@std/assert";
import { NativeOutputCapture } from "../../apps/worker/src/native-output.ts";
import {
  EventSpool,
  SpoolError,
  terminalReservationBytes,
} from "../../apps/worker/src/spool.ts";
import { WorkerApiClient } from "../../apps/worker/src/client.ts";
import { RegistrationStore } from "../../apps/worker/src/registration.ts";
import {
  executeAssignment,
  flushOnce,
  releaseAttempt,
} from "../../apps/worker/src/supervisor-execution.ts";
import { createSupervisorState } from "../../apps/worker/src/supervisor-state.ts";
import {
  localAssignment,
  protocolResponse,
  supervisorConfig,
} from "../helpers/worker-execution/recovery-support.ts";
import type {
  OutputBatch,
  WorkerOutputBinding,
} from "../../apps/worker/src/types.ts";
import type { ActiveAssignment } from "../../apps/worker/src/supervisor-support.ts";
const encoder = new TextEncoder();

function binding(a: ReturnType<typeof localAssignment>): WorkerOutputBinding {
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
async function fixture(maxBytes = 1024 * 1024) {
  const directory = await Deno.makeTempDir({
    prefix: "bakery-native-review-regression-",
  });
  const a = localAssignment();
  const spool = await EventSpool.open({
    path: `${directory}/spool.json`,
    maxRecords: maxBytes === 100000 ? 10 : 1000,
    maxBytes,
  });
  await spool.restoreJournalState(a.attemptId, "3", "2");
  await spool.reserveTerminal(a.attemptId, terminalReservationBytes(a));
  const b = binding(a);
  const options = {
    assignment: a,
    binding: b,
    spool,
    client: null as unknown as WorkerApiClient,
    workerSessionId: b.workerSessionId,
    workerSessionGeneration: "1",
    leaseActive: () => true,
    waitForAck: () => Promise.resolve(),
  };
  return { directory, a, spool, b, options };
}
Deno.test("review: alternating channels retain observed order", async () => {
  const f = await fixture();
  try {
    const c = new NativeOutputCapture(f.options);
    await c.write("stdout", encoder.encode("first\n"));
    await c.write("stderr", encoder.encode("second\n"));
    await c.write("stdout", encoder.encode("third\n"));
    await c.finish();
    const actual = f.spool.records().flatMap((r) =>
      (r.payload as OutputBatch).parts
    ).map((p) => `${p.channel}:${p.text}`);
    assertEquals(actual, [
      "stdout:first\n",
      "stderr:second\n",
      "stdout:third\n",
    ]);
  } finally {
    await Deno.remove(f.directory, { recursive: true });
  }
});
Deno.test("review: lifecycle append cannot consume reserved result capacity", async () => {
  const f = await fixture(100000);
  try {
    try {
      for (let i = 0; i < 10; i++) {
        await f.spool.enqueueEvent({
          attemptId: crypto.randomUUID(),
          leaseToken: "synthetic",
          fence: "1",
          localSeq: "1",
          eventId: crypto.randomUUID(),
          eventType: "job.accepted",
          payload: { acceptedAt: new Date().toISOString() },
        });
      }
    } catch (error) {
      assertEquals((error as Error).message, "SPOOL_CAPACITY_EXCEEDED");
    }
    let resultError: string | null = null;
    try {
      await f.spool.enqueueNextResult({
        ...f.a,
        eventId: crypto.randomUUID(),
        status: "completed",
        result: "b".repeat(31900),
      });
    } catch (e) {
      resultError = (e as Error).message;
    }
    assertEquals(resultError, null);
  } finally {
    await Deno.remove(f.directory, { recursive: true });
  }
});
Deno.test("review: capture stops admission when authority disappears while waiting for ACK", async () => {
  const f = await fixture();
  let active = true;
  try {
    for (let i = 0; i < 24; i++) {
      await f.spool.enqueueNextOutputEvent({
        ...f.a,
        eventId: crypto.randomUUID(),
        payload: { index: i },
        status: false,
      });
    }
    const c = new NativeOutputCapture({
      ...f.options,
      leaseActive: () => active,
      waitForAck: async () => {
        await f.spool.acknowledge(f.a.attemptId, "26");
        active = false;
      },
    });
    await c.write("stdout", encoder.encode("authority-sensitive-".repeat(30)));
    assertEquals(f.spool.records().length, 0);
  } finally {
    await Deno.remove(f.directory, { recursive: true });
  }
});
async function cancellation(capturesNativeOutput: boolean, revoke = false) {
  const f = await fixture();
  try {
    const store = new RegistrationStore(`${f.directory}/registration.json`);
    await store.saveRegistered("synthetic", {
      workerHostId: f.a.workerHostId,
      principalId: crypto.randomUUID(),
      status: "registered",
      registrationGeneration: 1,
      workerSessionId: f.a.workerSessionId,
      workerSessionGeneration: "1",
    });
    await store.saveActiveAssignment({
      assignment: f.a,
      nextLocalSeq: "3",
      ackedLocalSeq: "2",
    });
    let cleanupRequests = 0;
    const fatal: string[] = [];
    const reasons: string[] = [];
    const exitedAt = new Date().toISOString();
    const client = new WorkerApiClient({
      baseUrl: "http://127.0.0.1:8788",
      credential: "synthetic",
      fetcher: (input) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/output-bindings")) {
          return Promise.resolve(protocolResponse(f.b));
        }
        if (path.endsWith("/cleanup")) {
          cleanupRequests++;
          return Promise.resolve(protocolResponse({
            attemptId: f.a.attemptId,
            status: "canceled",
            cancellation: {
              processExited: true,
              cleanupStatus: "complete",
              terminationStatus: "confirmed",
              exitedAt,
              cleanupObserver: {
                observedBy: {
                  workerSessionId: f.a.workerSessionId,
                  workerSessionGeneration: "1",
                },
                attestedBy: {
                  workerSessionId: f.a.workerSessionId,
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
      assignment: f.a,
      controller: new AbortController(),
      renewalController: new AbortController(),
      leaseSeconds: 45,
      leaseDeadline: performance.now() + 60000,
      renewalLoopStarted: false,
      terminalAcked: false,
      executionStarted: true,
      restored: false,
    };
    const state = createSupervisorState({
      config: supervisorConfig(f.directory),
      client,
      registrationStore: store,
      spool: f.spool,
      executor: {
        capturesNativeOutput,
        execute: () => {
          active.controller.abort();
          if (revoke) active.publicationRevoked = true;
          return Promise.resolve({
            status: "canceled",
            cancellation: {
              processExited: true,
              exitedAt,
              cleanupStatus: "complete",
              terminationStatus: "confirmed",
            },
          });
        },
      },
      sleep: () => Promise.resolve(),
    });
    state.registration = await store.load();
    state.processSessionId = f.a.workerSessionId!;
    state.processSessionGeneration = "1";
    state.active.set(f.a.attemptId, active);
    await executeAssignment(state, f.a, active.controller.signal, {
      failFatal: (reason) => fatal.push(reason),
      startLeaseRenewal: () => {},
    }, async (id, reason, options) => {
      reasons.push(reason);
      await releaseAttempt(state, id, reason, options);
    });
    return {
      cleanupRequests,
      fatal,
      reasons,
      pendingClose: f.spool.hasPendingOutputClose(f.a.attemptId),
      retainedActive: !!(await store.load())?.activeAssignments
        ?.[f.a.attemptId],
    };
  } finally {
    await Deno.remove(f.directory, { recursive: true });
  }
}
Deno.test("review: native output does not suppress confirmed cancellation cleanup", async () => {
  const control = await cancellation(false);
  const native = await cancellation(true);
  assertEquals(control.cleanupRequests, 1);
  assertEquals(native.fatal, []);
  assertEquals(native.cleanupRequests, 1);
  assertEquals(native.retainedActive, false);
  assertEquals(native.pendingClose, false);
  assertEquals(native.reasons, ["CLEANUP_CONFIRMED"]);
  const revoked = await cancellation(true, true);
  assertEquals(revoked.cleanupRequests, 1);
  assertEquals(revoked.retainedActive, false);
  assertEquals(revoked.fatal, []);
});

Deno.test("review: terminal sanitization cannot reconstruct a configured secret on disk", async () => {
  const f = await fixture();
  try {
    const c = new NativeOutputCapture({
      ...f.options,
      configuredSecrets: ["review-synthetic-secret"],
    });
    await c.write("stdout", encoder.encode("review-\x1b[31msynthetic-secret"));
    await c.finish();
    const persisted = await Deno.readTextFile(`${f.directory}/spool.json`);
    assertEquals(persisted.includes("review-synthetic-secret"), false);
  } finally {
    await Deno.remove(f.directory, { recursive: true });
  }
});

Deno.test("review: close requires current heartbeat and unexpired publication authority", async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const client = new WorkerApiClient({
      baseUrl: "http://127.0.0.1:8788",
      credential: "synthetic",
      fetcher: () => {
        calls++;
        return Promise.resolve(
          protocolResponse({
            ...f.b,
            closed: true,
            capture: "complete",
            reason: "clean-end",
          }),
        );
      },
    });
    const state = createSupervisorState({
      config: supervisorConfig(f.directory),
      client,
      registrationStore: new RegistrationStore(
        `${f.directory}/registration.json`,
      ),
      spool: f.spool,
      sleep: () => Promise.resolve(),
    });
    state.processSessionId = f.a.workerSessionId!;
    state.processSessionGeneration = "1";
    state.active.set(f.a.attemptId, {
      assignment: f.a,
      controller: new AbortController(),
      renewalController: new AbortController(),
      leaseSeconds: 45,
      leaseDeadline: performance.now() - 1,
      renewalLoopStarted: false,
      terminalAcked: false,
      executionStarted: true,
      restored: true,
    });
    await f.spool.persistOutputClose({
      attemptId: f.a.attemptId,
      leaseToken: f.a.leaseToken,
      fence: "1",
      workerSessionId: f.b.workerSessionId,
      workerSessionGeneration: "1",
      idempotencyKey: crypto.randomUUID(),
      sessionId: f.b.sessionId,
      writerGeneration: "1",
      capture: "complete",
      reason: "clean-end",
    });
    await flushOnce(state);
    assertEquals(calls, 0);
  } finally {
    await Deno.remove(f.directory, { recursive: true });
  }
});

Deno.test("normalized split secrets stay absent across controls, markup, UTF-8 and alternating observations", async () => {
  const f = await fixture();
  try {
    const secret = "synthetic-🔐-secret";
    const drained: OutputBatch[] = [];
    const c = new NativeOutputCapture({
      ...f.options,
      configuredSecrets: [secret, "[REDACTED]"],
      waitForAck: async () => {
        const records = f.spool.records();
        drained.push(...records.map((record) => record.payload as OutputBatch));
        assertEquals(
          (await Deno.readTextFile(`${f.directory}/spool.json`)).includes(
            secret,
          ),
          false,
        );
        await f.spool.acknowledge(f.a.attemptId, records.at(-1)!.localSeq);
      },
    });
    const encoded = encoder.encode(
      "start synthetic-\x1b[31m🔐\x1b]52;c;discard\x07-<script>sec</script>ret end\n",
    );
    // Exercise every UTF-8 and terminal sequence boundary; keep the secret stress.
    for (const byte of encoded) {
      await c.write("stdout", new Uint8Array([byte]));
      await c.write("stderr", encoder.encode(".\n"));
    }
    await c.finish();
    const parts = [
      ...drained,
      ...f.spool.records().map((record) => record.payload as OutputBatch),
    ].flatMap((batch) => batch.parts);
    const text = parts.filter((part) => part.channel === "stdout").map((part) =>
      part.text
    ).join("");
    assertEquals(text.includes(secret), false);
    assertEquals(text.includes("[REDACTED]"), false);
    assertEquals(text.startsWith("start "), true);
    assertEquals(text.endsWith(" end\n"), true);
    assertEquals(text.includes("discard"), false);
    assertEquals(text.includes("script"), false);
    assertEquals(text.includes("\x1b"), false);
    assertEquals(
      (await Deno.readTextFile(`${f.directory}/spool.json`)).includes(secret),
      false,
    );
  } finally {
    await Deno.remove(f.directory, { recursive: true });
  }
});

Deno.test("deferred normalization preserves stdout stderr stdout admission rather than channel grouping", async () => {
  const f = await fixture();
  try {
    const c = new NativeOutputCapture({
      ...f.options,
      configuredSecrets: ["split-secret"],
    });
    await c.write("stdout", encoder.encode("first split-"));
    await c.write("stderr", encoder.encode("second\n"));
    await c.write("stdout", encoder.encode("\x1b[31msecret third\n"));
    await c.finish();
    const parts = f.spool.records().flatMap((record) =>
      (record.payload as OutputBatch).parts
    );
    assertEquals(parts.map((part) => `${part.channel}:${part.text}`), [
      "stdout:first [REDACTED]",
      "stderr:second\n",
      "stdout: third\n",
    ]);
  } finally {
    await Deno.remove(f.directory, { recursive: true });
  }
});

Deno.test("all attempts retain byte and record reservations across lifecycle status and result admission", async () => {
  for (const maxBytes of [240_000, 1024 * 1024]) {
    const f = await fixture(maxBytes);
    try {
      const other = localAssignment();
      await f.spool.restoreJournalState(other.attemptId, "1", "0");
      await f.spool.reserveTerminal(
        other.attemptId,
        terminalReservationBytes(other),
      );
      let rejected = false;
      for (let i = 0; i < 1100; i++) {
        try {
          await f.spool.enqueueEvent({
            ...other,
            attemptId: crypto.randomUUID(),
            localSeq: "1",
            eventId: crypto.randomUUID(),
            eventType: "job.accepted",
            payload: { acceptedAt: new Date().toISOString() },
          });
        } catch (error) {
          assertEquals((error as Error).message, "SPOOL_CAPACITY_EXCEEDED");
          rejected = true;
          break;
        }
      }
      assertEquals(rejected, true);
      for (const assignment of [f.a, other]) {
        await f.spool.enqueueNextOutputEvent({
          ...assignment,
          eventId: crypto.randomUUID(),
          payload: { text: "capture interrupted" },
          status: true,
        });
        await f.spool.enqueueNextResult({
          ...assignment,
          eventId: crypto.randomUUID(),
          status: "completed",
          result: "r".repeat(31900),
        });
      }
      assertEquals(f.spool.depth.bytes <= maxBytes, true);
      assertEquals(f.spool.depth.records <= 1000, true);
    } finally {
      await Deno.remove(f.directory, { recursive: true });
    }
  }
});

Deno.test("close rechecks each authority boundary and publishes only the accepted tuple", async () => {
  for (
    const missing of [
      "session",
      "heartbeat",
      "authority",
      "lease",
      "authorityDeadline",
      "sessionTuple",
      "revoked",
      "none",
    ]
  ) {
    const f = await fixture();
    try {
      let calls = 0;
      const client = new WorkerApiClient({
        baseUrl: "http://127.0.0.1:8788",
        credential: "synthetic",
        fetcher: () => {
          calls++;
          return Promise.resolve(
            protocolResponse({
              ...f.b,
              closed: true,
              capture: "complete",
              reason: "clean-end",
            }),
          );
        },
      });
      const state = createSupervisorState({
        config: supervisorConfig(f.directory),
        client,
        registrationStore: new RegistrationStore(
          `${f.directory}/registration.json`,
        ),
        spool: f.spool,
        sleep: () => Promise.resolve(),
      });
      state.processSessionId = f.a.workerSessionId!;
      state.processSessionGeneration = "1";
      state.processSessionAcquired = missing !== "session";
      state.freshHeartbeatReady = missing !== "heartbeat";
      const deadline = performance.now() + 60000;
      state.active.set(f.a.attemptId, {
        assignment: f.a,
        controller: new AbortController(),
        renewalController: new AbortController(),
        leaseSeconds: 45,
        leaseDeadline: missing === "lease" ? 0 : deadline,
        renewalLoopStarted: false,
        terminalAcked: false,
        executionStarted: true,
        restored: false,
        publicationRevoked: missing === "revoked",
      });
      const authority = publicationAuthorityForAssignment(
        f.a,
        state.processSessionId,
        "1",
        missing === "authorityDeadline" ? 0 : deadline,
      )!;
      if (missing !== "authority") {
        state.publicationAuthorities.set(f.a.attemptId, authority);
      }
      await f.spool.persistOutputClose({
        attemptId: f.a.attemptId,
        leaseToken: f.a.leaseToken,
        fence: "1",
        workerSessionId: missing === "sessionTuple"
          ? crypto.randomUUID()
          : state.processSessionId,
        workerSessionGeneration: "1",
        idempotencyKey: crypto.randomUUID(),
        sessionId: f.b.sessionId,
        writerGeneration: "1",
        capture: "complete",
        reason: "clean-end",
      });
      await flushOnce(state);
      assertEquals(calls, missing === "none" ? 1 : 0, missing);
      assertEquals(
        f.spool.hasPendingOutputClose(f.a.attemptId),
        missing !== "none",
        missing,
      );
    } finally {
      await Deno.remove(f.directory, { recursive: true });
    }
  }
});

Deno.test("close admission losing authority inside the spool mutation fails without a fatal capture error", async () => {
  const f = await fixture();
  try {
    let reads = 0;
    const c = new NativeOutputCapture({
      ...f.options,
      leaseActive: () => ++reads < 3,
    });
    assertEquals(await c.finish(), null);
    assertEquals(f.spool.pendingOutputCloses(), []);
  } finally {
    await Deno.remove(f.directory, { recursive: true });
  }
});

Deno.test("result admission reports lost authority after concurrent attempt retirement", async () => {
  const f = await fixture();
  try {
    await f.spool.discardAttempt(f.a.attemptId);
    const error = await assertRejects(
      () =>
        f.spool.enqueueNextResult({
          ...f.a,
          eventId: crypto.randomUUID(),
          status: "failed",
          fault: { code: "EXPECTED" },
        }, () => false),
      SpoolError,
    );
    assertEquals(error.code, "SPOOL_PUBLICATION_NOT_AUTHORIZED");
  } finally {
    await Deno.remove(f.directory, { recursive: true });
  }
});

Deno.test("display saturation records reserved truncation while bounded ACK drain preserves terminal capacity", async () => {
  const f = await fixture();
  try {
    let displayBytes = 0;
    const observe = () => {
      const records = f.spool.records();
      for (const record of records) {
        const batch = record.payload as OutputBatch;
        displayBytes += batch.parts.filter((part) => part.channel !== "status")
          .reduce((sum, part) => sum + encoder.encode(part.text).length, 0);
      }
      assertEquals(f.spool.outputDepth(f.a.attemptId).records <= 32, true);
      assertEquals(
        f.spool.outputDepth(f.a.attemptId).bytes <= 256 * 1024,
        true,
      );
      return records;
    };
    const acknowledge = async () => {
      const records = observe();
      await f.spool.acknowledge(f.a.attemptId, records.at(-1)!.localSeq);
    };
    const c = new NativeOutputCapture({
      ...f.options,
      waitForAck: acknowledge,
    });
    for (let i = 0; i < 530; i++) {
      await c.write("stdout", encoder.encode("y".repeat(16000)));
      if (f.spool.outputDepth(f.a.attemptId).records >= 8) await acknowledge();
    }
    assertEquals(await c.finish(), {
      capture: "truncated",
      reason: "text-limit",
    });
    const records = observe();
    assertEquals(displayBytes <= 8 * 1024 * 1024, true);
    assertEquals(displayBytes + 16000 > 8 * 1024 * 1024, true);
    const statuses = records.flatMap((record) =>
      (record.payload as OutputBatch).parts
    ).filter((part) => part.channel === "status");
    assertEquals(statuses.length, 1);
    assertEquals(encoder.encode(statuses[0].text).length <= 16 * 1024, true);
    await f.spool.acknowledge(f.a.attemptId, records.at(-1)!.localSeq);
    await f.spool.acknowledgeOutputClose(f.a.attemptId);
    await f.spool.enqueueNextResult({
      ...f.a,
      eventId: crypto.randomUUID(),
      status: "failed",
      fault: { code: "synthetic" },
    });
    assertEquals(f.spool.records().length, 1);
  } finally {
    await Deno.remove(f.directory, { recursive: true });
  }
});

for (const split of [false, true]) {
  Deno.test(`JSON-escaped secret is redacted in stream-json output (${split ? "split across chunks" : "whole"})`, async () => {
    const f = await fixture();
    try {
      const secret = 'a"b\\c-é-Zq81xPLm47';
      const escaped = JSON.stringify(secret).slice(1, -1);
      const ascii = escaped.replace(/é/g, "\\u00e9");
      const c = new NativeOutputCapture({
        ...f.options,
        configuredSecrets: [secret],
      });
      const line = `{"text":"${escaped}","ascii":"${ascii}"}\n`;
      const bytes = encoder.encode(line);
      if (split) {
        const middle = Math.floor(bytes.length / 3);
        await c.write("stdout", bytes.slice(0, middle));
        await c.write("stdout", bytes.slice(middle, middle * 2));
        await c.write("stdout", bytes.slice(middle * 2));
      } else await c.write("stdout", bytes);
      await c.finish();
      const text = f.spool.records().flatMap((record) =>
        (record.payload as OutputBatch).parts
      ).map((part) => part.text).join("");
      assertEquals(text.includes("Zq81xPLm47"), false);
      assertEquals(text.includes("[REDACTED]"), true);
    } finally {
      await Deno.remove(f.directory, { recursive: true });
    }
  });
}

Deno.test("finish with leaveOpen flushes output and persists no close", async () => {
  const f = await fixture();
  try {
    const c = new NativeOutputCapture(f.options);
    await c.write("stdout", encoder.encode("kept\n"));
    const disposition = await c.finish({ leaveOpen: true });
    assertEquals(disposition?.capture, "complete");
    const text = f.spool.records().flatMap((r) =>
      (r.payload as OutputBatch).parts ?? []
    ).map((p) => p.text).join("");
    assertEquals(text, "kept\n");
    assertEquals(f.spool.hasPendingOutputClose(f.a.attemptId), false);
  } finally {
    await Deno.remove(f.directory, { recursive: true });
  }
});

Deno.test("finish without leaveOpen persists the close", async () => {
  const f = await fixture();
  try {
    const c = new NativeOutputCapture(f.options);
    await c.write("stdout", encoder.encode("kept\n"));
    await c.finish();
    assertEquals(f.spool.hasPendingOutputClose(f.a.attemptId), true);
  } finally {
    await Deno.remove(f.directory, { recursive: true });
  }
});
