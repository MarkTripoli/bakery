import { useEffect, useState } from "react";
import * as UI from "@bakery/ui";
import { useI18n } from "../i18n/I18nProvider.tsx";

/**
 * A "Copy" button for one value on a details list: it puts `value` on the
 * clipboard, says "Copied" for a moment, and, if the browser refuses, says so
 * under the button so the person knows to select the text instead.
 */
export function CopyValueButton(
  { label, value }: Readonly<{
    /** The button's accessible name, such as "Copy address". */
    label: string;
    /** What goes on the clipboard. */
    value: string;
  }>,
) {
  const { translate } = useI18n();
  const [result, setResult] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (result !== "copied") return;
    const timer = globalThis.setTimeout(() => setResult("idle"), 2500);
    return () => globalThis.clearTimeout(timer);
  }, [result]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setResult("copied");
    } catch {
      setResult("failed");
    }
  };
  return (
    <UI.Stack gap="compact">
      <UI.Inline>
        <UI.Button
          aria-label={label}
          type="button"
          variant="outline"
          onClick={() => void copy()}
        >
          {translate(
            result === "copied" ? "settings.copy.copied" : "settings.copy.copy",
          )}
        </UI.Button>
      </UI.Inline>
      {result === "failed"
        ? (
          <UI.Text variant="muted">
            {translate("settings.copy.failed")}
          </UI.Text>
        )
        : null}
      <UI.VisuallyHidden as="div" role="status">
        {result === "copied" ? translate("settings.copy.copied") : null}
      </UI.VisuallyHidden>
    </UI.Stack>
  );
}
