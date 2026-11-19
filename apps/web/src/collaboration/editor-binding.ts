import {
  EditorState,
  type Extension,
  StateEffect,
  StateField,
  Transaction,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
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

/** One other person's caret as the editor draws it. */
export type CaretView = Readonly<{
  name: string;
  /** Which of the six presence colours (1 to 6). */
  colour: number;
  anchor: number;
  head: number;
}>;

/** Sets every other person's caret at once; an empty list clears them. */
export const setRemoteCarets = StateEffect.define<readonly CaretView[]>();

class CaretWidget extends WidgetType {
  constructor(readonly name: string, readonly colour: number) {
    super();
  }
  override eq(other: CaretWidget): boolean {
    return other.name === this.name && other.colour === this.colour;
  }
  override toDOM(): HTMLElement {
    const caret = document.createElement("span");
    caret.className = "ui-document-editor__caret";
    caret.setAttribute("data-presence-color", String(this.colour));
    caret.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.className = "ui-document-editor__caret-label";
    label.textContent = this.name;
    caret.append(label);
    return caret;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

/**
 * Other people's carets: a coloured caret with their first name where they are,
 * and a coloured underline under what they have selected. Drive it with
 * `setRemoteCarets`.
 */
export function remoteCaretLayer(): Extension {
  return [carets(), flipCarets];
}

/**
 * Near the inline end of the editor a name would leave it: the chip sits on the
 * other side of the caret instead. A caret keeps its widget when it moves, so
 * this is measured again on every change of the carets, the text and the
 * editor's geometry, for the page's text direction.
 */
const flipCarets = ViewPlugin.fromClass(
  class {
    constructor(readonly view: EditorView) {
      this.measure();
    }
    update(update: ViewUpdate) {
      if (
        update.geometryChanged || update.viewportChanged || update.docChanged ||
        update.transactions.some((transaction) =>
          transaction.effects.some((effect) => effect.is(setRemoteCarets))
        )
      ) this.measure();
    }
    measure() {
      this.view.requestMeasure({
        key: this,
        read: (view) => {
          const rtl = getComputedStyle(view.contentDOM).direction === "rtl";
          const content = view.contentDOM.getBoundingClientRect();
          return Array.from(
            view.dom.querySelectorAll<HTMLElement>(
              ".ui-document-editor__caret",
            ),
          ).map((caret) => {
            const name = caret.querySelector<HTMLElement>(
              ".ui-document-editor__caret-label",
            );
            const at = caret.getBoundingClientRect();
            const flip = name !== null &&
              (rtl
                ? at.right - name.offsetWidth < content.left
                : at.left + name.offsetWidth > content.right);
            return { caret, flip };
          });
        },
        write: (carets) => {
          for (const { caret, flip } of carets) {
            if (flip) caret.setAttribute("data-flip", "true");
            else caret.removeAttribute("data-flip");
          }
        },
      });
    }
  },
);

function carets(): Extension {
  return StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(carets, transaction) {
      let next = carets.map(transaction.changes);
      for (const effect of transaction.effects) {
        if (!effect.is(setRemoteCarets)) continue;
        const length = transaction.state.doc.length;
        const clamp = (position: number) =>
          Math.max(0, Math.min(position, length));
        next = Decoration.set(
          effect.value.flatMap((caret) => {
            const from = clamp(Math.min(caret.anchor, caret.head));
            const to = clamp(Math.max(caret.anchor, caret.head));
            const head = clamp(caret.head);
            return [
              ...(from < to
                ? [
                  Decoration.mark({
                    class: "ui-document-editor__peer-selection",
                    attributes: { "data-presence-color": String(caret.colour) },
                  }).range(from, to),
                ]
                : []),
              Decoration.widget({
                widget: new CaretWidget(caret.name, caret.colour),
                side: 1,
              }).range(head),
            ];
          }),
          true,
        );
      }
      return next;
    },
    provide: (field) => EditorView.decorations.from(field),
  });
}
