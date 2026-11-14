import { type ReactNode, useState } from "react";
import * as UI from "@bakery/ui";
import type { MessageKey } from "@bakery/i18n";
import { useShellViewport } from "../../app/responsive.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { ShellSlot } from "../../shell/shell-slots.tsx";
import {
  type ConnectionStatus,
  filterRepositories,
  type Health,
  type HealthKind,
  type Permission,
  SEARCH_AFTER,
  type SetupStep,
} from "./model.ts";
import { type ConnectionOutcome, OUTCOME_COPY } from "./outcomes.ts";
import type {
  CheckStatus,
  SelectionStatus,
  SwitchStatus,
} from "./use-connection.ts";
import type { ConnectStatus } from "./connect.ts";

export type ConnectionViewState =
  | "loading"
  | "notFound"
  | "error"
  | "forbidden"
  | "ready";

/** One repository in the list, with what is ticked now. */
export type RepositoryItem = {
  readonly id: string;
  readonly name: string;
  readonly ticked: boolean;
  readonly available: boolean;
};

export type RepositoriesProps = {
  readonly state: "loading" | "error" | "ready";
  readonly items: readonly RepositoryItem[];
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly changed: boolean;
  readonly saving: boolean;
  readonly status: SelectionStatus;
  readonly onToggle: (id: string) => void;
  readonly onSave: () => void;
  readonly onDiscard: () => void;
  readonly onLoadMore: () => void;
  readonly onRetry: () => void;
};

export type ConnectionViewProps = {
  readonly state: ConnectionViewState;
  readonly canManage: boolean;
  readonly account: string;
  readonly status: ConnectionStatus;
  readonly health: Health;
  readonly steps: readonly SetupStep[] | null;
  readonly permissions: readonly Permission[];
  readonly createdAt: string;
  readonly lastCheckedAt: string | null;
  readonly formatTime: (iso: string) => string;
  readonly outcome: ConnectionOutcome | null;
  readonly continuing: boolean;
  readonly connectStatus: ConnectStatus;
  readonly checkStatus: CheckStatus;
  /** The last check could not reach GitHub, so the earlier health stands. */
  readonly checkFaulted: boolean;
  readonly switchStatus: SwitchStatus;
  readonly repositories: RepositoriesProps;
  /** Runs the one fix the health names: reconnect, turn on, connect again. */
  readonly onFix: () => void;
  readonly onCheck: () => void;
  readonly onTurnOn: () => void;
  readonly onTurnOff: () => void;
  readonly onDismissOutcome: () => void;
  readonly onReload: () => void;
};

const BANNER_TONE: Readonly<
  Record<HealthKind, "information" | "warning" | "error" | null>
> = {
  working: null,
  notChecked: null,
  finishSetup: "information",
  needsAttention: "warning",
  authRequired: "error",
  limited: "warning",
  turnedOff: "information",
  removed: "error",
};

const CHECK_NOTICE: Readonly<Partial<Record<CheckStatus, MessageKey>>> = {
  pending: "settings.connections.check.pending",
  rateLimited: "settings.connections.check.rateLimited",
  timeout: "settings.connections.check.timeout",
  failed: "settings.connections.check.failed",
};

const SWITCH_NOTICE: Readonly<Partial<Record<SwitchStatus, MessageKey>>> = {
  noSelection: "settings.connections.enable.noSelection",
  stale: "settings.connections.enable.stale",
  failed: "settings.connections.switch.failed",
};

const SELECTION_NOTICE: Readonly<Partial<Record<SelectionStatus, MessageKey>>> =
  {
    stale: "settings.connections.repositories.stale",
    keepOne: "settings.connections.repositories.keepOne",
    failed: "settings.connections.repositories.failed",
  };

const PERMISSION_COPY: Readonly<Record<string, MessageKey>> = {
  "metadata:read": "settings.connections.permission.metadataRead",
  "contents:write": "settings.connections.permission.contentsWrite",
  "issues:write": "settings.connections.permission.issuesWrite",
  "pull_requests:write": "settings.connections.permission.pullRequestsWrite",
  "checks:write": "settings.connections.permission.checksWrite",
};

/** One GitHub connection: its health and fix, setup, repositories, access, details. */
export function ConnectionView(props: ConnectionViewProps) {
  const { translate } = useI18n();
  const phone = useShellViewport() === "phone";
  const { state } = props;
  const title = translate("settings.connections.row.title", {
    account: props.account,
  });
  // The page's one secondary action: in the shell's action slot on desktop,
  // under the title on a phone.
  const checkNow = state === "ready" && props.canManage
    ? (
      <UI.Button
        disabled={props.checkStatus === "checking" ||
          props.status === "pending" || props.status === "revoked"}
        loading={props.checkStatus === "checking"}
        onClick={props.onCheck}
        type="button"
        variant="secondary"
      >
        {translate("settings.connections.action.checkNow")}
      </UI.Button>
    )
    : null;
  return (
    <UI.SettingsContent data-testid="connection-page">
      {checkNow && !phone
        ? <ShellSlot name="actions">{checkNow}</ShellSlot>
        : null}
      <UI.PageHeader
        actions={phone ? checkNow : undefined}
        flush
        subtitle={state === "ready"
          ? translate("settings.connections.page.purpose")
          : undefined}
        summary={state === "ready"
          ? (
            <UI.Badge tone={props.health.tone}>
              {translate(
                `settings.connections.badge.${props.health.kind}` as MessageKey,
              )}
            </UI.Badge>
          )
          : undefined}
        title={state === "ready"
          ? title
          : translate("settings.connections.github.heading")}
        variant="list"
      />
      {state === "loading"
        ? (
          <UI.Stack
            aria-label={translate("settings.connections.loading")}
            gap="compact"
            role="status"
          >
            <UI.Skeleton shape="row" />
            <UI.Skeleton shape="row" />
          </UI.Stack>
        )
        : state === "forbidden"
        ? (
          <UI.AlertBanner tone="information">
            {translate("settings.connections.forbidden")}
          </UI.AlertBanner>
        )
        : state === "notFound"
        ? (
          <UI.EmptyState
            description={translate("settings.connections.page.notFound.body")}
            title={translate("settings.connections.page.notFound.title")}
          />
        )
        : state === "error"
        ? (
          <UI.ErrorState
            action={
              <UI.Button
                onClick={props.onReload}
                type="button"
                variant="secondary"
              >
                {translate("settings.connections.retry")}
              </UI.Button>
            }
            description={translate("settings.connections.loadError")}
            title={translate("settings.connections.github.heading")}
          />
        )
        : <ReadyContent {...props} />}
    </UI.SettingsContent>
  );
}

function ReadyContent(props: ConnectionViewProps) {
  const { translate } = useI18n();
  const { health, canManage } = props;
  const outcome = props.outcome ? OUTCOME_COPY[props.outcome] : null;
  const connecting = props.connectStatus === "starting" ||
    props.connectStatus === "redirecting" || props.continuing;
  const bannerTone = BANNER_TONE[health.kind];
  // The one button a problem banner carries; Finish setup is the steps below.
  const fixLabel = health.action === "reconnect" ||
      health.action === "turnOn" || health.action === "connectAgain"
    ? translate(`settings.connections.action.${health.action}` as MessageKey)
    : null;
  const fixing = health.action === "turnOn"
    ? props.switchStatus === "saving"
    : connecting;
  const checkNotice = CHECK_NOTICE[props.checkStatus];
  const switchNotice = SWITCH_NOTICE[props.switchStatus];
  return (
    <>
      {outcome
        ? (
          <UI.AlertBanner
            data-outcome={props.outcome ?? undefined}
            data-testid="github-connection-outcome"
            onDismiss={props.onDismissOutcome}
            tone={outcome.tone}
          >
            {translate(outcome.body)}
          </UI.AlertBanner>
        )
        : null}
      {props.continuing
        ? (
          <UI.AlertBanner tone="information">
            {translate(
              props.outcome === "awaiting_installation"
                ? "settings.connections.continuing.installation"
                : "settings.connections.continuing.authorization",
            )}
          </UI.AlertBanner>
        )
        : null}
      {props.connectStatus === "unregistered"
        ? (
          <UI.InlineNotice tone="warning">
            {translate("settings.connections.connect.unregistered")}
          </UI.InlineNotice>
        )
        : props.connectStatus === "storageUnavailable" ||
            props.connectStatus === "failed"
        ? (
          <UI.InlineNotice tone="error">
            {translate(
              props.connectStatus === "failed"
                ? "settings.connections.connect.failed"
                : "settings.connections.connect.storageUnavailable",
            )}
          </UI.InlineNotice>
        )
        : null}
      {bannerTone !== null
        ? (
          <UI.AlertBanner
            action={fixLabel !== null && canManage
              ? (
                <UI.Button
                  disabled={fixing}
                  loading={fixing}
                  onClick={props.onFix}
                  type="button"
                  variant="primary"
                >
                  {fixLabel}
                </UI.Button>
              )
              : undefined}
            data-testid="connection-problem"
            tone={bannerTone}
          >
            {translate(
              `settings.connections.banner.${health.kind}` as MessageKey,
            )}
            {health.action === "reconnect"
              ? (
                <UI.Text variant="hint">
                  {translate("settings.connections.reconnect.help")}
                </UI.Text>
              )
              : null}
          </UI.AlertBanner>
        )
        : null}
      {checkNotice
        ? (
          <UI.InlineNotice
            action={
              <UI.Button
                onClick={props.onCheck}
                type="button"
                variant="secondary"
              >
                {translate("settings.connections.action.checkAgain")}
              </UI.Button>
            }
            tone="warning"
          >
            {translate(checkNotice)}
          </UI.InlineNotice>
        )
        : null}
      {props.checkFaulted && props.checkStatus === "idle"
        ? (
          <UI.InlineNotice tone="warning">
            {translate("settings.connections.check.faulted")}
          </UI.InlineNotice>
        )
        : null}
      {switchNotice
        ? (
          <UI.InlineNotice tone="error">
            {translate(switchNotice)}
          </UI.InlineNotice>
        )
        : null}
      {props.steps ? <Steps {...props} steps={props.steps} /> : null}
      <RepositoriesSection
        canManage={canManage}
        repositories={props.repositories}
      />
      <PermissionsSection permissions={props.permissions} />
      <DetailsSection {...props} />
    </>
  );
}

function Steps(props: ConnectionViewProps & { steps: readonly SetupStep[] }) {
  const { translate } = useI18n();
  const label = (status: SetupStep["status"]) =>
    translate(`settings.connections.step.status.${status}` as MessageKey);
  const turnOnAction = (step: SetupStep): ReactNode =>
    step.id === "turnOn" && step.status === "waiting" && props.canManage
      ? (
        <UI.Button
          disabled={props.switchStatus === "saving"}
          loading={props.switchStatus === "saving"}
          onClick={props.onTurnOn}
          type="button"
          variant="primary"
        >
          {translate("settings.connections.action.turnOn")}
        </UI.Button>
      )
      : undefined;
  return (
    <UI.StepList label={translate("settings.connections.step.label")}>
      {props.steps.map((step) => (
        <UI.StepItem
          action={turnOnAction(step)}
          key={step.id}
          status={step.status}
          statusLabel={label(step.status)}
          summary={translate(
            `settings.connections.step.${step.id}.${
              step.status === "done" ? "done" : "help"
            }` as MessageKey,
          )}
          title={translate(
            `settings.connections.step.${step.id}.title` as MessageKey,
          )}
        />
      ))}
    </UI.StepList>
  );
}

function RepositoriesSection(
  { repositories, canManage }: {
    readonly repositories: RepositoriesProps;
    readonly canManage: boolean;
  },
) {
  const { translate } = useI18n();
  const [search, setSearch] = useState("");
  const items = repositories.items;
  const searchable = items.length > SEARCH_AFTER;
  const shown = searchable ? filterRepositories(items, search) : items;
  const notice = SELECTION_NOTICE[repositories.status];
  return (
    <UI.Stack data-testid="repositories" gap="compact">
      <UI.Heading data-paged-heading="repositories" level="section">
        {translate("settings.connections.repositories.heading", {
          count: items.filter((item) => item.ticked).length,
        })}
      </UI.Heading>
      <UI.Text variant="muted">
        {translate("settings.connections.repositories.intro")}
      </UI.Text>
      {repositories.state === "loading"
        ? (
          <UI.Text role="status">
            {translate("settings.connections.repositories.loading")}
          </UI.Text>
        )
        : repositories.state === "error"
        ? (
          <UI.InlineNotice
            action={
              <UI.Button
                data-paged-retry="repositories"
                onClick={repositories.onRetry}
                type="button"
                variant="secondary"
              >
                {translate("settings.connections.retry")}
              </UI.Button>
            }
            tone="error"
          >
            {translate("settings.connections.repositories.loadError")}
          </UI.InlineNotice>
        )
        : items.length === 0
        ? (
          <UI.Text>
            {translate("settings.connections.repositories.empty")}
          </UI.Text>
        )
        : (
          <>
            {searchable
              ? (
                <UI.Field
                  htmlFor="repository-search"
                  label={translate("settings.connections.repositories.search")}
                >
                  <UI.SearchField
                    id="repository-search"
                    maxLength={200}
                    message={repositories.hasMore
                      ? translate("settings.connections.repositories.filtering")
                      : undefined}
                    onChange={(event) => setSearch(event.target.value)}
                    value={search}
                  />
                </UI.Field>
              )
              : null}
            {shown.length === 0
              ? (
                <UI.Text>
                  {translate("settings.connections.repositories.noMatch")}
                </UI.Text>
              )
              : (
                <UI.Stack data-paged-list="repositories" gap="tight">
                  {shown.map((item) => (
                    <UI.Checkbox
                      checked={item.ticked}
                      disabled={!canManage || repositories.saving ||
                        (!item.available && !item.ticked)}
                      key={item.id}
                      name="repository"
                      onChange={() => repositories.onToggle(item.id)}
                      value={item.id}
                    >
                      {item.name}
                      {!item.available
                        ? ` ${
                          translate(
                            "settings.connections.repositories.unavailable",
                          )
                        }`
                        : ""}
                    </UI.Checkbox>
                  ))}
                </UI.Stack>
              )}
            {repositories.hasMore
              ? (
                <UI.Button
                  data-paged-more="repositories"
                  disabled={repositories.loadingMore}
                  loading={repositories.loadingMore}
                  onClick={repositories.onLoadMore}
                  type="button"
                  variant="secondary"
                >
                  {translate("settings.connections.repositories.more")}
                </UI.Button>
              )
              : null}
          </>
        )}
      {notice
        ? <UI.InlineNotice tone="warning">{translate(notice)}</UI.InlineNotice>
        : null}
      {canManage && repositories.changed
        ? (
          <UI.Inline gap="compact">
            <UI.Button
              disabled={repositories.saving}
              loading={repositories.saving}
              onClick={repositories.onSave}
              type="button"
            >
              {translate("settings.connections.action.saveSelection")}
            </UI.Button>
            <UI.Button
              disabled={repositories.saving}
              onClick={repositories.onDiscard}
              type="button"
              variant="quiet"
            >
              {translate("settings.connections.action.discard")}
            </UI.Button>
          </UI.Inline>
        )
        : null}
    </UI.Stack>
  );
}

function PermissionsSection(
  { permissions }: { readonly permissions: readonly Permission[] },
) {
  const { translate } = useI18n();
  const [names, setNames] = useState(false);
  return (
    <UI.Stack data-testid="permissions" gap="compact">
      <UI.Heading level="section">
        {translate("settings.connections.can.heading")}
        <UI.HelpTip label={translate("settings.connections.can.helpLabel")}>
          {translate("settings.connections.can.help")}
        </UI.HelpTip>
      </UI.Heading>
      {permissions.length === 0
        ? (
          <UI.Text variant="muted">
            {translate("settings.connections.permission.none")}
          </UI.Text>
        )
        : (
          <UI.Stack gap="tight">
            {permissions.map((permission) => (
              <UI.Inline gap="compact" key={permission.key}>
                <UI.Text>
                  {permission.known
                    ? translate(PERMISSION_COPY[permission.known] as MessageKey)
                    : permission.key}
                </UI.Text>
                {names && permission.known
                  ? <UI.DataText variant="code">{permission.key}</UI.DataText>
                  : null}
              </UI.Inline>
            ))}
          </UI.Stack>
        )}
      {permissions.some((permission) => permission.known)
        ? (
          <UI.Button
            aria-expanded={names}
            onClick={() => setNames(!names)}
            type="button"
            variant="text"
          >
            {translate(
              names
                ? "settings.connections.permission.hide"
                : "settings.connections.permission.show",
            )}
          </UI.Button>
        )
        : null}
    </UI.Stack>
  );
}

function DetailsSection(props: ConnectionViewProps) {
  const { translate } = useI18n();
  const [confirming, setConfirming] = useState(false);
  const canTurnOff = props.canManage &&
    (props.status === "enabled" || props.status === "degraded");
  return (
    <UI.Stack data-testid="connection-details" gap="compact">
      <UI.Heading level="section">
        {translate("settings.connections.details.heading")}
      </UI.Heading>
      <UI.DescriptionList>
        <UI.DescriptionItem
          description={props.formatTime(props.createdAt)}
          title={translate("settings.connections.details.connected")}
        />
        <UI.DescriptionItem
          description={props.lastCheckedAt === null
            ? translate("settings.connections.row.notChecked")
            : props.formatTime(props.lastCheckedAt)}
          title={translate("settings.connections.lastChecked")}
        />
      </UI.DescriptionList>
      {canTurnOff
        ? (
          <>
            <UI.Text variant="muted">
              {translate("settings.connections.turnOff.explain")}
            </UI.Text>
            <UI.Inline gap="compact">
              <UI.Button
                disabled={props.switchStatus === "saving"}
                onClick={() => setConfirming(true)}
                type="button"
                variant="destructive-outline"
              >
                {translate("settings.connections.action.turnOff")}
              </UI.Button>
            </UI.Inline>
            <UI.AlertDialog
              cancelAction={
                <UI.Button
                  onClick={() => setConfirming(false)}
                  type="button"
                  variant="secondary"
                >
                  {translate("core.actions.cancel")}
                </UI.Button>
              }
              confirmAction={
                <UI.Button
                  disabled={props.switchStatus === "saving"}
                  loading={props.switchStatus === "saving"}
                  onClick={() => {
                    setConfirming(false);
                    props.onTurnOff();
                  }}
                  type="button"
                  variant="primary"
                >
                  {translate("settings.connections.action.turnOff")}
                </UI.Button>
              }
              onOpenChange={setConfirming}
              open={confirming}
              title={translate("settings.connections.turnOff.title", {
                name: translate("settings.connections.row.title", {
                  account: props.account,
                }),
              })}
            >
              <UI.Text>
                {translate("settings.connections.turnOff.body")}
              </UI.Text>
            </UI.AlertDialog>
          </>
        )
        : null}
    </UI.Stack>
  );
}
