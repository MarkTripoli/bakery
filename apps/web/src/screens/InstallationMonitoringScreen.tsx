import * as UI from "@bakery/ui";
import { formatDate } from "@bakery/i18n";
import type {
  TelemetryDestination,
  TelemetryDestinationTestResult,
} from "../api/client.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import {
  atLimit,
  type DestinationDraft,
  type DestinationKind,
  failingOf,
  type FieldIssues,
  formProblem,
  type KindField,
  type MeasurementInfo,
  reenterNeeded,
  secretIsSaved,
  stateWords,
  unavailableFor,
} from "./monitoring/monitoring-display.ts";

/** Which dialog is open: a new destination of a kind, or one that exists. */
export type MonitoringDialog =
  | { readonly mode: "add"; readonly kind: string }
  | { readonly mode: "edit"; readonly id: string };

/** What a refused change says. */
export type SaveNotice =
  | "failed"
  | "conflict"
  | "nameTaken"
  | "limit"
  | "noKey"
  | "offline";

export type MonitoringTest =
  | { readonly state: "sending" }
  | {
    readonly state: "done";
    readonly result: TelemetryDestinationTestResult;
  }
  | { readonly state: "failed"; readonly notice: SaveNotice }
  | null;

export type InstallationMonitoringScreenProps = {
  readonly state: "loading" | "error" | "notFound" | "ready";
  readonly destinations: readonly TelemetryDestination[];
  readonly kinds: readonly DestinationKind[];
  readonly measurements: readonly MeasurementInfo[];
  readonly dialog: MonitoringDialog | null;
  readonly draft: DestinationDraft | null;
  readonly editing: TelemetryDestination | null;
  readonly kind: DestinationKind | null;
  readonly issues: FieldIssues | null;
  readonly notice: SaveNotice | null;
  readonly rowNotice: SaveNotice | null;
  readonly test: MonitoringTest;
  readonly saving: boolean;
  readonly pendingIds: readonly string[];
  readonly removing: TelemetryDestination | null;
  readonly lastUpdatedAt: number;
  readonly onAdd: (kind: string) => void;
  readonly onEdit: (destination: TelemetryDestination) => void;
  readonly onChange: (draft: DestinationDraft) => void;
  readonly onClose: () => void;
  readonly onSave: () => void;
  readonly onTest: () => void;
  readonly onToggle: (
    destination: TelemetryDestination,
    enabled: boolean,
  ) => void;
  readonly onRemoveAsk: (destination: TelemetryDestination | null) => void;
  readonly onRemove: () => void;
  readonly onReload: () => void;
  readonly onRetry: () => void;
};

const NOTICE_KEYS = {
  failed: "installation.monitoring.notice.failed",
  conflict: "installation.monitoring.notice.conflict",
  nameTaken: "installation.monitoring.notice.nameTaken",
  limit: "installation.monitoring.notice.limit",
  noKey: "installation.monitoring.notice.noKey",
  offline: "installation.monitoring.notice.offline",
} as const;

/**
 * `/installation/monitoring`: where Bakery sends its measurements. Everything
 * on the form comes from what the server lists, so a new kind of destination
 * needs no change here.
 */
export function InstallationMonitoringScreen(
  props: InstallationMonitoringScreenProps,
) {
  const { translate, locale, timeZone } = useI18n();
  const { state, destinations, kinds } = props;
  const when = (iso: string) =>
    formatDate(new Date(iso), locale, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone,
    });
  const kindLabel = (id: string) =>
    kinds.find((entry) => entry.kind === id)?.label ?? id;
  const limit = atLimit(destinations);
  const failing = failingOf(destinations);

  if (state === "notFound") {
    return (
      <UI.EmptyState
        description={translate("installation.monitoring.notFound.body")}
        inset="page"
        layout="centered"
        title={translate("installation.monitoring.notFound.title")}
        variant="filtered"
      />
    );
  }

  const addControl = kinds.length === 1
    ? (
      <UI.Button
        disabled={limit}
        onClick={() => props.onAdd(kinds[0].kind)}
        type="button"
      >
        {translate("installation.monitoring.add")}
      </UI.Button>
    )
    : (
      <UI.Popover
        align="end"
        label={translate("installation.monitoring.add")}
        trigger={translate("installation.monitoring.add")}
        triggerAppearance="toolbar"
        variant="interactive"
      >
        <UI.Menu
          aria-label={translate("installation.monitoring.add")}
          items={kinds.map((entry) => ({
            id: entry.kind,
            label: entry.label,
            disabled: limit,
          }))}
          onSelect={props.onAdd}
        />
      </UI.Popover>
    );

  return (
    <UI.SettingsContent data-page="installation-monitoring">
      <UI.AuthHeading
        description={translate("installation.monitoring.description")}
        title={translate("installation.monitoring.title")}
      />
      {state === "loading"
        ? (
          <UI.Stack aria-busy="true" gap="compact">
            <UI.Skeleton shape="row" />
            <UI.Skeleton shape="row" />
          </UI.Stack>
        )
        : null}
      {state === "error"
        ? (
          <UI.ErrorState
            action={
              <UI.Button onClick={props.onRetry} type="button">
                {translate("installation.monitoring.retry")}
              </UI.Button>
            }
            title={translate("installation.monitoring.error")}
          />
        )
        : null}
      {state === "ready"
        ? (
          <>
            {failing.slice(0, 3).map((destination) => (
              <UI.InlineNotice key={destination.id} tone="error">
                <strong>
                  {translate("installation.monitoring.failing.title", {
                    name: destination.name,
                  })}
                </strong>{" "}
                {destination.lastAnswerReason ?? ""}{" "}
                {destination.lastAcceptedAt === null
                  ? ""
                  : translate("installation.monitoring.failing.lastAccepted", {
                    time: when(destination.lastAcceptedAt),
                  })}{" "}
                {destination.dropped > 0 && destination.droppedSince !== null
                  ? translate("installation.monitoring.failing.dropped", {
                    count: destination.dropped,
                    since: when(destination.droppedSince),
                  })
                  : ""}{" "}
                {translate("installation.monitoring.failing.notAffected")}
              </UI.InlineNotice>
            ))}
            {failing.length > 3
              ? (
                <UI.Text variant="muted">
                  {translate("installation.monitoring.failing.more", {
                    count: failing.length - 3,
                  })}
                </UI.Text>
              )
              : null}
            {props.rowNotice !== null
              ? (
                <UI.InlineNotice tone="error">
                  {translate(NOTICE_KEYS[props.rowNotice])}
                </UI.InlineNotice>
              )
              : null}
            <UI.SettingsSection
              title={translate("installation.monitoring.section")}
              variant="stack"
            >
              <UI.Text variant="muted">
                {translate("installation.monitoring.sectionLine")}
              </UI.Text>
              <UI.Inline gap="standard">
                {destinations.length > 0 || kinds.length === 0
                  ? addControl
                  : null}
                {limit
                  ? (
                    <UI.Text variant="muted">
                      {translate("installation.monitoring.limit")}
                    </UI.Text>
                  )
                  : null}
              </UI.Inline>
              {destinations.length === 0
                ? (
                  <UI.EmptyState
                    action={
                      <UI.Inline gap="standard">
                        {kinds.map((entry) => (
                          <UI.Button
                            key={entry.kind}
                            onClick={() => props.onAdd(entry.kind)}
                            type="button"
                          >
                            {translate("installation.monitoring.addKind", {
                              kind: entry.label,
                            })}
                          </UI.Button>
                        ))}
                      </UI.Inline>
                    }
                    description={translate(
                      "installation.monitoring.empty.body",
                    )}
                    title={translate("installation.monitoring.empty.title")}
                    variant="firstUse"
                  />
                )
                : (
                  <UI.Stack
                    aria-label={translate("installation.monitoring.section")}
                    gap="compact"
                    role="list"
                  >
                    {destinations.map((destination) => (
                      <div key={destination.id} role="listitem">
                        <DestinationRow
                          destination={destination}
                          kindLabel={kindLabel(destination.kind)}
                          measurements={props.measurements}
                          onEdit={() =>
                            props.onEdit(destination)}
                          onToggle={(enabled) =>
                            props.onToggle(destination, enabled)}
                          pending={props.pendingIds.includes(destination.id)}
                          when={when}
                        />
                      </div>
                    ))}
                  </UI.Stack>
                )}
            </UI.SettingsSection>
            <UI.Text variant="muted">
              {translate("installation.monitoring.updated", {
                time: when(new Date(props.lastUpdatedAt).toISOString()),
              })}
            </UI.Text>
          </>
        )
        : null}
      <DestinationDialog {...props} />
      <UI.AlertDialog
        cancelAction={
          <UI.Button
            onClick={() => props.onRemoveAsk(null)}
            type="button"
            variant="secondary"
          >
            {translate("installation.monitoring.remove.cancel")}
          </UI.Button>
        }
        confirmAction={
          <UI.Button onClick={props.onRemove} type="button">
            {translate("installation.monitoring.remove.confirm")}
          </UI.Button>
        }
        onOpenChange={(open) => {
          if (!open) props.onRemoveAsk(null);
        }}
        open={props.removing !== null}
        title={translate("installation.monitoring.remove.title", {
          name: props.removing?.name ?? "",
        })}
        variant="destructive"
      >
        {translate("installation.monitoring.remove.body")}
      </UI.AlertDialog>
    </UI.SettingsContent>
  );
}

function DestinationRow(
  { destination, kindLabel, measurements, onEdit, onToggle, pending, when }: {
    readonly destination: TelemetryDestination;
    readonly kindLabel: string;
    readonly measurements: readonly MeasurementInfo[];
    readonly onEdit: () => void;
    readonly onToggle: (enabled: boolean) => void;
    readonly pending: boolean;
    readonly when: (iso: string) => string;
  },
) {
  const { translate } = useI18n();
  const words = stateWords(destination.state);
  const receives = measurements
    .filter((info) => destination.measurements.includes(info.kind))
    .map((info) => info.label)
    .join(", ");
  const line = [
    kindLabel,
    receives,
    destination.state === "working" && destination.lastAcceptedAt !== null
      ? translate("installation.monitoring.row.lastSent", {
        time: when(destination.lastAcceptedAt),
      })
      : destination.state === "not_tested_yet"
      ? translate("installation.monitoring.row.nothingSent")
      : destination.state === "failing"
      ? destination.lastAnswerReason ?? ""
      : destination.state === "dropping_data" && destination.droppedSince
      ? translate("installation.monitoring.row.dropped", {
        count: destination.dropped,
        since: when(destination.droppedSince),
      })
      : destination.state === "off"
      ? translate("installation.monitoring.row.off")
      : "",
    destination.state === "working" && destination.dropped > 0 &&
      destination.droppedSince !== null
      ? translate("installation.monitoring.row.droppedMore", {
        count: destination.dropped,
        since: when(destination.droppedSince),
      })
      : "",
  ].filter((part) => part !== "").join(" \u00b7 ");
  return (
    <UI.Inline gap="compact" variant="between">
      <UI.Stack gap="tight">
        <UI.Inline gap="compact">
          <UI.Heading level="subsection-compact">{destination.name}</UI.Heading>
          <UI.Badge tone={words.tone}>{translate(words.key)}</UI.Badge>
        </UI.Inline>
        <UI.Text variant="muted">{line}</UI.Text>
      </UI.Stack>
      <UI.Inline gap="compact">
        <UI.Button
          onClick={onEdit}
          type="button"
          variant={destination.state === "failing" ? "primary" : "secondary"}
        >
          {translate(
            destination.state === "failing"
              ? "installation.monitoring.row.fix"
              : "installation.monitoring.row.manage",
          )}
        </UI.Button>
        <UI.Switch
          checked={destination.enabled}
          disabled={pending}
          onChange={(event) => onToggle(event.currentTarget.checked)}
          pending={pending}
        >
          <UI.VisuallyHidden>
            {translate(
              destination.enabled
                ? "installation.monitoring.row.switchOn"
                : "installation.monitoring.row.switchOff",
              { name: destination.name },
            )}
          </UI.VisuallyHidden>
        </UI.Switch>
      </UI.Inline>
    </UI.Inline>
  );
}

function DestinationDialog(props: InstallationMonitoringScreenProps) {
  const { translate, locale, timeZone } = useI18n();
  const { dialog, draft, kind, editing, issues } = props;
  if (dialog === null || draft === null || kind === null) return null;
  const problem = formProblem(editing, kind, draft);
  const again = reenterNeeded(editing, kind, draft);
  const fieldInput = (field: KindField) => {
    // A saved secret shows as saved until the address it is bound to moves.
    const saved = secretIsSaved(editing, field, draft) && !again;
    const message = issues?.values[field.name];
    const help = field.secret && again &&
        editing?.secretFieldsSet.includes(field.name)
      ? translate("installation.monitoring.form.reenter")
      : field.help;
    return (
      <UI.Field
        error={message}
        hint={saved ? undefined : help}
        htmlFor={`monitoring-field-${field.name}`}
        key={field.name}
        label={field.label}
      >
        {saved
          ? (
            <UI.Inline gap="standard">
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
              id={`monitoring-field-${field.name}`}
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
              id={`monitoring-field-${field.name}`}
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
  return (
    <UI.Dialog
      dismissLabel={translate("installation.monitoring.form.close")}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      open
      state={props.saving ? "submitting" : props.notice ? "error" : "open"}
      title={editing === null
        ? translate("installation.monitoring.form.addTitle", {
          kind: kind.label,
        })
        : editing.name}
      variant="form"
    >
      <UI.Stack gap="standard">
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
        <UI.Stack gap="compact">
          <UI.Heading level="subsection-compact">
            {translate("installation.monitoring.form.measurements")}
          </UI.Heading>
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
        </UI.Stack>
        <TestResult test={props.test} />
        <UI.Inline data-form-actions gap="standard" variant="between">
          <UI.Inline gap="standard">
            <UI.Button
              disabled={props.test?.state === "sending" ||
                (again && problem === "reenter")}
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
            {editing !== null
              ? (
                <UI.Button
                  onClick={() => props.onRemoveAsk(editing)}
                  type="button"
                  variant="destructive-outline"
                >
                  {translate("installation.monitoring.form.remove")}
                </UI.Button>
              )
              : null}
          </UI.Inline>
          <UI.Inline gap="standard">
            <UI.Button
              onClick={props.onClose}
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
        </UI.Inline>
      </UI.Stack>
    </UI.Dialog>
  );
}

function TestResult({ test }: { readonly test: MonitoringTest }) {
  const { translate } = useI18n();
  if (test === null || test.state === "sending") return null;
  if (test.state === "failed") {
    return (
      <UI.InlineNotice tone="error">
        {translate(NOTICE_KEYS[test.notice])}
      </UI.InlineNotice>
    );
  }
  const result = test.result;
  return (
    <div aria-live="polite" role="status">
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
          <UI.Stack gap="compact">
            <UI.InlineNotice tone="error">
              <strong>
                {translate("installation.monitoring.test.failed")}
              </strong>{" "}
              {result.reason ?? ""}
              {` ${
                translate("installation.monitoring.test.took", {
                  ms: result.tookMs,
                })
              }`}
            </UI.InlineNotice>
            {result.answer !== null
              ? <UI.DataText>{result.answer}</UI.DataText>
              : null}
          </UI.Stack>
        )}
    </div>
  );
}
