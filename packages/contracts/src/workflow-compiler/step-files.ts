/**
 * A step's `files` section (chapter 25 section 17.6, O44, O45, O53, issue
 * #448): the areas of the storage tree an agent in the step may read and the
 * areas it may write. Areas are named, never paths: a path would let a
 * definition name a folder that only exists in one organization, and a named
 * area resolves against the run's own work item and project.
 *
 * Absent means the defaults O44 (read) and O45 (write). A definition may only
 * narrow them: `read: [inputs]` is an inputs-only step, `write: [outputs]` stops
 * side-writes. Widening is a person's grant (#729), never a definition's, so
 * an area outside the write defaults is refused by name at compile time.
 */

import { z } from "zod";
import { WORKFLOW_ACTION_METADATA } from "../workflow-action-registry.ts";

/**
 * Areas a step may read. `inputs`, `outputs` and `workspace` are the
 * step's own context directory, declared outputs and writable workspace;
 * the rest are places in the storage tree.
 */
export const WORKFLOW_FILE_READ_AREAS = Object.freeze(
  [
    "inputs",
    "outputs",
    "workspace",
    "work_item",
    "project",
    "shared",
    "library",
    "connections",
  ] as const,
);
export type WorkflowFileReadArea = typeof WORKFLOW_FILE_READ_AREAS[number];

/**
 * Areas a step may write. `run_folder` is `runs/<run>/<step>/` of the work
 * item, `attachments` the work item's attachments, `assets` and
 * `workspaces` the project's.
 */
export const WORKFLOW_FILE_WRITE_AREAS = Object.freeze(
  [
    "outputs",
    "workspace",
    "run_folder",
    "attachments",
    "assets",
    "workspaces",
  ] as const,
);
export type WorkflowFileWriteArea = typeof WORKFLOW_FILE_WRITE_AREAS[number];

/** The read areas that are places in the storage tree, reached by the files tools. */
export const WORKFLOW_FILE_TREE_READ_AREAS: readonly WorkflowFileReadArea[] =
  Object.freeze(["work_item", "project", "shared", "library", "connections"]);

/** The write areas that are places in the storage tree, written by the files tools. */
export const WORKFLOW_FILE_TREE_WRITE_AREAS: readonly WorkflowFileWriteArea[] =
  Object.freeze(["run_folder", "attachments", "assets", "workspaces"]);

export const WorkflowFileReadAreaSchema = z.enum(WORKFLOW_FILE_READ_AREAS)
  .describe(
    "One area a step's agent may read: its pinned inputs, its outputs, its workspace, the work item's folder, the project tree, /shared, published /library items, or the connections the definition binds.",
  );

export const WorkflowFileWriteAreaSchema = z.enum(WORKFLOW_FILE_WRITE_AREAS)
  .describe(
    "One area a step's agent may write: its declared outputs, its workspace, its own run folder under the work item, the work item's attachments, or the project's assets and workspaces.",
  );

export const MAX_STEP_BOUND_CONNECTIONS = 16;

const BOUND_CONNECTION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isBoundConnectionId(value: unknown): value is string {
  return typeof value === "string" && BOUND_CONNECTION_ID.test(value);
}

export const WorkflowStepFilesSchema = z.object({
  read: z.array(WorkflowFileReadAreaSchema).max(
    WORKFLOW_FILE_READ_AREAS.length,
  ).describe(
    "Areas the step may read, in canonical order and without repeats; [inputs] alone makes an inputs-only step that sees only its pinned inputs.",
  ),
  write: z.array(WorkflowFileWriteAreaSchema).max(
    WORKFLOW_FILE_WRITE_AREAS.length,
  ).describe(
    "Areas the step may write, in canonical order and without repeats; [outputs] alone stops side-writes. /shared and personal folders are never named here: they need a person's grant.",
  ),
  connections: z.array(
    z.string().regex(BOUND_CONNECTION_ID).describe(
      "Id of one storage connection of the organization, in lower case.",
    ),
  ).min(1).max(MAX_STEP_BOUND_CONNECTIONS).optional().describe(
    "Storage connections the step binds (O44), sorted and without repeats: its agent reads /connections/<connection> for exactly these, and read must name connections. Absent, the step's agent reads no connection without a person's grant. Each must exist in the organization and be readable by the person who starts the run.",
  ),
}).strict().describe(
  "A step's files section: the storage areas its agent may read and write. Absent means the O44 read and O45 write defaults; a definition can narrow them but never widen them.",
);

export type WorkflowStepFiles = z.infer<typeof WorkflowStepFilesSchema>;

/** O44 and O45: what a step with no files section may read and write. */
export const DEFAULT_STEP_FILES: Readonly<{
  read: readonly WorkflowFileReadArea[];
  write: readonly WorkflowFileWriteArea[];
}> = Object.freeze({
  read: WORKFLOW_FILE_READ_AREAS,
  write: WORKFLOW_FILE_WRITE_AREAS,
});

/**
 * What a files section that names `read` but not `write` may write: only
 * the step's own outputs and workspace. An omitted write is least privilege,
 * not the O45 defaults, so a read-only section never reaches the tree's write
 * areas (#448).
 */
export const OMITTED_STEP_FILES_WRITE: readonly WorkflowFileWriteArea[] = Object
  .freeze(["outputs", "workspace"] as const);

/** The files a step runs with: its own section, or the defaults when it has none. */
export function resolveStepFiles(
  files: WorkflowStepFiles | undefined,
): Readonly<{
  read: readonly WorkflowFileReadArea[];
  write: readonly WorkflowFileWriteArea[];
}> {
  return files ?? DEFAULT_STEP_FILES;
}

/**
 * The files section `sealed: true` expands into (O53): read only the step's
 * pinned inputs, write only its declared outputs.
 */
export const SEALED_STEP_FILES: Readonly<{
  read: readonly WorkflowFileReadArea[];
  write: readonly WorkflowFileWriteArea[];
}> = Object.freeze({
  read: Object.freeze(["inputs"] as const),
  write: Object.freeze(["outputs"] as const),
});

/**
 * A step's `sealed` flag as authored. It is sugar: the compiler expands it into
 * the files section and the normalized node and plan never carry it.
 */
export const WorkflowStepSealedSchema = z.boolean().describe(
  "Seals the step (O53): true expands into the files section {read: [inputs], write: [outputs]}, so the agent sees only its pinned inputs and writes only its declared outputs, with no storage tools. It is authoring sugar: the compiled document and plan carry only the files section, so a sealed step and its explicit files section compile to the same plan. false leaves the defaults. Absent, a step that runs an evaluation action (evaluation.sample, evaluation.check, evaluation.score) with no files section of its own is sealed by default; any other step keeps the defaults. An explicit files section always wins over that default.",
);

/**
 * Whether a step running this action is sealed when it authors neither
 * `sealed` nor a files section (O53): the evaluation actions, which an
 * evaluation run's steps run, so a sample or a score sees only its pinned
 * inputs and writes only its declared outputs.
 */
export function sealedByDefault(action: string): boolean {
  return Object.hasOwn(WORKFLOW_ACTION_METADATA, action) &&
    WORKFLOW_ACTION_METADATA[action as keyof typeof WORKFLOW_ACTION_METADATA]
        .effectPolicy === "evaluation_write";
}

export function boundStepConnections(
  files:
    | Readonly<{
      read: readonly WorkflowFileReadArea[];
      connections?: readonly string[];
    }>
    | undefined,
): readonly string[] {
  if (files === undefined || !files.read.includes("connections")) return [];
  return files.connections ?? [];
}

/** Whether a step reads only its pinned inputs (O53). */
export function readsOnlyInputs(files: WorkflowStepFiles | undefined): boolean {
  const resolved = resolveStepFiles(files);
  return resolved.read.length === 1 && resolved.read[0] === "inputs";
}
