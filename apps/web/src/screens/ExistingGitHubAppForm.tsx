import { type FormEvent, useId } from "react";
import * as UI from "@bakery/ui";
import type { MessageKey } from "@bakery/i18n";
import { useI18n } from "../i18n/I18nProvider.tsx";

/** What the administrator typed. Secret fields are never filled from the server. */
export type ExistingAppValues = {
  readonly appId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly privateKey: string;
  readonly webhookSecret: string;
};

export const EMPTY_EXISTING_APP: ExistingAppValues = {
  appId: "",
  clientId: "",
  clientSecret: "",
  privateKey: "",
  webhookSecret: "",
};

/** The outcome of the last submit; every failure stored nothing. */
export type ExistingAppStatus =
  | "idle"
  | "saving"
  | "saved"
  | "rejected"
  | "malformed"
  | "stale"
  | "appMismatch"
  | "githubUnavailable"
  | "unavailable"
  | "failed";

/** Active revision of each stored secret; null when none is stored. */
export type StoredSecretRevisions = {
  readonly clientSecret: number | null;
  readonly privateKey: number | null;
  readonly webhookSecret: number | null;
};

export type ExistingGitHubAppFormProps = {
  /** `register` adds an App; `replace` rotates the registered App's credentials. */
  readonly mode: "register" | "replace";
  readonly values: ExistingAppValues;
  readonly status: ExistingAppStatus;
  /** Revisions of the registered App's secrets; null while registering. */
  readonly stored: StoredSecretRevisions | null;
  readonly onChange: (field: keyof ExistingAppValues, value: string) => void;
  readonly onSubmit: () => void;
};

const STATUS_COPY: Readonly<
  Record<
    Exclude<ExistingAppStatus, "idle" | "saving">,
    { readonly tone: "success" | "error"; readonly body: MessageKey }
  >
> = {
  saved: { tone: "success", body: "settings.integrations.existing.saved" },
  rejected: { tone: "error", body: "settings.integrations.existing.rejected" },
  malformed: {
    tone: "error",
    body: "settings.integrations.existing.malformed",
  },
  stale: { tone: "error", body: "settings.integrations.existing.stale" },
  appMismatch: {
    tone: "error",
    body: "settings.integrations.existing.appMismatch",
  },
  githubUnavailable: {
    tone: "error",
    body: "settings.integrations.existing.githubUnavailable",
  },
  unavailable: {
    tone: "error",
    body: "settings.integrations.existing.unavailable",
  },
  failed: { tone: "error", body: "settings.integrations.existing.failed" },
};

/** Contract bounds (IntegrationAppRegistrationPut); longer values never leave the form. */
const MAX_LENGTH: Readonly<
  Record<Exclude<keyof ExistingAppValues, "appId">, number>
> = {
  clientId: 100,
  clientSecret: 4096,
  privateKey: 16384,
  webhookSecret: 4096,
};

/** A positive whole number, as GitHub numbers its Apps. */
export function parseAppId(value: string): number | null {
  if (!/^[1-9][0-9]{0,15}$/.test(value.trim())) return null;
  const id = Number(value.trim());
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * The 'Use an existing GitHub App' form, and the same fields to replace the
 * registered App's credentials. Secret inputs are write-only: they start
 * empty, never receive a stored value, and the page clears them after every
 * submit. A stored secret is described by its revision only.
 */
export function ExistingGitHubAppForm(
  { mode, values, status, stored, onChange, onSubmit }:
    ExistingGitHubAppFormProps,
) {
  const { translate } = useI18n();
  const ids = {
    appId: useId(),
    clientId: useId(),
    clientSecret: useId(),
    privateKey: useId(),
    webhookSecret: useId(),
  };
  const saving = status === "saving";
  const appIdInvalid = values.appId.trim() !== "" &&
    parseAppId(values.appId) === null;
  const tooLong = (field: keyof typeof MAX_LENGTH) =>
    values[field].length > MAX_LENGTH[field];
  const tooLongError = (field: keyof typeof MAX_LENGTH) =>
    tooLong(field)
      ? translate("settings.integrations.existing.tooLong")
      : undefined;
  const fieldState = (field: keyof typeof MAX_LENGTH) =>
    tooLong(field) ? "invalid" : "default";
  const ready = parseAppId(values.appId) !== null &&
    !(Object.keys(MAX_LENGTH) as (keyof typeof MAX_LENGTH)[]).some(tooLong) &&
    values.clientId.trim() !== "" && values.privateKey.trim() !== "" &&
    (mode === "replace" || values.clientSecret !== "");
  const storedHint = (revision: number | null | undefined) =>
    revision === null || revision === undefined
      ? translate("settings.integrations.existing.notStored")
      : translate("settings.integrations.existing.stored", { revision });
  const reveal = {
    show: translate("settings.integrations.existing.show"),
    hide: translate("settings.integrations.existing.hide"),
  };
  const outcome = status === "idle" || status === "saving"
    ? null
    : STATUS_COPY[status];
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (ready && !saving) onSubmit();
  };
  return (
    <UI.Stack gap="standard">
      <UI.Heading level="section">
        {translate(
          mode === "register"
            ? "settings.integrations.existing.heading"
            : "settings.integrations.replace.heading",
        )}
      </UI.Heading>
      <UI.Text variant="muted">
        {translate(
          mode === "register"
            ? "settings.integrations.existing.description"
            : "settings.integrations.replace.description",
        )}
      </UI.Text>
      {outcome
        ? (
          <UI.AlertBanner tone={outcome.tone}>
            {translate(outcome.body)}
            {outcome.tone === "error"
              ? ` ${translate("settings.integrations.existing.cleared")}`
              : ""}
          </UI.AlertBanner>
        )
        : null}
      <form
        aria-busy={saving || undefined}
        data-testid={`github-existing-app-${mode}`}
        noValidate
        onSubmit={submit}
      >
        <UI.Stack gap="standard">
          <UI.Field
            error={appIdInvalid
              ? translate("settings.integrations.existing.appId.invalid")
              : undefined}
            hint={translate("settings.integrations.existing.appId.hint")}
            htmlFor={ids.appId}
            label={translate("settings.integrations.existing.appId")}
            required
            state={appIdInvalid ? "invalid" : "default"}
          >
            <UI.TextInput
              autoComplete="off"
              disabled={saving}
              id={ids.appId}
              inputMode="numeric"
              invalid={appIdInvalid}
              name="appId"
              onChange={(value) => onChange("appId", value)}
              readOnly={mode === "replace"}
              required
              type="text"
              value={values.appId}
            />
          </UI.Field>
          <UI.Field
            error={tooLongError("clientId")}
            htmlFor={ids.clientId}
            label={translate("settings.integrations.existing.clientId")}
            required
            state={fieldState("clientId")}
          >
            <UI.TextInput
              autoComplete="off"
              disabled={saving}
              id={ids.clientId}
              invalid={tooLong("clientId")}
              name="clientId"
              onChange={(value) => onChange("clientId", value)}
              required
              type="text"
              value={values.clientId}
            />
          </UI.Field>
          <UI.Field
            error={tooLongError("clientSecret")}
            hint={mode === "replace"
              ? storedHint(stored?.clientSecret)
              : undefined}
            htmlFor={ids.clientSecret}
            label={translate("settings.integrations.existing.clientSecret")}
            note={mode === "replace"
              ? translate("settings.integrations.existing.optional")
              : undefined}
            required={mode === "register"}
            state={fieldState("clientSecret")}
          >
            <UI.PasswordInput
              invalid={tooLong("clientSecret")}
              autoComplete="new-password"
              disabled={saving}
              id={ids.clientSecret}
              name="clientSecret"
              onChange={(value) => onChange("clientSecret", value)}
              required={mode === "register"}
              revealLabels={reveal}
              value={values.clientSecret}
            />
          </UI.Field>
          <UI.Field
            error={tooLongError("privateKey")}
            hint={mode === "replace" && stored?.privateKey
              ? translate("settings.integrations.existing.storedKey", {
                revision: stored.privateKey,
              })
              : translate("settings.integrations.existing.privateKey.hint")}
            htmlFor={ids.privateKey}
            label={translate("settings.integrations.existing.privateKey")}
            required
            state={fieldState("privateKey")}
            variant="textarea"
          >
            <textarea
              aria-invalid={tooLong("privateKey") || undefined}
              autoComplete="off"
              disabled={saving}
              id={ids.privateKey}
              name="privateKey"
              onChange={(event) => onChange("privateKey", event.target.value)}
              required
              rows={6}
              spellCheck={false}
              value={values.privateKey}
            />
          </UI.Field>
          <UI.Field
            error={tooLongError("webhookSecret")}
            hint={mode === "replace"
              ? storedHint(stored?.webhookSecret)
              : undefined}
            htmlFor={ids.webhookSecret}
            label={translate("settings.integrations.existing.webhookSecret")}
            note={translate("settings.integrations.existing.optional")}
            state={fieldState("webhookSecret")}
          >
            <UI.PasswordInput
              autoComplete="new-password"
              disabled={saving}
              id={ids.webhookSecret}
              invalid={tooLong("webhookSecret")}
              name="webhookSecret"
              onChange={(value) => onChange("webhookSecret", value)}
              revealLabels={reveal}
              value={values.webhookSecret}
            />
          </UI.Field>
          <UI.Inline>
            <UI.Button disabled={!ready} loading={saving} type="submit">
              {translate(
                saving
                  ? "settings.integrations.existing.saving"
                  : mode === "register"
                  ? "settings.integrations.existing.submit"
                  : "settings.integrations.replace.submit",
              )}
            </UI.Button>
          </UI.Inline>
        </UI.Stack>
      </form>
    </UI.Stack>
  );
}
