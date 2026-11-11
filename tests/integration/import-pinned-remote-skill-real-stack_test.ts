import { assertEquals, assertMatch } from "@std/assert";
import { startRealSkillImportStack } from "../fixtures/real-skill-import-stack.ts";

const enabled = Deno.env.get("BAKERY_IMPORT_STACK_LOCKED") === "1";

Deno.test({
  name:
    "real API dispatches one pinned Git import through PostgreSQL, Inngest, and filesystem",
  ignore: !enabled,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const stack = await startRealSkillImportStack();
    try {
      assertEquals(await stack.databaseIdentities(), [
        "bakery:postgres",
        "bakery:bakery_app",
      ]);
      assertEquals(await stack.functionIds(), [
        "bakery-fixed-workflow",
        "bakery-skill-import",
        "bakery-skill-import-recovery",
        "bakery-workflow-recovery",
      ]);
      assertMatch(stack.source.nonce, /^[0-9a-f-]{36}$/);
      assertEquals(stack.postgresPort > 0, true);
      assertEquals(new URL(stack.inngestUrl).port.length > 0, true);

      const source = await stack.registerSource("git", stack.source.gitUrl);
      await stack.stopDispatch();
      const admitted = await stack.requestImport(source.id, "v1");
      assertEquals(admitted.kind, "skill_import");
      assertEquals(admitted.status, "queued");
      assertEquals(admitted.taskId, null);
      assertEquals(admitted.workflowVersionId, null);
      assertEquals(admitted.skillSourceId, source.id);
      await stack.restartDispatch();

      const runId = String(admitted.id);
      const terminal = await stack.waitTerminal(runId);
      assertEquals(terminal.status, "completed");
      assertEquals(terminal.kind, "skill_import");
      const persisted = await stack.snapshot(runId);
      assertEquals(persisted.runStatus, "completed");
      assertEquals(persisted.state, "completed");
      assertEquals(persisted.sourceRevision, stack.source.initialCommit);
      assertEquals({
        runCount: persisted.runCount,
        checkpointCount: persisted.checkpointCount,
        skillCount: persisted.skillCount,
        versionCount: persisted.versionCount,
        fileCount: persisted.fileCount,
        eventCount: persisted.eventCount,
        stepCount: persisted.stepCount,
        jobCount: persisted.jobCount,
      }, {
        runCount: "1",
        checkpointCount: "1",
        skillCount: "1",
        versionCount: "1",
        fileCount: "1",
        eventCount: "1",
        stepCount: "0",
        jobCount: "0",
      });
      const files = persisted.fileInventory as Array<{ objectKey: string }>;
      assertEquals(files.length, 1);
      assertMatch(
        files[0].objectKey,
        new RegExp(
          `^organizations/${stack.organizationId}/skill-versions/${persisted.skillVersionId}/sha256/[0-9a-f]{64}$`,
        ),
      );
      const object = await Deno.readFile(
        `${stack.root}/skill-store/${files[0].objectKey}`,
      );
      assertEquals(new TextDecoder().decode(object), "# Remote skill\n");

      const replay = await stack.requestImport(
        source.id,
        "v1",
        undefined,
        `replay-${crypto.randomUUID()}`,
      );
      assertEquals(replay.id, runId);
      assertEquals(await stack.snapshot(runId), persisted);
      const observations = await stack.source.observations();
      assertEquals(
        observations.some(({ path }) => path.includes("info/refs")),
        true,
      );
      assertEquals(
        observations.some(({ path }) => path.includes("git-upload-pack")),
        true,
      );
    } finally {
      await stack.cleanup();
    }
  },
});
