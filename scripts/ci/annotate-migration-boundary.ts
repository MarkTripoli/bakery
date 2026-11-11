import {
  classifyStatement,
  migrationRoots,
  splitStatements,
} from "../lib/postgresql-boundary.ts";
import type { BoundaryVerdict } from "../lib/postgresql-boundary.ts";
import {
  askSystemOne,
  publishStepSummary,
  readTypeSafeApiKey,
  TypeSafeUnavailable,
} from "../lib/typesafe.ts";
import type {
  ChoiceAnswer,
  NoulAnswer,
  Question,
  SystemOneResponse,
} from "../lib/typesafe.ts";

export const BOUNDARY_POLICY = [
  "PostgreSQL owns storage structure and relational integrity only. SQL migrations may define tables, columns, primary and foreign keys, NOT NULL and UNIQUE constraints, and indexes.",
  "TypeScript owns domain validation, authorization, lifecycle transitions, derived-state repair, retries, workflow behavior, and other business rules. Do not encode them in CHECK constraints, triggers, stored routines, rules, views, policies, or row-level security.",
  "Keep data changes out of schema migrations. Implement backfills, transformations, and compatibility transitions as versioned, bounded, idempotent TypeScript scripts using @bakery/config, with explicit rollout and recovery evidence.",
  "Deployed migrations remain immutable but are not precedent. New or revised database work must follow this boundary.",
].join("\n");

const QUESTIONS = {
  structural_only: {
    type: "noul",
    instructions:
      "Does `statement.sql` only define storage structure or relational integrity under `policy` — tables, columns, primary/foreign keys, NOT NULL, UNIQUE, indexes, grants, comments, extensions?",
    criteria: {
      true:
        "The statement only defines storage structure or relational integrity under policy: tables, columns, primary/foreign keys, NOT NULL, UNIQUE, indexes, grants, comments, or extensions.",
      false:
        "The statement changes or reads data, or defines in-database logic including CHECK constraints, triggers, routines, views, rules, policies, row-level security, DO blocks, or executes a query or routine at migration time.",
    },
  },
  kind: {
    type: "choice",
    instructions:
      "What kind of PostgreSQL migration statement is `statement.sql` under `policy`? Choose the single best kind.",
    criteria: {
      structural:
        "Defines storage structure or relational integrity only: tables, columns, primary/foreign keys, NOT NULL, UNIQUE, indexes, grants, comments, or extensions.",
      data_change:
        "Changes or reads persisted data, including INSERT, UPDATE, DELETE, SELECT, or a data backfill or transformation.",
      behavior:
        "Defines in-database logic or behavior, including CHECK constraints, triggers, routines, views, rules, or DO blocks, or executes a query or routine at migration time.",
      rls: "Creates a policy or enables or forces row-level security.",
    },
  },
  rls: {
    type: "noul",
    instructions:
      "Does `statement.sql` create a policy, or enable or force row level security?",
    criteria: {
      true:
        "The statement creates a policy or enables or forces row-level security.",
      false:
        "The statement does not create a policy and does not enable or force row-level security.",
    },
  },
} satisfies Record<string, Question>;

type FlagRow = {
  readonly railBehavior: string | null;
  readonly pStructural: number;
  readonly pRls: number;
  readonly kind: ChoiceAnswer;
};

export type BoundaryAnnotationRow = FlagRow & {
  readonly file: string;
  readonly index: number;
};

export type SummaryOptions = {
  readonly capped?: boolean;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly stopReason?: string;
};

export function flag(row: FlagRow): string | null {
  if (row.railBehavior === null && row.pStructural < 0.3) {
    return `rail passed but this looks like ${row.kind.choice} — check forbiddenPatterns`;
  }
  if (row.railBehavior !== null && row.pStructural > 0.8) {
    return `rail failed on "${row.railBehavior}" — keyword inside a literal or comment?`;
  }
  if (row.railBehavior === null && row.pRls >= 0.5) {
    return `rail passed but p(rls)=${
      row.pRls.toFixed(2)
    } — looks like row-level security`;
  }
  if (row.kind.confidence < 0.6) {
    return `low confidence (${row.kind.confidence})`;
  }
  return null;
}

export function renderSummary(
  rows: readonly BoundaryAnnotationRow[],
  statementCount: number,
  fileCount: number,
  options: SummaryOptions = {},
): string {
  const flagged = rows.filter((row) => flag(row) !== null);
  const annotated = rows.length;
  const lines = [
    "# TypeSafe migration-boundary advisory",
    `Rail remains the gate. Annotated ${annotated} of ${statementCount} statement${
      statementCount === 1 ? "" : "s"
    } across ${fileCount} file${fileCount === 1 ? "" : "s"}${
      options.capped ? " (capped at 40)" : ""
    }.`,
  ];
  if (options.capped) {
    lines.push(
      `Cost bound: annotated the first ${annotated} of ${statementCount} changed statements.`,
    );
  }
  if (options.inputTokens !== undefined || options.outputTokens !== undefined) {
    lines.push(
      `TypeSafe usage: ${options.inputTokens ?? 0} input tokens, ${
        options.outputTokens ?? 0
      } output tokens.`,
    );
  }
  lines.push(
    "",
    "| file | # | rail | p(structural) | p(rls) | kind (conf) | flag |",
    "| --- | ---: | --- | ---: | ---: | --- | --- |",
  );
  for (const row of flagged) {
    const message = flag(row);
    if (message === null) continue;
    lines.push(
      `| ${markdownCell(row.file)} | ${row.index} | ${
        markdownCell(row.railBehavior ?? "pass")
      } | ${row.pStructural.toFixed(2)} | ${row.pRls.toFixed(2)} | ${
        markdownCell(`${row.kind.choice} (${row.kind.confidence.toFixed(2)})`)
      } | ${markdownCell(message)} |`,
    );
  }
  if (flagged.length === 0) {
    lines.push(
      "",
      annotated === statementCount
        ? "no disagreements"
        : `no disagreements in the ${annotated} annotated statements`,
    );
  }
  if (options.stopReason !== undefined) {
    lines.push(
      "",
      `TypeSafe advisory stopped after ${annotated} statements: ${options.stopReason}`,
    );
  }
  return lines.join("\n");
}

function markdownCell(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replaceAll("\\", "\\\\").replaceAll(
    "|",
    "\\|",
  );
}

function answerOfType<T extends NoulAnswer["type"] | ChoiceAnswer["type"]>(
  response: SystemOneResponse,
  id: string,
  type: T,
): Extract<NoulAnswer | ChoiceAnswer, { type: T }> {
  const answer = response.answers[id];
  if (!answer || answer.type !== type) {
    throw new TypeSafeUnavailable(`response missing ${type} answer "${id}"`);
  }
  return answer as Extract<NoulAnswer | ChoiceAnswer, { type: T }>;
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

async function changedMigrationFiles(
  base: string,
  head: string,
): Promise<readonly { file: string; sql: string }[]> {
  const output = await gitOutput([
    "diff",
    "--name-only",
    "--diff-filter=AM",
    "-z",
    base,
    head,
    "--",
    ...migrationRoots,
  ]);
  const files = output.split("\0").filter((file) => file.endsWith(".sql"));
  return await Promise.all(
    files.map(async (file) => ({ file, sql: await Deno.readTextFile(file) })),
  );
}

function unavailableMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "TypeSafe request unavailable";
}

async function annotate(
  base: string,
  head: string,
  apiKey: string,
): Promise<void> {
  const files = await changedMigrationFiles(base, head);
  if (files.length === 0) {
    console.log("TypeSafe advisory: no changed SQL migrations");
    return;
  }

  const allStatements = files.flatMap(({ file, sql }) =>
    splitStatements(sql).map((statement, index) => ({
      file,
      index,
      sql: statement,
    }))
  );
  if (allStatements.length === 0) {
    console.log("TypeSafe advisory: no changed SQL migration statements");
    return;
  }

  const statements = allStatements.slice(0, 40);
  const rows: BoundaryAnnotationRow[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  try {
    for (const statement of statements) {
      const rail: BoundaryVerdict = classifyStatement(statement.sql);
      const response = await askSystemOne(
        {
          state: {
            policy: BOUNDARY_POLICY,
            statement: {
              file: statement.file,
              index: statement.index,
              sql: statement.sql,
            },
          },
          questions: QUESTIONS,
        },
        { apiKey },
      );
      const structural = answerOfType(response, "structural_only", "noul");
      const kind = answerOfType(response, "kind", "choice");
      const rls = answerOfType(response, "rls", "noul");
      inputTokens += response.usage.input_tokens;
      outputTokens += response.usage.output_tokens;
      rows.push({
        file: statement.file,
        index: statement.index,
        railBehavior: rail?.behavior ?? null,
        pStructural: structural.noul,
        pRls: rls.noul,
        kind,
      });
    }
  } catch (error) {
    if (!(error instanceof TypeSafeUnavailable)) throw error;
    const message = unavailableMessage(error);
    if (rows.length === 0) {
      console.log(`TypeSafe advisory skipped: ${message}`);
      return;
    }
    await publishStepSummary(
      renderSummary(rows, allStatements.length, files.length, {
        capped: allStatements.length > statements.length,
        inputTokens,
        outputTokens,
        stopReason: message,
      }),
    );
    return;
  }

  await publishStepSummary(
    renderSummary(rows, allStatements.length, files.length, {
      capped: allStatements.length > statements.length,
      inputTokens,
      outputTokens,
    }),
  );
}
async function main(): Promise<void> {
  const [mode, base, head] = Deno.args;
  if (mode !== "--commit-range" || !base || !head || Deno.args.length !== 3) {
    console.error(
      "Usage: annotate-migration-boundary.ts --commit-range <base> <head>",
    );
    // Advisory wiring errors stay visible as exit 2 despite continue-on-error.
    Deno.exit(2);
  }

  const apiKey = readTypeSafeApiKey();
  if (apiKey === null) {
    console.log("TypeSafe advisory skipped: TYPESAFE_API_KEY not set");
    return;
  }

  try {
    await annotate(base, head, apiKey);
  } catch (error) {
    console.log(`TypeSafe advisory skipped: ${unavailableMessage(error)}`);
  }
}

if (import.meta.main) await main();
