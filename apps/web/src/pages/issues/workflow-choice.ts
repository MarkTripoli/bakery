import type { WorkflowDefinitionResponse } from "../../api/client.ts";
import type { SettingsForm } from "./settings-model.ts";

export type WrittenWorkflow = Readonly<{
  id: string;
  name: string;
  description: string;
}>;

const WRITTEN_PREFIX = "workflow:";

export function writtenWorkflowsOf(
  items: readonly WorkflowDefinitionResponse[],
): WrittenWorkflow[] {
  return items
    .filter((item) =>
      item.origin.kind !== "catalog" && item.enabled &&
      item.activeVersionId !== null && !item.needsInputs
    )
    .map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description ?? "",
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function writtenWorkflowIdOf(value: string): string | null {
  return value.startsWith(WRITTEN_PREFIX)
    ? value.slice(WRITTEN_PREFIX.length) || null
    : null;
}

export function workflowOptionsOf(
  written: readonly WrittenWorkflow[],
  keptWorkflowId: string | null,
  keptName: string,
): { label: string; value: string }[] {
  const listed = written.map((workflow) => ({
    label: workflow.name,
    value: WRITTEN_PREFIX + workflow.id,
  }));
  return keptWorkflowId === null ||
      written.some((workflow) => workflow.id === keptWorkflowId)
    ? listed
    : [...listed, {
      label: keptName,
      value: WRITTEN_PREFIX + keptWorkflowId,
    }];
}

export function workflowValueOf(form: SettingsForm): string {
  if (form.preset !== null) return form.preset;
  return form.keptWorkflowId === null
    ? ""
    : WRITTEN_PREFIX + form.keptWorkflowId;
}

export function hasWorkflow(form: SettingsForm): boolean {
  return form.preset !== null || form.keptWorkflowId !== null;
}

export function writtenWorkflowOf(
  form: SettingsForm,
  written: readonly WrittenWorkflow[],
): WrittenWorkflow | undefined {
  return written.find((workflow) => workflow.id === form.keptWorkflowId);
}
