import { assertEquals } from "@std/assert";
import { LoroDoc } from "loro-crdt";

/**
 * Relays reach a peer in commit order, and every frame carries its
 * serverSequence. If one ever arrived early anyway (#175), a Loro document
 * holds it as pending until the gap fills and ends on the same text.
 */

function edit(doc: LoroDoc, at: number, text: string): Uint8Array {
  const from = doc.version();
  doc.getText("body").insert(at, text);
  doc.commit();
  return doc.export({ mode: "update", from });
}

Deno.test("a peer that imports update N+1 before N converges once N arrives", () => {
  const author = new LoroDoc();
  const first = edit(author, 0, "alpha");
  const second = edit(author, 5, " beta");
  const third = edit(author, 10, " gamma");

  const inOrder = new LoroDoc();
  for (const update of [first, second, third]) inOrder.import(update);

  const swapped = new LoroDoc();
  swapped.import(third);
  swapped.import(second);
  // Nothing past the gap is applied yet.
  assertEquals(swapped.getText("body").toString(), "");
  swapped.import(first);

  assertEquals(swapped.getText("body").toString(), "alpha beta gamma");
  assertEquals(
    swapped.getText("body").toString(),
    inOrder.getText("body").toString(),
  );
});
