import { useEffect, useId, useRef, useState } from "react";
import * as UI from "@bakery/ui";
import {
  WORKFLOW_START_EVENT_KINDS,
  WORKFLOW_START_MAX,
  WORKFLOW_START_MAX_BUDGET_USD,
  type WorkflowStart,
} from "@bakery/contracts/workflow-starts";
import type { MessageKey } from "@bakery/i18n";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import {
  briefInput,
  budgetText,
  chosenRepository,
  type DraftStart,
  newStart,
  otherFilters,
  SCHEDULE_REPOSITORY,
  shownBudget,
  type StartNeed,
  type StartProblem,
  type StartRepository,
  textInput,
  toEvent,
  toSchedule,
  withBriefInput,
  withBudget,
  withRepository,
  withTextInput,
} from "./start-list.ts";
import {
  cronOf,
  NEW_SCHEDULE,
  nextRunDays,
  SCHEDULE_REPEATS,
  SCHEDULE_TIMES,
  simpleSchedule,
  timeZones,
} from "./start-schedule.ts";

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
    | ((starts: readonly WorkflowStart[], typing?: string) => void)
    | undefined;
  readonly focus: StartFocus | null;
};

export type StartFocus = Pick<StartProblem, "startId" | "kind" | "name"> & {
  readonly request: number;
};

function problemField(base: string, focus: StartFocus): string {
  const field = focus.kind === "repository" || focus.kind === "budget"
    ? focus.kind
    : `input-${focus.name}`;
  return `${base}-${focus.startId}-${field}`;
}

type StartKey = MessageKey extends infer Key
  ? Key extends `library.editor.start.${infer Suffix}` ? Suffix : never
  : never;

function useStartCopy() {
  const { translate } = useI18n();
  return (key: StartKey, values?: Record<string, string | number>) =>
    translate(`library.editor.start.${key}`, values);
}

type Copy = ReturnType<typeof useStartCopy>;

type EventKind =
  | (typeof WORKFLOW_START_EVENT_KINDS)[number]
  | "work_item.ready";

function isEventKind(kind: string): kind is EventKind {
  return (WORKFLOW_START_EVENT_KINDS as readonly string[]).includes(kind) ||
    kind === "work_item.ready";
}

function eventName(kind: string, copy: Copy): string {
  return isEventKind(kind) ? copy(`event.${kind}`) : kind;
}

export function StartPanelBody(props: StartPanelProps) {
  const copy = useStartCopy();
  const { translate } = useI18n();
  const { starts, onChange, focus } = props;
  const base = useId();
  useEffect(() => {
    if (focus === null || props.repositories.state === "loading") return;
    globalThis.document.getElementById(problemField(base, focus))?.focus();
  }, [focus, base, props.repositories.state]);
  const replace = (next: WorkflowStart, typing?: string) =>
    onChange?.(
      starts.map((one) => one.id === next.id ? next : one),
      typing === undefined ? undefined : `${next.id}/${typing}`,
    );
  return (
    <UI.Stack gap="standard" data-testid="start-fields">
      <UI.Text>
        {translate("library.editor.startsByHand")}
      </UI.Text>
      {starts.map((start, index) => (
        <UI.Stack gap="compact" key={start.id} data-testid="start-row">
          <UI.Divider />
          <UI.Text variant="strong">
            {copy("heading", { number: index + 1 })}
          </UI.Text>
          {onChange === undefined
            ? <ReadOnlyStart {...props} start={start} />
            : (
              <StartFields
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

function ReadOnlyStart(
  { start, needs, repositories }: StartPanelProps & {
    readonly start: WorkflowStart;
  },
) {
  const copy = useStartCopy();
  const need = start.on.kind === "schedule"
    ? SCHEDULE_REPOSITORY
    : repositoryNeed(needs);
  const id = chosenRepository(start, need, repositories.list);
  const chosen = repositories.list.find((one) => one.id === id);
  const simple = start.on.kind === "schedule"
    ? simpleSchedule(start.on.cron)
    : null;
  return (
    <>
      <UI.Text>
        {start.on.kind === "event"
          ? eventName(start.on.eventKind, copy)
          : simple === null
          ? copy("schedule", {
            cron: start.on.cron,
            timezone: start.on.timezone,
          })
          : copy("scheduleSummary", {
            repeat: copy(`repeat.${simple.repeat}`),
            time: simple.time,
            timezone: start.on.timezone,
          })}
      </UI.Text>
      <UI.Text>
        {chosen === undefined
          ? copy("anyRepository")
          : copy("readRepository", { name: chosen.name })}
      </UI.Text>
      <UI.Text>{copy("readBudget", { amount: start.budgetUsd ?? 0 })}</UI.Text>
    </>
  );
}

const SCHEDULE_CHOICE = "@schedule";
const CUSTOM_REPEAT = "custom";

function ScheduleFields(
  { start, base, on, onChange }: {
    readonly start: WorkflowStart;
    readonly base: string;
    readonly on: Extract<WorkflowStart["on"], { kind: "schedule" }>;
    readonly onChange: (start: WorkflowStart) => void;
  },
) {
  const copy = useStartCopy();
  const { locale } = useI18n();
  const simple = simpleSchedule(on.cron);
  const set = (next: { cron?: string; timezone?: string }) =>
    onChange({ ...start, on: { ...on, ...next } });
  const day = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
  const times = simple === null || SCHEDULE_TIMES.includes(simple.time)
    ? SCHEDULE_TIMES
    : [...SCHEDULE_TIMES, simple.time].sort();
  return (
    <>
      <UI.Combobox
        id={`${base}-repeat`}
        label={copy("repeats")}
        onChange={(event) => {
          const repeat = SCHEDULE_REPEATS.find((one) =>
            one === event.currentTarget.value
          );
          if (repeat === undefined) return;
          set({
            cron: cronOf({
              repeat,
              time: simple?.time ?? NEW_SCHEDULE.time,
            }),
          });
        }}
        options={[
          ...SCHEDULE_REPEATS.map((repeat) => ({
            value: repeat,
            label: copy(`repeat.${repeat}`),
          })),
          ...(simple === null
            ? [{
              value: CUSTOM_REPEAT,
              label: copy("repeat.custom", { cron: on.cron }),
            }]
            : []),
        ]}
        value={simple?.repeat ?? CUSTOM_REPEAT}
      />
      {simple === null ? null : (
        <UI.Combobox
          id={`${base}-time`}
          label={copy("time")}
          onChange={(event) =>
            set({
              cron: cronOf({ ...simple, time: event.currentTarget.value }),
            })}
          options={times.map((time) => ({ value: time, label: time }))}
          value={simple.time}
        />
      )}
      <UI.Combobox
        id={`${base}-timezone`}
        label={copy("timezone")}
        onChange={(event) => set({ timezone: event.currentTarget.value })}
        options={timeZones(on.timezone).map((zone) => ({
          value: zone,
          label: zone,
        }))}
        value={on.timezone}
      />
      {simple === null ? null : (
        <UI.Stack gap="none" data-testid="start-next">
          <UI.Text variant="caption">{copy("next")}</UI.Text>
          {nextRunDays(simple, on.timezone, new Date()).map((next) => (
            <UI.Text key={next.toISOString()} variant="caption">
              {`${day.format(next)} ${simple.time}`}
            </UI.Text>
          ))}
        </UI.Stack>
      )}
      <UI.Text variant="caption">{copy("clockChange")}</UI.Text>
    </>
  );
}

function StartFields(
  { start, base, needs, problems, repositories, onChange }:
    & Omit<StartPanelProps, "onChange">
    & {
      readonly start: DraftStart;
      readonly base: string;
      readonly onChange: (start: WorkflowStart, typing?: string) => void;
    },
) {
  const copy = useStartCopy();
  const settledBudget = useRef(start.budgetUsd);
  const on = start.on;
  const kinds: readonly string[] = WORKFLOW_START_EVENT_KINDS;
  const eventKinds = on.kind !== "event" || kinds.includes(on.eventKind)
    ? kinds
    : [on.eventKind, ...kinds];
  const schedulable = repositories.state === "ready" &&
    repositories.list.length > 0;
  const options = [
    ...eventKinds.map((kind) => ({
      value: kind,
      label: eventName(kind, copy),
    })),
    ...(schedulable || on.kind === "schedule"
      ? [{ value: SCHEDULE_CHOICE, label: copy("onSchedule") }]
      : []),
  ];
  const choose = (value: string) => {
    if (value === SCHEDULE_CHOICE) {
      onChange(
        toSchedule(
          start,
          {
            cron: cronOf(NEW_SCHEDULE),
            timezone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
          },
          repositories.list[0],
        ),
      );
    } else if (on.kind === "schedule") {
      onChange(
        toEvent(start, value, repositoryNeed(needs), repositories.list),
      );
    } else {
      onChange({ ...start, on: { ...on, eventKind: value } });
    }
  };
  const problem = (need: StartNeed) =>
    problems.find((one) => one.startId === start.id && one.name === need.name);
  return (
    <>
      <UI.Combobox
        id={`${base}-event`}
        label={copy("when")}
        onChange={(event) => choose(event.currentTarget.value)}
        options={options}
        value={on.kind === "event" ? on.eventKind : SCHEDULE_CHOICE}
      />
      {repositories.state === "ready" && !schedulable
        ? (
          <UI.Text variant="caption">
            {copy("scheduleNeedsRepository")}
          </UI.Text>
        )
        : null}
      {on.kind === "event" && on.eventKind.endsWith("labeled")
        ? <UI.Text variant="caption">{copy("anyLabel")}</UI.Text>
        : null}
      {on.kind === "schedule"
        ? (
          <ScheduleFields
            base={base}
            on={on}
            onChange={onChange}
            start={start}
          />
        )
        : null}
      <RepositoryField
        base={base}
        need={on.kind === "schedule"
          ? SCHEDULE_REPOSITORY
          : repositoryNeed(needs)}
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
      <UI.Stack
        gap="none"
        onFocus={() => {
          settledBudget.current = start.budgetUsd;
        }}
      >
        <CommittedText
          error={start.budgetTyped === undefined
            ? undefined
            : copy("problem.budget", { max: WORKFLOW_START_MAX_BUDGET_USD })}
          hint={copy("budgetHelp")}
          id={`${base}-budget`}
          inputMode="decimal"
          label={copy("budget")}
          onCommit={(value) =>
            onChange(
              withBudget(start, value, settledBudget.current),
              "budget",
            )}
          shows={shownBudget}
          value={budgetText(start)}
        />
      </UI.Stack>
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
      {need !== undefined && start.on.kind === "event" &&
          chosen?.eventRepositoryId === null
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
    readonly onChange: (start: WorkflowStart, typing?: string) => void;
  },
) {
  const copy = useStartCopy();
  const id = `${base}-input-${need.name}`;
  const error = problem === undefined
    ? undefined
    : copy(`problem.${problem.kind}`, { name: need.name });
  if (need.kind === "unsupported") {
    return error === undefined ? null : (
      <UI.Stack id={id} tabIndex={-1}>
        <UI.InlineNotice tone="error">{error}</UI.InlineNotice>
      </UI.Stack>
    );
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
            onChange(
              withBriefInput(start, need.name, { ...brief, title }),
              `${need.name}.title`,
            )}
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
              `${need.name}.description`,
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
      onCommit={(value) =>
        onChange(withTextInput(start, need.name, value), need.name)}
      required
      value={textInput(start, need.name)}
    />
  );
}

function shownText(draft: string): string {
  return draft.trim() === "" ? "" : draft;
}

function CommittedText(
  props: {
    readonly id: string;
    readonly label: string;
    readonly value: string;
    readonly onCommit: (value: string) => void;
    readonly shows?: (draft: string) => string;
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
    if (props.value !== (props.shows ?? shownText)(draft)) {
      setDraft(props.value);
    }
  }
  const change = (next: string) => {
    setDraft(next);
    props.onCommit(next);
  };
  return (
    <UI.Field
      error={props.error}
      hint={props.hint}
      htmlFor={props.id}
      label={props.label}
      required={props.required}
      {...(props.multiline === true ? { variant: "textarea" as const } : {})}
    >
      {props.multiline === true
        ? (
          <textarea
            aria-invalid={props.error !== undefined || undefined}
            id={props.id}
            maxLength={props.maxLength}
            onChange={(event) => change(event.target.value)}
            rows={3}
            value={draft}
          />
        )
        : (
          <UI.TextInput
            autoComplete="off"
            id={props.id}
            inputMode={props.inputMode}
            invalid={props.error !== undefined || undefined}
            name={props.id}
            onChange={change}
            type="text"
            value={draft}
          />
        )}
    </UI.Field>
  );
}
