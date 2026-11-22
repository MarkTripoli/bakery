import type { ReactNode } from "react";
import * as UI from "@bakery/ui";
import type {
  InstallationUncertainActions,
  InstallationUpdateStatus,
} from "../api/client.ts";
import { useShellViewport } from "../app/responsive.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import {
  failureNotice,
  previousFact,
  runningFact,
  shortRelease,
  slot,
  splitSlots,
  type UpdateRow,
} from "./updates/update-history.ts";

export type UpdatesScreenState = "loading" | "error" | "notFound" | "ready";
export type UpdatePolicyValue = "go_back" | "ask";

export type UpdatePolicyForm = {
  /** The choice shown, or null until the settings are read. */
  readonly value: UpdatePolicyValue | null;
  readonly dirty: boolean;
  readonly saving: boolean;
  /** Why the choice cannot be changed now: a restore holds Bakery, or an update runs. */
  readonly lock: "held" | "paused" | null;
  readonly problem: "conflict" | "failed" | null;
  readonly saved: boolean;
};

export type InstallationUpdatesScreenProps = {
  readonly state: UpdatesScreenState;
  readonly status: InstallationUpdateStatus | null;
  readonly history: {
    readonly state: "loading" | "error" | "ready";
    readonly rows: readonly UpdateRow[];
    readonly hasMore: boolean;
    readonly loadingMore: boolean;
  };
  readonly uncertain: InstallationUncertainActions | null;
  readonly policy: UpdatePolicyForm;
  readonly dismissing: boolean;
  readonly onRetry: () => void;
  readonly onRetryHistory: () => void;
  readonly onLoadMore: () => void;
  readonly onPolicyChange: (value: UpdatePolicyValue) => void;
  readonly onSave: () => void;
  readonly onSavedShown: () => void;
  readonly onDismiss: (id: string) => void;
  readonly onOpenRestore: () => void;
};

/** The id of the held outside actions section, so "See them" can move there. */
const HELD_SECTION = "installation-updates-held";

/** A sentence whose slots are nodes: a release with its full id, a command. */
function Sentence(
  { text, nodes }: {
    readonly text: string;
    readonly nodes: Readonly<Record<string, ReactNode>>;
  },
) {
  return (
    <>
      {splitSlots(text).map((part, index) =>
        "slot" in part
          ? <span key={index}>{nodes[part.slot] ?? null}</span>
          : <span key={index}>{part.text}</span>
      )}
    </>
  );
}

/** A release as its first 8 characters, with the full id on hover and focus. */
function Release({ id }: { readonly id: string }) {
  return (
    <UI.Tooltip content={id}>
      <UI.DataText fit tabIndex={0} variant="identifier">
        {shortRelease(id)}
      </UI.DataText>
    </UI.Tooltip>
  );
}

function Command({ children }: { readonly children: string }) {
  return (
    <UI.DataText fit variant="code">
      {children}
    </UI.DataText>
  );
}

/**
 * Updates (#59 slice 4, design-ux revisions 3 and 4): which version runs, the
 * one Bakery can go back to, what happens when an update fails, and the
 * history. Updates themselves are started on the server, never here.
 */
export function InstallationUpdatesScreen(
  props: InstallationUpdatesScreenProps,
) {
  const { translate, locale, timeZone } = useI18n();
  const { state, status } = props;
  const dateTime = (iso: string) =>
    new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone,
    }).format(new Date(iso));
  const date = (iso: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone }).format(
      new Date(iso),
    );

  if (state === "notFound") {
    return (
      <UI.EmptyState
        description={translate("installation.updates.notFound.body")}
        inset="page"
        layout="centered"
        title={translate("installation.updates.notFound.title")}
        variant="filtered"
      />
    );
  }

  return (
    <UI.SettingsContent data-page="installation-updates" variant="wide">
      <UI.Stack gap="standard">
        <UI.PageHeader
          description={translate("installation.updates.description")}
          title={translate("installation.updates.title")}
          variant="list"
        />
        {state === "loading"
          ? (
            <UI.Stack
              aria-busy="true"
              aria-label={translate("installation.updates.loading")}
              gap="standard"
            >
              <UI.Skeleton shape="row" />
              <UI.Skeleton shape="row" />
              <UI.Skeleton shape="row" />
              <UI.Skeleton shape="row" />
              <UI.Skeleton shape="row" />
              <UI.Skeleton shape="row" />
              <UI.Skeleton shape="row" />
              <UI.Skeleton shape="row" />
            </UI.Stack>
          )
          : state === "error" || status === null
          ? (
            <UI.InlineNotice
              action={
                <UI.Button onClick={props.onRetry} variant="secondary">
                  {translate("core.actions.retry")}
                </UI.Button>
              }
              role="alert"
              tone="error"
            >
              {translate("installation.updates.error")}
            </UI.InlineNotice>
          )
          : (
            <>
              <FailureNotice
                dateTime={dateTime}
                dismissing={props.dismissing}
                held={props.uncertain?.total ?? 0}
                onDismiss={props.onDismiss}
                status={status}
              />
              <Facts date={date} status={status} />
              <Policy {...props} />
              <History {...props} dateTime={dateTime} />
              <Held date={date} uncertain={props.uncertain} />
            </>
          )}
        {props.policy.saved
          ? (
            <UI.Toast onDismiss={props.onSavedShown} tone="success">
              {translate("installation.updates.policy.saved")}
            </UI.Toast>
          )
          : null}
      </UI.Stack>
    </UI.SettingsContent>
  );
}

function FailureNotice(
  { status, held, dismissing, onDismiss, dateTime }: {
    readonly status: InstallationUpdateStatus;
    readonly held: number;
    readonly dismissing: boolean;
    readonly onDismiss: (id: string) => void;
    readonly dateTime: (iso: string) => string;
  },
) {
  const { translate } = useI18n();
  const failure = status.lastFailure;
  const notice = failureNotice(failure);
  if (failure === null || notice === null) return null;
  const nodes = {
    from: failure.fromRelease ? <Release id={failure.fromRelease} /> : null,
    to: failure.toRelease ? <Release id={failure.toRelease} /> : null,
    command: (
      <Command>
        {failure.kind === "interrupted"
          ? "bakery-release recover"
          : "bakery-release rollback"}
      </Command>
    ),
  };
  const values = {
    from: slot("from"),
    to: slot("to"),
    command: slot("command"),
    by: failure.by ?? "",
    when: translate("installation.updates.notice.when", {
      date: dateTime(failure.at),
    }),
  };
  return (
    <UI.InlineNotice
      action={
        <UI.Inline gap="compact">
          {held > 0
            ? (
              <UI.Button
                onClick={() =>
                  document.getElementById(HELD_SECTION)?.scrollIntoView()}
                variant="secondary"
              >
                {translate("installation.updates.notice.seeThem")}
              </UI.Button>
            )
            : null}
          <UI.Button
            loading={dismissing}
            onClick={() => onDismiss(failure.id)}
            variant="secondary"
          >
            {translate("installation.updates.notice.dismiss")}
          </UI.Button>
        </UI.Inline>
      }
      data-failure={failure.kind}
      role="status"
      tone={notice.tone}
    >
      <UI.Stack gap="tight">
        <UI.Text variant="strong">
          <Sentence nodes={nodes} text={translate(notice.title, values)} />
        </UI.Text>
        <UI.Text>
          <Sentence nodes={nodes} text={translate(notice.body, values)} />
        </UI.Text>
        {held > 0
          ? (
            <UI.Text>
              {translate("installation.updates.notice.held", { count: held })}
            </UI.Text>
          )
          : null}
      </UI.Stack>
    </UI.InlineNotice>
  );
}

function Facts(
  { status, date }: {
    readonly status: InstallationUpdateStatus;
    readonly date: (iso: string) => string;
  },
) {
  const { translate } = useI18n();
  const running = runningFact(status);
  const previous = previousFact(status);
  return (
    <UI.Stack gap="standard">
      <UI.DescriptionList labels="quiet">
        <UI.DescriptionItem
          action={
            <UI.Badge tone={status.healthy ? "success" : "danger"}>
              {translate(
                status.healthy
                  ? "installation.updates.facts.healthy"
                  : "installation.updates.facts.notHealthy",
              )}
            </UI.Badge>
          }
          data-fact="running"
          description={
            <Sentence
              nodes={{ release: <Release id={running.release} /> }}
              text={translate(running.key, {
                release: slot("release"),
                since: running.since === null ? "" : date(running.since),
              })}
            />
          }
          title={translate("installation.updates.facts.running")}
        />
        <UI.DescriptionItem
          data-fact="previous"
          description={previous.key ===
              "installation.updates.facts.previousNone"
            ? translate(previous.key)
            : (
              <Sentence
                nodes={{ release: <Release id={previous.release} /> }}
                text={translate(previous.key, {
                  release: slot("release"),
                  to: date(previous.to),
                  from: "from" in previous ? date(previous.from) : "",
                })}
              />
            )}
          title={translate("installation.updates.facts.previous")}
        />
        <UI.DescriptionItem
          data-fact="started"
          description={
            <Sentence
              nodes={{
                command: <Command>bakery-release deploy</Command>,
              }}
              text={translate("installation.updates.facts.startedValue", {
                command: slot("command"),
              })}
            />
          }
          title={translate("installation.updates.facts.started")}
        />
      </UI.DescriptionList>
      {status.healthy
        ? null
        : (
          <UI.InlineNotice data-notice="not-healthy" role="alert" tone="error">
            <Sentence
              nodes={{ command: <Command>bakery-release status</Command> }}
              text={translate("installation.updates.notHealthy", {
                command: slot("command"),
              })}
            />
          </UI.InlineNotice>
        )}
    </UI.Stack>
  );
}

function Policy(props: InstallationUpdatesScreenProps) {
  const { translate } = useI18n();
  const { policy } = props;
  if (policy.value === null) return null;
  const locked = policy.lock !== null;
  const disabled = locked || policy.saving;
  const choices = [
    {
      value: "go_back" as const,
      label: "installation.updates.policy.goBack" as const,
      description: "installation.updates.policy.goBack.description" as const,
    },
    {
      value: "ask" as const,
      label: "installation.updates.policy.ask" as const,
      description: "installation.updates.policy.ask.description" as const,
    },
  ];
  return (
    <UI.SettingsSection
      data-section="policy"
      title={translate("installation.updates.policy.title")}
      variant="stack"
    >
      {policy.lock === "held"
        ? (
          <UI.InlineNotice
            action={
              <UI.Button onClick={props.onOpenRestore} variant="secondary">
                {translate("installation.updates.policy.heldLink")}
              </UI.Button>
            }
            tone="information"
          >
            {translate("installation.updates.policy.held")}
          </UI.InlineNotice>
        )
        : policy.lock === "paused"
        ? (
          <UI.InlineNotice tone="information">
            {translate("installation.updates.policy.paused")}
          </UI.InlineNotice>
        )
        : null}
      <UI.Stack
        aria-label={translate("installation.updates.policy.title")}
        gap="tight"
        role="radiogroup"
      >
        {choices.map((choice) => (
          <UI.Stack gap="none" key={choice.value}>
            <UI.Radio
              checked={policy.value === choice.value}
              disabled={disabled}
              name="update-failure-policy"
              onChange={() => props.onPolicyChange(choice.value)}
              value={choice.value}
            >
              {translate(choice.label)}
            </UI.Radio>
            <UI.Text variant="hint">{translate(choice.description)}</UI.Text>
          </UI.Stack>
        ))}
      </UI.Stack>
      <UI.Text variant="hint">
        {translate("installation.updates.policy.help")}
      </UI.Text>
      {policy.problem === null ? null : (
        <UI.InlineNotice
          role="alert"
          tone={policy.problem === "conflict" ? "warning" : "error"}
        >
          {translate(
            policy.problem === "conflict"
              ? "installation.updates.policy.conflict"
              : "installation.updates.policy.failed",
          )}
        </UI.InlineNotice>
      )}
      <UI.Inline>
        <UI.Button
          data-action="save-policy"
          disabled={!policy.dirty || disabled}
          loading={policy.saving}
          onClick={props.onSave}
        >
          {translate("installation.updates.policy.save")}
        </UI.Button>
      </UI.Inline>
    </UI.SettingsSection>
  );
}

function History(
  props: InstallationUpdatesScreenProps & {
    readonly dateTime: (iso: string) => string;
  },
) {
  const { translate } = useI18n();
  const phone = useShellViewport() === "phone";
  const { history, dateTime } = props;
  const what = (row: UpdateRow) => {
    const event = row.event;
    return (
      <Sentence
        nodes={{
          from: event.fromRelease ? <Release id={event.fromRelease} /> : null,
          to: event.toRelease ? <Release id={event.toRelease} /> : null,
          command: <Command>bakery-release recover</Command>,
        }}
        text={translate(row.what, {
          from: slot("from"),
          to: slot("to"),
          command: slot("command"),
          by: event.by ?? "",
          detail: event.detail ?? "",
        })}
      />
    );
  };
  const by = (row: UpdateRow) => translate(row.by, { by: row.event.by ?? "" });
  const badge = (row: UpdateRow) => (
    <UI.Badge tone={row.tone}>{translate(row.result)}</UI.Badge>
  );
  return (
    <UI.SettingsSection
      data-section="history"
      title={translate("installation.updates.history.title")}
      variant="stack"
    >
      {history.state === "loading"
        ? (
          <UI.Stack
            aria-busy="true"
            aria-label={translate("installation.updates.loading")}
            gap="tight"
          >
            <UI.Skeleton shape="row" />
            <UI.Skeleton shape="row" />
            <UI.Skeleton shape="row" />
            <UI.Skeleton shape="row" />
            <UI.Skeleton shape="row" />
          </UI.Stack>
        )
        : history.state === "error" && history.rows.length === 0
        ? (
          <UI.InlineNotice
            action={
              <UI.Button onClick={props.onRetryHistory} variant="secondary">
                {translate("core.actions.retry")}
              </UI.Button>
            }
            role="alert"
            tone="error"
          >
            {translate("installation.updates.history.error")}
          </UI.InlineNotice>
        )
        : history.rows.length === 0
        ? (
          <UI.EmptyState
            description={translate("installation.updates.history.empty.body")}
            title={translate("installation.updates.history.empty.title")}
          />
        )
        : phone
        ? (
          <UI.Stack gap="none">
            {history.rows.map((row) => (
              <UI.StackedRow
                data-event={row.event.id}
                flush
                key={row.event.id}
                status={badge(row)}
                title={dateTime(row.event.at)}
                titleLines="wrap"
              >
                <UI.Text>{what(row)}</UI.Text>
                <UI.Text variant="caption">{by(row)}</UI.Text>
              </UI.StackedRow>
            ))}
          </UI.Stack>
        )
        : (
          <UI.DataTable
            caption={translate("installation.updates.history.title")}
            captionHidden
            columns={[
              {
                id: "when",
                header: translate("installation.updates.history.when"),
                width: "20%",
                cell: (row) => dateTime(row.event.at),
              },
              {
                id: "what",
                header: translate("installation.updates.history.what"),
                cell: what,
              },
              {
                id: "result",
                header: translate("installation.updates.history.result"),
                width: "16%",
                cell: badge,
              },
              {
                id: "by",
                header: translate("installation.updates.history.by"),
                width: "20%",
                cell: by,
              },
            ]}
            getRowAttributes={(row) => ({ "data-event": row.event.id })}
            getRowKey={(row) => row.event.id}
            rows={[...history.rows]}
            state="ready"
          />
        )}
      {history.hasMore
        ? (
          <UI.Inline>
            <UI.Button
              data-paged-more="updates"
              data-paged-retry={history.state === "error"
                ? "updates"
                : undefined}
              loading={history.loadingMore}
              onClick={props.onLoadMore}
              type="button"
              variant="outline"
            >
              {translate("installation.updates.history.loadMore")}
            </UI.Button>
          </UI.Inline>
        )
        : null}
    </UI.SettingsSection>
  );
}

function Held(
  { uncertain, date }: {
    readonly uncertain: InstallationUncertainActions | null;
    readonly date: (iso: string) => string;
  },
) {
  const { translate } = useI18n();
  if (uncertain === null || uncertain.total === 0) return null;
  return (
    <UI.SettingsSection
      data-section="held"
      id={HELD_SECTION}
      title={translate("installation.updates.held.title", {
        count: uncertain.total,
      })}
      variant="stack"
    >
      <UI.Text variant="muted">
        {translate("installation.updates.held.body")}
      </UI.Text>
      <UI.DataTable
        caption={translate("installation.updates.held.title", {
          count: uncertain.total,
        })}
        captionHidden
        columns={[
          {
            id: "action",
            header: translate("installation.updates.held.action"),
            cell: (row) => (
              <UI.DataText fit variant="code">{row.operation}</UI.DataText>
            ),
          },
          {
            id: "count",
            header: translate("installation.updates.held.count"),
            width: "20%",
            cell: (row) => row.count,
          },
          {
            id: "since",
            header: translate("installation.updates.held.since"),
            width: "25%",
            cell: (row) => date(row.since),
          },
        ]}
        getRowKey={(row) => row.operation}
        rows={[...uncertain.kinds]}
        state="ready"
      />
    </UI.SettingsSection>
  );
}
