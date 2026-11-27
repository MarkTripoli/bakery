import { useEffect, useId, useRef } from "react";
import * as UI from "@bakery/ui";
import type { MessageKey } from "@bakery/i18n";
import { RouterLink } from "../../app/router-link.tsx";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { focusAfterPaint } from "../../app/focus.ts";
import type { Health } from "./model.ts";
import type { ConnectionOutcome } from "./outcomes.ts";
import type { ConnectStatus } from "./connect.ts";
import {
  hasSetupPages,
  healthBadge,
  PROVIDER_IDENTITY,
  providerLook,
  providerOutcomeCopy,
} from "./providers/index.ts";
import { WEB_PROVIDERS } from "../../integrations/registry.ts";

export type IntegrationsHomeState = "loading" | "error" | "forbidden" | "ready";

/** One connected integration as the list shows it. */
export type ConnectionRow = {
  readonly id: string;
  readonly provider: string;
  /** The account the connection belongs to, such as an organization name. */
  readonly account: string;
  readonly health: Health;
  /** An ISO time, or `null` when it was never checked. */
  readonly lastCheckedAt: string | null;
};

export type IntegrationsHomeViewProps = {
  readonly state: IntegrationsHomeState;
  /** Administrators add and fix integrations; others only read. */
  readonly canManage: boolean;
  readonly rows: readonly ConnectionRow[];
  readonly outcome: ConnectionOutcome | null;
  readonly outcomeProvider: string;
  readonly canOpenInstallation?: boolean;
  readonly removedName?: string | null;
  readonly onDismissRemoved?: () => void;
  readonly providerConnectStatus: ConnectStatus;
  readonly onConnectProvider: (slug: string) => void;
  /** The page is on its way back to the provider for the attempt's next step. */
  readonly continuing: boolean;
  readonly connectStatus: ConnectStatus;
  readonly onConnect: () => void;
  readonly onReconnect: (id: string) => void;
  /** Opens the connection's own page. */
  readonly onOpen: (id: string) => void;
  readonly onDismissOutcome: () => void;
  readonly onReload: () => void;
  /** Formats an ISO time for a person. */
  readonly formatTime: (iso: string) => string;
};

const CONNECT_FAILURE: Readonly<Partial<Record<ConnectStatus, MessageKey>>> = {
  storageUnavailable: "settings.connections.connect.storageUnavailable",
  failed: "settings.connections.connect.failed",
};

/** The home of the organization's integrations: what is connected, what can be added. */
export function IntegrationsHomeView(props: IntegrationsHomeViewProps) {
  const { translate } = useI18n();
  const { state, canManage, rows, outcome, connectStatus } = props;
  const busy = connectStatus === "starting" ||
    connectStatus === "redirecting" || props.continuing;
  const copy = providerOutcomeCopy(props.outcomeProvider, outcome);
  const ownOutcome = hasSetupPages(props.outcomeProvider);
  const providerBusy = props.providerConnectStatus === "starting" ||
    props.providerConnectStatus === "redirecting";
  const failure = CONNECT_FAILURE[connectStatus];
  const returned = useRef<HTMLDivElement>(null);
  const announced = copy !== null || (props.removedName ?? null) !== null;
  useEffect(() => {
    if (announced) focusAfterPaint(() => returned.current);
  }, [announced]);
  const connectButton = (
    variant: "primary" | "secondary",
    label: "connect" | "home.connect",
  ) => (
    <UI.Button
      disabled={busy}
      loading={connectStatus === "starting"}
      onClick={props.onConnect}
      type="button"
      variant={variant}
    >
      {translate(
        busy
          ? "settings.connections.connecting"
          : label === "connect"
          ? "settings.connections.connect"
          : "settings.connections.home.connect",
      )}
    </UI.Button>
  );

  return (
    <UI.SettingsContent data-testid="organization-integrations">
      <UI.PageHeader
        flush
        subtitle={translate("settings.connections.description")}
        title={translate("settings.connections.title")}
        variant="list"
      />
      {announced
        ? (
          <div data-testid="returned-notice" ref={returned} tabIndex={-1}>
            {(props.removedName ?? null) !== null
              ? (
                <UI.AlertBanner
                  onDismiss={props.onDismissRemoved}
                  tone="success"
                >
                  {translate("integrations.slack.remove.done", {
                    name: props.removedName ?? "",
                  })}
                </UI.AlertBanner>
              )
              : null}
            {copy
              ? (
                <UI.AlertBanner
                  action={copy.retry && canManage
                    ? (
                      <UI.Button
                        disabled={ownOutcome ? busy : providerBusy}
                        onClick={ownOutcome
                          ? props.onConnect
                          : () =>
                            props.onConnectProvider(props.outcomeProvider)}
                        type="button"
                        variant="secondary"
                      >
                        {translate(
                          ownOutcome
                            ? "settings.connections.connectAgain"
                            : `integrations.${props.outcomeProvider}.connectAgain` as MessageKey,
                        )}
                      </UI.Button>
                    )
                    : undefined}
                  data-outcome={outcome ?? undefined}
                  data-testid="github-connection-outcome"
                  onDismiss={props.onDismissOutcome}
                  tone={copy.tone}
                >
                  {translate(copy.body, {
                    account:
                      providerLook(props.outcomeProvider, translate).name,
                  })}
                </UI.AlertBanner>
              )
              : null}
          </div>
        )
        : null}
      {props.continuing
        ? (
          <UI.AlertBanner tone="information">
            {translate(
              outcome === "awaiting_installation"
                ? "settings.connections.continuing.installation"
                : "settings.connections.continuing.authorization",
            )}
          </UI.AlertBanner>
        )
        : connectStatus === "redirecting"
        ? (
          <UI.AlertBanner tone="information">
            {translate("settings.connections.redirecting")}
          </UI.AlertBanner>
        )
        : null}
      {failure
        ? <UI.AlertBanner tone="error">{translate(failure)}</UI.AlertBanner>
        : null}
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
            title={translate("settings.connections.title")}
          />
        )
        : state === "forbidden"
        ? (
          <UI.AlertBanner tone="information">
            {translate("settings.connections.forbidden")}
          </UI.AlertBanner>
        )
        : (
          <>
            {!canManage
              ? (
                <UI.InlineNotice tone="information">
                  {translate("settings.connections.readOnly")}
                </UI.InlineNotice>
              )
              : null}
            {rows.length > 0
              ? (
                <UI.Stack gap="compact">
                  <UI.Heading level="section">
                    {translate("settings.connections.home.connected")}
                  </UI.Heading>
                  <UI.Stack
                    gap="none"
                    role="list"
                    aria-label={translate(
                      "settings.connections.home.connected",
                    )}
                    data-testid="connected-list"
                  >
                    {rows.map((row) => (
                      <div
                        role="listitem"
                        data-testid={`connection-${row.id}`}
                        key={row.id}
                      >
                        <ConnectedRow
                          canManage={canManage}
                          formatTime={props.formatTime}
                          onOpen={props.onOpen}
                          onReconnect={props.onReconnect}
                          row={row}
                          busy={busy}
                        />
                      </div>
                    ))}
                  </UI.Stack>
                </UI.Stack>
              )
              : (
                <UI.EmptyState
                  action={canManage
                    ? connectButton("primary", "connect")
                    : undefined}
                  description={translate("settings.connections.empty.body")}
                  title={translate("settings.connections.empty.title")}
                />
              )}
            <UI.Stack gap="compact">
              <UI.Heading level="section">
                {translate("settings.connections.home.available")}
              </UI.Heading>
              <div data-testid="available-list">
                <UI.ObjectRow
                  aligned
                  actions={canManage
                    ? connectButton("secondary", "home.connect")
                    : undefined}
                  identity={
                    <UI.Inline gap="compact">
                      <UI.Avatar
                        alt={PROVIDER_IDENTITY.avatarAlt}
                        fallback={PROVIDER_IDENTITY.avatarFallback}
                        size="small"
                      />
                      <UI.Text variant="strong">
                        {translate(PROVIDER_IDENTITY.headingKey)}
                      </UI.Text>
                    </UI.Inline>
                  }
                  metadata={translate(
                    "settings.connections.home.purpose",
                  )}
                />
                {WEB_PROVIDERS.filter((module) =>
                  !rows.some((row) => row.provider === module.manifest.slug)
                ).map((module) =>
                  module.connectAvailable === false
                    ? (
                      <ProviderNotYetConnectable
                        canManage={canManage}
                        key={module.manifest.slug}
                        slug={module.manifest.slug}
                      />
                    )
                    : (
                      <ProviderConnectable
                        canManage={canManage}
                        key={module.manifest.slug}
                        onConnect={() =>
                          props.onConnectProvider(module.manifest.slug)}
                        canOpenInstallation={props.canOpenInstallation === true}
                        slug={module.manifest.slug}
                        status={props.providerConnectStatus}
                      />
                    )
                )}
              </div>
              {canManage && connectStatus !== "unregistered"
                ? (
                  <UI.InlineNotice tone="neutral">
                    {translate("settings.connections.home.connectNotice")}
                  </UI.InlineNotice>
                )
                : null}
              {connectStatus === "unregistered"
                ? (
                  <UI.InlineNotice
                    data-testid="unregistered-notice"
                    tone="warning"
                  >
                    {translate("settings.connections.connect.unregistered")}
                    {props.canOpenInstallation === true
                      ? (
                        <>
                          {" "}
                          <RouterLink to="/settings/installation/integrations">
                            {translate(
                              "settings.connections.connect.unregisteredLink",
                            )}
                          </RouterLink>
                        </>
                      )
                      : null}
                  </UI.InlineNotice>
                )
                : null}
            </UI.Stack>
          </>
        )}
    </UI.SettingsContent>
  );
}

function ConnectedRow(
  { row, canManage, busy, onOpen, onReconnect, formatTime }: {
    readonly row: ConnectionRow;
    readonly canManage: boolean;
    readonly busy: boolean;
    readonly onOpen: (id: string) => void;
    readonly onReconnect: (id: string) => void;
    readonly formatTime: (iso: string) => string;
  },
) {
  const { translate } = useI18n();
  const { health } = row;
  const guided = hasSetupPages(row.provider);
  const look = providerLook(row.provider, translate);
  const label = translate(
    guided
      ? `settings.connections.action.${health.action}` as MessageKey
      : "settings.connections.action.manage",
  );
  // Reconnecting and connecting again leave for the provider; every other fix, and
  // Manage, opens the connection's own page.
  const leaves = guided &&
    (health.action === "reconnect" || health.action === "connectAgain");
  const open = (
    <RouterLink
      params={{ connectionId: row.id }}
      to="/settings/organization/integrations/$connectionId"
    >
      {guided
        ? translate("settings.connections.row.title", { account: row.account })
        : translate("settings.connections.other.title", {
          provider: look.name,
          account: row.account,
        })}
    </RouterLink>
  );
  return (
    <UI.ObjectRow
      aligned
      actions={canManage || !leaves
        ? (
          <UI.Button
            disabled={busy && leaves}
            onClick={() => leaves ? onReconnect(row.id) : onOpen(row.id)}
            type="button"
            variant="outline"
          >
            {label}
          </UI.Button>
        )
        : undefined}
      identity={
        <UI.Inline gap="compact">
          <UI.Avatar alt={look.name} fallback={look.fallback} size="small" />
          <UI.Text variant="strong">{open}</UI.Text>
        </UI.Inline>
      }
      metadata={guided
        ? rowLine(row, translate, formatTime)
        : otherRowLine(row, look.name, translate)}
      status={
        <UI.Badge tone={healthBadge(row.provider, health).tone}>
          {translate(healthBadge(row.provider, health).key)}
        </UI.Badge>
      }
    />
  );
}

function otherRowLine(
  row: ConnectionRow,
  provider: string,
  translate: ReturnType<typeof useI18n>["translate"],
): string | undefined {
  switch (row.health.kind) {
    case "turnedOff":
      return translate("settings.connections.other.turnedOff", { provider });
    case "removed":
      return translate("settings.connections.other.removed", { provider });
    case "needsAttention":
    case "authRequired":
    case "limited":
      return translate("settings.connections.other.needsAttention", {
        provider,
      });
    case "finishSetup":
    case "working":
    case "notChecked":
      return undefined;
  }
}

/** The one line under a row: what is worth knowing for its state, or nothing. */
function rowLine(
  row: ConnectionRow,
  translate: ReturnType<typeof useI18n>["translate"],
  formatTime: (iso: string) => string,
): string | undefined {
  switch (row.health.kind) {
    case "working":
      return row.lastCheckedAt === null
        ? undefined
        : translate("settings.connections.row.checked", {
          time: formatTime(row.lastCheckedAt),
        });
    case "finishSetup":
      return translate("settings.connections.row.finishSetup");
    case "turnedOff":
      return translate("settings.connections.row.turnedOff");
    case "needsAttention":
    case "authRequired":
    case "limited":
      return translate("settings.connections.row.needsAttention");
    case "removed":
      return translate("settings.connections.row.removed");
    case "notChecked":
      return undefined;
  }
}

function ProviderConnectable(
  { slug, canManage, canOpenInstallation, status, onConnect }: {
    readonly slug: string;
    readonly canManage: boolean;
    readonly canOpenInstallation: boolean;
    readonly status: ConnectStatus;
    readonly onConnect: () => void;
  },
) {
  const { translate } = useI18n();
  const say = (suffix: string) =>
    translate(`integrations.${slug}.${suffix}` as MessageKey);
  const name = say("name");
  const busy = status === "starting" || status === "redirecting";
  return (
    <UI.Stack data-testid={`provider-row-${slug}`} gap="compact">
      <UI.ObjectRow
        aligned
        actions={canManage
          ? (
            <UI.Button
              aria-label={say("connect")}
              disabled={busy}
              loading={status === "starting"}
              onClick={onConnect}
              type="button"
              variant="secondary"
            >
              {translate("settings.connections.home.connect")}
            </UI.Button>
          )
          : undefined}
        identity={
          <UI.Inline gap="compact">
            <UI.Avatar alt={name} fallback={name.slice(0, 1)} size="small" />
            <UI.Text variant="strong">{name}</UI.Text>
          </UI.Inline>
        }
        metadata={say("purpose")}
      />
      {status === "redirecting"
        ? (
          <UI.InlineNotice tone="information">
            {say("redirecting")}
          </UI.InlineNotice>
        )
        : status === "failed"
        ? <UI.InlineNotice tone="error">{say("failed")}</UI.InlineNotice>
        : status === "unregistered"
        ? (
          <UI.InlineNotice tone="warning">
            {say("unregistered")}
            {canOpenInstallation
              ? (
                <>
                  {" "}
                  <RouterLink
                    hash={slug}
                    to="/settings/installation/integrations"
                  >
                    {say("unregisteredLink")}
                  </RouterLink>
                </>
              )
              : null}
          </UI.InlineNotice>
        )
        : null}
    </UI.Stack>
  );
}

/**
 * A provider this server deploys whose connect flow is not built yet.
 *
 * Shown rather than hidden, so nobody wonders where it is: a neutral badge, one
 * line saying why, and Connect disabled and pointing at that line. It wins over
 * "Needs setup" because there is nothing for an administrator to do yet. It goes
 * when the provider's web module stops saying `connectAvailable: false`.
 */
function ProviderNotYetConnectable(
  { slug, canManage }: { slug: string; canManage: boolean },
) {
  const { translate } = useI18n();
  const reason = useId();
  const name = translate(`integrations.${slug}.name` as MessageKey);
  return (
    <UI.ObjectRow
      aligned
      actions={canManage
        ? (
          <UI.Button
            aria-describedby={reason}
            aria-label={translate(`integrations.${slug}.connect` as MessageKey)}
            disabled
            type="button"
            variant="secondary"
          >
            {translate("settings.connections.home.connect")}
          </UI.Button>
        )
        : undefined}
      identity={
        <UI.Inline gap="compact">
          <UI.Avatar alt={name} fallback={name.slice(0, 1)} size="small" />
          <UI.Text variant="strong">{name}</UI.Text>
        </UI.Inline>
      }
      metadata={
        <span id={reason}>
          {translate(`integrations.${slug}.soon` as MessageKey)}
        </span>
      }
      status={<UI.Badge>{translate("shell.navigation.comingSoon")}</UI.Badge>}
    />
  );
}
