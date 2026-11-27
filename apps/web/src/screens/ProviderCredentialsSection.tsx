import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import * as UI from "@bakery/ui";
import type { MessageKey } from "@bakery/i18n";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { CopyValueButton } from "../pages/CopyValueButton.tsx";

/** Longest client ID and secret the server accepts. */
export const CLIENT_ID_MAX = 200;
export const CLIENT_SECRET_MAX = 4096;

/** What the administrator typed. The secret is never filled from the server. */
export type ProviderCredentialValues = {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly signingSecret: string;
};

export const EMPTY_PROVIDER_CREDENTIALS: ProviderCredentialValues = {
  clientId: "",
  clientSecret: "",
  signingSecret: "",
};

/** The saved registration as the section shows it; never the secret. */
export type ProviderCredentialsSaved = {
  readonly configured: boolean;
  readonly clientId: string | null;
  readonly clientSecretSavedAt: string | null;
  readonly signingSecretSavedAt: string | null;
  readonly callbackUrl: string;
};

export type ProviderCredentialsView =
  | "loading"
  | "error"
  | "forbidden"
  | "ready";

/** The outcome of the last save; every failure saved nothing. */
export type ProviderCredentialsStatus =
  | "idle"
  | "saving"
  | "stale"
  | "failed";

export type ProviderCredentialsSectionProps = {
  /** Provider slug; its words live under `integrations.<slug>.credentials.*`. */
  readonly provider: string;
  readonly view: ProviderCredentialsView;
  readonly saved: ProviderCredentialsSaved | null;
  readonly values: ProviderCredentialValues;
  readonly status: ProviderCredentialsStatus;
  /** Where the provider's OAuth application is created, if it has a page for it. */
  readonly guideUrl?: string;
  readonly connectAvailable?: boolean;
  readonly signingSecret?: boolean;
  readonly onChange: (
    field: keyof ProviderCredentialValues,
    value: string,
  ) => void;
  readonly onSubmit: () => void;
  readonly onReload: () => void;
  /** Cancel closes Replace and drops what was typed and any save notice. */
  readonly onCancel: () => void;
};

/** Both fields present and within bounds: what the server will accept. */
export function providerCredentialsReady(
  values: ProviderCredentialValues,
): boolean {
  return values.clientId.trim() !== "" && values.clientSecret.trim() !== "" &&
    values.clientId.length <= CLIENT_ID_MAX &&
    values.clientSecret.length <= CLIENT_SECRET_MAX &&
    values.signingSecret.length <= CLIENT_SECRET_MAX;
}

/**
 * One provider's OAuth client credentials on the installation settings page.
 *
 * Presentational: the page loads, saves and clears. The secret is write-only, so
 * a saved registration shows the client ID and when the secret was saved, and
 * Replace opens both fields empty.
 */
export function ProviderCredentialsSection(
  {
    provider,
    view,
    saved,
    values,
    status,
    guideUrl,
    connectAvailable,
    signingSecret,
    onChange,
    onSubmit,
    onReload,
    onCancel,
  }: ProviderCredentialsSectionProps,
) {
  const { translate, locale, timeZone } = useI18n();
  const key = (suffix: string) =>
    `integrations.${provider}.credentials.${suffix}` as MessageKey;
  const ids = {
    clientId: useId(),
    clientSecret: useId(),
    signingSecret: useId(),
  };
  const [replacing, setReplacing] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const saving = status === "saving";
  // Replace closes when its save ends in anything but a plain failure: a saved pair, or
  // "details changed", which shows what is stored now. A failed save keeps the form open.
  const previousStatus = useRef(status);
  useEffect(() => {
    if (previousStatus.current === "saving" && status !== "failed") {
      setReplacing(false);
    }
    previousStatus.current = status;
  }, [status]);
  const configured = saved?.configured === true;
  const showForm = !configured || replacing;
  const idMissing = attempted && values.clientId.trim() === "";
  const secretMissing = attempted && values.clientSecret.trim() === "";
  const idTooLong = values.clientId.length > CLIENT_ID_MAX;
  const secretTooLong = values.clientSecret.length > CLIENT_SECRET_MAX;
  const signingTooLong = values.signingSecret.length > CLIENT_SECRET_MAX;
  const date = (value: string | null) =>
    value
      ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone })
        .format(new Date(value))
      : "";
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    setAttempted(true);
    if (!providerCredentialsReady(values)) return;
    onSubmit();
    setAttempted(false);
  };
  const reveal = {
    show: translate("settings.storage.show"),
    hide: translate("settings.storage.hide"),
  };
  return (
    <section
      aria-labelledby={`${ids.clientId}-heading`}
      data-testid={`${provider}-credentials`}
    >
      <UI.Stack gap="standard">
        <UI.Heading id={`${ids.clientId}-heading`} level="section">
          <UI.ProviderMark
            name={translate(`integrations.${provider}.name` as MessageKey)}
            provider={provider}
            size="header"
          />
          {translate(`integrations.${provider}.name` as MessageKey)}
        </UI.Heading>
        {connectAvailable === false
          ? (
            <UI.Text variant="muted">
              {translate(`integrations.${provider}.soon` as MessageKey)}
            </UI.Text>
          )
          : null}
        {view === "loading"
          ? (
            <UI.AlertBanner tone="information">
              {translate(key("loading"))}
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
              {translate(key("loadError"))}
            </UI.AlertBanner>
          )
          : null}
        {view === "ready" && saved
          ? (
            <>
              {configured
                ? (
                  <>
                    <UI.Text>{translate(key("setUp"))}</UI.Text>
                    <UI.Stack gap="compact">
                      <UI.Text>
                        {translate(key("clientIdSaved"), {
                          id: saved.clientId ?? "",
                        })}
                      </UI.Text>
                      <UI.Text>
                        {translate(key("secretSaved"), {
                          date: date(saved.clientSecretSavedAt),
                        })}
                      </UI.Text>
                      {signingSecret
                        ? (
                          <UI.Text>
                            {saved.signingSecretSavedAt
                              ? translate(key("signingSecretSaved"), {
                                date: date(saved.signingSecretSavedAt),
                              })
                              : translate(key("signingSecretNotSaved"))}
                          </UI.Text>
                        )
                        : null}
                    </UI.Stack>
                  </>
                )
                : (
                  <>
                    <UI.Text variant="muted">
                      {translate(key("notSet"))}
                    </UI.Text>
                    {guideUrl
                      ? (
                        <UI.Text>
                          <UI.Link href={guideUrl} variant="external">
                            {translate(key("guide"))}
                          </UI.Link>
                        </UI.Text>
                      )
                      : null}
                  </>
                )}
              {status === "failed"
                ? (
                  <UI.AlertBanner tone="error">
                    {translate(key("saveFailed"))}
                  </UI.AlertBanner>
                )
                : null}
              {status === "stale"
                ? (
                  <UI.AlertBanner tone="warning">
                    {translate(key("stale"))}
                  </UI.AlertBanner>
                )
                : null}
              {showForm
                ? (
                  <form
                    aria-busy={saving || undefined}
                    data-testid={`${provider}-credentials-form`}
                    noValidate
                    onSubmit={submit}
                  >
                    <UI.Stack gap="standard">
                      <UI.Stack gap="compact">
                        <UI.DescriptionList>
                          <UI.DescriptionItem
                            action={
                              <CopyValueButton
                                label={translate(
                                  "settings.integrations.credentials.copyCallback",
                                )}
                                value={saved.callbackUrl}
                              />
                            }
                            description={
                              <UI.DataText
                                data-testid={`${provider}-callback-url`}
                                state="wrapped"
                                variant="code"
                              >
                                {saved.callbackUrl}
                              </UI.DataText>
                            }
                            title={translate(
                              "settings.integrations.credentials.callbackLabel",
                            )}
                          />
                        </UI.DescriptionList>
                        <UI.Text variant="muted">
                          {translate(key("callbackHint"))}
                        </UI.Text>
                      </UI.Stack>
                      <UI.Field
                        error={idMissing
                          ? translate(
                            "settings.integrations.credentials.clientIdRequired",
                          )
                          : idTooLong
                          ? translate(
                            "settings.integrations.credentials.tooLong",
                            { limit: CLIENT_ID_MAX },
                          )
                          : undefined}
                        htmlFor={ids.clientId}
                        label={translate(
                          `integrations.${provider}.fields.client_id` as MessageKey,
                        )}
                        required
                        state={idMissing || idTooLong ? "invalid" : "default"}
                      >
                        <UI.TextInput
                          autoComplete="off"
                          disabled={saving}
                          id={ids.clientId}
                          invalid={idMissing || idTooLong}
                          name="clientId"
                          onChange={(value) => onChange("clientId", value)}
                          required
                          type="text"
                          value={values.clientId}
                        />
                      </UI.Field>
                      <UI.Field
                        error={secretMissing
                          ? translate(
                            "settings.integrations.credentials.clientSecretRequired",
                          )
                          : secretTooLong
                          ? translate(
                            "settings.integrations.credentials.tooLong",
                            { limit: CLIENT_SECRET_MAX },
                          )
                          : undefined}
                        htmlFor={ids.clientSecret}
                        label={translate(
                          `integrations.${provider}.fields.client_secret` as MessageKey,
                        )}
                        required
                        state={secretMissing || secretTooLong
                          ? "invalid"
                          : "default"}
                      >
                        <UI.PasswordInput
                          autoComplete="new-password"
                          disabled={saving}
                          id={ids.clientSecret}
                          invalid={secretMissing || secretTooLong}
                          name="clientSecret"
                          onChange={(value) => onChange("clientSecret", value)}
                          required
                          revealLabels={reveal}
                          value={values.clientSecret}
                        />
                      </UI.Field>
                      {signingSecret
                        ? (
                          <UI.Field
                            error={signingTooLong
                              ? translate(
                                "settings.integrations.credentials.tooLong",
                                { limit: CLIENT_SECRET_MAX },
                              )
                              : undefined}
                            hint={translate(key("signingSecretHint"))}
                            htmlFor={ids.signingSecret}
                            label={translate(
                              `integrations.${provider}.fields.signing_secret` as MessageKey,
                            )}
                            state={signingTooLong ? "invalid" : "default"}
                          >
                            <UI.PasswordInput
                              autoComplete="new-password"
                              disabled={saving}
                              id={ids.signingSecret}
                              invalid={signingTooLong}
                              name="signingSecret"
                              onChange={(value) =>
                                onChange("signingSecret", value)}
                              revealLabels={reveal}
                              value={values.signingSecret}
                            />
                          </UI.Field>
                        )
                        : null}
                      <UI.Inline>
                        <UI.Button
                          disabled={saving}
                          loading={saving}
                          type="submit"
                        >
                          {translate("settings.integrations.credentials.save")}
                        </UI.Button>
                        {configured
                          ? (
                            <UI.Button
                              disabled={saving}
                              onClick={() => {
                                setReplacing(false);
                                setAttempted(false);
                                onCancel();
                              }}
                              type="button"
                              variant="secondary"
                            >
                              {translate(
                                "settings.integrations.credentials.cancel",
                              )}
                            </UI.Button>
                          )
                          : null}
                      </UI.Inline>
                    </UI.Stack>
                  </form>
                )
                : (
                  <div>
                    <UI.Button
                      onClick={() => setReplacing(true)}
                      type="button"
                      variant="secondary"
                    >
                      {translate("settings.integrations.credentials.replace")}
                    </UI.Button>
                  </div>
                )}
            </>
          )
          : null}
      </UI.Stack>
    </section>
  );
}
