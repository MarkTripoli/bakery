import { useEffect, useRef, useState } from "react";
import * as UI from "@bakery/ui";
import { useI18n } from "../../i18n/I18nProvider.tsx";

export type PublishedNotice = {
  readonly kind: "published";
  readonly versionId: string;
  readonly revision: number;
  readonly used: boolean;
  readonly refused?: boolean;
};

export type EditorNotice =
  | { readonly kind: "deleted"; readonly name: string }
  | { readonly kind: "refused"; readonly why: "away" | "conflict" }
  | PublishedNotice
  | {
    readonly kind: "skill";
    readonly text: string;
    readonly undo?: () => void;
  };

const offersUndo = (notice: EditorNotice): boolean =>
  notice.kind === "deleted" ||
  (notice.kind === "skill" && notice.undo !== undefined);

export function useEditorNotice(edit: unknown) {
  const [notice, setNotice] = useState<EditorNotice | null>(null);
  const offered = useRef<{ notice: EditorNotice; edit: unknown } | null>(null);
  useEffect(() => {
    if (notice === null || !offersUndo(notice)) return;
    if (offered.current?.notice !== notice) {
      offered.current = { notice, edit };
    } else if (offered.current.edit !== edit) {
      setNotice(null);
    }
  }, [notice, edit]);
  return [notice, setNotice] as const;
}

export function EditorToast(
  { notice, onUndoDelete, onUse, onClose }: {
    notice: EditorNotice;
    onUndoDelete: () => void;
    onUse: (version: PublishedNotice) => void;
    onClose: () => void;
  },
) {
  const { translate } = useI18n();
  const offer = (label: string, run: () => void) => (
    <UI.Button
      variant="secondary"
      onClick={() => {
        onClose();
        run();
      }}
    >
      {label}
    </UI.Button>
  );
  const toast = (
    tone: "success" | "warning",
    message: string,
    action?: React.ReactNode,
  ) => (
    <UI.Toast
      placement="floating"
      tone={tone}
      onDismiss={onClose}
      {...(action === undefined ? {} : { action })}
    >
      {message}
    </UI.Toast>
  );
  switch (notice.kind) {
    case "deleted":
      return toast(
        "success",
        translate("library.editor.deleted" as never, { name: notice.name }),
        offer(translate("library.editor.undo" as never), onUndoDelete),
      );
    case "refused":
      return toast(
        "warning",
        translate(
          notice.why === "away"
            ? "library.editor.publishAway"
            : "library.editor.publishConflict",
        ),
      );
    case "published": {
      const version = { version: String(notice.revision) };
      if (notice.used) {
        return toast(
          "success",
          translate("library.editor.published.used", version),
        );
      }
      return toast(
        notice.refused ? "warning" : "success",
        translate(
          notice.refused
            ? "library.editor.publish.notUsed"
            : "library.editor.published.notUsed",
          version,
        ),
        offer(
          translate(
            notice.refused
              ? "library.editor.save.tryAgain"
              : "library.workflow.versions.use",
          ),
          () => onUse(notice),
        ),
      );
    }
    case "skill":
      return toast(
        "success",
        notice.text,
        notice.undo === undefined ? undefined : offer(
          translate("library.workflow.editor.skills.toast.undo" as never),
          notice.undo,
        ),
      );
  }
}
