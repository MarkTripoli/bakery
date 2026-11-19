import { assertEquals } from "@std/assert";
import { LoroDoc } from "loro-crdt/base64";
import type { DraftSuggestionResponse } from "../../apps/web/src/api/client.ts";
import {
  cardKind,
  inDocumentOrder,
  listedSuggestions,
  newSuggestionCount,
  suggestionChange,
  suggestionRange,
} from "../../apps/web/src/collaboration/suggestions.ts";

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
function world() {
  const doc = new LoroDoc();
  const text = doc.getText("body");
  text.insert(0, "Hello brave new world");
  doc.commit();
  const cursors = (from: number, to: number) => ({
    startCursor: b64(text.getCursor(from, 0)!.encode()),
    endCursor: b64(text.getCursor(to, 0)!.encode()),
  });
  return { doc, text, cursors };
}
const make = (id: string, over: Record<string, unknown> = {}) =>
  ({
    id,
    state: "waiting",
    expectedText: "x",
    replacement: "y",
    createdAt: "2026-01-01T00:00:00.000Z",
    startCursor: "",
    endCursor: "",
    ...over,
  }) as unknown as DraftSuggestionResponse;

Deno.test("a suggestion's range is found through its cursors, and follows edits before it", () => {
  const { doc, text, cursors } = world();
  const mine = cursors(6, 11);
  assertEquals(suggestionRange(doc, mine), { from: 6, to: 11 });
  text.insert(0, ">> ");
  doc.commit();
  assertEquals(suggestionRange(doc, mine), { from: 9, to: 14 });
});

Deno.test("a cursor the document cannot read is not a range", () => {
  const { doc } = world();
  assertEquals(
    suggestionRange(doc, { startCursor: "not base64 !", endCursor: "AAAA" }),
    null,
  );
});

Deno.test("suggestions come in document order, unplaceable ones last", () => {
  const { doc, cursors } = world();
  const a = make("a", cursors(12, 15));
  const b = make("b", cursors(0, 5));
  const c = make("c", { startCursor: "", endCursor: "" });
  assertEquals(inDocumentOrder(doc, [a, c, b]).map((s) => s.id), [
    "b",
    "a",
    "c",
  ]);
});

Deno.test("only waiting, no-longer-fitting and unknown suggestions are listed", () => {
  const states = [
    "waiting",
    "accepted",
    "rejected",
    "no_longer_fits",
    "unknown",
  ];
  const listed = listedSuggestions(
    states.map((state, i) => make(String(i), { state })),
  );
  assertEquals(listed.map((s) => s.state), [
    "waiting",
    "no_longer_fits",
    "unknown",
  ]);
});

Deno.test("a change is a replace, an add or a remove", () => {
  assertEquals(
    suggestionChange({ expectedText: "a", replacement: "b" }),
    "replace",
  );
  assertEquals(suggestionChange({ expectedText: "", replacement: "b" }), "add");
  assertEquals(
    suggestionChange({ expectedText: "a", replacement: "" }),
    "remove",
  );
});

Deno.test("the card look follows the state, and unknown is never shown as applied", () => {
  assertEquals(cardKind({ state: "waiting" }), "default");
  assertEquals(cardKind({ state: "no_longer_fits" }), "outdated");
  assertEquals(cardKind({ state: "unknown" }), "unknown");
});

Deno.test("new suggestions are the ones not seen before", () => {
  assertEquals(
    newSuggestionCount(new Set(["a"]), [{ id: "a" }, { id: "b" }, { id: "c" }]),
    2,
  );
  assertEquals(newSuggestionCount(new Set(), []), 0);
});
