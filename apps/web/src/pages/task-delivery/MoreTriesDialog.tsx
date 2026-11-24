import { useId, useState } from "react";
import * as UI from "@bakery/ui";
import type { MessageKey } from "@bakery/i18n";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import type { MoreTriesPhase } from "./use-more-tries.ts";

const DEFAULT_TRIES = 2;

const NOTICE_KEYS: Readonly<
  Partial<Record<MoreTriesPhase, MessageKey>>
> = {
  notStopped: "tasks.delivery.moreTries.notice.notStopped",
  forbidden: "tasks.delivery.moreTries.notice.forbidden",
  error: "tasks.delivery.moreTries.notice.error",
  noAnswer: "tasks.delivery.moreTries.notice.noAnswer",
};

const wholeNumber = (text: string, max: number): number | null => {
  if (!/^\d+$/.test(text.trim())) return null;
  const value = Number(text.trim());
  return value >= 1 && value <= max ? value : null;
};

export function MoreTriesDialog(
  { count, max, offline, onClose, onGive, open, phase }: Readonly<{
    count: number;
    max: number;
    offline: boolean;
    open: boolean;
    phase: MoreTriesPhase;
    onClose: () => void;
    onGive: (tries: number) => Promise<MoreTriesPhase>;
  }>,
) {
  const { translate: t } = useI18n();
  const fieldId = useId();
  const [text, setText] = useState(String(Math.min(DEFAULT_TRIES, max)));
  const [missing, setMissing] = useState(false);
  const working = phase === "working";
  const notice = NOTICE_KEYS[phase];
  const give = async () => {
    const tries = wholeNumber(text, max);
    if (tries === null) {
      setMissing(true);
      return;
    }
    const outcome = await onGive(tries);
    if (outcome === "idle") onClose();
  };
  return (
    <UI.Dialog
      dismissLabel={t("core.actions.close")}
      onOpenChange={(next) => !next && !working && onClose()}
      open={open}
      state={working
        ? "submitting"
        : notice === undefined && phase !== "tooMany"
        ? "open"
        : "error"}
      title={t("tasks.delivery.moreTries.title")}
      variant="form"
    >
      <UI.Stack>
        <UI.Text>{t("tasks.delivery.moreTries.body", { count })}</UI.Text>
        <UI.Field
          error={missing
            ? t("tasks.delivery.moreTries.invalid", { max })
            : phase === "tooMany"
            ? t("tasks.delivery.moreTries.tooMany", { max })
            : undefined}
          hint={t("tasks.delivery.moreTries.hint", { max })}
          htmlFor={fieldId}
          label={t("tasks.delivery.moreTries.label")}
          state={missing || phase === "tooMany" ? "invalid" : "default"}
          width="short"
        >
          <UI.TextInput
            autoComplete="off"
            id={fieldId}
            inputMode="numeric"
            invalid={missing}
            max={max}
            min={1}
            name="tries"
            onChange={(value) => {
              setText(value);
              setMissing(false);
            }}
            readOnly={working}
            step={1}
            type="number"
            value={text}
          />
        </UI.Field>
        {notice === undefined ? null : (
          <UI.InlineNotice
            data-testid="delivery-more-tries-notice"
            role="alert"
            tone="error"
          >
            {t(notice)}
          </UI.InlineNotice>
        )}
        <UI.Inline>
          <UI.Button
            disabled={working}
            onClick={onClose}
            variant="secondary"
          >
            {phase === "notStopped"
              ? t("tasks.delivery.moreTries.close")
              : t("core.actions.cancel")}
          </UI.Button>
          {phase === "notStopped" ? null : (
            <UI.Button
              disabled={offline || working}
              loading={working}
              onClick={() => void give()}
              variant="primary"
            >
              {t("tasks.delivery.moreTries.confirm")}
            </UI.Button>
          )}
        </UI.Inline>
      </UI.Stack>
    </UI.Dialog>
  );
}
