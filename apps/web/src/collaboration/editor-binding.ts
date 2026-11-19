import { EditorState, type Extension, Transaction } from "@codemirror/state";
import { LoroSyncPlugin, LoroUndoPlugin } from "loro-codemirror";
import type { LoroDoc as LoroDocument } from "loro-crdt";
import { UndoManager } from "loro-crdt/base64";
import type { LoroDoc } from "loro-crdt/base64";
import { DOCUMENT_LIMIT_BYTES } from "./session.ts";

const getText = (doc: LoroDocument) => doc.getText("body");

/**
 * The patched Loro binding for one session document: typed text goes into the
 * shared document as it is typed, the server's text comes back in, and undo
 * and redo move the editor and the document together.
 */
export function loroExtensions(document: LoroDoc): Extension[] {
  // The two builds of loro-crdt share one runtime (the base64 entry); only
  // their type declarations are separate, so the boundary is cast once here.
  const doc = document as unknown as LoroDocument;
  return [
    LoroSyncPlugin(doc, getText),
    ...LoroUndoPlugin(
      doc,
      new UndoManager(doc as never, { mergeInterval: 500 }) as never,
      getText,
    ),
  ];
}

/**
 * Refuses typing or pasting that would take the document past the server's
 * limit; text arriving from the server is never filtered.
 */
export function sizeLimit(limitBytes = DOCUMENT_LIMIT_BYTES): Extension {
  const encoder = new TextEncoder();
  return EditorState.transactionFilter.of((transaction) => {
    if (
      !transaction.docChanged ||
      transaction.annotation(Transaction.userEvent) === undefined ||
      transaction.newDoc.length <= transaction.startState.doc.length ||
      // A UTF-16 unit is at most three UTF-8 bytes: below a third of the limit it cannot reach it.
      transaction.newDoc.length * 3 <= limitBytes
    ) return transaction;
    const bytes = encoder.encode(transaction.newDoc.toString()).length;
    return bytes > limitBytes ? [] : transaction;
  });
}
