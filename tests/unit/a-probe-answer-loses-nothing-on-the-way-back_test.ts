/**
 * The flat wire answer and the probe's own union (#437 slice 3).
 *
 * The interesting cases are the two where a naive mapper lies: a described file
 * whose answer omits a fact must not gain `width: 0`, and an answer with no
 * status must be "no probe yet" rather than an empty description.
 */
import { assertEquals } from "@std/assert";
import {
  type ProbeAnswer,
  probeFromAnswer,
} from "../../apps/web/src/pages/probe-answer.ts";

const empty: ProbeAnswer = {
  status: null,
  kind: null,
  mediaType: null,
  byteLength: null,
  width: null,
  height: null,
  durationMs: null,
  lineCount: null,
  utf8: null,
  code: null,
  limit: null,
  probedAt: null,
};

Deno.test("no answer yet is null, not an empty description", () => {
  assertEquals(probeFromAnswer(null), null);
  assertEquals(probeFromAnswer(empty), null);
});

Deno.test("a described file keeps exactly the facts it was measured with", () => {
  assertEquals(
    probeFromAnswer({
      ...empty,
      status: "described",
      kind: "text",
      mediaType: "text/plain",
      byteLength: 4096,
      lineCount: 412,
      utf8: true,
      probedAt: "2026-11-20T05:00:00.000Z",
    }),
    {
      status: "described",
      kind: "text",
      mediaType: "text/plain",
      byteLength: 4096,
      lineCount: 412,
      utf8: true,
    },
  );
  // An image measured without a duration must not gain one, and a text file
  // must not gain pixels.
  const image = probeFromAnswer({
    ...empty,
    status: "described",
    kind: "image",
    mediaType: "image/png",
    byteLength: 1024,
    width: 1200,
    height: 800,
  });
  assertEquals(image, {
    status: "described",
    kind: "image",
    mediaType: "image/png",
    byteLength: 1024,
    width: 1200,
    height: 800,
  });
  assertEquals(Object.hasOwn(image as object, "durationMs"), false);
});

Deno.test("a refusal keeps its code and its limit", () => {
  assertEquals(
    probeFromAnswer({
      ...empty,
      status: "refused",
      code: "too-large",
      limit: 25_000_000,
    }),
    { status: "refused", code: "too-large", limit: 25_000_000 },
  );
  // A code that names no limit carries none.
  assertEquals(
    probeFromAnswer({ ...empty, status: "refused", code: "timeout" }),
    { status: "refused", code: "timeout" },
  );
  // A refusal with no code is unreadable nonsense, not a refusal.
  assertEquals(probeFromAnswer({ ...empty, status: "refused" }), null);
});
