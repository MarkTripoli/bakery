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
  joinPunctuation,
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

/** Draws one slot; `after` is punctuation that must stay on its line. */
type SlotNode = (after: string) => ReactNode;

/** A sentence whose slots are nodes: a release with its full id, a command. */
function Sentence(
  { text, nodes }: {
    readonly text: string;
    readonly nodes: Readonly<Record<string, SlotNode | null>>;
  },
) {
  return (
    <>
      {joinPunctuation(splitSlots(text)).map((part, index) =>
        "slot" in part
          ? (
            <span key={index}>
              {nodes[part.slot]?.(part.after) ?? part.after}
            </span>
          )
          : <span key={index}>{part.text}</span>
      )}
    </>
  );
}

/** A release as its first 8 characters, with the full id on hover and focus. */
function Release(
  { id, after = "" }: { readonly id: string; readonly after?: string },
) {
  return (
    <UI.Tooltip content={id}>
      <UI.DataText fit tabIndex={0} trailing={after} variant="identifier">
        {shortRelease(id)}
      </UI.DataText>
    </UI.Tooltip>
  );
}

/** A release slot, or nothing when the event has no such release. */
function releaseNode(id: string | null): SlotNode | null {
  return id === null ? null : (after) => <Release after={after} id={id} />;
}

function Command(
  { children, after = "" }: {
    readonly children: string;
    readonly after?: string;
  },
) {
  return (
    <UI.DataText fit trailing={after} variant="code">
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
      <UI.SettingsContent data-page="installation-updates" variant="wide">
        <UI.EmptyState
          align="start"
          description={translate("installation.updates.notFound.body")}
          layout="centered"
          title={translate("installation.updates.notFound.title")}
          titleStyle="heading"
          variant="filtered"
        />
      </UI.SettingsContent>
    );
  }

  return (
    <UI.SettingsContent data-page="installation-updates" variant="wide">
      <UI.Stack gap="standard">
        <UI.PageHeader
          description={translate("installation.updates.description")}
          flush
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
                onDismiss={props.onDismiss}
                status={status}
              />
              <Facts date={date} status={status} />
              <Held date={date} uncertain={props.uncertain} />
              <Policy {...props} />
              <History {...props} dateTime={dateTime} />
            </>
          )}
      </UI.Stack>
    </UI.SettingsContent>
  );
}

/**
 * The one notice slot at the top (design revision 6). While Bakery is not
 * healthy it holds the health notice, which cannot be dismissed; the notice for
 * the last update that did not go through comes back with Dismiss when health
 * does.
 */
function FailureNotice(
  { status, dismissing, onDismiss, dateTime }: {
    readonly status: InstallationUpdateStatus;
    readonly dismissing: boolean;
    readonly onDismiss: (id: string) => void;
    readonly dateTime: (iso: string) => string;
  },
) {
  const { translate } = useI18n();
  const phone = useShellViewport() === "phone";
  const failure = status.lastFailure;
  const when = (iso: string) =>
    translate("installation.updates.notice.when", { date: dateTime(iso) });
  if (!status.healthy) {
    const stayed = failure !== null && failure.kind === "decided_stay" &&
      failure.fromRelease === status.runningRelease;
    const nodes = {
      release: (after: string) => (
        <Release after={after} id={status.runningRelease} />
      ),
      command: (after: string) => (
        <Command after={after}>bakery-release status</Command>
      ),
    };
    const stayNodes = {
      command: (after: string) => (
        <Command after={after}>bakery-release rollback</Command>
      ),
    };
    return (
      <UI.InlineNotice data-notice="not-healthy" role="alert" tone="error">
        <UI.Stack gap="tight">
          <UI.Text variant="strong">
            {translate("installation.updates.notHealthy.title")}
          </UI.Text>
          <UI.Text>
            <Sentence
              nodes={nodes}
              text={translate("installation.updates.notHealthy.body", {
                release: slot("release"),
                command: slot("command"),
              })}
            />
          </UI.Text>
          {stayed
            ? (
              <UI.Text>
                <Sentence
                  nodes={stayNodes}
                  text={translate(
                    failure.by === null
                      ? "installation.updates.notHealthy.stayNobody"
                      : "installation.updates.notHealthy.stay",
                    {
                      when: when(failure.at),
                      by: failure.by ?? "",
                      command: slot("command"),
                    },
                  )}
                />
              </UI.Text>
            )
            : null}
        </UI.Stack>
      </UI.InlineNotice>
    );
  }
  const notice = failureNotice(failure);
  if (failure === null || notice === null) return null;
  const nodes = {
    from: releaseNode(failure.fromRelease),
    to: releaseNode(failure.toRelease),
    command: (after: string) => (
      <Command after={after}>
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
    when: when(failure.at),
  };
  return (
    <UI.InlineNotice
      action={
        <UI.Inline gap="compact" variant={phone ? "actions" : "flow"}>
          <UI.Button
            loading={dismissing}
            onClick={() => onDismiss(failure.id)}
            variant="secondary"
          >
            {translate("installation.updates.notice.dismiss")}
          </UI.Button>
        </UI.Inline>
      }
      actionLayout="below"
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
              nodes={{
                release: (after: string) => (
                  <Release after={after} id={running.release} />
                ),
              }}
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
                nodes={{
                  release: (after: string) => (
                    <Release after={after} id={previous.release} />
                  ),
                }}
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
                command: (after: string) => (
                  <Command after={after}>bakery-release deploy</Command>
                ),
              }}
              text={translate("installation.updates.facts.startedValue", {
                command: slot("command"),
              })}
            />
          }
          title={translate("installation.updates.facts.started")}
        />
      </UI.DescriptionList>
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
  const saved = choices.find((choice) => choice.value === policy.value) ??
    choices[0]!;
  return (
    <UI.SettingsSection
      data-section="policy"
      title={translate("installation.updates.policy.title")}
      variant="stack"
    >
      {locked
        ? (
          <>
            <UI.DescriptionList labels="quiet">
              <UI.DescriptionItem
                action={policy.lock === "held"
                  ? (
                    <UI.Button
                      onClick={props.onOpenRestore}
                      variant="secondary"
                    >
                      {translate("installation.updates.policy.heldLink")}
                    </UI.Button>
                  )
                  : undefined}
                actionPlacement="below"
                data-policy-locked={policy.lock}
                description={translate(saved.description)}
                title={translate(saved.label)}
              />
            </UI.DescriptionList>
            <UI.Text variant="hint">
              {translate(
                policy.lock === "held"
                  ? "installation.updates.policy.lockedHeld"
                  : "installation.updates.policy.lockedPaused",
              )}
            </UI.Text>
          </>
        )
        : (
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
                <UI.Text variant="hint">
                  {translate(choice.description)}
                </UI.Text>
              </UI.Stack>
            ))}
          </UI.Stack>
        )}
      <UI.Text variant="hint">
        {translate("installation.updates.policy.help")}
      </UI.Text>
      {!locked && (policy.dirty || policy.saving)
        ? (
          <UI.Inline>
            <UI.Button
              data-action="save-policy"
              disabled={disabled}
              loading={policy.saving}
              onClick={props.onSave}
            >
              {translate("installation.updates.policy.save")}
            </UI.Button>
          </UI.Inline>
        )
        : null}
      {/* Every result of pressing Save shows here, right under the button. */}
      {policy.saved
        ? (
          <UI.Toast
            data-result="saved"
            onDismiss={props.onSavedShown}
            tone="success"
          >
            {translate("installation.updates.policy.saved")}
          </UI.Toast>
        )
        : null}
      {policy.problem === null ? null : (
        <UI.InlineNotice
          data-result={policy.problem}
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
          from: releaseNode(event.fromRelease),
          to: releaseNode(event.toRelease),
          command: (after: string) => (
            <Command after={after}>bakery-release recover</Command>
          ),
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
            span="column"
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
  const phone = useShellViewport() === "phone";
  if (uncertain === null || uncertain.total === 0) return null;
  return (
    <UI.SettingsSection
      data-section="held"
      id={HELD_SECTION}
      title={translate("installation.updates.held.title")}
      variant="stack"
    >
      <UI.Text variant="muted">
        {translate("installation.updates.held.body", {
          count: uncertain.total,
        })}
      </UI.Text>
      {phone
        ? (
          <UI.Stack gap="none">
            {uncertain.kinds.map((row) => (
              <UI.StackedRow
                data-held={row.operation}
                flush
                key={row.operation}
                title={row.operation}
                titleLines="wrap"
              >
                <UI.Text variant="caption">
                  {translate("installation.updates.held.row", {
                    count: row.count,
                    date: date(row.since),
                  })}
                </UI.Text>
              </UI.StackedRow>
            ))}
          </UI.Stack>
        )
        : (
          <UI.DataTable
            caption={translate("installation.updates.held.title")}
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
        )}
    </UI.SettingsSection>
  );
}
