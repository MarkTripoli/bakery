import type { ReactNode } from "react";
import * as UI from "@bakery/ui";
import type { MessageKey } from "@bakery/i18n";
import { useI18n } from "../i18n/I18nProvider.tsx";

/**
 * Coarse GitHub callback outcome the server carries in `?githubConnection=`
 * (integrations/callbacks.ts `ConnectionOutcome`); never a provider detail.
 */
export const CONNECTION_OUTCOMES = [
  "pending",
  "refreshed",
  "awaiting_authorization",
  "awaiting_installation",
  "installation_requested",
  "state_rejected",
  "expired",
  "authorization_denied",
  "provider_unregistered",
  "exchange_failed",
  "installation_listing_failed",
  "repository_listing_failed",
  "installation_unverified",
  "installation_check_failed",
  "installation_suspended",
  "admin_required",
  "already_connected",
  "reconnect_unavailable",
  "storage_failed",
] as const;
export type ConnectionOutcome = (typeof CONNECTION_OUTCOMES)[number];

type OutcomeCopy = {
  readonly tone: "success" | "information" | "warning" | "error";
  readonly body: MessageKey;
  /** Offer Connect GitHub again beside the message. */
  readonly retry: boolean;
};

const OUTCOME_COPY: Readonly<Record<ConnectionOutcome, OutcomeCopy>> = {
  pending: {
    tone: "success",
    body: "settings.connections.outcome.pending",
    retry: false,
  },
  refreshed: {
    tone: "success",
    body: "settings.connections.outcome.refreshed",
    retry: false,
  },
  awaiting_authorization: {
    tone: "warning",
    body: "settings.connections.outcome.awaitingAuthorization",
    retry: true,
  },
  awaiting_installation: {
    tone: "warning",
    body: "settings.connections.outcome.awaitingInstallation",
    retry: true,
  },
  installation_requested: {
    tone: "information",
    body: "settings.connections.outcome.installationRequested",
    retry: true,
  },
  state_rejected: {
    tone: "error",
    body: "settings.connections.outcome.stateRejected",
    retry: true,
  },
  expired: {
    tone: "error",
    body: "settings.connections.outcome.expired",
    retry: true,
  },
  authorization_denied: {
    tone: "warning",
    body: "settings.connections.outcome.authorizationDenied",
    retry: true,
  },
  provider_unregistered: {
    tone: "error",
    body: "settings.connections.outcome.providerUnregistered",
    retry: false,
  },
  exchange_failed: {
    tone: "error",
    body: "settings.connections.outcome.exchangeFailed",
    retry: true,
  },
  installation_listing_failed: {
    tone: "error",
    body: "settings.connections.outcome.installationListingFailed",
    retry: true,
  },
  repository_listing_failed: {
    tone: "error",
    body: "settings.connections.outcome.repositoryListingFailed",
    retry: true,
  },
  installation_unverified: {
    tone: "error",
    body: "settings.connections.outcome.installationUnverified",
    retry: true,
  },
  installation_check_failed: {
    tone: "error",
    body: "settings.connections.outcome.installationCheckFailed",
    retry: true,
  },
  installation_suspended: {
    tone: "error",
    body: "settings.connections.outcome.installationSuspended",
    retry: true,
  },
  admin_required: {
    tone: "error",
    body: "settings.connections.outcome.adminRequired",
    retry: false,
  },
  already_connected: {
    tone: "information",
    body: "settings.connections.outcome.alreadyConnected",
    retry: false,
  },
  reconnect_unavailable: {
    tone: "error",
    body: "settings.connections.outcome.reconnectUnavailable",
    retry: true,
  },
  storage_failed: {
    tone: "error",
    body: "settings.connections.outcome.storageFailed",
    retry: true,
  },
};

export type OrganizationIntegrationsView =
  | "loading"
  | "error"
  | "forbidden"
  | "ready";

export type ConnectStatus =
  | "idle"
  | "starting"
  | "redirecting"
  | "unregistered"
  | "storageUnavailable"
  | "failed";

export type OrganizationIntegrationsScreenProps = {
  readonly view: OrganizationIntegrationsView;
  /** Admins connect, select, enable and check; others only read. */
  readonly canManage: boolean;
  readonly outcome: ConnectionOutcome | null;
  /** The page is on its way back to GitHub for the attempt's next step. */
  readonly continuing: boolean;
  readonly connectStatus: ConnectStatus;
  readonly empty: boolean;
  readonly onConnect: () => void;
  readonly onDismissOutcome: () => void;
  readonly onReload: () => void;
  /** One `ConnectionPanel` per connection. */
  readonly children?: ReactNode;
};

const CONNECT_COPY: Readonly<
  Partial<Record<ConnectStatus, MessageKey>>
> = {
  unregistered: "settings.connections.connect.unregistered",
  storageUnavailable: "settings.connections.connect.storageUnavailable",
  failed: "settings.connections.connect.failed",
};

export function OrganizationIntegrationsScreen(
  {
    view,
    canManage,
    outcome,
    continuing,
    connectStatus,
    empty,
    onConnect,
    onDismissOutcome,
    onReload,
    children,
  }: OrganizationIntegrationsScreenProps,
) {
  const { translate } = useI18n();
  const busy = connectStatus === "starting" ||
    connectStatus === "redirecting" || continuing;
  const copy = outcome ? OUTCOME_COPY[outcome] : null;
  const connectFailure = CONNECT_COPY[connectStatus];
  const connectButton = (label: MessageKey) => (
    <UI.Button
      disabled={busy}
      loading={connectStatus === "starting"}
      onClick={onConnect}
      type="button"
    >
      {translate(busy ? "settings.connections.connecting" : label)}
    </UI.Button>
  );
  return (
    <UI.SettingsContent data-testid="organization-integrations">
      <UI.Heading level="page">
        {translate("settings.connections.title")}
      </UI.Heading>
      <UI.Text variant="muted">
        {translate("settings.connections.description")}
      </UI.Text>
      {view === "loading"
        ? (
          <UI.AlertBanner tone="information">
            {translate("settings.connections.loading")}
          </UI.AlertBanner>
        )
        : null}
      {view === "forbidden"
        ? (
          <UI.AlertBanner tone="information">
            {translate("settings.connections.forbidden")}
          </UI.AlertBanner>
        )
        : null}
      {view === "error"
        ? (
          <UI.AlertBanner
            action={
              <UI.Button onClick={onReload} type="button">
                {translate("settings.connections.retry")}
              </UI.Button>
            }
            tone="error"
          >
            {translate("settings.connections.loadError")}
          </UI.AlertBanner>
        )
        : null}
      {continuing
        ? (
          <UI.AlertBanner
            data-testid="github-connect-continuing"
            tone="information"
          >
            {translate(
              outcome === "awaiting_installation"
                ? "settings.connections.continuing.installation"
                : "settings.connections.continuing.authorization",
            )}
          </UI.AlertBanner>
        )
        : null}
      {copy && !continuing && view !== "forbidden"
        ? (
          <UI.AlertBanner
            action={copy.retry && canManage && view === "ready"
              ? (
                <UI.Button disabled={busy} onClick={onConnect} type="button">
                  {translate("settings.connections.connectAgain")}
                </UI.Button>
              )
              : undefined}
            data-outcome={outcome}
            data-testid="github-connection-outcome"
            onDismiss={onDismissOutcome}
            tone={copy.tone}
          >
            {translate(copy.body)}
          </UI.AlertBanner>
        )
        : null}
      {connectFailure
        ? (
          <UI.AlertBanner
            action={connectStatus === "unregistered"
              ? undefined
              : (
                <UI.Button disabled={busy} onClick={onConnect} type="button">
                  {translate("settings.connections.retry")}
                </UI.Button>
              )}
            tone="error"
          >
            {translate(connectFailure)}
          </UI.AlertBanner>
        )
        : null}
      {connectStatus === "redirecting"
        ? (
          <UI.AlertBanner tone="information">
            {translate("settings.connections.redirecting")}
          </UI.AlertBanner>
        )
        : null}
      {view === "ready"
        ? (
          <UI.SettingsSection
            title={translate("settings.connections.github.heading")}
            variant="stack"
          >
            <UI.Text variant="muted">
              {translate("settings.connections.github.steps")}
            </UI.Text>
            {canManage
              ? <div>{connectButton("settings.connections.connect")}</div>
              : (
                <UI.Text variant="muted">
                  {translate("settings.connections.readOnly")}
                </UI.Text>
              )}
            {empty
              ? (
                <UI.EmptyState
                  description={translate("settings.connections.empty.body")}
                  title={translate("settings.connections.empty.title")}
                />
              )
              : children}
          </UI.SettingsSection>
        )
        : null}
    </UI.SettingsContent>
  );
}

export type ConnectionStatus =
  | "pending"
  | "enabled"
  | "disabled"
  | "degraded"
  | "revoked";

const STATUS_BADGE: Readonly<
  Record<ConnectionStatus, { status: UI.Status; label: MessageKey }>
> = {
  pending: { status: "queued", label: "settings.connections.status.pending" },
  enabled: { status: "healthy", label: "settings.connections.status.enabled" },
  disabled: {
    status: "disabled",
    label: "settings.connections.status.disabled",
  },
  degraded: {
    status: "degraded",
    label: "settings.connections.status.degraded",
  },
  revoked: {
    status: "disconnected",
    label: "settings.connections.status.revoked",
  },
};

export type RepositoryRow = {
  readonly id: string;
  readonly name: string;
  readonly url: string | null;
  readonly selected: boolean;
  readonly available: boolean;
  /** A select or deselect for this row is in flight. */
  readonly saving: boolean;
};

export type RepositoryList = {
  readonly state: "loading" | "error" | "ready";
  readonly items: readonly RepositoryRow[];
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly onLoadMore: () => void;
  readonly onRetry: () => void;
  readonly onToggle: (id: string, selected: boolean) => void;
  /** The last select or deselect was refused. */
  readonly failure: "stale" | "failed" | null;
};

export type EnableStatus =
  | "idle"
  | "saving"
  | "noSelection"
  | "stale"
  | "failed";

export type CheckStatus =
  | "idle"
  | "checking"
  | "pending"
  | "rateLimited"
  | "timeout"
  | "failed";

export type CheckResult = {
  readonly healthy: boolean;
  readonly health: "unknown" | "healthy" | "degraded" | "auth_required" | null;
  readonly checkedAt: string;
  readonly capabilities: readonly string[];
  readonly faulted: boolean;
};

export type ConnectionPanelProps = {
  readonly id: string;
  readonly label: string;
  readonly status: ConnectionStatus;
  readonly lastCheckedAt: string | null;
  /** The connection the latest GitHub redirect named. */
  readonly highlighted: boolean;
  readonly canManage: boolean;
  readonly repositories: RepositoryList;
  readonly enableStatus: EnableStatus;
  readonly onEnable: () => void;
  readonly checkStatus: CheckStatus;
  readonly check: CheckResult | null;
  readonly onCheck: () => void;
};

const ENABLE_COPY: Readonly<Partial<Record<EnableStatus, MessageKey>>> = {
  noSelection: "settings.connections.enable.noSelection",
  stale: "settings.connections.enable.stale",
  failed: "settings.connections.enable.failed",
};

const CHECK_COPY: Readonly<Partial<Record<CheckStatus, MessageKey>>> = {
  pending: "settings.connections.check.pending",
  rateLimited: "settings.connections.check.rateLimited",
  timeout: "settings.connections.check.timeout",
  failed: "settings.connections.check.failed",
};

const HEALTH_COPY: Readonly<
  Record<NonNullable<CheckResult["health"]>, MessageKey>
> = {
  unknown: "settings.connections.health.unknown",
  healthy: "settings.connections.health.healthy",
  degraded: "settings.connections.health.degraded",
  auth_required: "settings.connections.health.authRequired",
};

export function ConnectionPanel(
  {
    id,
    label,
    status,
    lastCheckedAt,
    highlighted,
    canManage,
    repositories,
    enableStatus,
    onEnable,
    checkStatus,
    check,
    onCheck,
  }: ConnectionPanelProps,
) {
  const { translate, locale, timeZone } = useI18n();
  const date = (value: string) =>
    new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone,
    }).format(new Date(value));
  const badge = STATUS_BADGE[status];
  const selected = repositories.items.filter((item) => item.selected).length;
  const pending = status === "pending";
  const enableFailure = ENABLE_COPY[enableStatus];
  const checkFailure = CHECK_COPY[checkStatus];
  const health = check?.health ??
    (check ? (check.healthy ? "healthy" : "degraded") : null);
  return (
    <section
      aria-labelledby={`connection-${id}`}
      data-connection-id={id}
      data-highlighted={highlighted || undefined}
      data-testid="github-connection"
    >
      <UI.Stack gap="standard">
        <UI.Inline gap="compact">
          <UI.Heading id={`connection-${id}`} level="subsection">
            {label}
          </UI.Heading>
          <UI.StatusBadge status={badge.status}>
            {translate(badge.label)}
          </UI.StatusBadge>
        </UI.Inline>
        <UI.DescriptionList>
          <UI.DescriptionItem
            description={lastCheckedAt
              ? date(lastCheckedAt)
              : translate("settings.connections.neverChecked")}
            title={translate("settings.connections.lastChecked")}
          />
        </UI.DescriptionList>
        {pending
          ? (
            <UI.InlineNotice tone="information">
              {translate("settings.connections.pending.steps")}
            </UI.InlineNotice>
          )
          : null}
        <div
          aria-busy={repositories.state === "loading" || undefined}
          aria-labelledby={`connection-${id}-repositories`}
          data-testid="github-connection-repositories"
          role="group"
        >
          <UI.Stack gap="compact">
            <UI.Heading
              id={`connection-${id}-repositories`}
              level="subsection-compact"
            >
              {translate("settings.connections.repositories.heading", {
                count: selected,
              })}
            </UI.Heading>
            {repositories.state === "loading"
              ? (
                <UI.Text variant="muted">
                  {translate("settings.connections.repositories.loading")}
                </UI.Text>
              )
              : null}
            {repositories.state === "error"
              ? (
                <UI.AlertBanner
                  action={
                    <UI.Button onClick={repositories.onRetry} type="button">
                      {translate("settings.connections.retry")}
                    </UI.Button>
                  }
                  tone="error"
                >
                  {translate("settings.connections.repositories.loadError")}
                </UI.AlertBanner>
              )
              : null}
            {repositories.state === "ready" && repositories.items.length === 0
              ? (
                <UI.Text variant="muted">
                  {translate("settings.connections.repositories.empty")}
                </UI.Text>
              )
              : null}
            {repositories.items.map((item) => (
              <UI.Checkbox
                checked={item.selected}
                disabled={!canManage || item.saving ||
                  (!item.available && !item.selected)}
                key={item.id}
                name="repository"
                onChange={(event) =>
                  repositories.onToggle(item.id, event.currentTarget.checked)}
                value={item.id}
              >
                {item.name}
                {item.available
                  ? ""
                  : ` ${
                    translate("settings.connections.repositories.unavailable")
                  }`}
              </UI.Checkbox>
            ))}
            {repositories.hasMore
              ? (
                <div>
                  <UI.Button
                    disabled={repositories.loadingMore}
                    loading={repositories.loadingMore}
                    onClick={repositories.onLoadMore}
                    type="button"
                    variant="secondary"
                  >
                    {translate("settings.connections.repositories.more")}
                  </UI.Button>
                </div>
              )
              : null}
            {repositories.failure
              ? (
                <UI.AlertBanner tone="error">
                  {translate(
                    repositories.failure === "stale"
                      ? "settings.connections.repositories.stale"
                      : "settings.connections.repositories.failed",
                  )}
                </UI.AlertBanner>
              )
              : null}
          </UI.Stack>
        </div>
        {enableFailure
          ? (
            <UI.AlertBanner tone="error">
              {translate(enableFailure)}
            </UI.AlertBanner>
          )
          : null}
        {checkFailure
          ? (
            <UI.AlertBanner tone="error">
              {translate(checkFailure)}
            </UI.AlertBanner>
          )
          : null}
        {canManage
          ? (
            <UI.Inline gap="compact">
              {pending
                ? (
                  <UI.Button
                    disabled={selected === 0 || enableStatus === "saving"}
                    loading={enableStatus === "saving"}
                    onClick={onEnable}
                    type="button"
                  >
                    {translate("settings.connections.enable")}
                  </UI.Button>
                )
                : null}
              <UI.Button
                disabled={pending || checkStatus === "checking"}
                loading={checkStatus === "checking"}
                onClick={onCheck}
                type="button"
                variant={pending ? "secondary" : "primary"}
              >
                {translate("settings.connections.check")}
              </UI.Button>
            </UI.Inline>
          )
          : null}
        {pending && canManage && selected === 0
          ? (
            <UI.Text variant="muted">
              {translate("settings.connections.enable.hint")}
            </UI.Text>
          )
          : null}
        {check
          ? (
            <div data-testid="github-connection-check">
              <UI.DescriptionList>
                <UI.DescriptionItem
                  description={health
                    ? translate(HEALTH_COPY[health])
                    : translate("settings.connections.health.unknown")}
                  title={translate("settings.connections.health")}
                />
                <UI.DescriptionItem
                  description={date(check.checkedAt)}
                  title={translate("settings.connections.checkedAt")}
                />
              </UI.DescriptionList>
              {check.faulted
                ? (
                  <UI.Text variant="muted">
                    {translate("settings.connections.check.faulted")}
                  </UI.Text>
                )
                : null}
              {check.capabilities.length === 0
                ? (
                  <UI.Text variant="muted">
                    {translate("settings.connections.capabilities.empty")}
                  </UI.Text>
                )
                : (
                  <UI.CapabilityList
                    aria-label={translate(
                      "settings.connections.capabilities",
                    )}
                    items={check.capabilities.map((capability) => ({
                      id: capability,
                      title: capability,
                      value: translate(
                        "settings.connections.capabilities.available",
                      ),
                    }))}
                    variant="access"
                  />
                )}
            </div>
          )
          : null}
      </UI.Stack>
    </section>
  );
}
