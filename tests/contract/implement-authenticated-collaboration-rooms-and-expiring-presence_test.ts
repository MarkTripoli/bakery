import { assert, assertEquals } from "@std/assert";
import {
  catalogActions,
  contractSchemas,
} from "../../packages/contracts/src/contracts.ts";

const room = { kind: "draft", id: crypto.randomUUID() };
const state = { activity: "active", typing: false, cursor: null };

Deno.test("the collaboration socket is cataloged as a draft-read upgrade with no MCP tool", () => {
  const entry = catalogActions.find((action) =>
    action.action === "collaboration.connect"
  );
  assert(entry);
  assertEquals(entry.method, "GET");
  assertEquals(entry.path, "/v1/collaboration");
  assertEquals(entry.permission, "draft:read");
  assertEquals(entry.input, "CollaborationUpgrade");
  assertEquals(entry.output, "CollaborationFrames");
  assertEquals(entry.mcp, null);
});

Deno.test("client frames are strict: identity, timestamps and unknown keys are refused", () => {
  const frame = contractSchemas.CollaborationFrame;
  const update = {
    type: "presence.update",
    requestId: crypto.randomUUID(),
    room,
    state,
  };
  assert(frame.safeParse(update).success);
  for (
    const forged of [
      { ...update, principalId: crypto.randomUUID() },
      { ...update, displayName: "Someone else" },
      { ...update, receivedAt: new Date().toISOString() },
      { ...update, state: { ...state, principalId: crypto.randomUUID() } },
      { ...update, state: { ...state, avatar: "https://example.test/x" } },
    ]
  ) {
    assertEquals(
      frame.safeParse(forged).success,
      false,
      JSON.stringify(forged),
    );
  }
  assertEquals(
    frame.safeParse({ ...update, room: { kind: "conversation", id: room.id } })
      .success,
    false,
  );
});

Deno.test("presence hints are bounded: cursor positions at most 512 bytes and the frame at most 64 KiB", () => {
  const frame = contractSchemas.CollaborationFrame;
  const withCursor = (head: string) => ({
    type: "presence.update",
    requestId: crypto.randomUUID(),
    room,
    state: { ...state, cursor: { anchor: "AQID", head } },
  });
  assert(frame.safeParse(withCursor("x".repeat(512))).success);
  assertEquals(frame.safeParse(withCursor("x".repeat(513))).success, false);
});

Deno.test("server presence carries the server-assigned identity and receipt time", () => {
  const presence = contractSchemas.CollaborationPresence;
  const value = {
    participantKey: crypto.randomUUID(),
    principalId: crypto.randomUUID(),
    principalType: "human",
    displayName: "Ada",
    state,
    receivedAt: new Date().toISOString(),
  };
  assert(presence.safeParse(value).success);
  for (
    const field of [
      "participantKey",
      "principalId",
      "principalType",
      "displayName",
      "receivedAt",
    ]
  ) {
    const { [field]: _, ...missing } = value as Record<string, unknown>;
    assertEquals(presence.safeParse(missing).success, false, field);
  }
});
