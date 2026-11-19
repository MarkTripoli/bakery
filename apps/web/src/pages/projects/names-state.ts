import type {
  RoleBindingCreate,
  RoleBindingResponse,
  RoleBindingUpdate,
} from "../../api/client.ts";

/** The longest a name, its other names or its note may be (the server's limit). */
export const NAME_LIMIT = 200;

/** What a person types for one name of a repository: its name, other names for it, and a note. */
export type NameValues = {
  readonly name: string;
  readonly others: string;
  readonly note: string;
};

export const EMPTY_NAME: NameValues = { name: "", others: "", note: "" };

/** The names that point at one repository, active ones first, each group by name. */
export function namesOf(
  bindings: readonly RoleBindingResponse[],
  repositoryId: string,
): RoleBindingResponse[] {
  return bindings
    .filter((binding) => binding.repositoryId === repositoryId)
    .sort((a, b) =>
      Number(a.archivedAt !== null) - Number(b.archivedAt !== null) ||
      a.role.localeCompare(b.role)
    );
}

export function isActive(binding: RoleBindingResponse): boolean {
  return binding.archivedAt === null;
}

/** The values of a name already saved, for editing. */
export function valuesOf(binding: RoleBindingResponse): NameValues {
  return {
    name: binding.role,
    others: binding.alias ?? "",
    note: binding.provenance ?? "",
  };
}

export type NameProblem = "empty" | "tooLong";

/** What is wrong with the name being entered, or null: a name is required and each field is bounded. */
export function nameProblem(values: NameValues): NameProblem | null {
  if (values.name.trim() === "") return "empty";
  if (
    values.name.trim().length > NAME_LIMIT ||
    values.others.trim().length > NAME_LIMIT ||
    values.note.trim().length > NAME_LIMIT
  ) return "tooLong";
  return null;
}

const orNull = (text: string) => text.trim() === "" ? null : text.trim();

export function createInput(
  applicationId: string,
  repositoryId: string,
  values: NameValues,
): RoleBindingCreate {
  return {
    applicationId,
    repositoryId,
    role: values.name.trim(),
    alias: orNull(values.others),
    provenance: orNull(values.note),
  };
}

export function updateInput(
  binding: RoleBindingResponse,
  values: NameValues,
): RoleBindingUpdate {
  return {
    expectedVersion: binding.version,
    role: values.name.trim(),
    alias: orNull(values.others),
    provenance: orNull(values.note),
  };
}

/** Archive or restore: the same name, switched off or on again. */
export function archiveInput(
  binding: RoleBindingResponse,
  now: Date,
): RoleBindingUpdate {
  return {
    expectedVersion: binding.version,
    archivedAt: isActive(binding) ? now.toISOString() : null,
  };
}

/** Whether the values differ from what is saved, so Save is only offered for a change. */
export function changed(
  binding: RoleBindingResponse,
  values: NameValues,
): boolean {
  const saved = valuesOf(binding);
  return saved.name !== values.name.trim() ||
    saved.others !== values.others.trim() ||
    saved.note !== values.note.trim();
}
