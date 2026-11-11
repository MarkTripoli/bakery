import { assertEquals } from "@std/assert";
import {
  type RealSkillImportStack,
  startRealSkillImportStack,
} from "../fixtures/real-skill-import-stack.ts";
import type { SkillImportCheckpointBoundary } from "../../apps/server/src/modules/catalog/import-workflow.ts";

const enabled = Deno.env.get("BAKERY_IMPORT_STACK_LOCKED") === "1";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitPersistedTerminal(
  stack: RealSkillImportStack,
  runId: string,
  attempts = 480,
): Promise<Awaited<ReturnType<RealSkillImportStack["snapshot"]>>> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const state = await stack.snapshot(runId);
    if (state.state === "completed" || state.state === "failed") return state;
    await delay(250);
  }
  throw new Error(
    `PERSISTED_TERMINAL_TIMEOUT:${runId}:${
      JSON.stringify(await stack.snapshot(runId))
    }`,
  );
}

async function interruptAt(
  stack: RealSkillImportStack,
  boundary: SkillImportCheckpointBoundary,
  sourceId: string,
  revision: string,
): Promise<
  {
    runId: string;
    before: Awaited<ReturnType<RealSkillImportStack["snapshot"]>>;
  }
> {
  await stack.stopDispatch();
  const admitted = await stack.requestImport(sourceId, revision);
  const runId = String(admitted.id);
  await stack.armBoundary(boundary);
  await stack.restartDispatch();
  await stack.waitBoundary(boundary, runId);
  return { runId, before: await stack.snapshot(runId) };
}

function assertSingletons(
  state: Awaited<ReturnType<RealSkillImportStack["snapshot"]>>,
): void {
  assertEquals({
    runCount: state.runCount,
    checkpointCount: state.checkpointCount,
    skillCount: state.skillCount,
    versionCount: state.versionCount,
    fileCount: state.fileCount,
    stepCount: state.stepCount,
    jobCount: state.jobCount,
  }, {
    runCount: "1",
    checkpointCount: "1",
    skillCount: "1",
    versionCount: "1",
    fileCount: "1",
    stepCount: "0",
    jobCount: "0",
  });
}

Deno.test({
  name:
    "real import resumes exact pins across server, dispatcher, Inngest, and PostgreSQL restarts",
  ignore: !enabled,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const stack = await startRealSkillImportStack();
    try {
      const resolvedSource = await stack.registerSource(
        "git",
        stack.source.gitUrl,
        "Resolved restart",
      );
      const resolved = await interruptAt(
        stack,
        "resolved",
        resolvedSource.id,
        "v1",
      );
      assertEquals(resolved.before.state, "resolved");
      assertEquals(resolved.before.sourceRevision, stack.source.initialCommit);
      await stack.source.moveTagToSecondCommit();
      await stack.stopServer();
      await stack.restartServer();
      const resolvedAfter = await waitPersistedTerminal(stack, resolved.runId);
      assertEquals(resolvedAfter.state, "completed");
      assertEquals(resolvedAfter.sourceRevision, stack.source.initialCommit);
      assertSingletons(resolvedAfter);
      console.log(
        "restart-boundary resolved: server restarted; pinned commit reused",
      );

      const reservedSource = await stack.registerSource(
        "url",
        stack.source.archiveVariantUrl("reserved"),
        "Reserved restart",
      );
      const reserved = await interruptAt(
        stack,
        "reserved",
        reservedSource.id,
        stack.source.etag,
      );
      assertEquals(reserved.before.state, "reserved");
      const reservedIdentity = {
        skillVersionId: reserved.before.skillVersionId,
        fileInventory: reserved.before.fileInventory,
      };
      await stack.stopServer();
      await stack.stopDispatch();
      await stack.restartDispatch();
      await stack.restartServer();
      const reservedAfter = await waitPersistedTerminal(stack, reserved.runId);
      assertEquals(reservedAfter.state, "completed");
      assertEquals({
        skillVersionId: reservedAfter.skillVersionId,
        fileInventory: reservedAfter.fileInventory,
      }, reservedIdentity);
      assertSingletons(reservedAfter);
      console.log(
        "restart-boundary reserved: server+dispatcher restarted; UUID/object key reused",
      );

      const storedSource = await stack.registerSource(
        "url",
        stack.source.archiveVariantUrl("stored"),
        "Stored restart",
      );
      const stored = await interruptAt(
        stack,
        "stored",
        storedSource.id,
        stack.source.etag,
      );
      assertEquals(stored.before.state, "stored");
      const storedIdentity = {
        skillVersionId: stored.before.skillVersionId,
        fileInventory: stored.before.fileInventory,
      };
      await stack.stopServer();
      await stack.stopEngine();
      await stack.restartEngine();
      await stack.restartServer();
      const storedAfter = await waitPersistedTerminal(stack, stored.runId);
      assertEquals(storedAfter.state, "completed");
      assertEquals({
        skillVersionId: storedAfter.skillVersionId,
        fileInventory: storedAfter.fileInventory,
      }, storedIdentity);
      assertSingletons(storedAfter);
      console.log(
        "restart-boundary stored: server+Inngest restarted; UUID/object key reused",
      );

      const preAckSource = await stack.registerSource(
        "url",
        stack.source.archiveVariantUrl("pre-ack"),
        "Pre-ack restart",
      );
      const preAck = await interruptAt(
        stack,
        "pre_ack",
        preAckSource.id,
        stack.source.etag,
      );
      assertEquals(preAck.before.state, "completed");
      const preAckIdentity = {
        skillVersionId: preAck.before.skillVersionId,
        fileInventory: preAck.before.fileInventory,
      };
      await stack.stopServer();
      await stack.stopPostgres();
      await stack.restartPostgres();
      await stack.restartServer();
      const preAckAfter = await waitPersistedTerminal(stack, preAck.runId);
      assertEquals(preAckAfter.state, "completed");
      assertEquals({
        skillVersionId: preAckAfter.skillVersionId,
        fileInventory: preAckAfter.fileInventory,
      }, preAckIdentity);
      assertSingletons(preAckAfter);
      console.log(
        "restart-boundary pre_ack: server+PostgreSQL restarted; one publication retained",
      );

      const mutationSource = await stack.registerSource(
        "url",
        stack.source.archiveVariantUrl("mutated-bytes"),
        "Mutated bytes",
      );
      const mutated = await interruptAt(
        stack,
        "resolved",
        mutationSource.id,
        stack.source.etag,
      );
      await stack.source.useSecondArchive();
      await stack.stopServer();
      await stack.restartServer();
      const mutatedAfter = await waitPersistedTerminal(stack, mutated.runId);
      assertEquals(mutatedAfter.state, "failed");
      assertEquals(mutatedAfter.versionCount, "0");
      assertEquals(mutatedAfter.stepCount, "0");
      assertEquals(mutatedAfter.jobCount, "0");

      const disabledSource = await stack.registerSource(
        "url",
        stack.source.archiveVariantUrl("disabled"),
        "Disabled source",
      );
      const disabled = await interruptAt(
        stack,
        "reserved",
        disabledSource.id,
        stack.source.etag,
      );
      await stack.disableSource(disabledSource.id, disabledSource.version);
      await stack.stopServer();
      await stack.restartServer();
      const disabledAfter = await waitPersistedTerminal(stack, disabled.runId);
      assertEquals(disabledAfter.state, "failed");
      assertEquals(disabledAfter.runStatus, "failed");
      assertSingletons(disabledAfter);

      const unavailableSource = await stack.registerSource(
        "url",
        stack.source.archiveVariantUrl("unavailable"),
        "Unavailable source",
      );
      const unavailable = await interruptAt(
        stack,
        "stored",
        unavailableSource.id,
        stack.source.etag,
      );
      const orphanIdentity = {
        skillVersionId: unavailable.before.skillVersionId,
        fileInventory: unavailable.before.fileInventory,
      };
      await stack.stopServer();
      await stack.source.stop();
      await stack.restartServer();
      const unavailableAfter = await waitPersistedTerminal(
        stack,
        unavailable.runId,
        2_400,
      );
      assertEquals(unavailableAfter.state, "failed");
      assertEquals(unavailableAfter.versionStatus, "draft");
      assertEquals(unavailableAfter.activeVersionId, null);
      assertEquals({
        skillVersionId: unavailableAfter.skillVersionId,
        fileInventory: unavailableAfter.fileInventory,
      }, orphanIdentity);
      assertSingletons(unavailableAfter);
      const replay = await stack.requestImport(
        unavailableSource.id,
        stack.source.etag,
        undefined,
        `unavailable-replay-${crypto.randomUUID()}`,
      );
      assertEquals(replay.id, unavailable.runId);
      assertEquals((await stack.snapshot(unavailable.runId)).versionCount, "1");
      console.log(
        "faults: disabled and unreachable sources failed with one inaccessible draft identity",
      );
    } finally {
      await stack.cleanup();
    }

    const revokedStack = await startRealSkillImportStack();
    try {
      const source = await revokedStack.registerSource(
        "git",
        revokedStack.source.gitUrl,
        "Revoked requester",
      );
      const interrupted = await interruptAt(
        revokedStack,
        "resolved",
        source.id,
        revokedStack.source.initialCommit,
      );
      await revokedStack.revokeRequester(interrupted.runId);
      await revokedStack.stopServer();
      await revokedStack.restartServer();
      const terminal = await waitPersistedTerminal(
        revokedStack,
        interrupted.runId,
      );
      assertEquals(terminal.state, "failed");
      assertEquals(terminal.runStatus, "failed");
      assertEquals(terminal.versionCount, "0");
      assertEquals(terminal.fileCount, "0");
      assertEquals(terminal.stepCount, "0");
      assertEquals(terminal.jobCount, "0");
      console.log("fault: revoked requester failed before reservation");
    } finally {
      await revokedStack.cleanup();
    }
  },
});
