import type {
  WorkflowPresetResponse,
  WorkflowVersionCreate,
  WorkflowVersionResponse,
} from "../../api/client.ts";

/** The longest a workflow name may be (the server's limit). */
export const NAME_LIMIT = 200;
const SLUG_LIMIT = 100;

/** "Release train" becomes "Release train (copy)", kept within the name limit. */
export function copyName(name: string, suffix: string): string {
  const base = `${name.trim()} ${suffix}`.trim();
  return base.length <= NAME_LIMIT
    ? base
    : `${name.trim().slice(0, NAME_LIMIT - suffix.length - 1)} ${suffix}`;
}

/** A name as the lower-case words and hyphens a workflow's address uses. */
export function slugOf(name: string): string {
  const slug = name.normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, SLUG_LIMIT - 6).replace(/-+$/g, "");
  return slug === "" ? "workflow" : slug;
}

/** The first address from the name that no workflow of the organization uses yet. */
export function uniqueSlug(name: string, taken: ReadonlySet<string>): string {
  const base = slugOf(name);
  if (!taken.has(base)) return base;
  for (let number = 2;; number += 1) {
    const candidate = `${base}-${number}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** What a copy starts from: the definition (the steps) and, when there is one, its file. */
export type CopySource = {
  /** The name of what is copied, which the copy's name starts from. */
  readonly name: string;
  /** What the copy says it is for. */
  readonly description: string;
  /** The version the copy starts from, shown to the person. */
  readonly revision: number;
  readonly definition: WorkflowVersionCreate["definition"];
  readonly sourceYaml?: string;
};

/** A built-in workflow's steps as a definition a copy can start from. */
export function presetSource(
  preset: Pick<WorkflowPresetResponse, "steps" | "revision">,
  copy: { readonly title: string; readonly description: string | null },
): CopySource {
  return {
    name: copy.title,
    description: copy.description ?? "",
    revision: preset.revision,
    definition: {
      steps: preset.steps.map((step) => ({ id: step.id, uses: step.uses })),
    },
  };
}

/** A version of the organization's own workflow as a copy's starting point. */
export function versionSource(
  workflow: { readonly name: string; readonly description?: string | null },
  version: Pick<
    WorkflowVersionResponse,
    "revision" | "normalizedSpec" | "sourceYaml"
  >,
): CopySource {
  return {
    name: workflow.name,
    description: workflow.description ?? "",
    revision: version.revision,
    definition: version.normalizedSpec as WorkflowVersionCreate["definition"],
    ...(typeof version.sourceYaml === "string" && version.sourceYaml !== ""
      ? { sourceYaml: version.sourceYaml }
      : {}),
  };
}
