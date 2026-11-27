import { useEffect, useId, useState } from "react";
import * as UI from "@bakery/ui";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import {
  afterName,
  type ListStates,
  type NotifyChoice,
  unknownWho,
  whoName,
} from "./notify-copy.ts";
import {
  AFTER_HOURS,
  DEFAULT_AFTER_HOURS,
  NOTE_MAX,
  type NotifyFields,
  type NotifyNeed,
  type NotifyNext,
} from "./notify-step.ts";

export type NotifyPanelProps = Readonly<{
  stepId: string;
  fields: NotifyFields;
  onChange: ((fields: NotifyFields, typing?: string) => void) | undefined;
  choices: readonly NotifyChoice[];
  lists: ListStates;
  onRetry: () => void;
  remembered: NotifyNext | null;
  onRemember: (next: NotifyNext) => void;
  whoWarning: string | undefined;
  nextWarning: string | undefined;
  documents: readonly NotifyChoice[];
  fromProblem: string | undefined;
  nextProblem: string | undefined;
  focus: Readonly<{ field: "from" | "next"; request: number }> | null;
}>;

export function NotifyPanelBody(props: NotifyPanelProps) {
  return props.onChange === undefined
    ? <ReadOnlyNotify {...props} />
    : <EditableNotify {...props} onChange={props.onChange} />;
}

function EndNote({ escalates }: { readonly escalates: boolean }) {
  const { translate } = useI18n();
  return (
    <UI.InlineNotice tone="information">
      <UI.Stack gap="tight">
        <UI.Text variant="strong">
          {translate(
            escalates
              ? "library.editor.notify.expiry.stillTitle"
              : "library.editor.notify.expiry.title",
          )}
        </UI.Text>
        <UI.Text>{translate("library.editor.notify.expiry.body")}</UI.Text>
      </UI.Stack>
    </UI.InlineNotice>
  );
}

function ReadOnlyNotify(
  { fields, choices, lists, documents }: NotifyPanelProps,
) {
  const { translate } = useI18n();
  return (
    <UI.Stack gap="compact">
      <UI.Text>
        {translate("library.editor.notify.read.who", {
          who: whoName(fields.who, choices, lists, translate),
        })}
      </UI.Text>
      <UI.Text>
        {translate(`library.editor.notify.need.${fields.need}`)}
      </UI.Text>
      {fields.need === "review"
        ? (
          <UI.Text>
            {translate("library.editor.notify.read.from", {
              step: documents.find((one) => one.value === fields.from)?.label ??
                fields.from,
            })}
          </UI.Text>
        )
        : null}
      {fields.note === "" ? null : (
        <UI.Text>
          {translate("library.editor.notify.read.note", {
            note: fields.note,
          })}
        </UI.Text>
      )}
      <UI.Text>
        {translate(
          fields.wait
            ? "library.editor.notify.wait.on"
            : "library.editor.notify.wait.off",
        )}
      </UI.Text>
      {fields.next === null ? null : (
        <UI.Text>
          {translate("library.editor.notify.read.next", {
            time: afterName(fields.next.after, translate),
            who: whoName(fields.next.who, choices, lists, translate),
          })}
        </UI.Text>
      )}
      {fields.wait ? <EndNote escalates={fields.next !== null} /> : null}
    </UI.Stack>
  );
}

function EditableNotify(
  props: NotifyPanelProps & {
    readonly onChange: (fields: NotifyFields, typing?: string) => void;
  },
) {
  const { fields, onChange, choices, focus } = props;
  const { translate } = useI18n();
  const base = useId();
  const fromId = `${base}-from`;
  const nextId = `${base}-next`;
  const [note, setNote] = useState(fields.note);
  const [seenNote, setSeenNote] = useState(fields.note);
  if (seenNote !== fields.note) {
    setSeenNote(fields.note);
    setNote(fields.note);
  }
  useEffect(() => {
    if (focus === null) return;
    globalThis.document.getElementById(focus.field === "from" ? fromId : nextId)
      ?.focus();
  }, [focus, fromId, nextId]);
  const options = (value: string) =>
    [
      ...choices.filter((choice) => !choice.gone || choice.value === value),
      ...(value === "" || choices.some((choice) => choice.value === value)
        ? []
        : [{
          value,
          label: unknownWho(value, props.lists, translate, "alone"),
        }]),
    ].map((choice) => ({ value: choice.value, label: choice.label }));
  const { onRemember } = props;
  const next = fields.next;
  useEffect(() => {
    if (next !== null) onRemember(next);
  }, [next, onRemember]);
  const setNext = (changed: NotifyNext) =>
    onChange({ ...fields, next: changed });
  const loading = props.lists.people === "loading" ||
    props.lists.groups === "loading";
  const failed = props.lists.people === "failed" ||
    props.lists.groups === "failed";
  return (
    <UI.Stack gap="standard" data-testid="notify-fields">
      <UI.Stack gap="tight">
        <UI.Combobox
          disabled={loading}
          label={translate("library.editor.notify.who.label")}
          onChange={(event) =>
            onChange({ ...fields, who: event.currentTarget.value })}
          options={options(fields.who)}
          value={fields.who}
        />
        <UI.Text variant="caption">
          {translate("library.editor.notify.who.help")}
        </UI.Text>
        {props.whoWarning === undefined
          ? null
          : <UI.InlineNotice tone="warning">{props.whoWarning}
          </UI.InlineNotice>}
        {failed
          ? (
            <UI.InlineNotice
              tone="error"
              action={
                <UI.Button variant="secondary" onClick={props.onRetry}>
                  {translate("library.editor.ask.retry")}
                </UI.Button>
              }
            >
              {translate("library.editor.notify.who.failed")}
            </UI.InlineNotice>
          )
          : null}
      </UI.Stack>
      <UI.Combobox
        label={translate("library.editor.notify.need.label")}
        onChange={(event) => {
          const need = event.currentTarget.value as NotifyNeed;
          onChange({
            ...fields,
            need,
            wait: need === "review" && fields.wait,
            next: need === "review" ? fields.next : null,
          });
        }}
        options={[
          {
            value: "fyi",
            label: translate("library.editor.notify.need.fyi"),
          },
          {
            value: "review",
            label: translate("library.editor.notify.need.review"),
          },
        ]}
        value={fields.need}
      />
      {fields.need === "review"
        ? (
          <UI.Stack gap="tight">
            <UI.Combobox
              error={props.fromProblem}
              id={fromId}
              label={translate("library.editor.notify.from.label")}
              onChange={(event) =>
                onChange({ ...fields, from: event.currentTarget.value })}
              options={[
                {
                  value: "",
                  label: translate(
                    props.documents.length === 0
                      ? "library.editor.notify.from.none"
                      : "library.editor.notify.from.choose",
                  ),
                },
                ...props.documents,
              ]}
              value={props.documents.some((one) => one.value === fields.from)
                ? fields.from
                : ""}
            />
            <UI.Text variant="caption">
              {translate("library.editor.notify.from.help")}
            </UI.Text>
          </UI.Stack>
        )
        : null}
      <UI.Field
        hint={translate("library.editor.notify.note.help")}
        htmlFor={`${base}-note`}
        label={translate("library.editor.notify.note.label")}
      >
        <UI.TextInput
          autoComplete="off"
          id={`${base}-note`}
          name="note"
          onChange={(value) => {
            const typed = value.slice(0, NOTE_MAX);
            setNote(typed);
            onChange({ ...fields, note: typed }, "note");
          }}
          type="text"
          value={note}
        />
      </UI.Field>
      <UI.Stack gap="tight">
        <UI.Switch
          checked={fields.wait}
          disabled={fields.need !== "review"}
          onChange={(event) => {
            const wait = event.currentTarget.checked;
            onChange({ ...fields, wait, next: wait ? fields.next : null });
          }}
        >
          {translate("library.editor.notify.wait.label")}
        </UI.Switch>
        <UI.Text variant="caption">
          {translate(
            fields.need !== "review"
              ? "library.editor.notify.wait.unavailable"
              : fields.wait
              ? "library.editor.notify.wait.on"
              : "library.editor.notify.wait.off",
          )}
        </UI.Text>
      </UI.Stack>
      {fields.wait
        ? (
          <UI.Stack gap="tight">
            <UI.Switch
              checked={next !== null}
              onChange={(event) =>
                onChange({
                  ...fields,
                  next: event.currentTarget.checked
                    ? props.remembered ??
                      { after: DEFAULT_AFTER_HOURS, who: "" }
                    : null,
                })}
            >
              {translate("library.editor.notify.next.label")}
            </UI.Switch>
            <UI.Text variant="caption">
              {translate("library.editor.notify.next.help")}
            </UI.Text>
            {next === null ? null : (
              <UI.Stack gap="compact">
                <UI.Combobox
                  label={translate("library.editor.notify.next.after")}
                  onChange={(event) =>
                    setNext({
                      ...next,
                      after: Number(event.currentTarget.value),
                    })}
                  options={(AFTER_HOURS.includes(next.after)
                    ? AFTER_HOURS
                    : [...AFTER_HOURS, next.after]).map((hours) => ({
                      value: String(hours),
                      label: afterName(hours, translate),
                    }))}
                  value={String(next.after)}
                />
                <UI.Combobox
                  error={props.nextProblem}
                  id={nextId}
                  label={translate("library.editor.notify.next.who")}
                  onChange={(event) =>
                    setNext({ ...next, who: event.currentTarget.value })}
                  options={[
                    {
                      value: "",
                      label: translate("library.editor.notify.next.choose"),
                    },
                    ...options(next.who),
                  ]}
                  value={next.who}
                />
                {props.nextWarning === undefined
                  ? null
                  : (
                    <UI.InlineNotice tone="warning">
                      {props.nextWarning}
                    </UI.InlineNotice>
                  )}
              </UI.Stack>
            )}
            <EndNote escalates={next !== null} />
          </UI.Stack>
        )
        : null}
    </UI.Stack>
  );
}
