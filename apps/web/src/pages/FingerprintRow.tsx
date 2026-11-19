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
  {
    fingerprint,
    helpText,
    inset,
    label,
    display,
    testId,
    noHelp,
    copyFailedText,
    note,
  }: Readonly<{
    /** The whole value: what Copy puts on the clipboard. */
    fingerprint: string;
    /** Replaces the generic help text when the thing identified needs saying. */
    helpText?: string;
    /** `page` on a page whose main area has no inset of its own. */
    inset?: "page";
    /** The row's name; "Fingerprint" when left out. */
    label?: string;
    /** What shows before Copy; the first characters of the value when left out. */
    display?: string;
    /** The row's test id; "fingerprint-row" when left out. */
    testId?: string;
    /** No help tip: an id needs none. */
    noHelp?: boolean;
    /** What is said when the clipboard refuses; the fingerprint's sentence when left out. */
    copyFailedText?: string;
    /** One muted line under the row's name, for example where the value first applied. */
    note?: string;
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
    <UI.DescriptionList data-testid={testId ?? "fingerprint-row"} inset={inset}>
      <UI.DescriptionItem
        action={
          <UI.Inline gap="compact">
            {result === "failed" ? null : (
              <UI.DataText variant="code">
                {display ?? fingerprint.slice(0, SHOWN)}
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
                {copyFailedText ?? t("tasks.fingerprint.copyFailed")}
              </UI.Text>
              <UI.DataText data-testid="fingerprint-full" variant="code">
                {fingerprint}
              </UI.DataText>
            </UI.Stack>
          )
          : note}
        title={
          <>
            <UI.VisuallyHidden as="div" role="status">
              {result === "copied" ? t("tasks.fingerprint.copied") : ""}
            </UI.VisuallyHidden>
            {label ?? t("tasks.fingerprint.label")}
            {noHelp ? null : (
              <UI.HelpTip
                closeLabel={t("tasks.fingerprint.closeHelp")}
                label={t("tasks.fingerprint.helpLabel")}
              >
                {helpText ?? t("tasks.fingerprint.help")}
              </UI.HelpTip>
            )}
          </>
        }
      />
    </UI.DescriptionList>
  );
}
