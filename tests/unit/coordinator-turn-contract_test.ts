import { assert, assertEquals, assertFalse } from "@std/assert";
import { z } from "zod";
import {
  buildCoordinatorTurnJobInput,
  COORDINATOR_INPUT_MAX_BYTES,
  COORDINATOR_INPUT_TARGET_BYTES,
  COORDINATOR_OUTPUT_MAX_BYTES,
  COORDINATOR_TURN_ACTION,
  CoordinatorModelOutputSchema,
  coordinatorOutputJsonSchema,
  CoordinatorTurnJobInputSchema,
  CoordinatorTurnJobOutputSchema,
} from "../../packages/contracts/src/coordinator-turn.ts";
import {
  registeredWorkerActionInputSchema,
  workerActionCapabilities,
  workerActionOutputSchema,
} from "../../packages/contracts/src/contracts.ts";
import { WORKFLOW_ACTION_NAMES } from "../../packages/contracts/src/workflow-action-registry.ts";
import { executionJobInputFitsTransport } from "../../packages/persistence/src/repository-admission.ts";

const enc = new TextEncoder();
const uuid = "6f1c2b0e-0000-4000-8000-000000000001";

function walk(schema: z.ZodType, path: string, bad: string[]): void {
  const seen = new Set<z.ZodType>();
  const visit = (node: z.ZodType, at: string) => {
    if (seen.has(node)) return;
    seen.add(node);
    if (!node.description || node.description.trim().length < 8) bad.push(at);
    const def = node.def as unknown as Record<string, unknown>;
    const shape = (node as unknown as { shape?: Record<string, z.ZodType> })
      .shape;
    if (shape) {
      for (const [k, v] of Object.entries(shape)) visit(v, `${at}.${k}`);
    }
    for (
      const key of ["element", "innerType", "in", "out", "keyType", "valueType"]
    ) {
      const child = def[key];
      if (child && typeof child === "object") {
        visit(child as z.ZodType, `${at}.${key}`);
      }
    }
    const options = def.options as z.ZodType[] | undefined;
    if (options) options.forEach((o, i) => visit(o, `${at}|${i}`));
  };
  visit(schema, path);
}

Deno.test("every coordinator turn schema node is described", () => {
  const bad: string[] = [];
  walk(CoordinatorTurnJobInputSchema, "input", bad);
  walk(CoordinatorTurnJobOutputSchema, "output", bad);
  walk(CoordinatorModelOutputSchema, "model", bad);
  assertEquals(bad, []);
});

function maxOutput(bodyBytes: number) {
  const reply = { type: "reply", body: "r".repeat(bodyBytes) };
  return {
    effects: [reply],
    model: "claude-opus-5-5",
    claudeCodeVersion: "2.0.0",
  };
}

Deno.test("output at cap passes and cap+1 fails", () => {
  const base = enc.encode(JSON.stringify(maxOutput(0))).length;
  const atCap = maxOutput(COORDINATOR_OUTPUT_MAX_BYTES - base);
  assertEquals(
    enc.encode(JSON.stringify(atCap)).length,
    COORDINATOR_OUTPUT_MAX_BYTES,
  );
  assert(CoordinatorTurnJobOutputSchema.safeParse(atCap).success);
  const over = maxOutput(COORDINATOR_OUTPUT_MAX_BYTES - base + 1);
  assertFalse(CoordinatorTurnJobOutputSchema.safeParse(over).success);
  assert(COORDINATOR_OUTPUT_MAX_BYTES <= 65_536 - 0);
  assertEquals(COORDINATOR_OUTPUT_MAX_BYTES, 32_000 - 4_096);
});

Deno.test("twenty maximum effects exceed the total cap, 21 effects fail count", () => {
  const plan = {
    type: "planRevision",
    title: "t".repeat(300),
    steps: Array.from({ length: 100 }, (_, i) => ({
      id: `s${i}`,
      title: "x".repeat(300),
      detail: "d".repeat(4000),
    })),
  };
  const full = {
    effects: Array.from({ length: 20 }, () => plan),
    model: "m",
    claudeCodeVersion: "v",
  };
  assertFalse(CoordinatorTurnJobOutputSchema.safeParse(full).success);
  const twentyOne = {
    effects: Array.from({ length: 21 }, () => ({ type: "noop" })),
    model: "m",
    claudeCodeVersion: "v",
  };
  assertFalse(CoordinatorTurnJobOutputSchema.safeParse(twentyOne).success);
  const twenty = { ...twentyOne, effects: twentyOne.effects.slice(0, 20) };
  assert(CoordinatorTurnJobOutputSchema.safeParse(twenty).success);
});

const question = (audience?: unknown) => ({
  effects: [{
    type: "question",
    prompt: "Which repositories?",
    ...(audience ? { audience } : {}),
  }],
  model: "m",
  claudeCodeVersion: "v",
});

Deno.test("principals audience is rejected and absent from the JSON schema", () => {
  assertFalse(
    CoordinatorTurnJobOutputSchema.safeParse(
      question({ type: "principals", principalIds: [uuid] }),
    ).success,
  );
  assert(
    CoordinatorTurnJobOutputSchema.safeParse(
      question({ type: "task_participants" }),
    ).success,
  );
  assertFalse(
    JSON.stringify(coordinatorOutputJsonSchema()).includes("principal"),
  );
});

Deno.test("1000-message transcript is trimmed then fits transport", () => {
  const messages = Array.from({ length: 1000 }, (_, i) => ({
    sequence: String(i + 1),
    authorId: i % 2 ? null : uuid,
    messageType: "user",
    intent: "chat",
    body: "m".repeat(2000),
  }));
  const input = buildCoordinatorTurnJobInput({
    turnId: uuid,
    conversationId: uuid,
    contextThroughSequence: "1000",
    messages,
    scope: { applicationId: null, repositoryId: null, taskId: null },
    openQuestions: [],
    currentPlanRevision: null,
  });
  assert(input.messages.length < 1000);
  assertEquals(input.messages.at(-1)?.sequence, "1000");
  assertEquals(input.truncatedBeforeSequence, input.messages[0].sequence);
  assert(executionJobInputFitsTransport(input));
  assert(
    enc.encode(JSON.stringify(input)).length <= COORDINATOR_INPUT_TARGET_BYTES,
  );
  assert(CoordinatorTurnJobInputSchema.safeParse(input).success);
  assert(COORDINATOR_INPUT_TARGET_BYTES < COORDINATOR_INPUT_MAX_BYTES);
  assert(input.messages.every((m) => !("authorId" in m)));
  // Untrimmed fixture over the cap is rejected.
  assertFalse(
    CoordinatorTurnJobInputSchema.safeParse({
      ...input,
      messages: messages.map((m) => ({
        sequence: m.sequence,
        role: "participant",
        messageType: m.messageType,
        intent: m.intent,
        body: m.body,
      })),
    }).success,
  );
});

// Minimal JSON Schema subset validator (draft-7 as emitted by zod).
function valid(schema: Record<string, unknown>, value: unknown): boolean {
  if (schema.oneOf) {
    return (schema.oneOf as Record<string, unknown>[]).filter((s) =>
      valid(s, value)
    ).length === 1;
  }
  if (schema.anyOf) {
    return (schema.anyOf as Record<string, unknown>[]).some((s) =>
      valid(s, value)
    );
  }
  if ("const" in schema) return value === schema.const;
  if (schema.enum) return (schema.enum as unknown[]).includes(value);
  switch (schema.type) {
    case "string": {
      if (typeof value !== "string") return false;
      const len = [...value].length;
      return (schema.minLength === undefined ||
        len >= (schema.minLength as number)) &&
        (schema.maxLength === undefined || len <= (schema.maxLength as number));
    }
    case "number":
    case "integer": {
      if (typeof value !== "number") return false;
      if (schema.type === "integer" && !Number.isInteger(value)) return false;
      return (schema.minimum === undefined ||
        value >= (schema.minimum as number)) &&
        (schema.maximum === undefined || value <= (schema.maximum as number));
    }
    case "boolean":
      return typeof value === "boolean";
    case "array": {
      if (!Array.isArray(value)) return false;
      if (
        schema.minItems !== undefined &&
        value.length < (schema.minItems as number)
      ) return false;
      if (
        schema.maxItems !== undefined &&
        value.length > (schema.maxItems as number)
      ) return false;
      return value.every((v) =>
        valid(schema.items as Record<string, unknown>, v)
      );
    }
    case "object": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return false;
      }
      const props = (schema.properties ?? {}) as Record<
        string,
        Record<string, unknown>
      >;
      const obj = value as Record<string, unknown>;
      for (const r of (schema.required ?? []) as string[]) {
        if (!(r in obj)) return false;
      }
      for (const [k, v] of Object.entries(obj)) {
        if (!props[k]) {
          if (schema.additionalProperties === false) return false;
          continue;
        }
        if (!valid(props[k], v)) return false;
      }
      return true;
    }
  }
  return true;
}

Deno.test("JSON schema and Zod agree on fixtures", async () => {
  const json = coordinatorOutputJsonSchema();
  const dir = new URL(
    "../fixtures/scripted-coordinator/templates/",
    import.meta.url,
  );
  const fixtures: unknown[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.name.endsWith(".json")) continue;
    const parsed = JSON.parse(
      await Deno.readTextFile(new URL(entry.name, dir)),
    );
    if (JSON.stringify(parsed).includes('"principals"')) continue;
    if (parsed && Array.isArray(parsed.effects)) {
      fixtures.push({ effects: parsed.effects });
    }
  }
  assert(fixtures.length >= 3);
  const rejects = [
    {
      effects: [{
        type: "question",
        prompt: "p",
        audience: { type: "principals", principalIds: [uuid] },
      }],
    },
    { effects: [{ type: "reply", body: "" }] },
    { effects: [{ type: "bogus" }] },
    { effects: Array.from({ length: 21 }, () => ({ type: "noop" })) },
    { effects: [{ type: "reply", body: "x", extra: 1 }] },
    {},
  ];
  for (const f of [...fixtures, ...rejects]) {
    assertEquals(
      valid(json, f),
      CoordinatorModelOutputSchema.safeParse(f).success,
      JSON.stringify(f).slice(0, 120),
    );
  }
  for (const f of fixtures) assert(valid(json, f));
  for (const f of rejects) assertFalse(valid(json, f));
});

Deno.test("coordinator.turn is a registered non-workflow model action", () => {
  assertFalse(
    (WORKFLOW_ACTION_NAMES as readonly string[]).includes(
      COORDINATOR_TURN_ACTION,
    ),
  );
  assertEquals([...workerActionCapabilities(COORDINATOR_TURN_ACTION)], [
    "model",
  ]);
  assertEquals(
    registeredWorkerActionInputSchema(COORDINATOR_TURN_ACTION),
    CoordinatorTurnJobInputSchema,
  );
  assertEquals(
    workerActionOutputSchema(COORDINATOR_TURN_ACTION),
    CoordinatorTurnJobOutputSchema,
  );
});
