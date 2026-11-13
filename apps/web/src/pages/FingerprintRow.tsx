import { useEffect, useState } from "react";
import * as UI from "@bakery/ui";
import { useI18n } from "../i18n/I18nProvider.tsx";

/** How many characters of the fingerprint show before the person copies it. */
const SHOWN = 12;

/**
 * One "Fingerprint" row of a details list, the same row the repository rules
 * page has: the name with a help tip, the first characters of the value and a
 * Copy button. If the clipboard refuses, the whole value is shown to select.
 * The fingerprint is a SHA-256 digest; it identifies one exact version, so it
 * sits behind this row and not in the main view.
 */
export function FingerprintRow(
  { fingerprint, helpText }: Readonly<{
    fingerprint: string;
    /** Replaces the generic help text when the thing identified needs saying. */
    helpText?: string;
  }>,
) {
  const { translate: t } = useI18n();
  const [result, setResult] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (result !== "copied") return;
    const timer = globalThis.setTimeout(() => setResult("idle"), 2500);
    return () => globalThis.clearTimeout(timer);
  }, [result]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(fingerprint);
      setResult("copied");
    } catch {
      setResult("failed");
    }
  };
  return (
    <UI.DescriptionList data-testid="fingerprint-row">
      <UI.DescriptionItem
        action={
          <UI.Inline gap="compact">
            {result === "failed" ? null : (
              <UI.DataText variant="code">
                {fingerprint.slice(0, SHOWN)}
              </UI.DataText>
            )}
            <UI.Button
              onClick={() => void copy()}
              type="button"
              variant="secondary"
            >
              {t(
                result === "copied"
                  ? "tasks.fingerprint.copied"
                  : "tasks.fingerprint.copy",
              )}
            </UI.Button>
          </UI.Inline>
        }
        description={result === "failed"
          ? (
            <UI.Stack gap="tight">
              <UI.Text role="alert" variant="error">
                {t("tasks.fingerprint.copyFailed")}
              </UI.Text>
              <UI.DataText data-testid="fingerprint-full" variant="code">
                {fingerprint}
              </UI.DataText>
            </UI.Stack>
          )
          : undefined}
        title={
          <>
            <UI.VisuallyHidden as="div" role="status">
              {result === "copied" ? t("tasks.fingerprint.copied") : ""}
            </UI.VisuallyHidden>
            {t("tasks.fingerprint.label")}
            <UI.HelpTip
              closeLabel={t("tasks.fingerprint.closeHelp")}
              label={t("tasks.fingerprint.helpLabel")}
            >
              {helpText ?? t("tasks.fingerprint.help")}
            </UI.HelpTip>
          </>
        }
      />
    </UI.DescriptionList>
  );
}
