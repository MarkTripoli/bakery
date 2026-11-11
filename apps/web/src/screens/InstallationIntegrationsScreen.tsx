import { type FormEvent, type ReactNode, useId } from "react";
import * as UI from "@bakery/ui";
import type { MessageKey } from "@bakery/i18n";
import { useI18n } from "../i18n/I18nProvider.tsx";
import {
  type ExistingAppStatus,
  type ExistingAppValues,
  ExistingGitHubAppForm,
  type StoredSecretRevisions,
} from "./ExistingGitHubAppForm.tsx";

/** Coarse callback outcome the server carries in `?githubAppRegistration=`. */
export type RegistrationOutcome =
  | "registered"
  | "state_rejected"
  | "already_registered"
  | "conversion_failed"
  | "storage_failed";

export type IntegrationsView =
  | "loading"
  | "error"
  | "forbidden"
  | "unregistered"
  | "registered";

export type RegisteredApp = {
  readonly name: string;
  readonly appId: number;
  readonly slug: string;
  readonly ownerLogin: string;
  readonly ownerType: string;
  readonly registeredAt: string | null;
  readonly permissions: readonly (readonly [name: string, level: string])[];
  /** Active revision of each stored secret; never a value. */
  readonly secrets: StoredSecretRevisions;
};

/** The existing-App form's typed values, outcome and callbacks, owned by the page. */
export type ExistingAppForm = {
  readonly values: ExistingAppValues;
  readonly status: ExistingAppStatus;
  readonly onChange: (field: keyof ExistingAppValues, value: string) => void;
  readonly onSubmit: () => void;
};

/** Single-use values GitHub needs; held only until the form posts. */
export type ManifestHandoff = {
  readonly registrationUrl: string;
  readonly manifest: string;
  readonly state: string;
};

/** GitHub's App name limit; names are also unique across github.com. */
export const APP_NAME_MAX_LENGTH = 34;

/** The trimmed name when GitHub would accept its length, else null. */
export function parseAppName(value: string): string | null {
  const name = value.trim();
  return name.length >= 1 && name.length <= APP_NAME_MAX_LENGTH ? name : null;
}

export type CreateStatus =
  | "idle"
  | "starting"
  | "handoff"
  | "unavailable"
  | "failed";

export type InstallationIntegrationsScreenProps = {
  readonly view: IntegrationsView;
  readonly app: RegisteredApp | null;
  readonly outcome: RegistrationOutcome | null;
  readonly createStatus: CreateStatus;
  readonly handoff: ManifestHandoff | null;
  /** The App name the manifest asks GitHub for. */
  readonly appName: string;
  readonly onAppNameChange: (value: string) => void;
  readonly onCreate: () => void;
  readonly onReload: () => void;
  readonly onDismissOutcome: () => void;
  readonly existingApp: ExistingAppForm;
  /** The object storage section, rendered below the GitHub App area. */
  readonly storage?: ReactNode;
};

const OUTCOME_COPY: Readonly<
  Record<
    Exclude<RegistrationOutcome, "registered">,
    {
      readonly tone: "error" | "information";
      readonly body: MessageKey;
      readonly title?: MessageKey;
      readonly retry: boolean;
    }
  >
> = {
  state_rejected: {
    tone: "error",
    title: "settings.integrations.outcome.stateRejected.title",
    body: "settings.integrations.outcome.stateRejected.body",
    retry: true,
  },
  already_registered: {
    tone: "information",
    body: "settings.integrations.outcome.alreadyRegistered",
    retry: false,
  },
  conversion_failed: {
    tone: "error",
    body: "settings.integrations.outcome.conversionFailed",
    retry: true,
  },
  storage_failed: {
    tone: "error",
    body: "settings.integrations.outcome.storageFailed",
    retry: true,
  },
};

export function InstallationIntegrationsScreen(
  {
    view,
    app,
    outcome,
    createStatus,
    handoff,
    appName,
    onAppNameChange,
    onCreate,
    onReload,
    onDismissOutcome,
    existingApp,
    storage,
  }: InstallationIntegrationsScreenProps,
) {
  const { translate, locale, timeZone } = useI18n();
  const appNameId = useId();
  const busy = createStatus === "starting" || createStatus === "handoff";
  const appNameValid = parseAppName(appName) !== null;
  const submitCreate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (appNameValid && !busy) onCreate();
  };
  const date = (value: string | null) =>
    value
      ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone })
        .format(new Date(value))
      : "";
  const ownerType = (value: string) =>
    value === "Organization"
      ? translate("settings.integrations.owner.organization")
      : value === "User"
      ? translate("settings.integrations.owner.user")
      : value;
  const failed = outcome && outcome !== "registered"
    ? OUTCOME_COPY[outcome]
    : null;
  const canCreate = view === "unregistered";
  const createForm = (
    <form
      aria-busy={busy || undefined}
      data-testid="github-app-create"
      noValidate
      onSubmit={submitCreate}
    >
      <UI.Stack gap="standard">
        <UI.Field
          error={appNameValid
            ? undefined
            : translate("settings.integrations.appName.invalid", {
              max: APP_NAME_MAX_LENGTH,
            })}
          hint={translate("settings.integrations.appName.hint", {
            max: APP_NAME_MAX_LENGTH,
          })}
          htmlFor={appNameId}
          label={translate("settings.integrations.appName")}
          required
          state={appNameValid ? "default" : "invalid"}
        >
          <UI.TextInput
            autoComplete="off"
            disabled={busy}
            id={appNameId}
            invalid={!appNameValid}
            name="appName"
            onChange={onAppNameChange}
            required
            type="text"
            value={appName}
          />
        </UI.Field>
        <div>
          <UI.Button
            disabled={busy || !appNameValid}
            loading={createStatus === "starting"}
            type="submit"
          >
            {translate(
              busy
                ? "settings.integrations.creating"
                : "settings.integrations.create",
            )}
          </UI.Button>
        </div>
      </UI.Stack>
    </form>
  );
  return (
    <UI.SettingsContent data-testid="installation-integrations">
      <UI.IntegrationAppRegistration
        description={translate("settings.integrations.description")}
        notices={
          <>
            {view === "loading"
              ? (
                <UI.AlertBanner tone="information">
                  {translate("settings.integrations.loading")}
                </UI.AlertBanner>
              )
              : null}
            {view === "forbidden"
              ? (
                <UI.AlertBanner tone="information">
                  {translate("settings.integrations.forbidden")}
                </UI.AlertBanner>
              )
              : null}
            {view === "error"
              ? (
                <UI.AlertBanner
                  action={
                    <UI.Button onClick={onReload} type="button">
                      {translate("settings.integrations.retry")}
                    </UI.Button>
                  }
                  tone="error"
                >
                  {translate("settings.integrations.loadError")}
                </UI.AlertBanner>
              )
              : null}
            {outcome === "registered" && view === "registered"
              ? (
                <UI.AlertBanner
                  onDismiss={onDismissOutcome}
                  tone="success"
                >
                  {translate("settings.integrations.outcome.registered")}
                </UI.AlertBanner>
              )
              : null}
            {failed && view !== "loading" && view !== "forbidden" &&
                view !== "error"
              ? (
                <UI.AlertBanner
                  action={failed.retry && canCreate
                    ? (
                      <UI.Button
                        disabled={busy || !appNameValid}
                        onClick={onCreate}
                        type="button"
                      >
                        {translate("settings.integrations.outcome.retry")}
                      </UI.Button>
                    )
                    : undefined}
                  onDismiss={onDismissOutcome}
                  tone={failed.tone}
                >
                  {failed.title ? `${translate(failed.title)} ` : ""}
                  {translate(failed.body)}
                </UI.AlertBanner>
              )
              : null}
            {createStatus === "failed"
              ? (
                <UI.AlertBanner
                  action={
                    <UI.Button onClick={onCreate} type="button">
                      {translate("settings.integrations.retry")}
                    </UI.Button>
                  }
                  tone="error"
                >
                  {translate("settings.integrations.createFailed")}
                </UI.AlertBanner>
              )
              : null}
            {createStatus === "unavailable"
              ? (
                <UI.AlertBanner
                  action={
                    <UI.Button onClick={onCreate} type="button">
                      {translate("settings.integrations.retry")}
                    </UI.Button>
                  }
                  tone="error"
                >
                  {translate("settings.integrations.setupUnavailable")}
                </UI.AlertBanner>
              )
              : null}
            {createStatus === "handoff"
              ? (
                <UI.AlertBanner tone="information">
                  {translate("settings.integrations.handoff")}
                </UI.AlertBanner>
              )
              : null}
          </>
        }
        state={view}
        title={translate("settings.integrations.title")}
      >
        {view === "unregistered"
          ? (
            <>
              <UI.Heading level="section">
                {translate("settings.integrations.github.heading")}
              </UI.Heading>
              <UI.EmptyState
                description={translate(
                  "settings.integrations.unregistered.description",
                )}
                title={translate("settings.integrations.unregistered.title")}
              />
              {createForm}
              <ExistingGitHubAppForm
                mode="register"
                onChange={existingApp.onChange}
                onSubmit={existingApp.onSubmit}
                status={existingApp.status}
                stored={null}
                values={existingApp.values}
              />
            </>
          )
          : null}
        {view === "registered" && app
          ? (
            <>
              <UI.Heading level="section">
                {translate("settings.integrations.github.heading")}
              </UI.Heading>
              <UI.DescriptionList>
                <UI.DescriptionItem
                  description={app.name}
                  title={translate("settings.integrations.registered.name")}
                />
                <UI.DescriptionItem
                  description={String(app.appId)}
                  title={translate("settings.integrations.registered.id")}
                />
                <UI.DescriptionItem
                  description={app.slug}
                  title={translate("settings.integrations.registered.slug")}
                />
                <UI.DescriptionItem
                  description={translate(
                    "settings.integrations.registered.ownerType",
                    {
                      login: app.ownerLogin,
                      type: ownerType(app.ownerType),
                    },
                  )}
                  title={translate("settings.integrations.registered.owner")}
                />
                {app.registeredAt
                  ? (
                    <UI.DescriptionItem
                      description={date(app.registeredAt)}
                      title={translate(
                        "settings.integrations.registered.registeredAt",
                      )}
                    />
                  )
                  : null}
              </UI.DescriptionList>
              <UI.Heading level="section">
                {translate("settings.integrations.permissions.heading")}
              </UI.Heading>
              {app.permissions.length === 0
                ? (
                  <UI.Text variant="muted">
                    {translate("settings.integrations.permissions.empty")}
                  </UI.Text>
                )
                : (
                  <UI.CapabilityList
                    aria-label={translate(
                      "settings.integrations.permissions.label",
                    )}
                    items={app.permissions.map(([name, level]) => ({
                      id: name,
                      title: name,
                      value: level === "read" || level === "write" ||
                          level === "admin"
                        ? translate(`settings.integrations.permission.${level}`)
                        : level,
                    }))}
                    variant="access"
                  />
                )}
              <UI.Text variant="muted">
                {translate("settings.integrations.secrets.note")}
              </UI.Text>
              <ExistingGitHubAppForm
                mode="replace"
                onChange={existingApp.onChange}
                onSubmit={existingApp.onSubmit}
                status={existingApp.status}
                stored={app.secrets}
                values={existingApp.values}
              />
            </>
          )
          : null}
        {handoff
          ? (
            <UI.HandoffForm
              action={handoff.registrationUrl}
              autoSubmit
              data-testid="github-manifest-handoff"
              fields={{ manifest: handoff.manifest, state: handoff.state }}
            />
          )
          : null}
      </UI.IntegrationAppRegistration>
      {storage}
    </UI.SettingsContent>
  );
}
