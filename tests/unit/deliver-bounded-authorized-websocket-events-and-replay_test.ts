import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  EVENTS_SOCKET_LIMITS,
  parseScopeFilters,
  scopeFilters,
} from "../../apps/server/src/modules/work/events-socket.ts";
import {
  type ClockRow,
  isOutsideRetention,
  type SyncScope,
} from "../../apps/server/src/modules/work/event-stream.ts";
import {
  decodeSequenceCursorFilters,
  encodeSequenceCursor,
} from "../../apps/server/src/platform/cursor.ts";
import { websocketAcceptKey } from "../helpers/ws-client.ts";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";

const secret = "phase-4-websocket-unit-secret";
const principalId = "00000000-0000-4000-8000-000000000001";
const otherPrincipalId = "00000000-0000-4000-8000-000000000002";
const organizationId = "00000000-0000-4000-8000-000000000010";
const applicationId = "00000000-0000-4000-8000-000000000011";
const repositoryId = "00000000-0000-4000-8000-000000000012";
const taskId = "00000000-0000-4000-8000-000000000013";
const conversationId = "00000000-0000-4000-8000-000000000014";

const scopes: readonly SyncScope[] = [
  { type: "application", id: applicationId },
  { type: "repository", id: repositoryId },
  { type: "task", id: taskId },
  { type: "conversation", id: conversationId },
];

function binding(filters: string, principal = principalId) {
  return {
    action: "events.connect",
    principalId: principal,
    organizationId,
    ordering: "sequence:asc",
    filters,
    schemaVersion: 1,
  };
}

function assertInvalidCursor(action: () => unknown): void {
  const error = assertThrows(action, StandardError);
  assertEquals(error.code, "INVALID_CURSOR");
}

Deno.test("event cursor scopes are canonical and reject malformed filters", () => {
  const shuffled: readonly SyncScope[] = [
    { type: "conversation", id: conversationId.toUpperCase() },
    { type: "task", id: taskId.toUpperCase() },
    { type: "repository", id: repositoryId.toUpperCase() },
    { type: "application", id: applicationId.toUpperCase() },
  ];

  const filters = scopeFilters(shuffled);
  assertEquals(
    filters,
    `a:${applicationId};r:${repositoryId};t:${taskId};c:${conversationId}`,
  );
  assertEquals(parseScopeFilters(filters), scopes);

  const malformed = [
    `x:${applicationId}`,
    "a:not-a-uuid",
    `a:${applicationId};a:${applicationId}`,
    "",
    [
      `a:${applicationId}`,
      `r:${repositoryId}`,
      `t:${taskId}`,
      `c:${conversationId}`,
      `a:00000000-0000-4000-8000-000000000015`,
    ].join(";"),
  ];
  for (const value of malformed) {
    assertInvalidCursor(() => parseScopeFilters(value));
  }
});

Deno.test("four-scope sequence cursor stays bounded at a 19-digit sequence", async () => {
  const filters = scopeFilters(scopes);
  const cursor = await encodeSequenceCursor(
    secret,
    binding(filters),
    { sequence: "9999999999999999999" },
  );

  assert(new TextEncoder().encode(cursor).byteLength <= 512);
  assertEquals(
    await decodeSequenceCursorFilters(secret, cursor, binding("")),
    { sequence: "9999999999999999999", filters },
  );
});

Deno.test("tampered and other-principal sequence cursors fail closed", async () => {
  const filters = scopeFilters(scopes);
  const cursor = await encodeSequenceCursor(
    secret,
    binding(filters),
    { sequence: "19" },
  );
  const last = cursor.at(-1);
  assert(last !== undefined);
  const tampered = `${cursor.slice(0, -1)}${last === "A" ? "B" : "A"}`;

  const tamperedError = await assertRejects(
    () => decodeSequenceCursorFilters(secret, tampered, binding("")),
    StandardError,
  );
  assertEquals(tamperedError.code, "INVALID_CURSOR");

  const principalError = await assertRejects(
    () =>
      decodeSequenceCursorFilters(
        secret,
        cursor,
        binding("", otherPrincipalId),
      ),
    StandardError,
  );
  assertEquals(principalError.code, "INVALID_CURSOR");
});

Deno.test("WebSocketFrame accepts statusless client ack and rejects execute", () => {
  const requestId = "00000000-0000-4000-8000-000000000020";
  const eventId = "00000000-0000-4000-8000-000000000021";
  const ack = contractSchemas.WebSocketFrame.safeParse({
    type: "ack",
    requestId,
    eventId,
    sequence: "1",
  });
  assertEquals(ack.success, true);

  const execute = contractSchemas.WebSocketFrame.safeParse({
    type: "execute",
    requestId,
    operation: "tasks.create",
  });
  assertEquals(execute.success, false);
});

Deno.test("WebSocketFrame rejects a frame exactly one byte over maxFrameBytes", () => {
  const requestId = "00000000-0000-4000-8000-000000000022";
  const baseEvents = Array.from({ length: 9 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 30).padStart(12, "0")}`,
    sequence: String(index + 1),
    type: "tasks.updated",
    schemaVersion: 1,
    occurredAt: "2026-09-12T12:00:00.000Z",
    taskId,
    repositoryId: null,
    conversationId,
    workerHostId: null,
    workerEnrollmentId: null,
    payload: { blob: "" },
  }));
  const base = {
    type: "events",
    requestId,
    events: baseEvents,
    highwater: "9",
  };
  const baseBytes = new TextEncoder().encode(JSON.stringify(base)).byteLength;
  const totalPadding = EVENTS_SOCKET_LIMITS.maxFrameBytes + 1 - baseBytes;
  const perEvent = Math.floor(totalPadding / baseEvents.length);
  const remainder = totalPadding % baseEvents.length;
  const frame = {
    ...base,
    events: baseEvents.map((event, index) => ({
      ...event,
      payload: { blob: "x".repeat(perEvent + (index < remainder ? 1 : 0)) },
    })),
  };

  for (const event of frame.events) {
    assertEquals(
      contractSchemas.WebSocketFrame.safeParse({
        ...base,
        events: [event],
        highwater: event.sequence,
      }).success,
      true,
    );
  }
  assertEquals(
    new TextEncoder().encode(JSON.stringify(frame)).byteLength,
    EVENTS_SOCKET_LIMITS.maxFrameBytes + 1,
  );
  assertEquals(contractSchemas.WebSocketFrame.safeParse(frame).success, false);
});

Deno.test("event retention allows the predecessor and highwater boundaries only", () => {
  const clock: ClockRow = { retainedFrom: "100", highwater: "142" };
  assertEquals(isOutsideRetention(99n, clock), false);
  assertEquals(isOutsideRetention(98n, clock), true);
  assertEquals(isOutsideRetention(142n, clock), false);
  assertEquals(isOutsideRetention(143n, clock), true);
});

Deno.test("websocket accept key matches RFC6455 standard vector", async () => {
  assertEquals(
    await websocketAcceptKey("dGhlIHNhbXBsZSBub25jZQ=="),
    "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
  );
});
