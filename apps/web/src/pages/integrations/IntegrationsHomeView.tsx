import * as UI from "@bakery/ui";
import type { MessageKey } from "@bakery/i18n";
import { useShellViewport } from "../../app/responsive.ts";
import { RouterLink } from "../../app/router-link.tsx";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { ShellSlot } from "../../shell/shell-slots.tsx";
import type { Health } from "./model.ts";
import { type ConnectionOutcome, OUTCOME_COPY } from "./outcomes.ts";
import type { ConnectStatus } from "./connect.ts";

export type IntegrationsHomeState = "loading" | "error" | "forbidden" | "ready";

/** One connected integration as the list shows it. */
export type ConnectionRow = {
  readonly id: string;
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
  /** The page is on its way back to the provider for the attempt's next step. */
  readonly continuing: boolean;
  readonly connectStatus: ConnectStatus;
  readonly onAdd: () => void;
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
  const phone = useShellViewport() === "phone";
  const { state, canManage, rows, outcome, connectStatus } = props;
  const busy = connectStatus === "starting" ||
    connectStatus === "redirecting" || props.continuing;
  const copy = outcome ? OUTCOME_COPY[outcome] : null;
  const failure = CONNECT_FAILURE[connectStatus];
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

  // Where a list page's one primary action goes: the shell's action slot on
  // desktop, under the title on a phone.
  const add = canManage && state === "ready"
    ? (
      <UI.Button onClick={props.onAdd} type="button">
        {translate("settings.connections.add")}
      </UI.Button>
    )
    : null;
  return (
    <UI.SettingsContent data-testid="organization-integrations">
      {add && !phone ? <ShellSlot name="actions">{add}</ShellSlot> : null}
      <UI.PageHeader
        actions={phone ? add : undefined}
        flush
        subtitle={translate("settings.connections.description")}
        title={translate("settings.connections.title")}
        variant="list"
      />
      {copy
        ? (
          <UI.AlertBanner
            action={copy.retry && canManage
              ? (
                <UI.Button
                  disabled={busy}
                  onClick={props.onConnect}
                  type="button"
                  variant="secondary"
                >
                  {translate("settings.connections.connectAgain")}
                </UI.Button>
              )
              : undefined}
            data-outcome={outcome ?? undefined}
            data-testid="github-connection-outcome"
            onDismiss={props.onDismissOutcome}
            tone={copy.tone}
          >
            {translate(copy.body)}
          </UI.AlertBanner>
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
              <div data-testid="available-list" id="integrations-available">
                <UI.ObjectRow
                  actions={canManage
                    ? connectButton("secondary", "home.connect")
                    : undefined}
                  identity={
                    <UI.Inline gap="compact">
                      <UI.Avatar alt="GitHub" fallback="GH" size="small" />
                      <UI.Text variant="strong">
                        {translate("settings.connections.github.heading")}
                      </UI.Text>
                    </UI.Inline>
                  }
                  metadata={translate(
                    "settings.connections.home.purpose",
                  )}
                />
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
                    {" "}
                    <RouterLink to="/settings/installation/integrations">
                      {translate(
                        "settings.connections.connect.unregisteredLink",
                      )}
                    </RouterLink>
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
  const unhealthy = health.banner;
  const label = translate(
    `settings.connections.action.${health.action}` as MessageKey,
  );
  // Reconnecting and connecting again leave for the provider; every other fix, and
  // Manage, opens the connection's own page.
  const leaves = health.action === "reconnect" ||
    health.action === "connectAgain";
  const open = (
    <RouterLink
      params={{ connectionId: row.id }}
      to="/settings/organization/integrations/$connectionId"
    >
      {translate("settings.connections.row.title", { account: row.account })}
    </RouterLink>
  );
  return (
    <UI.ObjectRow
      actions={canManage || !leaves
        ? (
          <UI.Button
            disabled={busy && leaves}
            onClick={() => leaves ? onReconnect(row.id) : onOpen(row.id)}
            type="button"
            variant={unhealthy ? "primary" : "secondary"}
          >
            {label}
          </UI.Button>
        )
        : undefined}
      identity={
        <UI.Inline gap="compact">
          <UI.Avatar alt="GitHub" fallback="GH" size="small" />
          <UI.Text variant="strong">{open}</UI.Text>
        </UI.Inline>
      }
      metadata={row.lastCheckedAt === null
        ? translate("settings.connections.row.notChecked")
        : translate("settings.connections.row.checked", {
          time: formatTime(row.lastCheckedAt),
        })}
      status={
        <UI.Badge tone={health.tone}>
          {translate(`settings.connections.badge.${health.kind}` as MessageKey)}
        </UI.Badge>
      }
    />
  );
}
