import { useEffect, useId, useState } from "react";
import * as UI from "@bakery/ui";
import {
  WORKFLOW_START_EVENT_KINDS,
  WORKFLOW_START_MAX,
  type WorkflowStart,
} from "@bakery/contracts/workflow-starts";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import {
  briefInput,
  chosenRepository,
  newStart,
  otherFilters,
  type StartNeed,
  type StartProblem,
  type StartRepository,
  textInput,
  withBriefInput,
  withBudget,
  withRepository,
  withTextInput,
} from "./start-list.ts";

export type StartRepositories = {
  readonly state: "loading" | "failed" | "ready";
  readonly list: readonly StartRepository[];
  readonly onRetry: () => void;
};

export type StartPanelProps = {
  readonly starts: readonly WorkflowStart[];
  readonly needs: readonly StartNeed[];
  readonly problems: readonly StartProblem[];
  readonly repositories: StartRepositories;
  readonly onChange:
    | ((starts: readonly WorkflowStart[]) => void)
    | undefined;
  readonly focus: number | null;
};

function useStartCopy() {
  const { translate } = useI18n();
  return (key: string, values?: Record<string, string | number>) =>
    translate(`library.editor.start.${key}` as never, values as never);
}

type Copy = ReturnType<typeof useStartCopy>;

function eventName(kind: string, copy: Copy): string {
  const known = (WORKFLOW_START_EVENT_KINDS as readonly string[]).includes(
    kind,
  ) || kind === "work_item.ready";
  return known ? copy(`event.${kind}`) : kind;
}

export function StartPanelBody(props: StartPanelProps) {
  const copy = useStartCopy();
  const { translate } = useI18n();
  const { starts, onChange, focus } = props;
  const base = useId();
  useEffect(() => {
    if (focus === null) return;
    globalThis.document.querySelector<HTMLElement>(
      "[data-testid=start-fields] [aria-invalid=true]",
    )?.focus();
  }, [focus]);
  const replace = (next: WorkflowStart) =>
    onChange?.(starts.map((one) => one.id === next.id ? next : one));
  return (
    <UI.Stack gap="standard" data-testid="start-fields">
      <UI.Text>
        {translate("library.editor.startsByHand" as never)}
      </UI.Text>
      {starts.map((start, index) => (
        <UI.Stack gap="compact" key={start.id} data-testid="start-row">
          <UI.Divider />
          <UI.Text variant="strong">
            {copy("heading", { number: index + 1 })}
          </UI.Text>
          {start.on.kind === "schedule"
            ? (
              <>
                <UI.Text>
                  {copy("schedule", {
                    cron: start.on.cron,
                    timezone: start.on.timezone,
                  })}
                </UI.Text>
                <UI.InlineNotice tone="warning">
                  {copy("scheduleNotRun")}
                </UI.InlineNotice>
              </>
            )
            : onChange === undefined
            ? <ReadOnlyEventStart {...props} start={start} />
            : (
              <EventStartFields
                {...props}
                base={`${base}-${start.id}`}
                onChange={replace}
                start={start}
              />
            )}
          {onChange === undefined ? null : (
            <UI.Inline gap="compact">
              <UI.Button
                aria-label={copy("removeNamed", { number: index + 1 })}
                onClick={() =>
                  onChange(starts.filter((one) => one.id !== start.id))}
                variant="text"
              >
                {copy("remove")}
              </UI.Button>
            </UI.Inline>
          )}
        </UI.Stack>
      ))}
      <UI.Text variant="caption">
        {copy(starts.length === 0 ? "none" : "scope")}
      </UI.Text>
      {onChange === undefined ? null : (
        <UI.Button
          disabled={starts.length >= WORKFLOW_START_MAX}
          onClick={() => onChange([...starts, newStart(starts)])}
          variant="secondary"
        >
          {copy("add")}
        </UI.Button>
      )}
    </UI.Stack>
  );
}

function repositoryNeed(
  needs: readonly StartNeed[],
): StartNeed | undefined {
  return needs.find((need) => need.kind === "repository");
}

function ReadOnlyEventStart(
  { start, needs, repositories }: StartPanelProps & {
    readonly start: WorkflowStart;
  },
) {
  const copy = useStartCopy();
  if (start.on.kind !== "event") return null;
  const id = chosenRepository(start, repositoryNeed(needs), repositories.list);
  const chosen = repositories.list.find((one) => one.id === id);
  return (
    <>
      <UI.Text>{eventName(start.on.eventKind, copy)}</UI.Text>
      <UI.Text>
        {chosen === undefined
          ? copy("anyRepository")
          : copy("readRepository", { name: chosen.name })}
      </UI.Text>
      <UI.Text>{copy("readBudget", { amount: start.budgetUsd ?? 0 })}</UI.Text>
    </>
  );
}

function EventStartFields(
  { start, base, needs, problems, repositories, onChange }:
    & Omit<StartPanelProps, "onChange">
    & {
      readonly start: WorkflowStart;
      readonly base: string;
      readonly onChange: (start: WorkflowStart) => void;
    },
) {
  const copy = useStartCopy();
  if (start.on.kind !== "event") return null;
  const on = start.on;
  const kinds: readonly string[] = WORKFLOW_START_EVENT_KINDS;
  const options =
    (kinds.includes(on.eventKind) ? kinds : [on.eventKind, ...kinds]).map((
      kind,
    ) => ({
      value: kind,
      label: eventName(kind, copy),
    }));
  const problem = (need: StartNeed) =>
    problems.find((one) => one.startId === start.id && one.name === need.name);
  return (
    <>
      <UI.Combobox
        id={`${base}-event`}
        label={copy("when")}
        onChange={(event) =>
          onChange({
            ...start,
            on: { ...on, eventKind: event.currentTarget.value },
          })}
        options={options}
        value={on.eventKind}
      />
      {on.eventKind.endsWith("labeled")
        ? <UI.Text variant="caption">{copy("anyLabel")}</UI.Text>
        : null}
      <RepositoryField
        base={base}
        need={repositoryNeed(needs)}
        onChange={onChange}
        problem={problems.find((one) =>
          one.startId === start.id && one.kind === "repository"
        )}
        repositories={repositories}
        start={start}
      />
      {repositories.state !== "ready" ||
          otherFilters(start, repositories.list).length === 0
        ? null
        : (
          <UI.Text variant="caption">
            {copy("filter", {
              filter: otherFilters(start, repositories.list).join(", "),
            })}
          </UI.Text>
        )}
      {needs.filter((need) => need.kind !== "repository").map((need) => (
        <NeedField
          base={base}
          key={need.name}
          need={need}
          onChange={onChange}
          problem={problem(need)}
          start={start}
        />
      ))}
      <CommittedText
        hint={copy("budgetHelp")}
        id={`${base}-budget`}
        inputMode="decimal"
        label={copy("budget")}
        onCommit={(value) => onChange(withBudget(start, value))}
        value={start.budgetUsd === undefined ? "" : String(start.budgetUsd)}
      />
    </>
  );
}

function RepositoryField(
  { base, need, start, problem, repositories, onChange }: {
    readonly base: string;
    readonly need: StartNeed | undefined;
    readonly start: WorkflowStart;
    readonly problem: StartProblem | undefined;
    readonly repositories: StartRepositories;
    readonly onChange: (start: WorkflowStart) => void;
  },
) {
  const copy = useStartCopy();
  const value = chosenRepository(start, need, repositories.list);
  const choosable = need === undefined
    ? repositories.list.filter((one) => one.eventRepositoryId !== null)
    : repositories.list;
  const chosen = repositories.list.find((one) => one.id === value);
  const placeholder = repositories.state === "loading"
    ? "repositoriesLoading"
    : need === undefined
    ? "anyRepository"
    : "chooseRepository";
  return (
    <UI.Stack gap="tight">
      <UI.Combobox
        disabled={repositories.state !== "ready"}
        error={problem === undefined ? undefined : copy("problem.repository")}
        id={`${base}-repository`}
        label={copy("repository")}
        onChange={(event) => {
          const id = event.currentTarget.value;
          onChange(
            withRepository(
              start,
              need,
              repositories.list.find((one) => one.id === id),
            ),
          );
        }}
        options={[
          { value: "", label: copy(placeholder) },
          ...choosable.map((one) => ({ value: one.id, label: one.name })),
        ]}
        value={value}
      />
      {repositories.state === "failed"
        ? (
          <UI.InlineNotice
            action={
              <UI.Button variant="secondary" onClick={repositories.onRetry}>
                {copy("retry")}
              </UI.Button>
            }
            tone="error"
          >
            {copy("repositoriesFailed")}
          </UI.InlineNotice>
        )
        : null}
      {need !== undefined && chosen?.eventRepositoryId === null
        ? <UI.Text variant="caption">{copy("repositoryHelp")}</UI.Text>
        : null}
    </UI.Stack>
  );
}

function NeedField(
  { base, need, start, problem, onChange }: {
    readonly base: string;
    readonly need: StartNeed;
    readonly start: WorkflowStart;
    readonly problem: StartProblem | undefined;
    readonly onChange: (start: WorkflowStart) => void;
  },
) {
  const copy = useStartCopy();
  const id = `${base}-input-${need.name}`;
  const error = problem === undefined
    ? undefined
    : copy(`problem.${problem.kind}`, { name: need.name });
  if (need.kind === "unsupported") {
    return error === undefined
      ? null
      : <UI.InlineNotice tone="error">{error}</UI.InlineNotice>;
  }
  if (need.kind === "brief") {
    const brief = briefInput(start, need.name);
    return (
      <>
        <CommittedText
          error={error}
          id={id}
          label={copy("title.field")}
          maxLength={500}
          onCommit={(title) =>
            onChange(withBriefInput(start, need.name, { ...brief, title }))}
          required
          value={brief.title}
        />
        <CommittedText
          id={`${id}-description`}
          label={copy("description")}
          maxLength={4000}
          multiline
          onCommit={(description) =>
            onChange(
              withBriefInput(start, need.name, { ...brief, description }),
            )}
          value={brief.description}
        />
      </>
    );
  }
  return (
    <CommittedText
      error={error}
      id={id}
      label={need.name}
      maxLength={4000}
      onCommit={(value) => onChange(withTextInput(start, need.name, value))}
      required
      value={textInput(start, need.name)}
    />
  );
}

function CommittedText(
  props: {
    readonly id: string;
    readonly label: string;
    readonly value: string;
    readonly onCommit: (value: string) => void;
    readonly error?: string | undefined;
    readonly hint?: string;
    readonly maxLength?: number;
    readonly inputMode?: "decimal";
    readonly multiline?: boolean;
    readonly required?: boolean;
  },
) {
  const [draft, setDraft] = useState(props.value);
  const [seen, setSeen] = useState(props.value);
  if (seen !== props.value) {
    setSeen(props.value);
    setDraft(props.value);
  }
  const commit = () => {
    if (draft !== props.value) props.onCommit(draft);
  };
  return (
    <UI.Field
      error={draft === props.value ? props.error : undefined}
      hint={props.hint}
      htmlFor={props.id}
      label={props.label}
      required={props.required}
      {...(props.multiline === true ? { variant: "textarea" as const } : {})}
    >
      {props.multiline === true
        ? (
          <textarea
            id={props.id}
            maxLength={props.maxLength}
            onBlur={commit}
            onChange={(event) => setDraft(event.target.value)}
            rows={3}
            value={draft}
          />
        )
        : (
          <UI.TextInput
            autoComplete="off"
            id={props.id}
            inputMode={props.inputMode}
            name={props.id}
            onBlur={commit}
            onChange={setDraft}
            onKeyDown={(event) => {
              if (event.key === "Enter") commit();
            }}
            type="text"
            value={draft}
          />
        )}
    </UI.Field>
  );
}
