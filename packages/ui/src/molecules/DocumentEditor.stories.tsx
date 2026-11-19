import { useEffect, useMemo, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { EditorView } from "@codemirror/view";
import { LoroSyncPlugin, LoroUndoPlugin } from "loro-codemirror";
import { LoroDoc, UndoManager } from "loro-crdt";
import { DocumentEditor, Stack, Text } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/DocumentEditor",
  parameters: { catalogId: "ui.documentEditor", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

const getText = (doc: LoroDoc) => doc.getText("body");

/**
 * The editor bound to a Loro document the way the artifact page binds it, with
 * the document's own text printed beside it so a test can see what was shared.
 * packages/ui/tests/document-editor-binding.spec.ts drives it.
 */
function SharedDemo(
  { editAtMount, startText }: { editAtMount?: string; startText: string },
) {
  const [text, setText] = useState(startText);
  const bound = useMemo(() => {
    const doc = new LoroDoc();
    getText(doc).insert(0, startText);
    doc.commit();
    return {
      doc,
      extensions: [
        LoroSyncPlugin(doc, getText),
        ...LoroUndoPlugin(
          doc,
          new UndoManager(doc, { mergeInterval: 0 }),
          getText,
        ),
      ],
    };
  }, [startText]);
  useEffect(() => {
    const read = () => setText(getText(bound.doc).toString());
    const stop = bound.doc.subscribe(read);
    read();
    return () => stop();
  }, [bound]);
  const [view, setView] = useState<EditorView | null>(null);
  useEffect(() => {
    if (!view || !editAtMount) return;
    // An edit that arrives in the first moments after the editor is made, as a
    // restored piece of text does: nothing else has touched the editor yet.
    let live = true;
    void Promise.resolve().then(() => Promise.resolve()).then(() => {
      if (live) {
        view.dispatch({
          changes: { from: view.state.doc.length, insert: editAtMount },
        });
      }
    });
    return () => {
      live = false;
    };
  }, [view, editAtMount]);
  return (
    <Stack gap="standard">
      <DocumentEditor
        aria-label="Shared document text"
        extensions={bound.extensions}
        initialText={startText}
        onViewChange={setView}
      />
      <Text data-testid="shared-text">{text}</Text>
    </Stack>
  );
}

/** Empty with its placeholder, with text, read-only, and bound to a shared document. */
export const Contract: StoryObj = {
  render: () => (
    <Stack gap="standard">
      <div data-testid="editor-empty">
        <DocumentEditor
          aria-label="Empty document"
          placeholder="Start writing. Everyone here sees it as you type."
        />
      </div>
      <div data-testid="editor-text">
        <DocumentEditor
          aria-label="Document with text"
          initialText="# Introduction&#10;&#10;The bakery orders flour every Monday."
        />
      </div>
      <div data-testid="editor-read-only">
        <DocumentEditor
          aria-label="Read-only document"
          initialText="Nobody can type here."
          readOnly
        />
      </div>
      <div data-testid="editor-shared">
        <SharedDemo startText="hello" />
      </div>
      <div data-testid="editor-restored">
        <SharedDemo editAtMount=" restored" startText="hello" />
      </div>
    </Stack>
  ),
};
