import {
  type Answer,
  askSystemOne,
  publishStepSummary,
  type Question,
  readTypeSafeApiKey,
  type ScoreAnswer,
  TypeSafeUnavailable,
} from "../lib/typesafe.ts";
import { descriptionDefectKind } from "../../packages/contracts/src/description-quality.ts";

const INVENTORY_PATH = "docs/technical-design/transport-schemas.json";
const BATCH_SIZE = 8;
const MAX_PR_FIELDS = 96;
const DESCRIPTION_LEVELS = [
  "Restates the field name, its type, or that a value is recorded/bounded; a client learns nothing new.",
  "Adds one generic fact (nullable, bounded, some timestamp) but not what the value means or how a client uses it.",
  "Explains the meaning, source, units, or client obligation specific to this field.",
] as const;

type JsonRecord = Record<string, unknown>;

export type ContractField = {
  readonly path: string;
  readonly type: string;
  readonly nullable: boolean;
  readonly description: string;
  readonly parent: string;
};

export type ContractDescriptionAnnotationRow = ContractField & {
  readonly verdict: "weak" | "generic" | null;
  readonly score: number;
  readonly confidence: number;
};

export type ContractDescriptionRequest = {
  readonly fields: readonly ContractField[];
  readonly state: { fields: Record<string, ContractField> };
  readonly questions: Record<string, Question>;
};

export type SummaryOptions = {
  readonly capped?: boolean;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly requestCount?: number;
  readonly stopReason?: string;
  /** `--all` judges the whole inventory, not a change set. */
  readonly audit?: boolean;
};

// Keys whose values are `{ [fieldName]: string }` maps rather than schema
// nodes; `description` is skipped as the node's own text.
const SKIPPED_CHILD_KEYS: Record<string, true> = {
  description: true,
  fieldDescriptions: true,
  fieldTypes: true,
  sourceColumns: true,
  computedFields: true,
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonemptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function fieldType(
  node: JsonRecord,
  owner?: JsonRecord,
  name?: string,
): string {
  const own = nonemptyString(node.type);
  if (own !== null) return own;
  if (owner !== undefined && name !== undefined) {
    const inherited = nonemptyString(
      owner.fieldTypes instanceof Object
        ? (owner.fieldTypes as JsonRecord)[name]
        : undefined,
    );
    if (inherited !== null) return inherited;
  }
  return "object";
}

function isNullable(
  node: JsonRecord,
  owner?: JsonRecord,
  name?: string,
  type = fieldType(node, owner, name),
): boolean {
  if (node.nullable === true) return true;
  if (type.includes("|null") || type.endsWith("?")) return true;
  return owner !== undefined && name !== undefined &&
    Array.isArray(owner.nullableFields) && owner.nullableFields.includes(name);
}

function childPath(path: string, key: string): string {
  if (path.length === 0) return key;
  // `fields` is a container, not part of the public schema path.
  return key === "fields" ? path : `${path}.${key}`;
}

/** Collects every described node in the authored transport inventory. */
export function collectFields(doc: unknown): ContractField[] {
  const fields: ContractField[] = [];
  const seen = new Set<object>();

  const visit = (value: unknown, path: string, parent: string): void => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => {
        if (isRecord(entry) && nonemptyString(entry.name) !== null) {
          const name = nonemptyString(entry.name)!;
          const entryPath = path.length === 0 ? name : `${path}.${name}`;
          visit(entry, entryPath, path || "schema");
        } else {
          const entryPath = `${path}[${index}]`;
          visit(entry, entryPath, path || "schema");
        }
      });
      return;
    }
    if (!isRecord(value) || seen.has(value)) return;
    seen.add(value);

    const description = value.description;
    if (typeof description === "string") {
      fields.push({
        path: path || "schema",
        type: fieldType(value),
        nullable: isNullable(value),
        description,
        parent,
      });
    }

    const fieldDescriptions = isRecord(value.fieldDescriptions)
      ? value.fieldDescriptions
      : undefined;
    if (fieldDescriptions !== undefined) {
      const names = Object.keys(fieldDescriptions).sort();
      for (const name of names) {
        const fieldDescription = fieldDescriptions[name];
        if (typeof fieldDescription !== "string") continue;
        const node: JsonRecord = { description: fieldDescription };
        const type = fieldType(node, value, name);
        fields.push({
          path: path ? `${path}.${name}` : name,
          type,
          nullable: isNullable(node, value, name, type),
          description: fieldDescription,
          parent: path || "schema",
        });
      }
    }

    for (const key of Object.keys(value).sort()) {
      // Field-keyed string maps are not schema nodes: a field literally named
      // `description` would otherwise appear as a phantom described node.
      if (SKIPPED_CHILD_KEYS[key]) continue;
      const child = value[key];
      if (!Array.isArray(child) && !isRecord(child)) continue;
      const nextPath = Array.isArray(child)
        ? childPath(path, key)
        : (path.length === 0 ? key : `${path}.${key}`);
      visit(child, nextPath, path || "schema");
    }
  };

  visit(doc, "", "schema");
  return fields;
}

function fieldKey(field: ContractField): string {
  return `${field.path}\u0000${field.description}`;
}

/** Returns new or changed descriptions, excluding deterministic gate defects. */
export function changedFields(
  baseFields: readonly ContractField[],
  headFields: readonly ContractField[],
): ContractField[] {
  const base = new Set(baseFields.map(fieldKey));
  const included = new Set<string>();
  return headFields.filter((field) => {
    const key = fieldKey(field);
    if (base.has(key) || included.has(key)) return false;
    included.add(key);
    return descriptionDefectKind(field.description, field.path) === undefined;
  });
}

export function buildRequests(
  fields: readonly ContractField[],
  batchSize = BATCH_SIZE,
): ContractDescriptionRequest[] {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new RangeError("batch size must be a positive integer");
  }
  const requests: ContractDescriptionRequest[] = [];
  for (let offset = 0; offset < fields.length; offset += batchSize) {
    const slice = fields.slice(offset, offset + batchSize);
    const stateFields: Record<string, ContractField> = {};
    const questions: Record<string, Question> = {};
    slice.forEach((field, index) => {
      const id = `f${index}`;
      stateFields[id] = field;
      questions[id] = {
        type: "score",
        instructions:
          `How much does \`fields.${id}.description\` tell an API client beyond what \`fields.${id}.path\` and \`fields.${id}.type\` already say?`,
        criteria: DESCRIPTION_LEVELS,
      };
    });
    requests.push({
      fields: slice,
      state: { fields: stateFields },
      questions,
    });
  }
  return requests;
}

/**
 * Decides from the level distribution, not the expected score gated by
 * confidence. Confidence measures concentration across all three levels, so a
 * description split between "restates the name" and "adds one generic fact"
 * reads as low confidence although it is certainly not informative. Measured
 * on 164 templated + 164 informative descriptions: recall 161/164 (from
 * 135/164 with the confidence gate), 0–1 false weak, lowest run-to-run flips.
 */
export function verdictFor(answer: ScoreAnswer): "weak" | "generic" | null {
  const restates = answer.probabilities["0"] ?? 0;
  const oneFact = answer.probabilities["1"] ?? 0;
  if (restates >= 0.5) return "weak";
  if (restates + oneFact >= 0.75) return "generic";
  return null;
}

function scoreAnswer(answer: Answer | undefined, id: string): ScoreAnswer {
  if (!answer || answer.type !== "score") {
    throw new TypeSafeUnavailable(`TypeSafe answer ${id} had the wrong type`);
  }
  return answer;
}

function annotationRows(
  fields: readonly ContractField[],
  answers: Record<string, Answer>,
): ContractDescriptionAnnotationRow[] {
  return fields.map((field, index) => {
    const id = `f${index}`;
    const answer = scoreAnswer(answers[id], id);
    return {
      ...field,
      verdict: verdictFor(answer),
      score: answer.score,
      confidence: answer.confidence,
    };
  });
}

function markdownCell(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replaceAll("\\", "\\\\").replaceAll(
    "|",
    "\\|",
  );
}

export function renderSummary(
  rows: readonly ContractDescriptionAnnotationRow[],
  changedCount: number,
  options: SummaryOptions = {},
): string {
  const findings = rows.filter((row) => row.verdict !== null);
  const judged = rows.length;
  const noun = options.audit ? "descriptions" : "changed descriptions";
  const lines = [
    "# TypeSafe contract-description advisory",
    "The `descriptionDefectKind` gate remains the gate; this annotation is advisory only.",
    `Judged ${judged} of ${changedCount} ${noun}${
      options.capped ? " (capped at 96 fields / 12 requests)" : ""
    }.`,
  ];
  if (options.capped) {
    lines.push(
      `Cost bound: judged the first ${judged} of ${changedCount} ${noun}.`,
    );
  }
  if (judged > 0) {
    const weak = rows.filter((row) => row.verdict === "weak").length;
    const generic = rows.filter((row) => row.verdict === "generic").length;
    lines.push(
      `weak: ${weak}, generic: ${generic}, silent: ${judged - weak - generic}`,
    );
  }
  if (
    options.inputTokens !== undefined || options.outputTokens !== undefined ||
    options.requestCount !== undefined
  ) {
    lines.push(
      `TypeSafe usage: ${options.inputTokens ?? 0} input tokens, ${
        options.outputTokens ?? 0
      } output tokens across ${options.requestCount ?? 0} requests.`,
    );
  }
  if (judged > 0) {
    lines.push(
      "",
      "| path | description | verdict | score (conf) |",
      "| --- | --- | --- | ---: |",
    );
    for (const row of findings) {
      lines.push(
        `| ${markdownCell(row.path)} | ${
          markdownCell(row.description)
        } | ${row.verdict} | ${row.score.toFixed(2)} (${
          row.confidence.toFixed(2)
        }) |`,
      );
    }
    if (findings.length === 0) {
      lines.push(
        "",
        `no weak or generic descriptions among the ${judged} judged`,
      );
    }
  }
  if (options.stopReason !== undefined) {
    lines.push(
      "",
      `TypeSafe advisory stopped after ${judged} descriptions: ${options.stopReason}`,
    );
  }
  return lines.join("\n");
}

async function gitOutput(args: readonly string[]): Promise<string> {
  const result = await new Deno.Command("git", {
    args: [...args],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (result.code !== 0) {
    const detail = new TextDecoder().decode(result.stderr).trim();
    throw new Error(detail || "git command failed");
  }
  return new TextDecoder().decode(result.stdout);
}

async function readInventoryAt(base: string): Promise<unknown> {
  return JSON.parse(await gitOutput(["show", `${base}:${INVENTORY_PATH}`]));
}

async function readHeadInventory(): Promise<unknown> {
  return JSON.parse(await Deno.readTextFile(INVENTORY_PATH));
}

async function annotate(
  mode: "all" | "commit-range",
  base: string | undefined,
  apiKey: string,
): Promise<void> {
  const headFields = collectFields(await readHeadInventory());
  const changed = mode === "all"
    ? changedFields([], headFields)
    : changedFields(
      collectFields(await readInventoryAt(base!)),
      headFields,
    );
  if (changed.length === 0) {
    console.log(
      mode === "all"
        ? "TypeSafe advisory: no contract descriptions to judge"
        : "TypeSafe advisory: no changed contract descriptions",
    );
    return;
  }

  const capped = mode === "commit-range" && changed.length > MAX_PR_FIELDS;
  const fields = capped ? changed.slice(0, MAX_PR_FIELDS) : changed;
  const requests = buildRequests(fields);
  const rows: ContractDescriptionAnnotationRow[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let completedRequests = 0;

  try {
    for (const request of requests) {
      const response = await askSystemOne(
        { state: request.state, questions: request.questions },
        { apiKey },
      );
      inputTokens += response.usage.input_tokens;
      outputTokens += response.usage.output_tokens;
      rows.push(...annotationRows(request.fields, response.answers));
      completedRequests += 1;
      if (mode === "all" && completedRequests % 20 === 0) {
        console.log(
          `TypeSafe advisory progress: ${completedRequests} requests completed`,
        );
      }
    }
  } catch (error) {
    if (!(error instanceof TypeSafeUnavailable)) throw error;
    const message = error.message || "TypeSafe request unavailable";
    if (rows.length === 0) {
      console.log(`TypeSafe advisory skipped: ${message}`);
      return;
    }
    await publishStepSummary(
      renderSummary(rows, changed.length, {
        audit: mode === "all",
        capped,
        inputTokens,
        outputTokens,
        requestCount: completedRequests,
        stopReason: message,
      }),
    );
    return;
  }

  await publishStepSummary(
    renderSummary(rows, changed.length, {
      audit: mode === "all",
      capped,
      inputTokens,
      outputTokens,
      requestCount: completedRequests,
    }),
  );
}

function parseArgs(args: readonly string[]): {
  mode: "all" | "commit-range";
  base?: string;
} | null {
  if (args.length === 1 && args[0] === "--all") return { mode: "all" };
  if (args.length === 3 && args[0] === "--commit-range" && args[1] && args[2]) {
    return { mode: "commit-range", base: args[1] };
  }
  return null;
}

async function main(): Promise<void> {
  const parsed = parseArgs(Deno.args);
  if (parsed === null) {
    console.error(
      "Usage: annotate-contract-descriptions.ts --commit-range <base> <head> | --all",
    );
    Deno.exit(2);
  }
  const apiKey = readTypeSafeApiKey();
  if (apiKey === null) {
    console.log("TypeSafe advisory skipped: TYPESAFE_API_KEY not set");
    return;
  }

  try {
    await annotate(parsed.mode, parsed.base, apiKey);
  } catch (error) {
    const message = error instanceof Error && error.message
      ? error.message
      : "request failed";
    console.log(`TypeSafe advisory skipped: ${message}`);
  }
}

if (import.meta.main) await main();
