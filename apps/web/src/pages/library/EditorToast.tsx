import * as UI from "@bakery/ui";
import { useI18n } from "../../i18n/I18nProvider.tsx";

export type EditorNotice =
  | { readonly kind: "deleted"; readonly name: string }
  | { readonly kind: "refused"; readonly why: "away" | "conflict" }
  | {
    readonly kind: "published";
    readonly revision: number;
    readonly used: boolean;
  }
  | {
    readonly kind: "skill";
    readonly text: string;
    readonly undo?: () => void;
  };

export function EditorToast(
  { notice, onUndoDelete, onUse, onClose }: {
    notice: EditorNotice;
    onUndoDelete: () => void;
    onUse: () => void;
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
    case "published":
      return toast(
        "success",
        translate(
          notice.used
            ? "library.editor.published.used"
            : "library.editor.published.notUsed",
          { version: String(notice.revision) },
        ),
        notice.used
          ? undefined
          : offer(translate("library.workflow.versions.use"), onUse),
      );
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
