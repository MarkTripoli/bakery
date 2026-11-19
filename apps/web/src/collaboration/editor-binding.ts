import {
  EditorState,
  type Extension,
  StateEffect,
  StateField,
  Transaction,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
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

/** Tints one range of the text (a chosen suggestion's), or none with null. */
export const tintRange = StateEffect.define<
  { readonly from: number; readonly to: number } | null
>();

const tintMark = Decoration.mark({ class: "ui-document-editor__suggested" });

/**
 * The range a chosen suggestion points at: tinted, and followed through edits
 * so it keeps covering the same text. Drive it with `tintRange`.
 */
export function suggestionTint(): Extension {
  return StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(tint, transaction) {
      let next = tint.map(transaction.changes);
      for (const effect of transaction.effects) {
        if (!effect.is(tintRange)) continue;
        const range = effect.value;
        const length = transaction.state.doc.length;
        next = range && range.from < range.to && range.to <= length
          ? Decoration.set([tintMark.range(range.from, range.to)])
          : Decoration.none;
      }
      return next;
    },
    provide: (field) => EditorView.decorations.from(field),
  });
}

/** Tints a range and brings it into view; null clears the tint. */
export function showSuggestedRange(
  view: EditorView,
  range: { readonly from: number; readonly to: number } | null,
): void {
  view.dispatch({
    effects: [
      tintRange.of(range),
      ...(range
        ? [EditorView.scrollIntoView(range.from, { y: "center" })]
        : []),
    ],
  });
}
