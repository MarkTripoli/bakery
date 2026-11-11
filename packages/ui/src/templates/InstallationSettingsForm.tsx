import { useEffect, useId, useState } from "react";
import type { ReactNode } from "react";
import { Button } from "../atoms/Button.tsx";
import { Heading } from "../atoms/Heading.tsx";
import { Radio } from "../atoms/Radio.tsx";
import { InlineNotice } from "../molecules/InlineNotice.tsx";
import "./installation-settings.css";

export type InstallationPolicyChoice = {
  readonly value: string;
  readonly label: string;
  readonly description: string;
  readonly disabled?: boolean;
  readonly disabledHint?: string;
};

export type InstallationPolicyGroup = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly value: string;
  readonly choices: readonly InstallationPolicyChoice[];
  readonly onChange: (value: string) => void;
};

export type InstallationSettingsFormProps = {
  readonly title: string;
  readonly description: string;
  readonly groups: readonly InstallationPolicyGroup[];
  readonly state:
    | "default"
    | "loading"
    | "saving"
    | "error"
    | "conflict"
    | "forbidden";
  readonly notice?: ReactNode;
  readonly noticeTitle?: string;
  readonly noticeAction?: ReactNode;
  readonly keepEditingLabel?: string;
  readonly retryLabel?: string;
  readonly changedLabel: string;
  readonly saveLabel: string;
  readonly discardLabel: string;
  readonly dirty: boolean;
  readonly onSave: () => void;
  readonly onDiscard: () => void;
};

export function InstallationSettingsForm({
  title,
  description,
  groups,
  state,
  notice,
  noticeTitle,
  noticeAction,
  keepEditingLabel,
  retryLabel,
  changedLabel,
  saveLabel,
  discardLabel,
  dirty,
  onSave,
  onDiscard,
}: InstallationSettingsFormProps) {
  const instanceId = useId();
  const [editingFailure, setEditingFailure] = useState(false);
  useEffect(() => setEditingFailure(false), [state]);
  const busy = state === "saving" || state === "loading";
  const blocked = busy || state === "forbidden";
  const failure = (state === "error" || state === "conflict") &&
    groups.length > 0;
  const showFailure = failure && !editingFailure;
  return (
    <div
      aria-busy={busy || undefined}
      className="ui-installation-settings"
      data-state={state}
      data-ui-component="installationSettingsForm"
      data-variant="policy"
    >
      <div className="ui-installation-settings__heading">
        <Heading level="page">{title}</Heading>
        {!showFailure ? <p>{description}</p> : null}
      </div>
      {showFailure
        ? (
          <>
            <section
              aria-labelledby={`${instanceId}-failure-title`}
              className="ui-installation-settings__failure"
              data-tone={state === "conflict" ? "warning" : "error"}
              role="alert"
            >
              <h2 id={`${instanceId}-failure-title`}>{noticeTitle}</h2>
              <p>{notice}</p>
              <div className="ui-installation-settings__actions">
                {state === "conflict"
                  ? (
                    <>
                      {noticeAction}
                      <Button
                        onClick={() => setEditingFailure(true)}
                        variant="outline"
                      >
                        {keepEditingLabel ?? discardLabel}
                      </Button>
                    </>
                  )
                  : (
                    <>
                      <Button onClick={onSave}>
                        {retryLabel ?? saveLabel}
                      </Button>
                      <Button onClick={onDiscard} variant="outline">
                        {discardLabel}
                      </Button>
                    </>
                  )}
              </div>
            </section>
            <dl className="ui-installation-settings__summary">
              {groups.map((group) => (
                <div key={group.id}>
                  <dt>{group.title}</dt>
                  <dd
                    data-policy-group={group.id}
                    data-policy-value={group.value}
                  >
                    {group.choices.find((choice) =>
                      choice.value === group.value
                    )
                      ?.label}
                  </dd>
                </div>
              ))}
            </dl>
          </>
        )
        : notice
        ? (
          <InlineNotice
            action={noticeAction}
            tone={state === "conflict"
              ? "warning"
              : state === "error" || state === "forbidden"
              ? "error"
              : "information"}
          >
            {notice}
          </InlineNotice>
        )
        : null}
      {state !== "forbidden" && !showFailure
        ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!blocked && dirty && state !== "conflict") onSave();
            }}
          >
            {groups.map((group) => {
              const descriptionId = `${instanceId}-${group.id}-description`;
              return (
                <fieldset
                  className="ui-installation-settings__group"
                  disabled={blocked}
                  key={group.id}
                >
                  <legend className="ui-installation-settings__legend">
                    {group.title}
                  </legend>
                  <div
                    className="ui-installation-settings__label"
                    aria-hidden="true"
                  >
                    <strong>{group.title}</strong>
                    <span id={descriptionId}>{group.description}</span>
                  </div>
                  <div className="ui-installation-settings__choices">
                    {group.choices.map((choice) => (
                      <Radio
                        aria-describedby={descriptionId}
                        checked={group.value === choice.value}
                        disabled={blocked || choice.disabled}
                        key={choice.value}
                        name={`${instanceId}-${group.id}`}
                        onChange={() => group.onChange(choice.value)}
                        title={choice.disabledHint}
                        value={choice.value}
                      >
                        <span
                          aria-hidden="true"
                          className="ui-installation-settings__radio-glyph"
                        />
                        <span className="ui-installation-settings__choice-copy">
                          <strong>{choice.label}</strong>
                          <span>
                            {choice.disabled
                              ? choice.disabledHint ?? choice.description
                              : choice.description}
                          </span>
                        </span>
                      </Radio>
                    ))}
                  </div>
                </fieldset>
              );
            })}
            <div className="ui-installation-settings__footer">
              <span>{changedLabel}</span>
              <div className="ui-installation-settings__actions">
                <Button
                  disabled={blocked || !dirty}
                  onClick={onDiscard}
                  variant="outline"
                >
                  {discardLabel}
                </Button>
                <Button
                  disabled={blocked || !dirty || state === "conflict"}
                  loading={state === "saving"}
                  type="submit"
                >
                  {saveLabel}
                </Button>
              </div>
            </div>
          </form>
        )
        : null}
    </div>
  );
}
