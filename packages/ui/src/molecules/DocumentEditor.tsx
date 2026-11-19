import { useEffect, useRef } from "react";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  placeholder as placeholderExtension,
} from "@codemirror/view";
import "../collaboration.css";

export type DocumentEditorProps = {
  /** The editor's accessible name ("Document text"), already translated. */
  "aria-label": string;
  /** The text the editor starts with. Read once; remount (change `key`) to start over. */
  initialText?: string;
  /** Refuse typing and keep the text selectable. */
  readOnly?: boolean;
  /** Shown while the document is empty, already translated. */
  placeholder?: string;
  /**
   * Extra CodeMirror extensions, such as the shared-document binding. Read once
   * at mount; remount (change `key`) to change them.
   */
  extensions?: readonly Extension[];
  /** Gives the page the view once it exists, and null when it is gone. */
  onViewChange?: (view: EditorView | null) => void;
  "data-testid"?: string;
};

/**
 * A plain-text editor for long documents, on CodeMirror. It owns the editing
 * surface only: what is shared, saved or refused is the page's business, passed
 * in as extensions. One multi-line text field with the standard editing keys.
 */
export function DocumentEditor(
  {
    "aria-label": ariaLabel,
    extensions,
    initialText = "",
    onViewChange,
    placeholder,
    readOnly = false,
    "data-testid": testId,
  }: DocumentEditorProps,
) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const access = useRef(new Compartment());
  // Read once at mount; the latest values are kept for that moment only.
  const mount = useRef({ extensions, initialText, onViewChange, placeholder });
  mount.current = { extensions, initialText, onViewChange, placeholder };
  const initialReadOnly = useRef(readOnly);

  useEffect(() => {
    const { extensions, initialText, onViewChange, placeholder } =
      mount.current;
    const created = new EditorView({
      parent: host.current ?? undefined,
      state: EditorState.create({
        doc: initialText,
        extensions: [
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({
            "aria-label": ariaLabel,
            "aria-multiline": "true",
          }),
          access.current.of(accessExtension(initialReadOnly.current)),
          placeholder ? placeholderExtension(placeholder) : [],
          ...(extensions ?? []),
        ],
      }),
    });
    view.current = created;
    onViewChange?.(created);
    return () => {
      onViewChange?.(null);
      created.destroy();
      view.current = null;
    };
    // The label is applied once with the view; a new label arrives with a remount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    view.current?.dispatch({
      effects: access.current.reconfigure(accessExtension(readOnly)),
    });
  }, [readOnly]);

  return (
    <div
      className="ui-document-editor"
      data-testid={testId}
      data-ui-component="documentEditor"
      data-variant="default"
      data-state={readOnly ? "readOnly" : "editable"}
      ref={host}
    />
  );
}

function accessExtension(readOnly: boolean): Extension {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];
}
