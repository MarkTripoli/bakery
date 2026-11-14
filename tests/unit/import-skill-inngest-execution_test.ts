import { assertEquals, assertRejects } from "@std/assert";
import { readInngestRuntimeConfig } from "@bakery/config";
import type { PgDatabase } from "@bakery/persistence";
import { StandardError } from "../../packages/contracts/src/http.ts";
import { Inngest, NonRetriableError } from "inngest";
import {
  createSkillImportRecovery,
  createSkillImportWorkflow,
} from "../../apps/server/src/modules/catalog/import-workflow.ts";
import type { SkillSourceAdapter } from "../../apps/server/src/modules/catalog/source-adapters.ts";
import type { SkillFileStoreOperations } from "../../apps/server/src/modules/catalog/storage.ts";
import { createDefaultInngestFunctions } from "../../apps/server/src/modules/execution/inngest-http.ts";

type CapturedFunction = {
  config: Record<string, unknown>;
  handler: unknown;
};

type TestStep = {
  run<T>(id: string, work: () => Promise<T>): Promise<T>;
  sendEvent(id: string, event: unknown): Promise<void>;
};

function fakeClient(captured: CapturedFunction[]): Inngest {
  return {
    createFunction(config: unknown, handler: unknown) {
      const value = {
        config: config as Record<string, unknown>,
        handler,
      };
      captured.push(value);
      return value;
    },
  } as unknown as Inngest;
}

const database = {} as PgDatabase;
const sourceAdapter = {} as SkillSourceAdapter;
const skillFileStore = {
  recover: () => Promise.resolve(),
  putIfAbsent: () => Promise.resolve(),
  read: () => Promise.resolve(new Uint8Array()),
} satisfies SkillFileStoreOperations;

Deno.test("default Inngest registration keeps workflow and budget recovery handlers and adds the import handlers and the automation clock", () => {
  const captured: CapturedFunction[] = [];
  const config = readInngestRuntimeConfig({
    BAKERY_ENV: "test",
    INNGEST_URL: "http://127.0.0.1:8288",
    INNGEST_SIGNING_KEY:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    INNGEST_EVENT_KEY: "issue-278-event-key",
  });
  const functions = createDefaultInngestFunctions({
    config,
    database,
    client: fakeClient(captured),
    skillImport: { sourceAdapter, skillFileStore },
  });

  assertEquals(functions.length, 10);
  assertEquals(captured.map(({ config }) => config.id), [
    "bakery-fixed-workflow",
    "bakery-workflow-recovery",
    "bakery-budget-recovery",
    "bakery-skill-import",
    "bakery-skill-import-recovery",
    "bakery-output-archive",
    "bakery-conversation-turn",
    "bakery-conversation-turn-recovery",
    "bakery-audit-retention",
    "bakery-automation-tick",
  ]);
  assertEquals(captured[5].config.triggers, [{ cron: "* * * * *" }]);
  assertEquals(captured[9].config.triggers, [{ cron: "* * * * *" }]);
  assertEquals(captured[0].config.triggers, [
    { event: "bakery/run.requested.v1" },
  ]);
  assertEquals(captured[3].config.triggers, [
    { event: "bakery/skill.import.requested.v1" },
  ]);
});

Deno.test("import workflow accepts only the import event payload and stores no bytes in step output", async () => {
  const captured: CapturedFunction[] = [];
  const runId = "22222222-2222-4222-8222-222222222222";
  const calls: string[] = [];
  createSkillImportWorkflow({
    client: fakeClient(captured),
    database,
    sourceAdapter,
    skillFileStore,
    execute: (receivedRunId) => {
      calls.push(receivedRunId);
      return Promise.resolve({
        runId: receivedRunId,
        state: "completed" as const,
        skillVersionId: "33333333-3333-4333-8333-333333333333",
      });
    },
  });
  const handler = captured[0].handler as (context: {
    event: unknown;
    step: TestStep;
  }) => Promise<unknown>;
  const stepNames: string[] = [];
  const result = await handler({
    event: {
      name: "bakery/skill.import.requested.v1",
      data: { payload: { runId } },
    },
    step: {
      async run(_id, work) {
        stepNames.push(_id);
        return await work();
      },
      sendEvent: () => Promise.resolve(),
    },
  });

  assertEquals(calls, [runId]);
  assertEquals(stepNames, [`execute-skill-import-${runId}`]);
  assertEquals(result, {
    runId,
    state: "completed",
    skillVersionId: "33333333-3333-4333-8333-333333333333",
  });
});

Deno.test("import workflow marks deterministic source and authority faults non-retriable inside the step", async () => {
  const captured: CapturedFunction[] = [];
  const runId = "55555555-5555-4555-8555-555555555555";
  createSkillImportWorkflow({
    client: fakeClient(captured),
    database,
    sourceAdapter,
    skillFileStore,
    execute: () =>
      Promise.reject(new StandardError({ code: "PRECONDITION_FAILED" })),
  });
  const handler = captured[0].handler as (context: {
    event: unknown;
    step: TestStep;
  }) => Promise<unknown>;
  await assertRejects(
    () =>
      handler({
        event: {
          name: "bakery/skill.import.requested.v1",
          data: { payload: { runId } },
        },
        step: {
          async run(_id, work) {
            return await work();
          },
          sendEvent: () => Promise.resolve(),
        },
      }),
    NonRetriableError,
    "PRECONDITION_FAILED",
  );
});

Deno.test("import recovery rearms only import runs with generation-bound events", async () => {
  const captured: CapturedFunction[] = [];
  const runId = "44444444-4444-4444-8444-444444444444";
  createSkillImportRecovery({
    client: fakeClient(captured),
    database,
    loadCandidates: () => Promise.resolve([{ runId, generation: 7 }]),
  });
  const handler = captured[0].handler as (context: {
    step: TestStep;
  }) => Promise<unknown>;
  const sent: Array<{ id: string; event: unknown }> = [];
  const result = await handler({
    step: {
      async run(_id, work) {
        return await work();
      },
      sendEvent(id, event) {
        sent.push({ id, event });
        return Promise.resolve();
      },
    },
  });

  assertEquals(result, { rearmed: 1 });
  assertEquals(sent, [{
    id: `rearm-skill-import-${runId}-7`,
    event: {
      name: "bakery/skill.import.requested.v1",
      data: { payload: { runId } },
    },
  }]);
});
