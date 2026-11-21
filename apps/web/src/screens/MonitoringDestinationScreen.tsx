import * as UI from "@bakery/ui";
import { formatDate } from "@bakery/i18n";
import type { MessageKey } from "@bakery/i18n";
import type {
  TelemetryDestination,
  TelemetryDestinationTestResult,
} from "../api/client.ts";
import { useShellViewport } from "../app/responsive.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import {
  NOTICE_KEYS,
  type SaveNotice,
} from "./InstallationMonitoringScreen.tsx";
import {
  type DestinationDraft,
  type DestinationKind,
  type FieldIssues,
  formProblem,
  type KindField,
  type MeasurementInfo,
  type ProviderInfo,
  reenterNeeded,
  secretIsSaved,
  stateWords,
  unavailableFor,
} from "./monitoring/monitoring-display.ts";

export type MonitoringTest =
  | { readonly state: "sending" }
  | {
    readonly state: "done";
    readonly result: TelemetryDestinationTestResult;
  }
  | { readonly state: "failed"; readonly notice: SaveNotice }
  | null;

export type MonitoringDestinationScreenProps = {
  readonly state: "loading" | "error" | "notFound" | "ready";
  /** The kind of this destination, or the one being added. */
  readonly kind: DestinationKind | null;
  /** Who runs the backend it sends to, or null when the server no longer knows it. */
  readonly provider: ProviderInfo | null;
  /** The destination being edited; `null` while adding a new one. */
  readonly editing: TelemetryDestination | null;
  readonly measurements: readonly MeasurementInfo[];
  readonly draft: DestinationDraft | null;
  readonly issues: FieldIssues | null;
  readonly notice: SaveNotice | null;
  readonly test: MonitoringTest;
  readonly saving: boolean;
  readonly togglePending: boolean;
  /** The remove confirmation is open. */
  readonly removing: boolean;
  readonly onChange: (draft: DestinationDraft) => void;
  readonly onCancel: () => void;
  readonly onSave: () => void;
  readonly onTest: () => void;
  readonly onToggle: (enabled: boolean) => void;
  readonly onRemoveAsk: (open: boolean) => void;
  readonly onRemove: () => void;
  readonly onReload: () => void;
  readonly onRetry: () => void;
};

/**
 * `/installation/monitoring/new` and `/installation/monitoring/{id}`: one
 * destination on its own page. The form is built from what the server lists
 * for its kind, so a new kind needs no change here; status and the test sit
 * beside it.
 */
export function MonitoringDestinationScreen(
  props: MonitoringDestinationScreenProps,
) {
  const { translate, locale, timeZone } = useI18n();
  const viewport = useShellViewport();
  const { state, kind, editing, draft, issues } = props;
  const when = (iso: string) =>
    formatDate(new Date(iso), locale, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone,
    });

  if (state === "notFound") {
    return (
      <UI.EmptyState
        description={translate(
          "installation.monitoring.destinationNotFound.body",
        )}
        inset="page"
        layout="centered"
        title={translate("installation.monitoring.destinationNotFound.title")}
        variant="filtered"
      />
    );
  }
  if (state === "loading") {
    return (
      <UI.SettingsContent data-page="installation-monitoring-destination">
        <UI.Stack aria-busy="true" gap="compact">
          <UI.Skeleton shape="row" />
          <UI.Skeleton shape="row" />
        </UI.Stack>
      </UI.SettingsContent>
    );
  }
  if (state === "ready" && kind !== null && draft === null) {
    // The query is ready and the draft follows on the next effect: the form's
    // skeleton shows, not an error that flashes before the form.
    return (
      <UI.SettingsContent data-page="installation-monitoring-destination">
        <UI.Stack aria-busy="true" gap="compact">
          <UI.Skeleton shape="row" />
          <UI.Skeleton shape="row" />
        </UI.Stack>
      </UI.SettingsContent>
    );
  }
  if (state === "error" || kind === null || draft === null) {
    return (
      <UI.SettingsContent data-page="installation-monitoring-destination">
        <UI.ErrorState
          action={
            <UI.Button onClick={props.onRetry} type="button">
              {translate("installation.monitoring.retry")}
            </UI.Button>
          }
          title={translate("installation.monitoring.destinationError")}
        />
      </UI.SettingsContent>
    );
  }

  const problem = formProblem(editing, kind, draft);
  const again = reenterNeeded(editing, kind, draft);
  // A new destination has nothing to test until its required settings are in.
  // Below the two-column width a new destination is filled, tested, then
  // saved: its Test card sits above the save row, not before an empty form.
  const testBelowForm = editing === null && viewport !== "desktop";
  const providerName = props.provider?.name ?? kind.label;
  const providerKey = props.provider?.key ?? kind.kind;
  const missingValues = editing === null &&
    kind.fields.some((field) =>
      field.required && (draft.values[field.name] ?? "").trim() === ""
    );
  // The test waits for the connection fields: on a new destination until the
  // required ones are filled, on a saved one until a moved address has its
  // sign-in value typed again.
  const savedSecret = kind.fields.find((field) =>
    field.secret && editing?.secretFieldsSet.includes(field.name) &&
    !draft.touchedSecrets.includes(field.name)
  );
  const needsSecret = !missingValues && again && problem === "reenter";
  const needsValues = missingValues || needsSecret;
  const words = editing === null ? null : stateWords(editing.state);

  const fieldInput = (field: KindField) => {
    const saved = secretIsSaved(editing, field, draft) && !again;
    const message = issues?.values[field.name];
    const help = field.secret && again &&
        editing?.secretFieldsSet.includes(field.name)
      ? translate("installation.monitoring.form.reenter")
      : field.help;
    const id = `monitoring-field-${field.name}`;
    return (
      <UI.Field
        error={message}
        hint={saved ? undefined : help}
        htmlFor={id}
        key={field.name}
        label={field.label}
      >
        {saved
          ? (
            <UI.Inline gap="compact">
              <UI.Text>
                {translate("installation.monitoring.form.savedSecret", {
                  date: editing?.credentialUpdatedAt === null ||
                      editing?.credentialUpdatedAt === undefined
                    ? ""
                    : formatDate(
                      new Date(editing.credentialUpdatedAt),
                      locale,
                      {
                        dateStyle: "medium",
                        timeZone,
                      },
                    ),
                })}
              </UI.Text>
              <UI.Button
                onClick={() =>
                  props.onChange({
                    ...draft,
                    touchedSecrets: [...draft.touchedSecrets, field.name],
                  })}
                type="button"
                variant="secondary"
              >
                {translate("installation.monitoring.form.replace")}
              </UI.Button>
              <UI.Button
                onClick={() =>
                  props.onChange({
                    ...draft,
                    values: { ...draft.values, [field.name]: "" },
                    touchedSecrets: [...draft.touchedSecrets, field.name],
                  })}
                aria-label={translate(
                  "installation.monitoring.form.removeSecretNamed",
                  { field: field.label },
                )}
                type="button"
                variant="secondary"
              >
                {translate("installation.monitoring.form.removeSecret")}
              </UI.Button>
            </UI.Inline>
          )
          : field.secret
          ? (
            <UI.PasswordInput
              autoComplete="new-password"
              id={id}
              invalid={message !== undefined}
              name={field.name}
              onChange={(value) =>
                props.onChange({
                  ...draft,
                  values: { ...draft.values, [field.name]: value },
                  touchedSecrets: draft.touchedSecrets.includes(field.name)
                    ? draft.touchedSecrets
                    : [...draft.touchedSecrets, field.name],
                })}
              revealLabels={{
                hide: translate("installation.monitoring.form.hide"),
                show: translate("installation.monitoring.form.show"),
              }}
              value={draft.values[field.name] ?? ""}
            />
          )
          : (
            <UI.TextInput
              autoComplete="off"
              id={id}
              invalid={message !== undefined}
              name={field.name}
              onChange={(value) =>
                props.onChange({
                  ...draft,
                  values: { ...draft.values, [field.name]: value },
                })}
              type="text"
              value={draft.values[field.name] ?? ""}
            />
          )}
      </UI.Field>
    );
  };
  const toggleMeasurement = (id: string, on: boolean) =>
    props.onChange({
      ...draft,
      measurements: on
        ? [...draft.measurements, id]
        : draft.measurements.filter((item) => item !== id),
    });

  const testSection = (
    <UI.SettingsSection
      title={translate("installation.monitoring.test.heading")}
      variant="stack"
    >
      <UI.Text variant="muted">
        {translate("installation.monitoring.test.line")}
      </UI.Text>
      <UI.Inline gap="standard">
        <UI.Button
          disabled={props.test?.state === "sending" || needsValues}
          onClick={props.onTest}
          type="button"
          variant="secondary"
        >
          {translate(
            props.test?.state === "sending"
              ? "installation.monitoring.test.sending"
              : "installation.monitoring.test.button",
          )}
        </UI.Button>
      </UI.Inline>
      {needsValues
        ? (
          <UI.Text variant="muted">
            {missingValues
              ? translate("installation.monitoring.test.needsValues")
              : translate("installation.monitoring.test.needsSecret", {
                field: (savedSecret?.label ?? "").toLocaleLowerCase(locale),
              })}
          </UI.Text>
        )
        : null}
      {/* One live region stays mounted, so a result of either kind is announced. */}
      <div aria-live="polite" role="status">
        <TestResult test={props.test} />
      </div>
    </UI.SettingsSection>
  );

  return (
    <UI.SettingsContent data-page="installation-monitoring-destination">
      <UI.PageHeader
        subtitle={editing === null ? undefined : (
          <>
            {words === null
              ? null
              : <UI.Badge tone={words.tone}>{translate(words.key)}</UI.Badge>}
            <span>
              {translate("installation.monitoring.kindLine", {
                kind: providerName,
              })}
            </span>
          </>
        )}
        summary={editing === null ? undefined : (
          <UI.Switch
            checked={editing.enabled}
            disabled={props.togglePending}
            onChange={(event) => props.onToggle(event.currentTarget.checked)}
            pending={props.togglePending}
          >
            {translate("installation.monitoring.sendingLabel")}
          </UI.Switch>
        )}
        title={
          <>
            <UI.ProviderMark
              name={providerName}
              provider={providerKey}
              size="header"
            />
            {editing === null
              ? translate("installation.monitoring.form.addTitle", {
                kind: providerName,
              })
              : editing.name}
          </>
        }
        variant="split"
      />
      {editing?.state === "failing"
        ? (
          <UI.AlertBanner tone="error">
            <strong>
              {translate("installation.monitoring.failing.title", {
                name: editing.name,
              })}
            </strong>{" "}
            {editing.lastAnswerReason ?? ""}{" "}
            {translate("installation.monitoring.failing.notAffected")}
          </UI.AlertBanner>
        )
        : null}
      {props.notice !== null
        ? (
          <UI.InlineNotice
            action={props.notice === "conflict"
              ? (
                <UI.Button
                  onClick={props.onReload}
                  type="button"
                  variant="secondary"
                >
                  {translate("installation.monitoring.notice.reload")}
                </UI.Button>
              )
              : undefined}
            tone="error"
          >
            {translate(NOTICE_KEYS[props.notice])}
          </UI.InlineNotice>
        )
        : null}
      <UI.Inline gap="spacious" variant="split">
        <UI.Stack gap="spacious">
          <UI.SettingsSection
            title={translate("installation.monitoring.form.connection")}
            variant="stack"
          >
            <UI.Field
              error={issues?.name ??
                (props.notice === "nameTaken"
                  ? translate("installation.monitoring.notice.nameTaken")
                  : undefined)}
              hint={translate("installation.monitoring.form.nameHelp")}
              htmlFor="monitoring-name"
              label={translate("installation.monitoring.form.name")}
            >
              <UI.TextInput
                autoComplete="off"
                id="monitoring-name"
                invalid={issues?.name !== undefined}
                name="name"
                onChange={(value) => props.onChange({ ...draft, name: value })}
                type="text"
                value={draft.name}
              />
            </UI.Field>
            {kind.fields.map(fieldInput)}
          </UI.SettingsSection>
          <UI.SettingsSection
            title={translate("installation.monitoring.form.measurements")}
            variant="stack"
          >
            {props.measurements.map((info) => {
              const reason = unavailableFor(kind, info);
              return (
                <UI.Stack gap="none" key={info.kind}>
                  <UI.Checkbox
                    checked={draft.measurements.includes(info.kind)}
                    disabled={reason !== null}
                    onChange={(event) =>
                      toggleMeasurement(info.kind, event.currentTarget.checked)}
                  >
                    {info.label}
                  </UI.Checkbox>
                  <UI.Text variant="muted">
                    {reason === null || reason === "" ? info.help : reason}
                  </UI.Text>
                </UI.Stack>
              );
            })}
            {issues?.measurements !== undefined
              ? (
                <UI.InlineNotice tone="error">
                  {issues.measurements}
                </UI.InlineNotice>
              )
              : null}
          </UI.SettingsSection>
          {testBelowForm ? testSection : null}
          <UI.Inline data-form-actions gap="standard" variant="end">
            <UI.Button
              onClick={props.onCancel}
              type="button"
              variant="secondary"
            >
              {translate("installation.monitoring.form.cancel")}
            </UI.Button>
            <UI.Button
              disabled={problem !== null}
              loading={props.saving}
              onClick={props.onSave}
              type="button"
            >
              {translate(
                editing === null
                  ? "installation.monitoring.form.saveAdd"
                  : "installation.monitoring.form.save",
              )}
            </UI.Button>
          </UI.Inline>
          {editing === null ? null : (
            <UI.SettingsSection
              title={translate("installation.monitoring.form.removeHeading")}
              variant="stack"
            >
              <UI.Text variant="muted">
                {translate("installation.monitoring.remove.body")}
              </UI.Text>
              <UI.Inline gap="standard">
                <UI.Button
                  onClick={() => props.onRemoveAsk(true)}
                  type="button"
                  variant="destructive-outline"
                >
                  {translate("installation.monitoring.form.remove")}
                </UI.Button>
              </UI.Inline>
            </UI.SettingsSection>
          )}
        </UI.Stack>
        {editing === null && testBelowForm ? null : (
          <UI.Stack gap="spacious">
            {editing === null ? null : (
              <UI.SettingsSection
                title={translate("installation.monitoring.status.heading")}
                variant="stack"
              >
                <UI.DescriptionList>
                  <UI.DescriptionItem
                    description={editing.lastAcceptedAt === null
                      ? translate("installation.monitoring.status.never")
                      : when(editing.lastAcceptedAt)}
                    title={translate("installation.monitoring.column.lastSent")}
                  />
                  <UI.DescriptionItem
                    description={editing.lastAnswerReason ??
                      translate("installation.monitoring.status.noAnswer")}
                    title={translate("installation.monitoring.status.answer")}
                  />
                  <UI.DescriptionItem
                    description={editing.dropped === 0
                      ? "0"
                      : editing.droppedSince === null
                      ? translate(
                        "installation.monitoring.status.droppedCount",
                        {
                          count: editing.dropped,
                        },
                      )
                      : translate("installation.monitoring.status.dropped", {
                        count: editing.dropped,
                        since: when(editing.droppedSince),
                      })}
                    title={translate("installation.monitoring.column.dropped")}
                  />
                </UI.DescriptionList>
              </UI.SettingsSection>
            )}
            {testBelowForm ? null : testSection}
          </UI.Stack>
        )}
      </UI.Inline>
      <UI.AlertDialog
        cancelAction={
          <UI.Button
            onClick={() => props.onRemoveAsk(false)}
            type="button"
            variant="secondary"
          >
            {translate("installation.monitoring.remove.cancel")}
          </UI.Button>
        }
        confirmAction={
          <UI.Button
            disabled={props.togglePending}
            loading={props.togglePending}
            onClick={props.onRemove}
            type="button"
          >
            {translate("installation.monitoring.remove.confirm")}
          </UI.Button>
        }
        onOpenChange={(open) => {
          if (!open) props.onRemoveAsk(false);
        }}
        open={props.removing}
        title={translate("installation.monitoring.remove.title", {
          name: editing?.name ?? "",
        })}
        variant="destructive"
      >
        {translate("installation.monitoring.remove.body")}
      </UI.AlertDialog>
    </UI.SettingsContent>
  );
}

const TEST_NOTICE: Readonly<Record<SaveNotice, MessageKey>> = NOTICE_KEYS;

function TestResult({ test }: { readonly test: MonitoringTest }) {
  const { translate } = useI18n();
  if (test === null || test.state === "sending") return null;
  if (test.state === "failed") {
    return (
      <UI.InlineNotice tone="error">
        {translate(TEST_NOTICE[test.notice])}
      </UI.InlineNotice>
    );
  }
  const result = test.result;
  return (
    <>
      {result.ok
        ? (
          <UI.InlineNotice tone="success">
            <strong>{translate("installation.monitoring.test.passed")}</strong>
            {" "}
            {translate("installation.monitoring.test.passedBody", {
              status: result.status ?? 0,
              ms: result.tookMs,
            })}
          </UI.InlineNotice>
        )
        : (
          <UI.InlineNotice tone="error">
            <strong>{translate("installation.monitoring.test.failed")}</strong>
            {" "}
            {result.reason ?? ""}
            {` ${
              translate("installation.monitoring.test.took", {
                ms: result.tookMs,
              })
            }`}
            {result.answer !== null
              ? <UI.DataText>{result.answer}</UI.DataText>
              : null}
          </UI.InlineNotice>
        )}
    </>
  );
}
