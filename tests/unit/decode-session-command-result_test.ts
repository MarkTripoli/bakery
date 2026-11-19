import { assertEquals } from "@std/assert";
import { decodeCommandResult } from "../../apps/server/src/modules/execution/session-registry.ts";

// A command's result is the encoded response its replay record stores. Without
// decoding, an agent calling a write tool got the body as a numbered byte object.

const bytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));

Deno.test("a command's JSON body is decoded for the session", () => {
  assertEquals(
    decodeCommandResult({ status: 201, body: bytes({ id: "q1", n: 2 }) }),
    { id: "q1", n: 2 },
  );
});

Deno.test("an empty or no-content command answers null", () => {
  assertEquals(
    decodeCommandResult({ status: 204, body: new Uint8Array() }),
    null,
  );
  assertEquals(
    decodeCommandResult({ status: 200, body: new Uint8Array() }),
    null,
  );
});

Deno.test("anything that is not an encoded response passes through", () => {
  assertEquals(decodeCommandResult({ items: [] }), { items: [] });
  assertEquals(decodeCommandResult(null), null);
});
