import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import * as UI from "@bakery/ui";
import type { MessageKey } from "@bakery/i18n";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { CopyValueButton } from "../pages/CopyValueButton.tsx";
import {
  SLACK_FIELD_MAX,
  SLACK_SECRET_MAX,
  slackAppIdLooksRight,
  slackAppReady,
  type SlackAppValues,
} from "./slack-app-details.ts";

/** The saved registration as the section shows it; never a secret. */
export type SlackAppSaved = {
  readonly configured: boolean;
  readonly appId: string | null;
  readonly clientId: string | null;
  readonly clientSecretSavedAt: string | null;
  readonly signingSecretSavedAt: string | null;
  readonly detailsCheckedAt: string | null;
  readonly detailsCheckResult: string | null;
  readonly lastRequestAt: string | null;
  readonly lastRequestFailedAt: string | null;
  readonly redirectUrl: string;
  readonly eventsUrl: string;
  readonly interactivityUrl: string;
};

export type SlackAppView = "loading" | "error" | "forbidden" | "ready";

/** The outcome of the last save or check; every failure stored nothing. */
export type SlackAppStatus =
  | "idle"
  | "saving"
  | "checking"
  | "stale"
  | "failed"
  | "clientIdRefused"
  | "clientSecretRefused"
  | "removing"
  | "removed"
  | "removeFailed"
  | "removeStale"
  | "checkFailed"
  | "checkStale";

/**
 * The banner a failed press shows, or null when nothing failed.
 *
 * A save, a check and a removal each say what they were doing: "could not be
 * saved" over a failed check reads as if the details were lost.
 */
function failureKey(status: SlackAppStatus): string | null {
  switch (status) {
    case "failed":
      return "saveFailed";
    case "stale":
      return "stale";
    case "clientIdRefused":
      return "refused.clientId";
    case "clientSecretRefused":
      return "refused.clientSecret";
    case "checkFailed":
      return "checkFailed";
    case "checkStale":
      return "checkStale";
    case "removeFailed":
      return "removeFailed";
    case "removeStale":
      return "removeStale";
    default:
      return null;
  }
}

export type SlackAppSectionProps = {
  readonly view: SlackAppView;
  readonly saved: SlackAppSaved | null;
  readonly values: SlackAppValues;
  readonly status: SlackAppStatus;
  /** Whether saving is possible at all: at least one secret is stored or typed. */
  readonly secretsStored?: boolean;
  readonly onChange: (field: keyof SlackAppValues, value: string) => void;
  readonly onSubmit: () => void;
  readonly onCheck: () => void;
  readonly onRemove: () => void;
  readonly onReload: () => void;
  readonly onCancel: () => void;
};

/** The address rows Slack needs, in the order a person pastes them. */
const ADDRESS_KEYS = [
  ["redirectUrl", "redirect"],
  ["eventsUrl", "events"],
  ["interactivityUrl", "interactivity"],
] as const;

/**
 * This installation's Slack app on the settings page (#415).
 *
 * Presentational: the page loads, saves, checks and removes. The secrets are
 * write-only, so a saved app shows when each was saved, and Replace opens the
 * secrets empty with the old one kept unless a new one is typed.
 */
export function SlackAppSection(
  {
    view,
    saved,
    values,
    status,
    secretsStored = false,
    onChange,
    onSubmit,
    onCheck,
    onRemove,
    onReload,
    onCancel,
  }: SlackAppSectionProps,
) {
  const { translate, locale, timeZone } = useI18n();
  const key = (suffix: string) =>
    `integrations.slack.credentials.${suffix}` as MessageKey;
  const ids = {
    appId: useId(),
    clientId: useId(),
    clientSecret: useId(),
    signingSecret: useId(),
  };
  const [replacing, setReplacing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const busy = status === "saving" || status === "checking" ||
    status === "removing";
  // A successful save ends Replace; a refused one keeps the form open so the
  // person can fix the field that was named.
  const previousStatus = useRef(status);
  useEffect(() => {
    if (
      previousStatus.current === "saving" &&
      status !== "failed" && status !== "clientIdRefused" &&
      status !== "clientSecretRefused"
    ) {
      setReplacing(false);
    }
    // A removal closes its dialog whatever the outcome: a refusal belongs in the
    // banner, not over a modal that hides it.
    if (previousStatus.current === "removing") setRemoving(false);
    previousStatus.current = status;
  }, [status]);
  const configured = saved?.configured === true;
  const showForm = !configured || replacing;
  const secretKept = configured && secretsStored;
  const appIdMissing = attempted && values.appId.trim() === "";
  const appIdMalformed = values.appId.trim() !== "" &&
    !slackAppIdLooksRight(values.appId);
  const clientIdMissing = attempted && values.clientId.trim() === "";
  const clientSecretMissing = attempted && !secretKept &&
    values.clientSecret.trim() === "";
  const signingSecretMissing = attempted && !secretKept &&
    values.signingSecret.trim() === "";
  // Each field reports its own length: a client secret pasted into the wrong box
  // must complain where a person can see and fix it, not under App ID.
  const appIdTooLong = values.appId.length > SLACK_FIELD_MAX;
  const clientIdTooLong = values.clientId.length > SLACK_FIELD_MAX;
  const clientSecretTooLong = values.clientSecret.length > SLACK_SECRET_MAX;
  const signingSecretTooLong = values.signingSecret.length > SLACK_SECRET_MAX;
  const date = (value: string | null) => {
    if (value === null) return "";
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone })
      .format(new Date(value));
  };
  const stamp = (value: string | null) => {
    if (value === null) return "";
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone,
    }).format(new Date(value));
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setAttempted(true);
    if (!slackAppReady(values, secretKept)) return;
    if (!slackAppIdLooksRight(values.appId)) return;
    onSubmit();
    setAttempted(false);
  };
  const reveal = {
    show: translate("settings.storage.show"),
    hide: translate("settings.storage.hide"),
  };
  const secretHint = (savedAt: string | null) =>
    secretKept && savedAt !== null
      ? translate(key("secretKept"), { date: date(savedAt) })
      : undefined;
  const signInState = (() => {
    if (saved === null) return "";
    switch (saved.detailsCheckResult) {
      case null:
        return translate(key("status.neverChecked"));
      case "accepted":
        return translate(key("status.accepted"), {
          time: stamp(saved.detailsCheckedAt),
        });
      case "client_id_refused":
        return translate(key("status.clientIdRefused"));
      case "client_secret_refused":
        return translate(key("status.clientSecretRefused"));
      default:
        return translate(key("status.unreachable"));
    }
  })();
  const requestState = (() => {
    if (saved === null) return "";
    if (saved.lastRequestFailedAt !== null) {
      return translate(key("status.requestFailed"), {
        time: stamp(saved.lastRequestFailedAt),
      });
    }
    return saved.lastRequestAt === null
      ? translate(key("status.noRequest"))
      : translate(key("status.requestAccepted"), {
        time: stamp(saved.lastRequestAt),
      });
  })();
  const signInFaulted = saved?.detailsCheckResult === "client_id_refused" ||
    saved?.detailsCheckResult === "client_secret_refused" ||
    saved?.detailsCheckResult === "unreachable";
  const requestFaulted = saved !== null && saved.lastRequestFailedAt !== null;
  return (
    <section aria-labelledby={`${ids.appId}-heading`} data-testid="slack-app">
      <UI.Stack gap="standard">
        <UI.Heading id={`${ids.appId}-heading`} level="section">
          {translate("integrations.slack.name")}
        </UI.Heading>
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
              {status === "removed"
                ? (
                  <UI.AlertBanner tone="information">
                    {translate(key("removed"))}
                  </UI.AlertBanner>
                )
                : null}
              {configured
                ? (
                  <>
                    <UI.Text>{translate(key("setUp"))}</UI.Text>
                    <UI.DescriptionList>
                      <UI.DescriptionItem
                        description={saved.appId ?? ""}
                        title={translate("integrations.slack.fields.app_id")}
                      />
                      <UI.DescriptionItem
                        description={saved.clientId ?? ""}
                        title={translate("integrations.slack.fields.client_id")}
                      />
                      <UI.DescriptionItem
                        description={translate(key("secretSaved"), {
                          date: date(saved.clientSecretSavedAt),
                        })}
                        title={translate(
                          "integrations.slack.fields.client_secret",
                        )}
                      />
                      <UI.DescriptionItem
                        description={translate(key("secretSaved"), {
                          date: date(saved.signingSecretSavedAt),
                        })}
                        title={translate(
                          "integrations.slack.fields.signing_secret",
                        )}
                      />
                    </UI.DescriptionList>
                    <UI.DescriptionList>
                      <UI.DescriptionItem
                        actionPlacement="below"
                        action={
                          <UI.Button
                            disabled={busy}
                            loading={status === "checking"}
                            onClick={onCheck}
                            type="button"
                            variant="secondary"
                          >
                            {translate(key("checkNow"))}
                          </UI.Button>
                        }
                        icon={signInFaulted
                          ? <UI.IconGlyph name="alert" size="large" />
                          : undefined}
                        description={
                          <span data-testid="slack-signin-state">
                            {signInFaulted
                              ? (
                                <UI.Text variant="error">
                                  {signInState}
                                </UI.Text>
                              )
                              : signInState}
                          </span>
                        }
                        title={translate(key("signInRow"))}
                      />
                      <UI.DescriptionItem
                        icon={requestFaulted
                          ? <UI.IconGlyph name="alert" size="large" />
                          : undefined}
                        description={
                          <span data-testid="slack-requests-state">
                            {requestState}
                          </span>
                        }
                        title={translate(key("requestsRow"))}
                      />
                    </UI.DescriptionList>
                  </>
                )
                : (
                  <>
                    <UI.Text variant="muted">
                      {translate(key("notSet"))}
                    </UI.Text>
                    <UI.Text>
                      <UI.Link
                        href="https://api.slack.com/apps"
                        variant="external"
                      >
                        {translate(key("guide"))}
                      </UI.Link>
                    </UI.Text>
                  </>
                )}
              {failureKey(status) === null ||
                  failureKey(status)?.endsWith("Stale") === true
                ? null
                : (
                  <UI.AlertBanner tone="error">
                    {translate(key(failureKey(status)!))}
                  </UI.AlertBanner>
                )}
              {failureKey(status) === "stale" ||
                  failureKey(status) === "checkStale" ||
                  failureKey(status) === "removeStale"
                ? (
                  <UI.AlertBanner tone="warning">
                    {translate(key(failureKey(status)!))}
                  </UI.AlertBanner>
                )
                : null}
              {showForm
                ? (
                  <form
                    aria-busy={busy || undefined}
                    data-testid="slack-app-form"
                    noValidate
                    onSubmit={submit}
                  >
                    <UI.Stack gap="standard">
                      <UI.Stack gap="compact">
                        <UI.Heading level="subsection">
                          {translate(key("addresses.heading"))}
                        </UI.Heading>
                        <UI.DescriptionList>
                          {ADDRESS_KEYS.map(([field, name]) => (
                            <UI.DescriptionItem
                              actionPlacement="below"
                              action={
                                <CopyValueButton
                                  label={translate(key(`address.${name}.copy`))}
                                  value={saved[field]}
                                />
                              }
                              description={
                                <UI.Stack gap="compact">
                                  <UI.DataText
                                    data-testid={`slack-${name}-url`}
                                    state="wrapped"
                                    variant="code"
                                  >
                                    {saved[field]}
                                  </UI.DataText>
                                  <UI.Text variant="muted">
                                    {translate(key(`address.${name}.hint`))}
                                  </UI.Text>
                                </UI.Stack>
                              }
                              key={field}
                              title={translate(key(`address.${name}.label`))}
                            />
                          ))}
                        </UI.DescriptionList>
                      </UI.Stack>
                      <UI.Field
                        error={appIdMissing
                          ? translate(key("appIdRequired"))
                          : appIdMalformed
                          ? translate(key("appIdMalformed"))
                          : appIdTooLong
                          ? translate(
                            "settings.integrations.credentials.tooLong",
                            { limit: SLACK_FIELD_MAX },
                          )
                          : undefined}
                        hint={translate(key("appIdHint"))}
                        htmlFor={ids.appId}
                        label={translate("integrations.slack.fields.app_id")}
                        required
                        state={appIdMissing || appIdMalformed || appIdTooLong
                          ? "invalid"
                          : "default"}
                      >
                        <UI.TextInput
                          autoComplete="off"
                          disabled={busy}
                          id={ids.appId}
                          invalid={appIdMissing || appIdMalformed}
                          name="appId"
                          onChange={(value) => onChange("appId", value)}
                          required
                          type="text"
                          value={values.appId}
                        />
                      </UI.Field>
                      <UI.Field
                        error={clientIdMissing
                          ? translate(key("clientIdRequired"))
                          : clientIdTooLong
                          ? translate(
                            "settings.integrations.credentials.tooLong",
                            { limit: SLACK_FIELD_MAX },
                          )
                          : undefined}
                        hint={translate(key("clientIdHint"))}
                        htmlFor={ids.clientId}
                        label={translate(
                          "integrations.slack.fields.client_id",
                        )}
                        required
                        state={clientIdMissing || clientIdTooLong
                          ? "invalid"
                          : "default"}
                      >
                        <UI.TextInput
                          autoComplete="off"
                          disabled={busy}
                          id={ids.clientId}
                          invalid={clientIdMissing || clientIdTooLong}
                          name="clientId"
                          onChange={(value) =>
                            onChange("clientId", value)}
                          required
                          type="text"
                          value={values.clientId}
                        />
                      </UI.Field>
                      <UI.Field
                        error={clientSecretMissing
                          ? translate(key("clientSecretRequired"))
                          : clientSecretTooLong
                          ? translate(
                            "settings.integrations.credentials.tooLong",
                            { limit: SLACK_SECRET_MAX },
                          )
                          : undefined}
                        hint={secretHint(saved?.clientSecretSavedAt) ??
                          translate(key("clientSecretHint"))}
                        htmlFor={ids.clientSecret}
                        label={translate(
                          "integrations.slack.fields.client_secret",
                        )}
                        required={!secretKept}
                        state={clientSecretMissing || clientSecretTooLong
                          ? "invalid"
                          : "default"}
                      >
                        <UI.PasswordInput
                          autoComplete="new-password"
                          disabled={busy}
                          id={ids.clientSecret}
                          invalid={clientSecretMissing || clientSecretTooLong}
                          name="clientSecret"
                          onChange={(value) =>
                            onChange("clientSecret", value)}
                          required={!secretKept}
                          revealLabels={reveal}
                          value={values.clientSecret}
                        />
                      </UI.Field>
                      <UI.Field
                        error={signingSecretMissing
                          ? translate(key("signingSecretRequired"))
                          : signingSecretTooLong
                          ? translate(
                            "settings.integrations.credentials.tooLong",
                            { limit: SLACK_SECRET_MAX },
                          )
                          : undefined}
                        hint={secretHint(saved?.signingSecretSavedAt) ??
                          translate(key("signingSecretHint"))}
                        htmlFor={ids.signingSecret}
                        label={translate(
                          "integrations.slack.fields.signing_secret",
                        )}
                        required={!secretKept}
                        state={signingSecretMissing || signingSecretTooLong
                          ? "invalid"
                          : "default"}
                      >
                        <UI.PasswordInput
                          autoComplete="new-password"
                          disabled={busy}
                          id={ids.signingSecret}
                          invalid={signingSecretMissing || signingSecretTooLong}
                          name="signingSecret"
                          onChange={(value) => onChange("signingSecret", value)}
                          required={!secretKept}
                          revealLabels={reveal}
                          value={values.signingSecret}
                        />
                      </UI.Field>
                      <UI.Inline>
                        <UI.Button
                          disabled={busy}
                          loading={status === "saving"}
                          type="submit"
                        >
                          {translate("settings.integrations.credentials.save")}
                        </UI.Button>
                        {configured
                          ? (
                            <UI.Button
                              disabled={busy}
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
                  <UI.Inline>
                    <UI.Button
                      onClick={() => setReplacing(true)}
                      type="button"
                      variant="secondary"
                    >
                      {translate("settings.integrations.credentials.replace")}
                    </UI.Button>
                    <UI.Button
                      onClick={() => setRemoving(true)}
                      type="button"
                      variant="destructive-outline"
                    >
                      {translate(key("remove"))}
                    </UI.Button>
                  </UI.Inline>
                )}
              {removing && configured
                ? (
                  <UI.AlertDialog
                    cancelAction={
                      <UI.Button
                        onClick={() => setRemoving(false)}
                        type="button"
                        variant="secondary"
                      >
                        {translate("settings.integrations.credentials.cancel")}
                      </UI.Button>
                    }
                    confirmAction={
                      <UI.Button
                        onClick={onRemove}
                        loading={status === "removing"}
                        type="button"
                        variant="destructive"
                      >
                        {translate(key("removeConfirm"))}
                      </UI.Button>
                    }
                    open
                    title={translate(key("removeTitle"))}
                    variant="destructive"
                    onOpenChange={(open) => {
                      if (!open) setRemoving(false);
                    }}
                  >
                    <UI.Text>{translate(key("removeBody"))}</UI.Text>
                  </UI.AlertDialog>
                )
                : null}
            </>
          )
          : null}
      </UI.Stack>
    </section>
  );
}
