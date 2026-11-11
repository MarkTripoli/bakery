import { useState } from "react";
import { Button } from "../atoms/Button.tsx";
import { Checkbox } from "../atoms/Checkbox.tsx";
import { DataText } from "../atoms/DataText.tsx";
import "../controls.css";

const LONG_CODE_THRESHOLD = 20;

export type RecoveryCodesLabels = {
  acknowledge: string;
  copied: string;
  copy: string;
  download: string;
};

export type RecoveryCodesProps = {
  acknowledged: boolean;
  codes: readonly string[];
  fileName: string;
  labels: RecoveryCodesLabels;
  onAcknowledge: (acknowledged: boolean) => void;
};

/** Displays generated recovery codes with copy, download, and acknowledgement. */
export function RecoveryCodes(
  { acknowledged, codes, fileName, labels, onAcknowledge }: RecoveryCodesProps,
) {
  const [copied, setCopied] = useState(false);
  const longCopy = codes.some((code) => code.length > LONG_CODE_THRESHOLD);
  const state = acknowledged
    ? "acknowledged"
    : copied
    ? "copied"
    : longCopy
    ? "long-copy"
    : "default";

  const copyCodes = async () => {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setCopied(true);
    } catch {
      // Clipboard access can be unavailable; the codes remain selectable.
    }
  };

  const downloadCodes = () => {
    const blob = new Blob([`${codes.join("\n")}\n`], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  return (
    <div
      className="ui-recovery-codes"
      data-state={state}
      data-ui-component="recoveryCodes"
      data-variant="default"
    >
      <ol className="ui-recovery-codes__list">
        {codes.map((code) => (
          <li key={code}>
            <DataText variant="identifier">{code}</DataText>
          </li>
        ))}
      </ol>
      <div className="ui-recovery-codes__actions">
        <Button onClick={copyCodes} variant="secondary">
          {labels.copy}
        </Button>
        <Button onClick={downloadCodes} variant="secondary">
          {labels.download}
        </Button>
      </div>
      <div
        aria-live="polite"
        className="ui-recovery-codes__status"
        role="status"
      >
        {copied ? labels.copied : null}
      </div>
      <Checkbox
        checked={acknowledged}
        onChange={(event) => onAcknowledge(event.target.checked)}
      >
        {labels.acknowledge}
      </Checkbox>
    </div>
  );
}
