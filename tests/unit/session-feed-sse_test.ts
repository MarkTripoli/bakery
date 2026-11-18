import { assertEquals } from "@std/assert";
import { createSseParser } from "../../apps/web/src/api/session-feed-sse.ts";

// #405: the reader for the session feed's server-sent events.

Deno.test("an event is its id, its name and its data", () => {
  const parse = createSseParser();
  assertEquals(parse('id: 7\nevent: feed\ndata: {"a":1}\n\n'), [
    { id: "7", event: "feed", data: '{"a":1}' },
  ]);
});

Deno.test("a block split across chunks waits for its end, and comments are ignored", () => {
  const parse = createSseParser();
  assertEquals(parse(": keep-alive\n\nid: 1\nevent: fe"), []);
  assertEquals(parse("ed\ndata: one\n\nid: 2\nevent: feed\ndata: two\n\n"), [
    { id: "1", event: "feed", data: "one" },
    { id: "2", event: "feed", data: "two" },
  ]);
});

Deno.test("carriage returns and multi-line data are handled", () => {
  const parse = createSseParser();
  assertEquals(parse("id: 3\r\nevent: feed\r\ndata: a\r\ndata: b\r\n\r\n"), [
    { id: "3", event: "feed", data: "a\nb" },
  ]);
});

Deno.test("a block with no data is not an event", () => {
  const parse = createSseParser();
  assertEquals(parse("id: 4\nevent: feed\n\n"), []);
});
