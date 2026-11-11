import { assertEquals } from "@std/assert";
import {
  cutField,
  STREAM_FIELD_CHARS,
} from "../../apps/server/src/modules/auth/audit/stream.ts";

Deno.test("stream field cut never leaves a lone surrogate", () => {
  // An astral character straddling the cut is dropped whole.
  const straddling = "a".repeat(STREAM_FIELD_CHARS - 1) + "😀" + "tail";
  const cut = cutField(straddling);
  assertEquals(cut, "a".repeat(STREAM_FIELD_CHARS - 1));
  assertEquals(cut.isWellFormed(), true);
  assertEquals(JSON.stringify(cut).includes("\\ud83d"), false);

  // An astral character ending exactly at the cut is kept.
  const fitting = "a".repeat(STREAM_FIELD_CHARS - 2) + "😀" + "tail";
  assertEquals(cutField(fitting), "a".repeat(STREAM_FIELD_CHARS - 2) + "😀");

  // Plain text is cut at exactly STREAM_FIELD_CHARS units.
  assertEquals(cutField("b".repeat(5000)).length, STREAM_FIELD_CHARS);
});
