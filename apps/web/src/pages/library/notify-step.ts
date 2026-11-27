export const NOTIFY_ACTION = "people.tag";
export const NOTE_MAX = 280;
export const DEFAULT_AFTER_HOURS = 24;
export const AFTER_HOURS: readonly number[] = [1, 4, 24, 48, 72];

export const DOCUMENT_STEPS: ReadonlySet<string> = new Set([
  "task.brief",
  "rpi.research",
  "rpi.design",
  "rpi.plan",
]);

export type NotifyNeed = "fyi" | "review";

export type NotifyNext = Readonly<{ after: number; who: string }>;

export type NotifyFields = Readonly<{
  who: string;
  need: NotifyNeed;
  from: string;
  note: string;
  wait: boolean;
  next: NotifyNext | null;
}>;

export const NEW_NOTIFY: NotifyFields = {
  who: "run:starter",
  need: "fyi",
  from: "",
  note: "",
  wait: false,
  next: null,
};

const RECIPIENT_KEYS = {
  run: "recipientRunRole",
  group: "recipientGroupId",
  role: "recipientRoleKey",
  person: "recipientId",
} as const;

type RecipientKind = keyof typeof RECIPIENT_KEYS;

const INPUT_KEYS: ReadonlySet<string> = new Set([
  ...Object.values(RECIPIENT_KEYS),
  "intent",
  "artifactVersionId",
  "note",
  "wait",
  "ifNobodyAnswers",
]);
const NEXT_KEYS: ReadonlySet<string> = new Set([
  ...Object.values(RECIPIENT_KEYS),
  "afterHours",
]);
const REFERENCE = /^\$step\.([A-Za-z0-9_.-]+)\.artifact\.versionId$/;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function recipientOf(input: Record<string, unknown>): string | null {
  const named = (Object.keys(RECIPIENT_KEYS) as RecipientKind[]).filter(
    (kind) => input[RECIPIENT_KEYS[kind]] !== undefined,
  );
  if (named.length !== 1) return null;
  const value = input[RECIPIENT_KEYS[named[0]]];
  return typeof value === "string" && value !== "" && !value.startsWith("$")
    ? `${named[0]}:${value}`
    : null;
}

function recipientInput(who: string): Record<string, string> {
  const at = who.indexOf(":");
  return at === -1 ? {} : {
    [RECIPIENT_KEYS[who.slice(0, at) as RecipientKind]]: who.slice(at + 1),
  };
}

function nextOf(value: unknown): NotifyNext | null | undefined {
  if (value === undefined) return null;
  if (
    !isPlainObject(value) ||
    Object.keys(value).some((key) => !NEXT_KEYS.has(key))
  ) {
    return undefined;
  }
  const who = recipientOf(value);
  const after = value.afterHours ?? DEFAULT_AFTER_HOURS;
  return who === null || typeof after !== "number" ? undefined : { after, who };
}

export function notifyOfNode(
  node: Readonly<Record<string, unknown>> | undefined,
): NotifyFields | null {
  const input = node?.with;
  if (input === undefined) return NEW_NOTIFY;
  if (
    !isPlainObject(input) ||
    Object.keys(input).some((key) => !INPUT_KEYS.has(key))
  ) {
    return null;
  }
  const who = recipientOf(input);
  const need = input.intent;
  const note = input.note ?? "";
  const wait = input.wait ?? false;
  const next = nextOf(input.ifNobodyAnswers);
  const reference = input.artifactVersionId;
  const from = typeof reference === "string"
    ? REFERENCE.exec(reference)?.[1]
    : undefined;
  if (
    who === null || (need !== "fyi" && need !== "review") ||
    typeof note !== "string" || note.startsWith("$") ||
    typeof wait !== "boolean" || next === undefined ||
    (reference !== undefined && from === undefined)
  ) {
    return null;
  }
  return { who, need, from: from ?? "", note, wait, next };
}

export function notifyInput(fields: NotifyFields): Record<string, unknown> {
  const waits = fields.need === "review" && fields.wait;
  return {
    ...recipientInput(fields.who),
    intent: fields.need,
    ...(fields.need === "review" && fields.from !== ""
      ? { artifactVersionId: `$step.${fields.from}.artifact.versionId` }
      : {}),
    ...(fields.note.trim() === "" || fields.note.includes("$")
      ? {}
      : { note: fields.note }),
    ...(waits ? { wait: true } : {}),
    ...(waits && fields.next !== null && fields.next.who !== ""
      ? {
        ifNobodyAnswers: {
          afterHours: fields.next.after,
          ...recipientInput(fields.next.who),
        },
      }
      : {}),
  };
}

export function sameNotify(left: NotifyFields, right: NotifyFields): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export type NotifyProblemKind =
  | "from"
  | "fromGone"
  | "nextEmpty"
  | "nextSame";

export type NotifyProblem = Readonly<{
  field: "from" | "next";
  kind: NotifyProblemKind;
}>;

export function notifyProblems(
  fields: NotifyFields,
  documents: readonly string[],
): readonly NotifyProblem[] {
  const problems: NotifyProblem[] = [];
  if (fields.need === "review") {
    if (fields.from === "") {
      problems.push({ field: "from", kind: "from" });
    } else if (!documents.includes(fields.from)) {
      problems.push({ field: "from", kind: "fromGone" });
    }
  }
  if (fields.need === "review" && fields.wait && fields.next !== null) {
    if (fields.next.who === "") {
      problems.push({ field: "next", kind: "nextEmpty" });
    } else if (fields.next.who === fields.who) {
      problems.push({ field: "next", kind: "nextSame" });
    }
  }
  return problems;
}

export type PlacedStep = Readonly<
  { id: string; uses: string; list?: string }
>;

export const documentKey = (step: PlacedStep): string =>
  step.list === undefined ? step.id : `${step.list}.${step.id}`;

export function documentsBefore<Step extends PlacedStep>(
  steps: readonly Step[],
  id: string,
): readonly Step[] {
  const at = steps.findIndex((step) => step.id === id);
  return steps.slice(0, Math.max(at, 0)).filter((step) =>
    DOCUMENT_STEPS.has(step.uses)
  );
}
