import { useState } from "react";
import * as UI from "@bakery/ui";
import { CopyValueButton } from "../../pages/CopyValueButton.tsx";
import { useI18n } from "../../i18n/I18nProvider.tsx";

export type RunnerKeyView = {
  readonly phase: "idle" | "issuing" | "shown" | "failed";
  readonly credential: string | null;
};

export type RunnerKeyDialogProps = {
  readonly runnerKey: RunnerKeyView;
  readonly onDone: () => void;
};

export function RunnerKeyDialog(props: RunnerKeyDialogProps) {
  const { phase } = props.runnerKey;
  if (phase !== "shown" && phase !== "issuing") return null;
  return <KeyDialogBody {...props} />;
}

function KeyDialogBody(props: RunnerKeyDialogProps) {
  const { translate } = useI18n();
  const [copied, setCopied] = useState(false);
  const [tickMissing, setTickMissing] = useState(false);
  const { runnerKey } = props;
  const credential = runnerKey.credential;
  return (
    <UI.Dialog
      data-dialog="runner-key"
      dismissLabel={translate("installation.backups.key.dismiss")}
      onOpenChange={(next) => {
        if (!next && copied) props.onDone();
      }}
      open
      state={runnerKey.phase === "issuing" ? "submitting" : "open"}
      title={translate("installation.backups.key.title")}
      variant="form"
    >
      <UI.Stack gap="standard">
        {credential === null ? <UI.Skeleton shape="row" /> : (
          <>
            <UI.DataText data-value="runner-key" fit variant="code">
              {credential}
            </UI.DataText>
            <CopyValueButton
              label={translate("installation.backups.key.copyLabel")}
              value={credential}
            />
            <UI.Text variant="strong">
              {translate("installation.backups.key.warning")}
            </UI.Text>
            <UI.Checkbox
              checked={copied}
              data-field="key-copied"
              aria-invalid={tickMissing && !copied ? true : undefined}
              onChange={(event) => setCopied(event.target.checked)}
            >
              {translate("installation.backups.key.confirm")}
            </UI.Checkbox>
            {tickMissing && !copied
              ? (
                <UI.Text data-error="key-copied" role="alert" variant="error">
                  {translate("installation.backups.key.tick")}
                </UI.Text>
              )
              : null}
            <UI.Inline gap="compact" variant="actions">
              <UI.Button
                data-action="key-done"
                onClick={() => {
                  if (copied) props.onDone();
                  else setTickMissing(true);
                }}
                type="button"
                variant="primary"
              >
                {translate("installation.backups.key.done")}
              </UI.Button>
            </UI.Inline>
          </>
        )}
      </UI.Stack>
    </UI.Dialog>
  );
}
