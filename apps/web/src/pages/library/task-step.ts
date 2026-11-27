export const TASK_ACTION = "agent.freeform";
export const TASK_PROMPT_MAX = 8000;
export const TASK_TOOLS: readonly string[] = ["Read", "Glob", "Grep"];
export const TASK_MINUTES: readonly number[] = [5, 15, 30, 60, 120];
export const TASK_TURNS_MAX = 50;
export const TASK_COST_MAX = 100;

export type TaskFields = Readonly<{
  prompt: string;
  turns: string;
  minutes: number | null;
  cost: string;
  tools: readonly string[] | null;
}>;

export const NEW_TASK = {
  prompt: "",
  turns: "20",
  minutes: 30,
  cost: "5",
  tools: TASK_TOOLS,
} satisfies TaskFields;

const INPUT_KEYS: ReadonlySet<string> = new Set([
  "prompt",
  "maxTurns",
  "timeout",
  "maxCostUsd",
  "allowedTools",
]);
const DURATION = /^(?:PT(?:(\d+)H)?(?:(\d+)M)?|(\d+)(m|h))$/;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function textOf(value: unknown): string | null {
  if (value === undefined) return "";
  if (typeof value === "string") return value.startsWith("$") ? null : value;
  return isPlainObject(value) && Object.keys(value).join() === "$literal" &&
      typeof value.$literal === "string"
    ? value.$literal
    : null;
}

function minutesOf(value: unknown): number | null {
  const found = typeof value === "string" ? DURATION.exec(value) : null;
  if (found === null) return null;
  const [, hours, minutes, short, unit] = found;
  const total = short === undefined
    ? Number(hours ?? 0) * 60 + Number(minutes ?? 0)
    : Number(short) * (unit === "h" ? 60 : 1);
  return total > 0 ? total : null;
}

const timeoutOf = (minutes: number): string =>
  minutes % 60 === 0 ? `PT${minutes / 60}H` : `PT${minutes}M`;

const isToolList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((tool) => TASK_TOOLS.includes(tool));

export function taskOfNode(
  node: Readonly<Record<string, unknown>> | undefined,
): TaskFields | null {
  const input = node?.with ?? {};
  if (
    !isPlainObject(input) ||
    Object.keys(input).some((key) => !INPUT_KEYS.has(key))
  ) {
    return null;
  }
  const prompt = textOf(input.prompt);
  const minutes = input.timeout === undefined ? null : minutesOf(input.timeout);
  const turns = input.maxTurns ?? "";
  const cost = input.maxCostUsd ?? "";
  const tools = input.allowedTools === undefined ? null : input.allowedTools;
  if (
    prompt === null || (input.timeout !== undefined && minutes === null) ||
    (turns !== "" && typeof turns !== "number") ||
    (cost !== "" && typeof cost !== "number") ||
    !(tools === null || isToolList(tools))
  ) {
    return null;
  }
  return {
    prompt,
    minutes,
    turns: String(turns),
    cost: String(cost),
    tools,
  };
}

export function turnsOf(text: string): number | null {
  const turns = /^\d+$/.test(text.trim()) ? Number(text) : 0;
  return turns >= 1 && turns <= TASK_TURNS_MAX ? turns : null;
}

export function costOf(text: string): number | null {
  const cost = text.trim() === "" ? -1 : Number(text);
  return cost >= 0 && cost <= TASK_COST_MAX ? cost : null;
}

export function taskInput(fields: TaskFields): Record<string, unknown> {
  return {
    ...(fields.prompt === "" ? {} : {
      prompt: fields.prompt.includes("$")
        ? { $literal: fields.prompt }
        : fields.prompt,
    }),
    ...(fields.turns === "" ? {} : { maxTurns: Number(fields.turns) }),
    ...(fields.minutes === null ? {} : { timeout: timeoutOf(fields.minutes) }),
    ...(fields.cost === "" ? {} : { maxCostUsd: Number(fields.cost) }),
    ...(fields.tools === null ? {} : { allowedTools: [...fields.tools] }),
  };
}

export const typedTurns = (text: string): boolean => /^\d{0,4}$/.test(text);

export const typedCost = (text: string): boolean =>
  /^(\d{1,4}(\.\d*)?)?$/.test(text);

export function sameTask(left: TaskFields, right: TaskFields): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export type TaskProblem = Readonly<
  { field: "prompt" | "minutes" | "turns" | "cost" | "tools" }
>;

export const isTaskField = (field: string): field is TaskProblem["field"] =>
  ["prompt", "minutes", "turns", "cost", "tools"].includes(field);

export function taskProblems(fields: TaskFields): readonly TaskProblem[] {
  const problems: TaskProblem[] = [];
  if (fields.prompt.trim() === "") problems.push({ field: "prompt" });
  if (fields.minutes === null) problems.push({ field: "minutes" });
  if (costOf(fields.cost) === null) problems.push({ field: "cost" });
  if (turnsOf(fields.turns) === null) problems.push({ field: "turns" });
  if (fields.tools === null) problems.push({ field: "tools" });
  return problems;
}
