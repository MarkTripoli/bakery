export type ApprovalFields = {
  readonly prompt: string;
  readonly audience: readonly string[];
  readonly allowRequestChanges: boolean;
  readonly approveLabel: string;
  readonly rejectLabel: string;
};

export type ApprovalPerson = {
  readonly principalId: string;
  readonly displayName: string;
  readonly active: boolean;
};

export type ApprovalProblem = {
  readonly field: "prompt" | "audience";
  readonly kind: "promptEmpty" | "notMember";
  readonly name: string;
};

export const APPROVAL_ACTION = "human.approval";
export const APPROVAL_MAX_PEOPLE = 50;
export const APPROVAL_PROMPT_MAX = 2000;
export const APPROVAL_LABEL_MAX = 100;

export const NEW_APPROVAL: ApprovalFields = {
  prompt: "",
  audience: [],
  allowRequestChanges: true,
  approveLabel: "",
  rejectLabel: "",
};

const KNOWN_KEYS: ReadonlySet<string> = new Set(Object.keys(NEW_APPROVAL));

const MEMBER_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function textOf(value: unknown): string | null {
  if (value === undefined) return "";
  if (typeof value === "string") {
    return value.startsWith("$") ? null : value;
  }
  if (!isPlainObject(value) || Object.keys(value).join() !== "$literal") {
    return null;
  }
  return typeof value.$literal === "string" ? value.$literal : null;
}

export function approvalOfNode(
  node: Readonly<Record<string, unknown>> | undefined,
): ApprovalFields | null {
  const input = node?.with ?? {};
  if (!isPlainObject(input)) return null;
  if (Object.keys(input).some((key) => !KNOWN_KEYS.has(key))) return null;
  const prompt = textOf(input.prompt);
  const approveLabel = textOf(input.approveLabel);
  const rejectLabel = textOf(input.rejectLabel);
  const audience = input.audience ?? [];
  const allow = input.allowRequestChanges ?? true;
  if (prompt === null || approveLabel === null || rejectLabel === null) {
    return null;
  }
  if (typeof allow !== "boolean") return null;
  if (
    !Array.isArray(audience) || audience.length > APPROVAL_MAX_PEOPLE ||
    !audience.every((one): one is string =>
      typeof one === "string" && MEMBER_ID.test(one)
    )
  ) {
    return null;
  }
  return {
    prompt,
    audience,
    allowRequestChanges: allow,
    approveLabel,
    rejectLabel,
  };
}

const literal = (text: string): unknown =>
  text.includes("$") ? { $literal: text } : text;

export function approvalInput(
  fields: ApprovalFields,
): Record<string, unknown> | null {
  const input: Record<string, unknown> = {
    ...(fields.prompt.trim() === "" ? {} : { prompt: literal(fields.prompt) }),
    ...(fields.audience.length === 0 ? {} : { audience: [...fields.audience] }),
    ...(fields.allowRequestChanges ? {} : { allowRequestChanges: false }),
    ...(fields.approveLabel.trim() === ""
      ? {}
      : { approveLabel: literal(fields.approveLabel.trim()) }),
    ...(fields.rejectLabel.trim() === ""
      ? {}
      : { rejectLabel: literal(fields.rejectLabel.trim()) }),
  };
  return Object.keys(input).length === 0 ? null : input;
}

export function sameApproval(
  left: ApprovalFields,
  right: ApprovalFields,
): boolean {
  return JSON.stringify(approvalInput(left)) ===
    JSON.stringify(approvalInput(right));
}

export function approvalProblems(
  fields: ApprovalFields,
  people: readonly ApprovalPerson[] | null,
): readonly ApprovalProblem[] {
  const problems: ApprovalProblem[] = [];
  if (fields.prompt.trim() === "") {
    problems.push({ field: "prompt", kind: "promptEmpty", name: "" });
  }
  if (people === null) return problems;
  for (const id of fields.audience) {
    const person = people.find((one) => one.principalId === id);
    if (person?.active) continue;
    problems.push({
      field: "audience",
      kind: "notMember",
      name: person?.displayName ?? "",
    });
  }
  return problems;
}

export type AskedWho =
  | { readonly kind: "owner" }
  | { readonly kind: "one"; readonly name: string }
  | {
    readonly kind: "many";
    readonly first: string;
    readonly others: number;
  }
  | { readonly kind: "count"; readonly count: number };

export function askedWho(
  audience: readonly string[],
  people: readonly ApprovalPerson[] | null,
): AskedWho {
  if (audience.length === 0) return { kind: "owner" };
  const first = people?.find((one) => one.principalId === audience[0]);
  if (first === undefined) return { kind: "count", count: audience.length };
  if (audience.length === 1) {
    return { kind: "one", name: first.displayName };
  }
  return {
    kind: "many",
    first: first.displayName,
    others: audience.length - 1,
  };
}
