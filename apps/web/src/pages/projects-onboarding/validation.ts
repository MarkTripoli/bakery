import type {
  ApplicationCreate,
  RepositoryCreate,
  RepositoryUpdate,
} from "../../api/client.ts";

export type ProjectValidationError =
  | "required"
  | "invalidSlug"
  | "tooLong"
  | "invalidIdentity"
  | "invalidUuid"
  | "selectApplication";

export type ApplicationFormValues = Readonly<{
  slug: string;
  name: string;
  description: string;
}>;

export type RepositoryFormValues = Readonly<{
  slug: string;
  applicationId: string;
  integrationConnectionId: string;
  providerRepoId: string;
  owner: string;
  name: string;
  defaultBranch: string;
}>;

export type RepositoryEditValues = Readonly<{
  name: string;
  defaultBranch: string;
}>;

export type FieldErrors<Field extends string> = Partial<
  Record<Field, ProjectValidationError>
>;

export const EMPTY_APPLICATION_FORM: ApplicationFormValues = {
  slug: "",
  name: "",
  description: "",
};

export const EMPTY_REPOSITORY_FORM: RepositoryFormValues = {
  slug: "",
  applicationId: "",
  integrationConnectionId: "",
  providerRepoId: "",
  owner: "",
  name: "",
  defaultBranch: "",
};

const APPLICATION_SLUG_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const REPOSITORY_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,198}[a-z0-9])?$/;
const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function required(value: string): ProjectValidationError | undefined {
  return value.trim() === "" ? "required" : undefined;
}

function bounded(
  value: string,
  maxLength: number,
): ProjectValidationError | undefined {
  return value.length > maxLength ? "tooLong" : undefined;
}

function identity(value: string): ProjectValidationError | undefined {
  return IDENTITY_PATTERN.test(value) ? undefined : "invalidIdentity";
}

function uuid(value: string): ProjectValidationError | undefined {
  return UUID_PATTERN.test(value) ? undefined : "invalidUuid";
}

export function validateApplicationForm(
  values: ApplicationFormValues,
): FieldErrors<keyof ApplicationFormValues> {
  const errors: FieldErrors<keyof ApplicationFormValues> = {};
  errors.slug = required(values.slug) ??
    bounded(values.slug, 100) ??
    (APPLICATION_SLUG_PATTERN.test(values.slug) ? undefined : "invalidSlug");
  errors.name = required(values.name) ?? bounded(values.name, 200);
  errors.description = bounded(values.description, 2_000);
  return withoutUndefined(errors);
}

export function applicationCreateInput(
  values: ApplicationFormValues,
): ApplicationCreate {
  return {
    slug: values.slug.trim(),
    name: values.name.trim(),
    description: values.description.trim(),
  };
}

export function validateRepositoryForm(
  values: RepositoryFormValues,
): FieldErrors<keyof RepositoryFormValues> {
  const errors: FieldErrors<keyof RepositoryFormValues> = {};
  const repositorySlugMatch = values.slug.match(REPOSITORY_SLUG_PATTERN);
  errors.slug = required(values.slug) ??
    (repositorySlugMatch?.[0] === values.slug ? undefined : "invalidSlug");
  errors.applicationId = required(values.applicationId) === undefined
    ? undefined
    : "selectApplication";
  errors.integrationConnectionId = required(values.integrationConnectionId) ??
    uuid(values.integrationConnectionId);
  errors.providerRepoId = required(values.providerRepoId) ??
    bounded(values.providerRepoId, 65_536);
  errors.owner = required(values.owner) ?? identity(values.owner);
  errors.name = required(values.name) ?? identity(values.name);
  errors.defaultBranch = required(values.defaultBranch) ??
    bounded(values.defaultBranch, 255);
  return withoutUndefined(errors);
}

export function repositoryCreateInput(
  values: RepositoryFormValues,
): RepositoryCreate {
  return {
    applicationId: values.applicationId,
    slug: values.slug,
    integrationConnectionId: values.integrationConnectionId.trim(),
    providerRepoId: values.providerRepoId.trim(),
    owner: values.owner.trim(),
    name: values.name.trim(),
    defaultBranch: values.defaultBranch.trim(),
  };
}

export function validateRepositoryEdit(
  values: RepositoryEditValues,
): FieldErrors<keyof RepositoryEditValues> {
  const errors: FieldErrors<keyof RepositoryEditValues> = {};
  errors.name = required(values.name) ?? identity(values.name);
  errors.defaultBranch = required(values.defaultBranch) ??
    bounded(values.defaultBranch, 255);
  return withoutUndefined(errors);
}

export function repositoryUpdateInput(
  values: RepositoryEditValues,
): RepositoryUpdate {
  return {
    name: values.name.trim(),
    defaultBranch: values.defaultBranch.trim(),
  };
}

function withoutUndefined<Field extends string>(
  errors: FieldErrors<Field>,
): FieldErrors<Field> {
  for (const [field, error] of Object.entries(errors)) {
    if (error === undefined) delete errors[field as Field];
  }
  return errors;
}
