import {
  WORKFLOW_START_MAX_BUDGET_USD,
  type WorkflowStart,
  WorkflowStartsSchema,
} from "@bakery/contracts/workflow-starts";
import { canonicalJson } from "../projects/repository-state.ts";

export type DraftStart = WorkflowStart & { readonly budgetTyped?: string };

export type StartNeed = {
  readonly name: string;
  readonly kind: "repository" | "brief" | "text" | "unsupported";
};

export type StartProblem = {
  readonly startId: string;
  readonly number: number;
  readonly kind: "repository" | "title" | "text" | "unsupported" | "budget";
  readonly name: string;
};

export const NEW_START_BUDGET_USD = 5;
export const START_TASK_TYPE = "feature";

export type StartBrief = {
  readonly title: string;
  readonly description: string;
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function startsOfVersion(held: unknown): readonly WorkflowStart[] {
  const parsed = WorkflowStartsSchema.safeParse(held);
  return parsed.success ? parsed.data : [];
}

export function startNeeds(spec: unknown): readonly StartNeed[] {
  return Object.entries(record(record(spec).inputs)).flatMap(
    ([name, raw]) => {
      const input = record(raw);
      return input.required === true
        ? [{ name, kind: needKind(name, input) }]
        : [];
    },
  );
}

function needKind(
  name: string,
  input: Record<string, unknown>,
): StartNeed["kind"] {
  if (input.type === "TaskBrief") return "brief";
  if (input.type === "uuid" && name === "repositoryId") return "repository";
  if (input.type === "string" && input.enum === undefined) return "text";
  return "unsupported";
}

export function newStart(held: readonly WorkflowStart[]): WorkflowStart {
  const taken = new Set(held.map((start) => start.id));
  let n = 1;
  while (taken.has(`start-${n}`)) n += 1;
  return {
    id: `start-${n}`,
    budgetUsd: NEW_START_BUDGET_USD,
    on: { kind: "event", eventKind: "work_item.opened", filter: {} },
  };
}

export function textInput(start: WorkflowStart, name: string): string {
  const value = start.inputs?.[name];
  return typeof value === "string" ? value : "";
}

export function briefInput(start: WorkflowStart, name: string): StartBrief {
  const held = record(start.inputs?.[name]);
  return {
    title: typeof held.title === "string" ? held.title : "",
    description: typeof held.description === "string" ? held.description : "",
  };
}

type InputValue = NonNullable<WorkflowStart["inputs"]>[string];

function withInput(
  start: WorkflowStart,
  name: string,
  value: InputValue | undefined,
): WorkflowStart {
  const { inputs: held, ...rest } = start;
  const { [name]: _replaced, ...others } = held ?? {};
  const inputs = value === undefined ? others : { ...others, [name]: value };
  return Object.keys(inputs).length === 0 ? rest : { ...rest, inputs };
}

export function withTextInput(
  start: WorkflowStart,
  name: string,
  value: string,
): WorkflowStart {
  return withInput(start, name, value.trim() === "" ? undefined : value);
}

export function withBriefInput(
  start: WorkflowStart,
  name: string,
  brief: StartBrief,
): WorkflowStart {
  const empty = brief.title.trim() === "" && brief.description.trim() === "";
  return withInput(
    start,
    name,
    empty ? undefined : {
      ...record(start.inputs?.[name]),
      title: brief.title,
      description: brief.description,
      taskType: START_TASK_TYPE,
    } as InputValue,
  );
}

const AMOUNT = /^(\d+(\.\d*)?|\.\d+)$/;
const BUDGET_PROBLEM_NAME = "@budget";

function amount(text: string): number | null {
  const trimmed = text.trim();
  if (!AMOUNT.test(trimmed)) return null;
  const value = Number(trimmed);
  return value <= WORKFLOW_START_MAX_BUDGET_USD ? value : null;
}

export function shownBudget(text: string): string {
  if (text.trim() === "") return "";
  const value = amount(text);
  return value === null ? text : String(value);
}

export function budgetText(start: DraftStart): string {
  return start.budgetTyped ??
    (start.budgetUsd === undefined ? "" : String(start.budgetUsd));
}

export function savedStart(start: DraftStart): WorkflowStart {
  const { budgetTyped: _typed, ...saved } = start;
  return saved;
}

export function withBudget(
  start: DraftStart,
  text: string,
  settled: number | undefined,
): DraftStart {
  const { budgetTyped: _typed, budgetUsd: _budget, ...rest } = start;
  if (text.trim() === "") return rest;
  const value = amount(text);
  if (value !== null) return { ...rest, budgetUsd: value };
  return settled === undefined
    ? { ...rest, budgetTyped: text }
    : { ...rest, budgetUsd: settled, budgetTyped: text };
}

export const SCHEDULE_REPOSITORY: StartNeed = {
  name: "repositoryId",
  kind: "repository",
};

export function toSchedule(
  start: DraftStart,
  on: { readonly cron: string; readonly timezone: string },
  repository: StartRepository,
): DraftStart {
  return withTextInput(
    { ...start, on: { kind: "schedule", ...on } },
    SCHEDULE_REPOSITORY.name,
    textInput(start, SCHEDULE_REPOSITORY.name) || repository.id,
  );
}

export function toEvent(
  start: DraftStart,
  eventKind: string,
  need: StartNeed | undefined,
  repositories: readonly StartRepository[],
): DraftStart {
  const id = textInput(start, SCHEDULE_REPOSITORY.name);
  const repository = repositories.find((one) => one.id === id);
  const next = withTextInput(
    { ...start, on: { kind: "event", eventKind, filter: {} } },
    SCHEDULE_REPOSITORY.name,
    "",
  );
  return withRepository(next, need, repository);
}

export function startProblems(
  starts: readonly DraftStart[],
  needs: readonly StartNeed[],
): readonly StartProblem[] {
  return starts.flatMap((start, index) => {
    const unplaced = start.on.kind === "schedule" &&
        !needs.some((need) => need.kind === "repository") &&
        textInput(start, SCHEDULE_REPOSITORY.name).trim() === ""
      ? [SCHEDULE_REPOSITORY]
      : [];
    const required = [...unplaced, ...needs];
    const budget: readonly StartProblem[] = start.budgetTyped === undefined
      ? []
      : [{
        startId: start.id,
        number: index + 1,
        kind: "budget",
        name: BUDGET_PROBLEM_NAME,
      }];
    const missingInputs = required.flatMap((need): readonly StartProblem[] => {
      const missing = need.kind === "brief"
        ? briefInput(start, need.name).title.trim() === ""
        : need.kind === "unsupported"
        ? start.inputs?.[need.name] === undefined
        : textInput(start, need.name).trim() === "";
      return missing
        ? [{
          startId: start.id,
          number: index + 1,
          kind: need.kind === "brief" ? "title" : need.kind,
          name: need.name,
        }]
        : [];
    });
    return [...missingInputs, ...budget];
  });
}

export type StartRepository = {
  readonly id: string;
  readonly name: string;
  readonly eventRepositoryId: number | null;
};

const REPOSITORY_FILTER = "repositoryId";

export function eventRepositoryId(providerRepoId: string): number | null {
  const value = Number(providerRepoId);
  return /^[0-9]+$/.test(providerRepoId) && Number.isSafeInteger(value)
    ? value
    : null;
}

export function chosenRepository(
  start: WorkflowStart,
  need: StartNeed | undefined,
  repositories: readonly StartRepository[],
): string {
  if (need !== undefined) return textInput(start, need.name);
  if (start.on.kind !== "event") return "";
  const filtered = start.on.filter[REPOSITORY_FILTER];
  return repositories.find((one) => one.eventRepositoryId === filtered)?.id ??
    "";
}

export function otherFilters(
  start: WorkflowStart,
  repositories: readonly StartRepository[],
): readonly string[] {
  if (start.on.kind !== "event") return [];
  return Object.entries(start.on.filter).filter(([key, value]) =>
    key !== REPOSITORY_FILTER ||
    !repositories.some((one) => one.eventRepositoryId === value)
  ).map(([key, value]) => `${key} = ${value}`);
}

export function withRepository(
  start: WorkflowStart,
  need: StartNeed | undefined,
  repository: StartRepository | undefined,
): WorkflowStart {
  if (start.on.kind !== "event") {
    return withTextInput(
      start,
      SCHEDULE_REPOSITORY.name,
      repository?.id ?? "",
    );
  }
  const { [REPOSITORY_FILTER]: _held, ...others } = start.on.filter;
  const filter = repository === undefined ||
      repository.eventRepositoryId === null
    ? others
    : { ...others, [REPOSITORY_FILTER]: repository.eventRepositoryId };
  const next = { ...start, on: { ...start.on, filter } };
  return need === undefined
    ? next
    : withTextInput(next, need.name, repository?.id ?? "");
}

export function automaticStarts(
  starts: readonly WorkflowStart[],
): number {
  return starts.length;
}

export function sameStarts(
  left: readonly WorkflowStart[],
  right: readonly WorkflowStart[],
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
