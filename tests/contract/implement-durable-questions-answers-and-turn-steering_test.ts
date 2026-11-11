import { assert, assertEquals } from "@std/assert";
import catalog from "../../docs/technical-design/api-catalog.json" with {
  type: "json",
};
import {
  contractSchemas,
  domainEventPayloadSchema,
} from "../../packages/contracts/src/contracts.ts";
import {
  ConversationImplementedAction,
  ExecutionImplementedAction,
} from "../../packages/contracts/src/implemented-actions.ts";

type CatalogAction = {
  action: string;
  access: string;
  permission?: string;
  organizationContext?: string;
  method: string;
  path: string;
  event: string;
};
const actions = (catalog as unknown as { actions: CatalogAction[] }).actions;
const byName = (name: string) => actions.find((a) => a.action === name);

Deno.test("question and session operations are catalogued with permission keys and implemented", () => {
  const expected: Record<string, [string, string, string]> = {
    "questions.list": ["GET", "/v1/questions", "question:read"],
    "questions.get": ["GET", "/v1/questions/{id}", "question:read"],
    "questions.answer": [
      "PUT",
      "/v1/questions/{id}/answer",
      "question:write",
    ],
    "sessions.get": ["GET", "/v1/sessions/{id}", "session:read"],
    "sessions.steer": [
      "POST",
      "/v1/sessions/{id}/messages",
      "session:control",
    ],
  };
  for (const [name, [method, path, permission]] of Object.entries(expected)) {
    const entry = byName(name);
    assert(entry, `${name} catalogued`);
    assertEquals([entry.method, entry.path, entry.permission], [
      method,
      path,
      permission,
    ]);
    assertEquals(entry.access, "Developer");
    assertEquals(entry.organizationContext, "required_authenticated_context");
  }
  assertEquals(byName("questions.answer")?.event, "question.answered");
  assertEquals(byName("sessions.steer")?.event, "session.steering_requested");
  const implemented = [
    ...Object.values(ConversationImplementedAction),
    ...Object.values(ExecutionImplementedAction),
  ];
  for (const name of Object.keys(expected)) {
    assert(implemented.includes(name as never), `${name} implemented`);
  }
});

Deno.test("question contract keeps legacy fields and adds options, audience and expiry", () => {
  const now = new Date().toISOString();
  const parsed = contractSchemas.Question.parse({
    id: crypto.randomUUID(),
    taskId: crypto.randomUUID(),
    runId: null,
    conversationId: crypto.randomUUID(),
    prompt: "Proceed?",
    responseSchema: null,
    status: "expired",
    answer: null,
    answeredBy: null,
    answeredAt: null,
    createdAt: now,
    updatedAt: now,
    version: 1,
    kind: "question",
    turnId: crypto.randomUUID(),
    generation: 2,
    options: [{ id: "yes", label: "Yes" }],
    allowFreeText: false,
    audience: { type: "task_participants" },
    expiresAt: now,
  });
  assertEquals(parsed.generation, 2);
  assertEquals(parsed.status, "expired");
  assertEquals(
    contractSchemas.Question.safeParse({ ...parsed, status: "bogus" }).success,
    false,
  );
});

Deno.test("steering message accepts both modes and defaults the client id", () => {
  for (const mode of ["steer", "follow_up", "append", "interrupt"]) {
    assert(
      contractSchemas.SteeringMessage.safeParse({ body: "x", mode }).success,
    );
  }
  assert(contractSchemas.SteeringMessage.safeParse({ body: "x" }).success);
  assertEquals(
    contractSchemas.SteeringMessage.safeParse({ body: "x", mode: "pause" })
      .success,
    false,
  );
});

Deno.test("run control capability reasons include explicit unsupported", () => {
  const capability = contractSchemas.RunControlCapabilities.parse({
    runId: crypto.randomUUID(),
    actions: [{ action: "pause", canRequest: false, reason: "unsupported" }],
  });
  assertEquals(capability.actions[0].reason, "unsupported");
});

Deno.test("question and steering domain events have registered payload schemas", () => {
  const id = crypto.randomUUID();
  assert(
    domainEventPayloadSchema("question.opened")?.safeParse({
      questionId: id,
      conversationId: id,
    }).success,
  );
  assert(
    domainEventPayloadSchema("question.expired")?.safeParse({ questionId: id })
      .success,
  );
  const answered = domainEventPayloadSchema("question.answered");
  assert(answered?.safeParse({ questionId: id, runId: null }).success);
  assert(answered?.safeParse({ questionId: id, runId: id }).success);
  assert(
    domainEventPayloadSchema("session.steering_requested")?.safeParse({
      sessionId: id,
      messageId: id,
    }).success,
  );
});
