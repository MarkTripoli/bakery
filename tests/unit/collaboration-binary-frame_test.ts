import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  BINARY_HEADER_BYTES,
  BinaryFrameKind,
  decodeBinaryFrame,
  encodeBinaryFrame,
  MalformedFrameError,
} from "../../apps/web/src/collaboration/binary-frame.ts";
import {
  BINARY_HEADER_BYTES as SERVER_HEADER_BYTES,
  BinaryFrameKind as ServerKind,
  decodeBinaryFrame as serverDecode,
  encodeBinaryFrame as serverEncode,
} from "../../apps/server/src/modules/knowledge/collaboration-socket.ts";

const frame = {
  kind: BinaryFrameKind.ClientUpdate,
  epoch: 7,
  draftId: "0f0e0d0c-0b0a-4908-8706-050403020100",
  mutationId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  sequence: 123456789012n,
  payload: new Uint8Array([1, 2, 3, 250, 0, 9]),
};

Deno.test("the web codec and the server codec agree on the header and the kinds", () => {
  assertEquals(BINARY_HEADER_BYTES, SERVER_HEADER_BYTES);
  assertEquals({ ...BinaryFrameKind }, { ...ServerKind });
});

Deno.test("a frame round-trips through the web codec", () => {
  assertEquals(decodeBinaryFrame(encodeBinaryFrame(frame)), frame);
});

Deno.test("what the web encodes the server decodes, and the reverse, byte for byte", () => {
  const fromWeb = encodeBinaryFrame(frame);
  assertEquals(serverDecode(fromWeb), frame);
  const fromServer = serverEncode(frame);
  assertEquals(fromServer, fromWeb);
  assertEquals(decodeBinaryFrame(fromServer), frame);
});

Deno.test("an empty payload and the largest epoch survive", () => {
  const edge = { ...frame, epoch: 0xffffffff, payload: new Uint8Array() };
  assertEquals(decodeBinaryFrame(encodeBinaryFrame(edge)), edge);
});

Deno.test("a frame that does not match the protocol is refused", () => {
  const good = encodeBinaryFrame(frame);
  assertThrows(() => decodeBinaryFrame(good.slice(0, 10)), MalformedFrameError);
  const wrongVersion = good.slice();
  wrongVersion[0] = 9;
  assertThrows(() => decodeBinaryFrame(wrongVersion), MalformedFrameError);
  const reserved = good.slice();
  reserved[2] = 1;
  assertThrows(() => decodeBinaryFrame(reserved), MalformedFrameError);
  const longer = new Uint8Array(good.length + 1);
  longer.set(good);
  assertThrows(() => decodeBinaryFrame(longer), MalformedFrameError);
  assertThrows(
    () => encodeBinaryFrame({ ...frame, draftId: "not-a-uuid" }),
    MalformedFrameError,
  );
  assert(decodeBinaryFrame(good).payload.length === frame.payload.length);
});
