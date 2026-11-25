import { useEffect, useId, useState } from "react";
import * as UI from "@bakery/ui";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import {
  APPROVAL_LABEL_MAX,
  APPROVAL_MAX_PEOPLE,
  APPROVAL_PROMPT_MAX,
  type ApprovalFields,
  type ApprovalPerson,
} from "./approval-step.ts";

export type ApprovalFocus = {
  readonly field: "prompt" | "audience";
  readonly request: number;
};

export type ApprovalPanelProps = {
  readonly stepId: string;
  readonly fields: ApprovalFields;
  readonly onChange: ((fields: ApprovalFields) => void) | undefined;
  readonly people: {
    readonly state: "loading" | "failed" | "ready";
    readonly list: readonly ApprovalPerson[];
    readonly onRetry: () => void;
  };
  readonly promptProblem: string | undefined;
  readonly audienceProblems: readonly string[];
  readonly focus: ApprovalFocus | null;
};

type TextField = "prompt" | "approveLabel" | "rejectLabel";

export function ApprovalPanelBody(props: ApprovalPanelProps) {
  return props.onChange === undefined
    ? <ReadOnlyApproval {...props} />
    : <EditableApproval {...props} onChange={props.onChange} />;
}

function useApprovalCopy() {
  const { translate } = useI18n();
  return (key: string, values?: Record<string, string | number>) =>
    translate(`library.editor.ask.${key}` as never, values as never);
}

function personName(
  people: ApprovalPanelProps["people"],
  id: string,
  copy: ReturnType<typeof useApprovalCopy>,
): string {
  return people.list.find((one) => one.principalId === id)?.displayName ??
    copy("unknownPerson");
}

function ExpiryNote() {
  const copy = useApprovalCopy();
  return (
    <UI.InlineNotice tone="information">
      <UI.Stack gap="tight">
        <UI.Text variant="strong">{copy("expiryTitle")}</UI.Text>
        <UI.Text>{copy("expiryBody")}</UI.Text>
      </UI.Stack>
    </UI.InlineNotice>
  );
}

function ReadOnlyApproval({ fields, people }: ApprovalPanelProps) {
  const copy = useApprovalCopy();
  const asked = fields.audience.length === 0
    ? copy("owner")
    : fields.audience.map((id) => personName(people, id, copy)).join(", ");
  return (
    <UI.Stack gap="compact">
      <UI.Text>{copy("readAsks", { who: asked })}</UI.Text>
      <UI.Text>{copy("readWhat", { prompt: fields.prompt })}</UI.Text>
      <UI.Text>
        {copy(fields.allowRequestChanges ? "readThree" : "readTwo")}
      </UI.Text>
      {fields.approveLabel === "" && fields.rejectLabel === ""
        ? null
        : (
          <UI.Text>
            {copy("readButtons", {
              approve: fields.approveLabel || copy("approvePlaceholder"),
              reject: fields.rejectLabel || copy("rejectPlaceholder"),
            })}
          </UI.Text>
        )}
      <ExpiryNote />
    </UI.Stack>
  );
}

function EditableApproval(
  props: ApprovalPanelProps & {
    readonly onChange: (fields: ApprovalFields) => void;
  },
) {
  const { fields, onChange, people, focus } = props;
  const copy = useApprovalCopy();
  const base = useId();
  const promptId = `${base}-prompt`;
  const audienceId = `${base}-audience`;
  const [draft, setDraft] = useState(fields);
  const [seen, setSeen] = useState(fields);
  if (seen !== fields) {
    setSeen(fields);
    setDraft(fields);
  }
  useEffect(() => {
    if (focus === null) return;
    globalThis.document.getElementById(
      focus.field === "prompt" ? promptId : audienceId,
    )?.focus();
  }, [focus, promptId, audienceId]);
  const commit = (field: TextField) => {
    if (draft[field] !== fields[field]) {
      onChange({ ...fields, [field]: draft[field] });
    }
  };
  const type = (field: TextField, value: string, max: number) =>
    setDraft((held) => ({ ...held, [field]: value.slice(0, max) }));
  const free = people.list.filter((one) =>
    one.active && !fields.audience.includes(one.principalId)
  );
  const label = (field: "approveLabel" | "rejectLabel", name: string) => (
    <UI.Field
      htmlFor={`${base}-${field}`}
      label={copy(`${name}Label`)}
    >
      <UI.TextInput
        autoComplete="off"
        id={`${base}-${field}`}
        name={field}
        onBlur={() => commit(field)}
        onChange={(value) => type(field, value, APPROVAL_LABEL_MAX)}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit(field);
        }}
        placeholder={copy(`${name}Placeholder`)}
        type="text"
        value={draft[field]}
      />
    </UI.Field>
  );
  return (
    <UI.Stack gap="standard" data-testid="approval-fields">
      <UI.Stack gap="tight">
        <UI.Combobox
          disabled={people.state !== "ready" ||
            fields.audience.length >= APPROVAL_MAX_PEOPLE}
          error={props.audienceProblems.length === 0
            ? undefined
            : props.audienceProblems.join(" ")}
          id={audienceId}
          label={copy("who")}
          onChange={(event) => {
            const id = event.currentTarget.value;
            if (id === "") return;
            onChange({ ...fields, audience: [...fields.audience, id] });
          }}
          options={[
            {
              value: "",
              label: copy(
                people.state === "loading"
                  ? "loading"
                  : free.length === 0
                  ? "nobodyLeft"
                  : "add",
              ),
            },
            ...free.map((one) => ({
              value: one.principalId,
              label: one.displayName,
            })),
          ]}
          value=""
        />
        {people.state === "failed"
          ? (
            <UI.InlineNotice
              tone="error"
              action={
                <UI.Button variant="secondary" onClick={people.onRetry}>
                  {copy("retry")}
                </UI.Button>
              }
            >
              {copy("failed")}
            </UI.InlineNotice>
          )
          : null}
        <UI.Inline gap="compact" data-testid="approval-people">
          {fields.audience.length === 0
            ? <UI.Badge tone="neutral">{copy("ownerChip")}</UI.Badge>
            : fields.audience.map((id) => {
              const name = personName(people, id, copy);
              return (
                <UI.Inline gap="compact" key={id} data-controls="person">
                  <UI.Badge tone="neutral" title={name}>{name}</UI.Badge>
                  <UI.Button
                    aria-label={copy("removeNamed", { name })}
                    onClick={() =>
                      onChange({
                        ...fields,
                        audience: fields.audience.filter((one) => one !== id),
                      })}
                    variant="text"
                  >
                    {copy("remove")}
                  </UI.Button>
                </UI.Inline>
              );
            })}
        </UI.Inline>
        <UI.Text variant="caption">{copy("whoHelp")}</UI.Text>
      </UI.Stack>
      <UI.Field
        error={draft.prompt.trim() === "" ? props.promptProblem : undefined}
        hint={copy("promptHelp")}
        htmlFor={promptId}
        label={copy("prompt")}
        required
        variant="textarea"
      >
        <textarea
          id={promptId}
          maxLength={APPROVAL_PROMPT_MAX}
          onBlur={() => commit("prompt")}
          onChange={(event) =>
            type("prompt", event.target.value, APPROVAL_PROMPT_MAX)}
          required
          rows={4}
          value={draft.prompt}
        />
      </UI.Field>
      <UI.Stack gap="tight">
        <UI.Text variant="strong">{copy("theyCan")}</UI.Text>
        <UI.Text>{copy("theyCanLine")}</UI.Text>
        <UI.Checkbox
          checked={fields.allowRequestChanges}
          onChange={(event) =>
            onChange({
              ...fields,
              allowRequestChanges: event.currentTarget.checked,
            })}
        >
          {copy("requestChanges")}
        </UI.Checkbox>
        <UI.Text variant="caption">{copy("requestChangesHelp")}</UI.Text>
      </UI.Stack>
      <UI.Stack gap="tight">
        <UI.Text variant="strong">{copy("buttons")}</UI.Text>
        {label("approveLabel", "approve")}
        {label("rejectLabel", "reject")}
        <UI.Text variant="caption">{copy("buttonsHelp")}</UI.Text>
      </UI.Stack>
      <ExpiryNote />
    </UI.Stack>
  );
}
