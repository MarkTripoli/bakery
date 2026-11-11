import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { WorkerApiClient } from "../../apps/worker/src/client.ts";
import { readWorkerConfig } from "../../apps/worker/src/config.ts";
import { NativeOutputCapture } from "../../apps/worker/src/native-output.ts";
import {
  EventSpool,
  SpoolError,
  terminalReservationBytes,
} from "../../apps/worker/src/spool.ts";
import type {
  OutputBatch,
  WorkerOutputBinding,
} from "../../apps/worker/src/types.ts";
import { localAssignment } from "../helpers/worker-execution/recovery-support.ts";

const encoder = new TextEncoder();

function binding(attemptId: string): WorkerOutputBinding {
  const id = () => crypto.randomUUID();
  return {
    sessionId: id(),
    organizationId: id(),
    applicationId: id(),
    jobId: id(),
    taskId: null,
    runStepId: null,
    conversationId: null,
    logicalActor: "harness.implement:native",
    attemptId,
    workerHostId: id(),
    workerSessionId: id(),
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

async function fixture(
  options: { maxRecords?: number; maxBytes?: number } = {},
) {
  const directory = await Deno.makeTempDir({
    prefix: "bakery-output-capture-",
  });
  const spool = await EventSpool.open({
    path: `${directory}/spool.json`,
    maxRecords: options.maxRecords ?? 1_000,
    maxBytes: options.maxBytes ?? 1024 * 1024,
  });
  const assignment = localAssignment();
  await spool.restoreJournalState(assignment.attemptId, "3", "2");
  await spool.reserveTerminal(
    assignment.attemptId,
    terminalReservationBytes({
      attemptId: assignment.attemptId,
      leaseToken: assignment.leaseToken,
      fence: assignment.fence,
    }),
  );
  const outputBinding = binding(assignment.attemptId);
  const capture = new NativeOutputCapture({
    assignment,
    binding: outputBinding,
    client: null as unknown as WorkerApiClient,
    spool,
    workerSessionId: outputBinding.workerSessionId,
    workerSessionGeneration: outputBinding.workerSessionGeneration,
    configuredSecrets: ["split-secret"],
    leaseActive: () => true,
    waitForAck: () => Promise.resolve(),
  });
  return { directory, spool, assignment, capture };
}

Deno.test("native capture redacts split secrets and unsafe terminal controls before spool persistence", async () => {
  const { directory, spool, capture } = await fixture();
  try {
    const text = encoder.encode("before split-secret after 🔐\n");
    const emoji = encoder.encode("🔐");
    const emojiAt = text.findIndex((_, index) =>
      text.subarray(index, index + emoji.length).every((byte, offset) =>
        byte === emoji[offset]
      )
    );
    await capture.write("stdout", encoder.encode("before split-"));
    await capture.write("stdout", encoder.encode("secret after "));
    await capture.write("stdout", text.subarray(emojiAt, emojiAt + 2));
    await capture.write("stdout", text.subarray(emojiAt + 2));
    await capture.write(
      "stderr",
      encoder.encode("\x1b[31mred\x1b[0m\x1b]52;c;clipboard\x07\u0000ok"),
    );
    assertEquals(await capture.finish(), {
      capture: "complete",
      reason: "clean-end",
    });

    const output = spool.records().filter((record) =>
      record.type === "job.output"
    );
    assert(output.length >= 2);
    assertEquals(
      output.map((record) => record.localSeq),
      output.map((_, index) => String(index + 3)),
    );
    const batches = output.map((record) => record.payload as OutputBatch);
    const persisted = JSON.stringify(batches);
    assertEquals(persisted.includes("split-secret"), false);
    assert(persisted.includes("[REDACTED]"));
    assert(persisted.includes("🔐"));
    assertEquals(persisted.includes("clipboard"), false);
    assertEquals(persisted.includes("\\u001b"), false);
    assertEquals(persisted.includes("\\u0000"), false);
    assertEquals(spool.pendingOutputCloses()[0]?.capture, "complete");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("decoder loss discards unsafe carry and records interrupted unknown loss", async () => {
  const { directory, spool, capture } = await fixture();
  try {
    await capture.write("stdout", new Uint8Array([0xf0, 0x9f]));
    await capture.sourceLost("stdout", "PIPE_FAILED");
    assertEquals(await capture.finish(), {
      capture: "interrupted",
      reason: "source-lost",
    });
    const serialized = JSON.stringify(spool.records());
    assert(serialized.includes("unknown bytes discarded"));
    assertEquals(serialized.includes("�"), false);
    assertEquals(spool.pendingOutputCloses()[0]?.reason, "source-lost");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("one atomic allocator sequences output then exchanges terminal reservation for result", async () => {
  const { directory, spool, assignment, capture } = await fixture();
  try {
    await capture.write("stdout", encoder.encode("owned output"));
    await capture.finish();
    const output = spool.records().find((record) =>
      record.type === "job.output"
    );
    assert(output);
    await spool.acknowledgeOutputClose(assignment.attemptId);
    const result = await spool.enqueueNextResult({
      attemptId: assignment.attemptId,
      leaseToken: assignment.leaseToken,
      fence: assignment.fence,
      eventId: crypto.randomUUID(),
      status: "completed",
      result: { ok: true },
    });
    assertEquals(BigInt(result.localSeq), BigInt(output.localSeq) + 1n);
    assertEquals(spool.attemptIds(), [assignment.attemptId]);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("status reserve remains available when normal output reaches the native record boundary", async () => {
  const { directory, spool, assignment } = await fixture();
  try {
    const payload = {
      sessionId: crypto.randomUUID(),
      writerGeneration: "1",
      batchId: crypto.randomUUID(),
      sequence: "1",
      parts: [{ itemId: crypto.randomUUID(), channel: "stdout", text: "x" }],
      capture: "capturing",
      reason: null,
      digest: "0".repeat(64),
    };
    for (let index = 0; index < 24; index++) {
      await spool.enqueueNextOutputEvent({
        attemptId: assignment.attemptId,
        leaseToken: assignment.leaseToken,
        fence: assignment.fence,
        eventId: crypto.randomUUID(),
        payload,
        status: false,
      });
    }
    await assertRejects(
      () =>
        spool.enqueueNextOutputEvent({
          attemptId: assignment.attemptId,
          leaseToken: assignment.leaseToken,
          fence: assignment.fence,
          eventId: crypto.randomUUID(),
          payload,
          status: false,
        }),
      SpoolError,
      "SPOOL_CAPACITY_EXCEEDED",
    );
    await spool.enqueueNextOutputEvent({
      attemptId: assignment.attemptId,
      leaseToken: assignment.leaseToken,
      fence: assignment.fence,
      eventId: crypto.randomUUID(),
      payload: {
        ...payload,
        parts: [{ ...payload.parts[0], channel: "status" }],
        capture: "truncated",
        reason: "text-limit",
      },
      status: true,
    });
    assertEquals(spool.outputDepth(assignment.attemptId).records, 25);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("lease loss stops admission without close or fabricated acknowledgement", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "bakery-output-lease-loss-",
  });
  const spool = await EventSpool.open({
    path: `${directory}/spool.json`,
    maxRecords: 1_000,
    maxBytes: 1024 * 1024,
  });
  const assignment = localAssignment();
  const outputBinding = binding(assignment.attemptId);
  let active = true;
  try {
    await spool.restoreJournalState(assignment.attemptId, "3", "2");
    await spool.reserveTerminal(
      assignment.attemptId,
      terminalReservationBytes({
        attemptId: assignment.attemptId,
        leaseToken: assignment.leaseToken,
        fence: assignment.fence,
      }),
    );
    const capture = new NativeOutputCapture({
      assignment,
      binding: outputBinding,
      client: null as unknown as WorkerApiClient,
      spool,
      workerSessionId: outputBinding.workerSessionId,
      workerSessionGeneration: outputBinding.workerSessionGeneration,
      leaseActive: () => active,
      waitForAck: () => Promise.resolve(),
    });
    await capture.write("stdout", encoder.encode("accepted-before-lease-loss"));
    active = false;
    await capture.write("stderr", encoder.encode("must-not-be-admitted"));
    assertEquals(await capture.finish(), null);
    assertEquals(spool.pendingOutputCloses(), []);
    assertEquals(spool.journalState(assignment.attemptId).ackedLocalSeq, "2");
    assertEquals(
      JSON.stringify(spool.records()).includes("must-not-be-admitted"),
      false,
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("worker config rejects oversized output redaction material", () => {
  const base = {
    BAKERY_ENV: "test",
    BAKERY_SERVER_URL: "http://127.0.0.1:8000",
    BAKERY_WORKER_CAPABILITIES: "native",
    HOME: "/tmp",
  };
  assertThrows(
    () =>
      readWorkerConfig({
        ...base,
        BAKERY_WORKER_OUTPUT_REDACTION_SECRETS: JSON.stringify([
          "x".repeat(4_097),
        ]),
      }),
    Error,
    "BAKERY_WORKER_OUTPUT_REDACTION_SECRETS_INVALID",
  );
});

Deno.test("capture budgets: 4 KiB configured plus 4 KiB credential opens, 4 KiB + 1 in either group throws (#430)", async () => {
  const { directory, spool, assignment } = await fixture();
  try {
    const open = (
      configured: readonly string[],
      credential: readonly string[],
    ) => {
      const outputBinding = binding(assignment.attemptId);
      return new NativeOutputCapture({
        assignment,
        binding: outputBinding,
        client: null as unknown as WorkerApiClient,
        spool,
        workerSessionId: outputBinding.workerSessionId,
        workerSessionGeneration: outputBinding.workerSessionGeneration,
        configuredSecrets: configured,
        credentialSecrets: credential,
        leaseActive: () => true,
        waitForAck: () => Promise.resolve(),
      });
    };
    // Before the credential group existed, 4096 B of operator secrets plus the
    // lease token already exceeded the one shared 4096 B budget.
    open(["c".repeat(4_096)], ["k".repeat(4_096)]);
    assertThrows(
      () => open(["c".repeat(4_097)], []),
      Error,
      "NATIVE_OUTPUT_SECRETS_TOO_LARGE",
    );
    assertThrows(
      () => open([], ["k".repeat(4_097)]),
      Error,
      "NATIVE_OUTPUT_SECRETS_TOO_LARGE",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("capture redacts a credential value but leaves the other text alone (#430)", async () => {
  const { directory, spool, assignment } = await fixture();
  try {
    const outputBinding = binding(assignment.attemptId);
    const token = "sk-ant-oat01-SYNTHETIC-capture-0123456789";
    const capture = new NativeOutputCapture({
      assignment,
      binding: outputBinding,
      client: null as unknown as WorkerApiClient,
      spool,
      workerSessionId: outputBinding.workerSessionId,
      workerSessionGeneration: outputBinding.workerSessionGeneration,
      credentialSecrets: [token],
      leaseActive: () => true,
      waitForAck: () => Promise.resolve(),
    });
    // Split across two chunks and JSON-escaped on the second channel.
    await capture.write("stdout", encoder.encode(`a ${token.slice(0, 20)}`));
    await capture.write("stdout", encoder.encode(`${token.slice(20)} b\n`));
    await capture.write(
      "stderr",
      encoder.encode(`{"t":${JSON.stringify(token)}}\n`),
    );
    await capture.finish();
    const stored = JSON.stringify(spool.records());
    assert(!stored.includes(token));
    assert(stored.includes("[REDACTED]"));
    assert(stored.includes("a "));
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

// A heartbeat fence pauses publication briefly while its commands apply. It is
// not lost authority: output and the close must wait for it, not vanish.
async function fencedFixture() {
  const directory = await Deno.makeTempDir({
    prefix: "bakery-output-fence-",
  });
  const spool = await EventSpool.open({
    path: `${directory}/spool.json`,
    maxRecords: 1_000,
    maxBytes: 1024 * 1024,
  });
  const assignment = localAssignment();
  await spool.restoreJournalState(assignment.attemptId, "3", "2");
  await spool.reserveTerminal(
    assignment.attemptId,
    terminalReservationBytes({
      attemptId: assignment.attemptId,
      leaseToken: assignment.leaseToken,
      fence: assignment.fence,
    }),
  );
  const outputBinding = binding(assignment.attemptId);
  const gate = { fenced: false, authority: true };
  const capture = new NativeOutputCapture({
    assignment,
    binding: outputBinding,
    client: null as unknown as WorkerApiClient,
    spool,
    workerSessionId: outputBinding.workerSessionId,
    workerSessionGeneration: outputBinding.workerSessionGeneration,
    leaseActive: () => gate.authority && !gate.fenced,
    awaitPublication: async () => {
      while (gate.authority) {
        if (!gate.fenced) return true;
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      return false;
    },
    waitForAck: () => Promise.resolve(),
  });
  return { directory, spool, capture, gate };
}

const outputText = (spool: EventSpool) =>
  JSON.stringify(
    spool.records().filter((record) => record.type === "job.output"),
  );

Deno.test("native capture holds output and close through a heartbeat fence", async () => {
  const { directory, spool, capture, gate } = await fencedFixture();
  try {
    gate.fenced = true;
    const written = capture.write("stdout", encoder.encode("during-fence\n"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    gate.fenced = false;
    await written;
    assert(outputText(spool).includes("during-fence"));

    gate.fenced = true;
    const finished = capture.finish();
    setTimeout(() => gate.fenced = false, 20);
    assertEquals(await finished, { capture: "complete", reason: "clean-end" });
    assertEquals(spool.pendingOutputCloses()[0]?.capture, "complete");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("native capture still drops output and close when authority is lost during a fence", async () => {
  const { directory, spool, capture, gate } = await fencedFixture();
  try {
    gate.fenced = true;
    const written = capture.write("stdout", encoder.encode("after-revoke\n"));
    setTimeout(() => gate.authority = false, 10);
    await written;
    assertEquals(outputText(spool).includes("after-revoke"), false);

    assertEquals(await capture.finish(), null);
    assertEquals(spool.pendingOutputCloses().length, 0);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
