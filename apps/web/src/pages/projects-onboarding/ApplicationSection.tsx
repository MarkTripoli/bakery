import { useState } from "react";
import * as UI from "@bakery/ui";
import type {
  ApplicationCreate,
  ApplicationResponse,
  ApplicationUpdate,
} from "../../api/client.ts";
import type { ProjectsOnboardingLabels } from "./labels.ts";
import {
  applicationCreateInput,
  type ApplicationFormValues,
  EMPTY_APPLICATION_FORM,
  type FieldErrors,
  validateApplicationForm,
} from "./validation.ts";

type ApplicationSectionProps = Readonly<{
  labels: ProjectsOnboardingLabels;
  onCreate: (input: ApplicationCreate) => Promise<void>;
  selectedApplication: ApplicationResponse | null;
  onUpdate: (
    id: string,
    input: ApplicationUpdate,
    ifMatch: string,
  ) => Promise<void>;
  updatePending: boolean;
  createPending: boolean;
}>;

type ApplicationField = keyof ApplicationFormValues;

export function ApplicationSection({
  createPending,
  labels,
  onCreate,
  selectedApplication,
  onUpdate,
  updatePending,
}: ApplicationSectionProps) {
  const [values, setValues] = useState<ApplicationFormValues>(
    EMPTY_APPLICATION_FORM,
  );
  const [errors, setErrors] = useState<FieldErrors<ApplicationField>>({});
  const [submitError, setSubmitError] = useState(false);

  const submit = async () => {
    const nextErrors = validateApplicationForm(values);
    setErrors(nextErrors);
    setSubmitError(false);
    if (Object.keys(nextErrors).length > 0) return;
    try {
      await onCreate(applicationCreateInput(values));
      setValues(EMPTY_APPLICATION_FORM);
      setErrors({});
    } catch {
      setSubmitError(true);
    }
  };

  const error = (field: ApplicationField) => {
    const code = errors[field];
    return code === undefined ? undefined : labels.validation[code];
  };

  return (
    <UI.Stack data-testid="projects-onboarding-applications" gap="spacious">
      <p>{labels.applications.description}</p>
      <UI.SettingsSection
        title={labels.applications.createHeading}
        variant="stack"
      >
        {submitError
          ? (
            <UI.InlineNotice tone="error">
              {labels.errors.mutation}
            </UI.InlineNotice>
          )
          : null}
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <UI.Stack gap="standard">
            <UI.Field
              error={error("slug")}
              htmlFor="projects-onboarding-application-slug"
              label={labels.applications.fields.slug}
              required
            >
              <UI.TextInput
                autoComplete="off"
                id="projects-onboarding-application-slug"
                invalid={errors.slug !== undefined}
                name="slug"
                onChange={(slug) =>
                  setValues((current) => ({ ...current, slug }))}
                required
                type="text"
                value={values.slug}
              />
            </UI.Field>
            <UI.Field
              error={error("name")}
              htmlFor="projects-onboarding-application-name"
              label={labels.applications.fields.name}
              required
            >
              <UI.TextInput
                autoComplete="organization"
                id="projects-onboarding-application-name"
                invalid={errors.name !== undefined}
                name="name"
                onChange={(name) =>
                  setValues((current) => ({ ...current, name }))}
                required
                type="text"
                value={values.name}
              />
            </UI.Field>
            <UI.Field
              error={error("description")}
              htmlFor="projects-onboarding-application-description"
              label={labels.applications.fields.description}
            >
              <UI.TextInput
                autoComplete="off"
                id="projects-onboarding-application-description"
                invalid={errors.description !== undefined}
                name="description"
                onChange={(description) =>
                  setValues((current) => ({ ...current, description }))}
                type="text"
                value={values.description}
              />
            </UI.Field>
            <UI.Button
              disabled={createPending}
              loading={createPending}
              type="submit"
            >
              {createPending
                ? labels.applications.actions.creating
                : labels.applications.actions.create}
            </UI.Button>
          </UI.Stack>
        </form>
      </UI.SettingsSection>
      {selectedApplication
        ? (
          <ApplicationEditor
            key={`${selectedApplication.id}:${selectedApplication.version}`}
            application={selectedApplication}
            labels={labels}
            onUpdate={onUpdate}
            pending={updatePending}
          />
        )
        : null}
    </UI.Stack>
  );
}

export function ApplicationEditor(
  { application, labels, onUpdate, pending }: Readonly<{
    application: ApplicationResponse;
    labels: ProjectsOnboardingLabels;
    onUpdate: (
      id: string,
      input: ApplicationUpdate,
      ifMatch: string,
    ) => Promise<void>;
    pending: boolean;
  }>,
) {
  const [values, setValues] = useState<ApplicationFormValues>({
    slug: application.slug,
    name: application.name,
    description: application.description,
  });
  const [errors, setErrors] = useState<FieldErrors<ApplicationField>>({});
  const [failed, setFailed] = useState(false);
  const update = async (input: ApplicationUpdate) => {
    setFailed(false);
    try {
      await onUpdate(application.id, input, `"${application.version}"`);
    } catch {
      setFailed(true);
    }
  };
  return (
    <UI.SettingsSection title={labels.applications.editHeading} variant="stack">
      {failed
        ? (
          <UI.InlineNotice role="alert" tone="error">
            {labels.errors.mutation}
          </UI.InlineNotice>
        )
        : null}
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          const next = validateApplicationForm(values);
          setErrors(next);
          if (Object.keys(next).length === 0) {
            void update(
              applicationCreateInput(values),
            );
          }
        }}
      >
        <UI.Stack gap="standard">
          {(["slug", "name", "description"] as const).map((field) => (
            <UI.Field
              key={field}
              htmlFor={`projects-application-edit-${field}`}
              label={labels.applications.fields[field]}
              error={errors[field]
                ? labels.validation[errors[field]]
                : undefined}
              required={field !== "description"}
            >
              <UI.TextInput
                id={`projects-application-edit-${field}`}
                name={field}
                type="text"
                autoComplete="off"
                value={values[field]}
                invalid={errors[field] !== undefined}
                required={field !== "description"}
                onChange={(value) =>
                  setValues((current) => ({ ...current, [field]: value }))}
              />
            </UI.Field>
          ))}
          <UI.Inline gap="compact">
            <UI.Button type="submit" disabled={pending} loading={pending}>
              {pending
                ? labels.applications.actions.saving
                : labels.applications.actions.save}
            </UI.Button>
            <UI.Button
              type="button"
              disabled={pending}
              variant="secondary"
              onClick={() =>
                void update({
                  archivedAt: application.archivedAt === null
                    ? new Date().toISOString()
                    : null,
                })}
            >
              {application.archivedAt === null
                ? labels.applications.actions.archive
                : labels.applications.actions.reactivate}
            </UI.Button>
          </UI.Inline>
        </UI.Stack>
      </form>
    </UI.SettingsSection>
  );
}
