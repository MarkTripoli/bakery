import { assertEquals } from "@std/assert";
import { LoroDoc } from "loro-crdt/base64";
import {
  encodeCursorAt,
  firstName,
  positionOf,
  remoteCarets,
} from "../../apps/web/src/collaboration/carets.ts";
import type { Participant } from "../../apps/web/src/collaboration/people.ts";

function world() {
  const doc = new LoroDoc();
  doc.getText("body").insert(0, "Hello brave new world");
  doc.commit();
  return doc;
}
const person = (
  principalId: string,
  displayName: string,
  cursor: Participant["state"]["cursor"],
  receivedAt = "2026-01-01T00:00:00.000Z",
  principalType: Participant["principalType"] = "human",
): Participant => ({
  participantKey: principalId + receivedAt,
  principalId,
  principalType,
  displayName,
  state: { activity: "active", typing: false, cursor },
  receivedAt,
});

Deno.test("a name's first word is the label", () => {
  assertEquals(firstName("Ana Reyes"), "Ana");
  assertEquals(firstName("  Ana   Reyes "), "Ana");
  assertEquals(firstName("Ana"), "Ana");
});

Deno.test("a cursor round-trips and follows edits made before it", () => {
  const doc = world();
  const encoded = encodeCursorAt(doc, 6)!;
  assertEquals(positionOf(doc, encoded), 6);
  doc.getText("body").insert(0, ">> ");
  doc.commit();
  assertEquals(positionOf(doc, encoded), 9);
  assertEquals(positionOf(doc, "not base64 !"), null);
});

Deno.test("others' carets are drawn; this person's own and the cursorless are not", () => {
  const doc = world();
  const at = (a: number, h: number) => ({
    anchor: encodeCursorAt(doc, a)!,
    head: encodeCursorAt(doc, h)!,
  });
  const carets = remoteCarets(doc, [
    person("me", "Mark Tripoli", at(0, 0)),
    person("ana", "Ana Reyes", at(6, 11)),
    person("bo", "Bo Lin", null),
  ], "me");
  assertEquals(carets, [{
    principalId: "ana",
    name: "Ana",
    anchor: 6,
    head: 11,
  }]);
});

Deno.test("a person with several sessions has one caret, the latest", () => {
  const doc = world();
  const at = (p: number) => ({
    anchor: encodeCursorAt(doc, p)!,
    head: encodeCursorAt(doc, p)!,
  });
  const carets = remoteCarets(doc, [
    person("ana", "Ana Reyes", at(2), "2026-01-01T00:00:01.000Z"),
    person("ana", "Ana Reyes", at(8), "2026-01-01T00:00:05.000Z"),
  ], null);
  assertEquals(carets.map((c) => c.head), [8]);
});

Deno.test("a cursor that cannot be read is left out", () => {
  const doc = world();
  const carets = remoteCarets(doc, [
    person("ana", "Ana Reyes", { anchor: "bad", head: "bad" }),
  ], null);
  assertEquals(carets, []);
});

Deno.test("a person is labelled by first name, an agent by its whole name", () => {
  const doc = world();
  const at = (p: number) => ({
    anchor: encodeCursorAt(doc, p)!,
    head: encodeCursorAt(doc, p)!,
  });
  const carets = remoteCarets(doc, [
    person("ana", "Ana Reyes", at(2)),
    person("agent", "Coding agent", at(8), undefined, "service"),
    person("worker", "Build worker", at(12), undefined, "worker"),
  ], null);
  assertEquals(carets.map((c) => c.name), [
    "Ana",
    "Coding agent",
    "Build worker",
  ]);
});
