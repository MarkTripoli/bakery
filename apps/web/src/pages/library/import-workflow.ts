import type { WorkflowVersionCreate } from "../../api/client.ts";

/** Where in the file a problem is, in terms a person can find. */
export type ProblemWhere =
  | { readonly kind: "whole" }
  | {
    readonly kind: "step";
    readonly number: number;
    readonly field: string | null;
  }
  | { readonly kind: "path"; readonly path: string };

/** One thing wrong with a definition: where, and the checker's sentence. */
export type ImportProblem = {
  readonly where: ProblemWhere;
  readonly message: string;
};

/** What reading a definition file or pasted text gave. */
export type ImportRead =
  | {
    readonly ok: true;
    readonly definition: WorkflowVersionCreate["definition"];
    /** The steps the definition lists, when it lists them flat. */
    readonly steps: number | null;
    /** A name the definition gives itself, when it does. */
    readonly name: string | null;
  }
  | { readonly ok: false; readonly problems: readonly ImportProblem[] };

/** A JSON Pointer ("/steps/2/uses") as a place a person can find ("Step 3, uses"). */
export function whereOf(path: string): ProblemWhere {
  if (path === "") return { kind: "whole" };
  const parts = path.split("/").slice(1).map((part) =>
    part.replace(/~1/g, "/").replace(/~0/g, "~")
  );
  if (parts[0] === "steps" && /^\d+$/.test(parts[1] ?? "")) {
    return {
      kind: "step",
      number: Number(parts[1]) + 1,
      field: parts.length > 2 ? parts.slice(2).join(".") : null,
    };
  }
  return { kind: "path", path: parts.join(".") };
}

/** The checker's issues (a path and a sentence each) as problems to show. */
export function problemsOf(
  issues: readonly { readonly path: string; readonly message: string }[],
): ImportProblem[] {
  return issues.map((issue) => ({
    where: whereOf(issue.path),
    message: issue.message,
  }));
}

/** A file name as a name for the workflow: "release-train.yaml" is "Release train". */
export function nameFromFile(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, "").replace(/\.(ya?ml|json)$/i, "")
    .replace(/-v\d+$/i, "").replace(/[-_]+/g, " ").trim();
  if (base === "") return "";
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/**
 * Reads a definition from text (YAML, which includes JSON). The reader
 * refuses what the runtime would (anchors, tags, duplicate keys, too large),
 * so what comes back is plain data; the server still checks it.
 */
export async function readImport(text: string): Promise<ImportRead> {
  // Loaded on first use: the YAML reader is only needed when importing.
  const { decodeWorkflowYaml } = await import(
    "@bakery/contracts/workflow-compiler"
  );
  const decoded = decodeWorkflowYaml(text);
  if (!decoded.ok) {
    return { ok: false, problems: problemsOf(decoded.diagnostics) };
  }
  const value = decoded.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      ok: false,
      problems: [{
        where: { kind: "whole" },
        message: "The definition must be one object.",
      }],
    };
  }
  const record = value as Record<string, unknown>;
  return {
    ok: true,
    definition: value as WorkflowVersionCreate["definition"],
    steps: Array.isArray(record.steps) ? record.steps.length : null,
    name: typeof record.name === "string" && record.name.trim() !== ""
      ? record.name.trim().slice(0, 200)
      : null,
  };
}
