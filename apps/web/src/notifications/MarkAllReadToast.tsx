import * as UI from "@bakery/ui";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { type MarkAllReadSurface, useMarkAllRead } from "./useMarkAllRead.ts";

export function MarkAllReadToast(
  { surface }: { readonly surface: MarkAllReadSurface },
) {
  const { translate } = useI18n();
  const { dismissToast, toast, undo } = useMarkAllRead(surface);
  if (toast === null) return null;
  return (
    <UI.Toast
      action={toast.undoBatchId === null
        ? undefined
        : (
          <UI.Button onClick={() => void undo()} variant="quiet">
            {translate("notifications.undo")}
          </UI.Button>
        )}
      onDismiss={dismissToast}
      tone={toast.tone}
    >
      {toast.message}
    </UI.Toast>
  );
}
