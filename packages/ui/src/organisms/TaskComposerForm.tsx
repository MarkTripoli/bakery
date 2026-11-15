import type { ClientOutputMap } from "@bakery/contracts/client";
import { type FormEvent, type ReactNode, useId } from "react";
import { Button } from "../atoms/Button.tsx";
import { Checkbox } from "../atoms/Checkbox.tsx";
import { Text } from "../atoms/Text.tsx";
import { TextInput } from "../atoms/TextInput.tsx";
import { Combobox } from "../molecules/Combobox.tsx";
import { Field } from "../molecules/Field.tsx";
import { InlineNotice } from "../molecules/InlineNotice.tsx";
import { PresetOption } from "../molecules/PresetOption.tsx";
import "../controls.css";

/**
 * Why the server says a preset cannot run yet. This is the contract enum of
 * `WorkflowPresetAvailability.reasons`, not a copy of it.
 */
export type TaskComposerSetupReason = NonNullable<
  ClientOutputMap["Page<WorkflowPreset>"]["items"][number]["availability"]
>["reasons"][number];

export type TaskComposerTaskType = "feature" | "bug" | "epic" | "maintenance";

export type TaskComposerPreset = {
  id: string;
  title: ReactNode;
  description?: ReactNode;
  /**
   * The whole choice as one plain line. With a single preset there is nothing
   * to pick, so the form shows this line instead of a radio group.
   */
  line?: ReactNode;
};

export type TaskComposerValues = {
  repositoryId: string;
  presetId: string;
  title: string;
  taskType: TaskComposerTaskType;
  description: string;
  budget: string;
};

export type TaskComposerField = keyof TaskComposerValues;

export type TaskComposerSubmitState =
  | "idle"
  | "submitting"
  | "unknown"
  | "conflict"
  | "forbidden"
  | "error";

export type TaskComposerView =
  | "ready"
  | "loading"
  | "empty"
  | "offline"
  | "reconnecting";

export type TaskComposerLabels = Readonly<{
  heading: ReactNode;
  repository: string;
  repositoryPlaceholder: string;
  preset: ReactNode;
  title: ReactNode;
  taskType: string;
  taskTypes: Readonly<Record<TaskComposerTaskType, string>>;
  description: ReactNode;
  budget: ReactNode;
  budgetHint: ReactNode;
  submit: ReactNode;
  submitting: ReactNode;
  retry: ReactNode;
  discard: ReactNode;
  loading: ReactNode;
  empty: ReactNode;
  offline: ReactNode;
  reconnecting: ReactNode;
  unknown: ReactNode;
  conflict: ReactNode;
  forbidden: ReactNode;
  error: ReactNode;
  setupHeading: ReactNode;
  setupBadge: ReactNode;
  /** Copy for a reason this build does not know; keeps the form explained. */
  setupUnknown: ReactNode;
  setupRequired: Readonly<Record<TaskComposerSetupReason, ReactNode>>;
}>;

/**
 * Optional "Plan first" path: the task is created with a human-approved plan
 * stage and no run, so the preset and budget fields are not needed.
 */
export type TaskComposerPlanFirst = Readonly<{
  label: ReactNode;
  hint: ReactNode;
  /** Submit button copy while the plan-first path is chosen. */
  submit: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
}>;

export type TaskComposerFormProps = {
  labels: TaskComposerLabels;
  planFirst?: TaskComposerPlanFirst;
  repositories: readonly { id: string; label: string }[];
  presets: readonly TaskComposerPreset[];
  /**
   * Availability reasons of the selected preset, in server order. Every one is
   * shown once with its own copy; none are dropped.
   */
  setupReasons?: readonly TaskComposerSetupReason[];
  values: TaskComposerValues;
  onChange: <Name extends TaskComposerField>(
    field: Name,
    value: TaskComposerValues[Name],
  ) => void;
  onSubmit: () => void;
  onRetry: () => void;
  onDiscard: () => void;
  /** Heading level, so a full-page phone composer can own the h1. */
  headingLevel?: 1 | 2 | 3;
  submitState?: TaskComposerSubmitState;
  view?: TaskComposerView;
};

const TASK_TYPES: readonly TaskComposerTaskType[] = [
  "feature",
  "bug",
  "epic",
  "maintenance",
];

/**
 * Controlled new-task form: repository, preset, title, type, description and
 * budget. It owns no request. While a submission is in flight or its outcome
 * is unknown every field is read-only and only Retry or Discard act, so the
 * same intent is replayed rather than a second one created. One persistent
 * status region carries the view and submit notices.
 */
export function TaskComposerForm(
  {
    headingLevel = 2,
    labels,
    onChange,
    onDiscard,
    onRetry,
    onSubmit,
    planFirst,
    presets,
    repositories,
    setupReasons = [],
    submitState = "idle",
    values,
    view = "ready",
  }: TaskComposerFormProps,
) {
  const id = useId();
  const headingId = `${id}-heading`;
  const setupId = `${id}-setup`;
  const noticeId = `${id}-notice`;
  const Heading = `h${headingLevel}` as "h1" | "h2" | "h3";
  const planning = planFirst?.checked === true;
  const setup = setupReasons.length > 0 && !planning;
  const locked = submitState === "submitting" || submitState === "unknown";
  const inert = locked || view !== "ready";
  const state = view !== "ready"
    ? view
    : submitState !== "idle"
    ? submitState
    : setup
    ? `setup-${
      setupReasons[0] in labels.setupRequired ? setupReasons[0] : "unknown"
    }`
    : "idle";
  const canSubmit = view === "ready" && submitState === "idle" && !setup &&
    values.repositoryId !== "" && (planning || values.presetId !== "") &&
    values.title.trim() !== "";
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (canSubmit) onSubmit();
  };
  const notice = view === "loading"
    ? { tone: "neutral", text: labels.loading }
    : view === "empty"
    ? { tone: "information", text: labels.empty }
    : view === "offline"
    ? { tone: "warning", text: labels.offline }
    : view === "reconnecting"
    ? { tone: "warning", text: labels.reconnecting }
    : submitState === "unknown"
    ? { tone: "warning", text: labels.unknown }
    : submitState === "conflict"
    ? { tone: "error", text: labels.conflict }
    : submitState === "forbidden"
    ? { tone: "error", text: labels.forbidden }
    : submitState === "error"
    ? { tone: "error", text: labels.error }
    : null;
  return (
    <form
      aria-busy={view === "loading" || submitState === "submitting" ||
        undefined}
      aria-labelledby={headingId}
      className="ui-task-composer"
      data-reasons={setup ? setupReasons.join(" ") : undefined}
      data-state={state}
      data-ui-component="taskComposerForm"
      data-variant="form"
      noValidate
      onSubmit={submit}
    >
      <Heading id={headingId}>{labels.heading}</Heading>
      <div
        aria-atomic="true"
        aria-live="polite"
        className="ui-task-composer__notice"
        id={noticeId}
        role="status"
      >
        {notice
          ? (
            <InlineNotice
              role="none"
              tone={notice.tone as
                | "neutral"
                | "information"
                | "warning"
                | "error"}
            >
              {notice.text}
            </InlineNotice>
          )
          : null}
      </div>
      {planFirst
        ? (
          <div className="ui-task-composer__plan-first">
            <Checkbox
              aria-describedby={`${id}-plan-first-hint`}
              checked={planFirst.checked}
              disabled={inert}
              name="planFirst"
              onChange={(event) => planFirst.onChange(event.target.checked)}
            >
              {planFirst.label}
            </Checkbox>
            <Text id={`${id}-plan-first-hint`} variant="hint">
              {planFirst.hint}
            </Text>
          </div>
        )
        : null}
      <Combobox
        appearance="field"
        disabled={inert}
        id={`${id}-repository`}
        label={labels.repository}
        onChange={(event) => onChange("repositoryId", event.target.value)}
        options={[
          ...(values.repositoryId === ""
            ? [{
              disabled: true,
              label: labels.repositoryPlaceholder,
              value: "",
            }]
            : []),
          ...repositories.map((repository) => ({
            label: repository.label,
            value: repository.id,
          })),
        ]}
        required
        value={values.repositoryId}
      />
      {planning
        ? null
        : presets.length === 1 && presets[0].line !== undefined
        ? <Text data-ui-region="preset-line">{presets[0].line}</Text>
        : (
          <fieldset className="ui-task-composer__presets" disabled={inert}>
            <legend>{labels.preset}</legend>
            {presets.map((preset) => (
              <PresetOption
                checked={preset.id === values.presetId}
                description={preset.description}
                disabled={inert}
                key={preset.id}
                name={`${id}-preset`}
                onChange={() => onChange("presetId", preset.id)}
                title={preset.title}
                unavailable={setup && preset.id === values.presetId
                  ? labels.setupBadge
                  : undefined}
                value={preset.id}
              />
            ))}
          </fieldset>
        )}
      {setup
        ? (
          <div className="ui-task-composer__setup" id={setupId}>
            <p>{labels.setupHeading}</p>
            <ul>
              {setupReasons.map((reason) => (
                <li data-reason={reason} key={reason}>
                  {labels.setupRequired[reason] ?? labels.setupUnknown}
                </li>
              ))}
            </ul>
          </div>
        )
        : null}
      <Field htmlFor={`${id}-title`} label={labels.title} required>
        <TextInput
          autoComplete="off"
          id={`${id}-title`}
          name="title"
          onChange={(value) => onChange("title", value)}
          readOnly={inert}
          required
          type="text"
          value={values.title}
        />
      </Field>
      <Combobox
        appearance="field"
        disabled={inert}
        id={`${id}-type`}
        label={labels.taskType}
        onChange={(event) =>
          onChange("taskType", event.target.value as TaskComposerTaskType)}
        options={TASK_TYPES.map((type) => ({
          label: labels.taskTypes[type],
          value: type,
        }))}
        value={values.taskType}
      />
      <Field
        htmlFor={`${id}-description`}
        label={labels.description}
        variant="textarea"
      >
        <textarea
          className="ui-text-input"
          id={`${id}-description`}
          onChange={(event) => onChange("description", event.target.value)}
          readOnly={inert}
          rows={6}
          value={values.description}
        />
      </Field>
      {planning ? null : (
        <Field
          hint={labels.budgetHint}
          htmlFor={`${id}-budget`}
          label={labels.budget}
        >
          <TextInput
            autoComplete="off"
            id={`${id}-budget`}
            inputMode="decimal"
            name="budget"
            onChange={(value) => onChange("budget", value)}
            readOnly={inert}
            type="text"
            value={values.budget}
          />
        </Field>
      )}
      <div className="ui-task-composer__actions">
        {submitState === "unknown" || submitState === "conflict" ||
            submitState === "error" || submitState === "forbidden"
          ? (
            <>
              {submitState === "forbidden" && (
                <Button
                  aria-describedby={noticeId}
                  disabled
                  type="submit"
                  variant="primary"
                >
                  {labels.submit}
                </Button>
              )}
              {submitState !== "conflict" && submitState !== "forbidden"
                ? (
                  <Button onClick={onRetry} type="button" variant="primary">
                    {labels.retry}
                  </Button>
                )
                : null}
              <Button onClick={onDiscard} type="button" variant="secondary">
                {labels.discard}
              </Button>
            </>
          )
          : (
            <Button
              aria-describedby={setup ? setupId : undefined}
              disabled={!canSubmit}
              loading={submitState === "submitting"}
              type="submit"
              variant="primary"
            >
              {submitState === "submitting"
                ? labels.submitting
                : planning
                ? planFirst?.submit
                : labels.submit}
            </Button>
          )}
      </div>
    </form>
  );
}
