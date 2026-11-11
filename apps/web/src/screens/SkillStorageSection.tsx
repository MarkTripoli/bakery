import { type FormEvent, useId } from "react";
import * as UI from "@bakery/ui";
import type { MessageKey } from "@bakery/i18n";
import { useI18n } from "../i18n/I18nProvider.tsx";

/** What the administrator typed. Credentials are never filled from the server. */
export type SkillStorageValues = {
  readonly accountId: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
};

export const EMPTY_SKILL_STORAGE: SkillStorageValues = {
  accountId: "",
  bucket: "",
  accessKeyId: "",
  secretAccessKey: "",
};

/** The saved settings as the section shows them; never a credential. */
export type SkillStorageSaved = {
  readonly backend: "filesystem" | "r2";
  readonly configured: boolean;
  readonly accountId: string | null;
  readonly bucket: string | null;
  readonly credentialRevision: number | null;
  readonly credentialUpdatedAt: string | null;
};

export type SkillStorageView = "loading" | "error" | "forbidden" | "ready";

/** Fixed probe outcomes the verification endpoint can answer. */
export type SkillStorageOutcome =
  | "verified"
  | "not_configured"
  | "credentials_rejected"
  | "access_denied"
  | "bucket_not_found"
  | "endpoint_unreachable"
  | "integrity_failed"
  | "provider_error";

/** The seven outcomes that can refuse a credential rotation before saving. */
export type SkillStorageProbeRefusal = Exclude<SkillStorageOutcome, "verified">;

/** The outcome of the last save; every failure saved nothing. */
export type SkillStorageSaveStatus =
  | `probe:${SkillStorageProbeRefusal}`
  | "idle"
  | "saving"
  | "saved"
  | "stale"
  | "malformed"
  | "rejected"
  | "backendActive"
  | "unavailable"
  | "failed";

export type SkillStorageVerifyStatus =
  | { readonly state: "idle" }
  | { readonly state: "verifying" }
  | { readonly state: "failed" }
  | { readonly state: "done"; readonly outcome: SkillStorageOutcome };

export type SkillStorageSectionProps = {
  readonly view: SkillStorageView;
  readonly saved: SkillStorageSaved | null;
  readonly values: SkillStorageValues;
  readonly status: SkillStorageSaveStatus;
  readonly verification: SkillStorageVerifyStatus;
  readonly onChange: (field: keyof SkillStorageValues, value: string) => void;
  readonly onSubmit: () => void;
  readonly onVerify: () => void;
  readonly onReload: () => void;
};

const SAVE_COPY: Readonly<
  Record<
    Exclude<
      SkillStorageSaveStatus,
      "idle" | "saving" | `probe:${SkillStorageProbeRefusal}`
    >,
    { readonly tone: "success" | "error"; readonly body: MessageKey }
  >
> = {
  saved: { tone: "success", body: "settings.storage.saved" },
  stale: { tone: "error", body: "settings.storage.stale" },
  malformed: { tone: "error", body: "settings.storage.malformed" },
  rejected: { tone: "error", body: "settings.storage.rejected" },
  backendActive: { tone: "error", body: "settings.storage.backendActive" },
  unavailable: { tone: "error", body: "settings.storage.unavailable" },
  failed: { tone: "error", body: "settings.storage.failed" },
};

const OUTCOME_COPY: Readonly<Record<SkillStorageOutcome, MessageKey>> = {
  verified: "settings.storage.verify.verified",
  not_configured: "settings.storage.verify.not_configured",
  credentials_rejected: "settings.storage.verify.credentials_rejected",
  access_denied: "settings.storage.verify.access_denied",
  bucket_not_found: "settings.storage.verify.bucket_not_found",
  endpoint_unreachable: "settings.storage.verify.endpoint_unreachable",
  integrity_failed: "settings.storage.verify.integrity_failed",
  provider_error: "settings.storage.verify.provider_error",
};

/** Contract bounds (SkillStorageSettingsPut); the server enforces the same. */
export const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/;
export const BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const ACCESS_KEY_ID_MAX = 256;
const SECRET_ACCESS_KEY_MAX = 1024;

/** True when a pasted credential has no whitespace or control characters. */
function credentialText(value: string): boolean {
  return !Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 32 || code === 127;
  });
}

/**
 * Whether the form may be submitted: a valid account and bucket, and either
 * both credential fields (a new or replacement pair) or neither (keep the
 * stored pair, only possible once credentials are stored).
 */
export function skillStorageReady(
  values: SkillStorageValues,
  credentialsStored: boolean,
): boolean {
  if (!ACCOUNT_ID_PATTERN.test(values.accountId)) return false;
  if (!BUCKET_PATTERN.test(values.bucket)) return false;
  const { accessKeyId, secretAccessKey } = values;
  if (accessKeyId === "" && secretAccessKey === "") return credentialsStored;
  return accessKeyId !== "" && secretAccessKey !== "" &&
    accessKeyId.length <= ACCESS_KEY_ID_MAX &&
    secretAccessKey.length <= SECRET_ACCESS_KEY_MAX &&
    credentialText(accessKeyId) && credentialText(secretAccessKey);
}

/**
 * The "Object storage" section of the installation Integrations page. The
 * secret inputs are write-only: they start empty, never receive a stored
 * value, and the page clears them before every request. Stored credentials are
 * described by their revision and save date only.
 */
export function SkillStorageSection(
  {
    view,
    saved,
    values,
    status,
    verification,
    onChange,
    onSubmit,
    onVerify,
    onReload,
  }: SkillStorageSectionProps,
) {
  const { translate, locale, timeZone } = useI18n();
  const ids = {
    accountId: useId(),
    bucket: useId(),
    accessKeyId: useId(),
    secretAccessKey: useId(),
  };
  const saving = status === "saving";
  const verifying = verification.state === "verifying";
  const locked = saved?.backend === "r2";
  const credentialsStored = saved?.configured === true;
  const accountInvalid = values.accountId !== "" &&
    !ACCOUNT_ID_PATTERN.test(values.accountId);
  const bucketInvalid = values.bucket !== "" &&
    !BUCKET_PATTERN.test(values.bucket);
  const half = (values.accessKeyId === "") !== (values.secretAccessKey === "");
  const accessTooLong = values.accessKeyId.length > ACCESS_KEY_ID_MAX;
  const secretTooLong = values.secretAccessKey.length > SECRET_ACCESS_KEY_MAX;
  const ready = skillStorageReady(values, credentialsStored);
  const date = (value: string | null) =>
    value
      ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone })
        .format(new Date(value))
      : "";
  const outcome = status === "idle" || status === "saving"
    ? null
    : status.startsWith("probe:")
    ? {
      tone: "error" as const,
      body: OUTCOME_COPY[status.slice("probe:".length) as SkillStorageOutcome],
    }
    : SAVE_COPY[status as keyof typeof SAVE_COPY];
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (ready && !saving) onSubmit();
  };
  const reveal = {
    show: translate("settings.storage.show"),
    hide: translate("settings.storage.hide"),
  };
  const credentialsHint = credentialsStored && saved?.credentialRevision
    ? translate("settings.storage.credentials.hint.stored", {
      revision: saved.credentialRevision,
    })
    : translate("settings.storage.credentials.hint.new");
  const pairError = half
    ? translate("settings.storage.credentials.pair")
    : undefined;
  return (
    <section
      aria-labelledby={`${ids.accountId}-heading`}
      data-testid="skill-storage"
    >
      <UI.Stack gap="standard">
        <UI.Heading id={`${ids.accountId}-heading`} level="section">
          {translate("settings.storage.heading")}
        </UI.Heading>
        <UI.Text variant="muted">
          {translate("settings.storage.description")}
        </UI.Text>
        {view === "loading"
          ? (
            <UI.AlertBanner tone="information">
              {translate("settings.storage.loading")}
            </UI.AlertBanner>
          )
          : null}
        {view === "forbidden"
          ? (
            <UI.AlertBanner tone="information">
              {translate("settings.storage.forbidden")}
            </UI.AlertBanner>
          )
          : null}
        {view === "error"
          ? (
            <UI.AlertBanner
              action={
                <UI.Button onClick={onReload} type="button">
                  {translate("settings.storage.retry")}
                </UI.Button>
              }
              tone="error"
            >
              {translate("settings.storage.loadError")}
            </UI.AlertBanner>
          )
          : null}
        {view === "ready" && saved
          ? (
            <>
              <UI.DescriptionList>
                <UI.DescriptionItem
                  description={translate(
                    saved.backend === "r2"
                      ? "settings.storage.backend.r2"
                      : "settings.storage.backend.filesystem",
                  )}
                  title={translate("settings.storage.backend")}
                />
                {saved.accountId
                  ? (
                    <UI.DescriptionItem
                      description={saved.accountId}
                      title={translate("settings.storage.account")}
                    />
                  )
                  : null}
                {saved.bucket
                  ? (
                    <UI.DescriptionItem
                      description={saved.bucket}
                      title={translate("settings.storage.bucket")}
                    />
                  )
                  : null}
                <UI.DescriptionItem
                  description={credentialsStored && saved.credentialRevision
                    ? translate("settings.storage.credentials.stored", {
                      revision: saved.credentialRevision,
                      date: date(saved.credentialUpdatedAt),
                    })
                    : translate("settings.storage.credentials.none")}
                  title={translate("settings.storage.credentials")}
                />
              </UI.DescriptionList>
              <UI.Text variant="muted">
                {translate("settings.storage.backend.note")}
              </UI.Text>
              {!credentialsStored
                ? (
                  <UI.EmptyState
                    description={translate(
                      "settings.storage.unconfigured.description",
                    )}
                    title={translate("settings.storage.unconfigured.title")}
                  />
                )
                : null}
              {outcome
                ? (
                  <UI.AlertBanner tone={outcome.tone}>
                    {translate(outcome.body)}
                    {outcome.tone === "error"
                      ? ` ${translate("settings.storage.cleared")}`
                      : ""}
                  </UI.AlertBanner>
                )
                : null}
              <form
                aria-busy={saving || undefined}
                data-testid="skill-storage-form"
                noValidate
                onSubmit={submit}
              >
                <UI.Stack gap="standard">
                  <UI.Heading level="section">
                    {translate(
                      credentialsStored
                        ? "settings.storage.form.update"
                        : "settings.storage.form.configure",
                    )}
                  </UI.Heading>
                  {locked
                    ? (
                      <UI.Text variant="muted">
                        {translate("settings.storage.locked")}
                      </UI.Text>
                    )
                    : null}
                  <UI.Field
                    error={accountInvalid
                      ? translate("settings.storage.accountId.invalid")
                      : undefined}
                    hint={translate("settings.storage.accountId.hint")}
                    htmlFor={ids.accountId}
                    label={translate("settings.storage.accountId.label")}
                    required
                    state={accountInvalid ? "invalid" : "default"}
                  >
                    <UI.TextInput
                      autoComplete="off"
                      disabled={saving}
                      id={ids.accountId}
                      invalid={accountInvalid}
                      name="accountId"
                      onChange={(value) => onChange("accountId", value)}
                      readOnly={locked}
                      required
                      type="text"
                      value={values.accountId}
                    />
                  </UI.Field>
                  <UI.Field
                    error={bucketInvalid
                      ? translate("settings.storage.bucket.invalid")
                      : undefined}
                    hint={translate("settings.storage.bucket.hint")}
                    htmlFor={ids.bucket}
                    label={translate("settings.storage.bucket.label")}
                    required
                    state={bucketInvalid ? "invalid" : "default"}
                  >
                    <UI.TextInput
                      autoComplete="off"
                      disabled={saving}
                      id={ids.bucket}
                      invalid={bucketInvalid}
                      name="bucket"
                      onChange={(value) => onChange("bucket", value)}
                      readOnly={locked}
                      required
                      type="text"
                      value={values.bucket}
                    />
                  </UI.Field>
                  <UI.Field
                    error={pairError && values.accessKeyId === ""
                      ? pairError
                      : accessTooLong
                      ? translate("settings.storage.credentials.tooLong")
                      : undefined}
                    hint={credentialsHint}
                    htmlFor={ids.accessKeyId}
                    label={translate("settings.storage.accessKeyId.label")}
                    required={!credentialsStored}
                    state={(half && values.accessKeyId === "") || accessTooLong
                      ? "invalid"
                      : "default"}
                  >
                    <UI.PasswordInput
                      autoComplete="new-password"
                      disabled={saving}
                      id={ids.accessKeyId}
                      invalid={accessTooLong ||
                        (half && values.accessKeyId === "")}
                      name="accessKeyId"
                      onChange={(value) => onChange("accessKeyId", value)}
                      required={!credentialsStored}
                      revealLabels={reveal}
                      value={values.accessKeyId}
                    />
                  </UI.Field>
                  <UI.Field
                    error={pairError && values.secretAccessKey === ""
                      ? pairError
                      : secretTooLong
                      ? translate("settings.storage.credentials.tooLong")
                      : undefined}
                    htmlFor={ids.secretAccessKey}
                    label={translate("settings.storage.secretAccessKey.label")}
                    required={!credentialsStored}
                    state={(half && values.secretAccessKey === "") ||
                        secretTooLong
                      ? "invalid"
                      : "default"}
                  >
                    <UI.PasswordInput
                      autoComplete="new-password"
                      disabled={saving}
                      id={ids.secretAccessKey}
                      invalid={secretTooLong ||
                        (half && values.secretAccessKey === "")}
                      name="secretAccessKey"
                      onChange={(value) => onChange("secretAccessKey", value)}
                      required={!credentialsStored}
                      revealLabels={reveal}
                      value={values.secretAccessKey}
                    />
                  </UI.Field>
                  <UI.Inline>
                    <UI.Button
                      disabled={!ready}
                      loading={saving}
                      type="submit"
                    >
                      {translate(
                        saving
                          ? "settings.storage.saving"
                          : "settings.storage.submit",
                      )}
                    </UI.Button>
                  </UI.Inline>
                </UI.Stack>
              </form>
              {credentialsStored
                ? (
                  <UI.Stack gap="standard">
                    <UI.Heading level="section">
                      {translate("settings.storage.verify.heading")}
                    </UI.Heading>
                    <UI.Text variant="muted">
                      {translate("settings.storage.verify.description")}
                    </UI.Text>
                    {verification.state === "done"
                      ? (
                        <UI.AlertBanner
                          tone={verification.outcome === "verified"
                            ? "success"
                            : "error"}
                        >
                          {translate(OUTCOME_COPY[verification.outcome])}
                        </UI.AlertBanner>
                      )
                      : null}
                    {verification.state === "failed"
                      ? (
                        <UI.AlertBanner tone="error">
                          {translate("settings.storage.verify.failed")}
                        </UI.AlertBanner>
                      )
                      : null}
                    <UI.Inline>
                      <UI.Button
                        disabled={verifying || saving}
                        loading={verifying}
                        onClick={onVerify}
                        type="button"
                      >
                        {translate(
                          verifying
                            ? "settings.storage.verify.running"
                            : "settings.storage.verify.action",
                        )}
                      </UI.Button>
                    </UI.Inline>
                  </UI.Stack>
                )
                : null}
            </>
          )
          : null}
      </UI.Stack>
    </section>
  );
}
