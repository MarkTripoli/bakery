import { type ReactNode, useEffect, useRef } from "react";
import { formatDate, type MessageKey } from "@bakery/i18n";
import * as UI from "@bakery/ui";
import { RouterLink } from "../app/router-link.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";

const INTEGRATIONS_PATH = "/settings/organization/integrations";

export type SlackConnectionState =
  | "none"
  | "setup_unfinished"
  | "working"
  | "not_working";

export type SlackLinkStatus =
  | { readonly kind: "loading" }
  | { readonly kind: "failed" }
  | {
    readonly kind: "ready";
    readonly connection: SlackConnectionState;
    readonly state: "not_linked" | "linked" | "removed_by_admin";
    readonly workspaceName: string | null;
    readonly linkedAt: string | null;
    readonly removedAt: string | null;
  };

type NoticeTone = "success" | "neutral" | "error";

const NOTICES = {
  linked: ["success", "settings.security.linked.slack.result.linked"],
  relinked: ["success", "settings.security.linked.slack.result.linked"],
  unchanged: ["neutral", "settings.security.linked.slack.result.unchanged"],
  provider_denied: [
    "neutral",
    "settings.security.linked.slack.result.cancelled",
  ],
  link_refused: ["error", "settings.security.linked.slack.result.taken"],
  not_a_member: [
    "neutral",
    "settings.security.linked.slack.result.notAMember",
  ],
  exchange_failed: [
    "error",
    "settings.security.linked.slack.result.unconfirmed",
  ],
  token_invalid: [
    "error",
    "settings.security.linked.slack.result.unconfirmed",
  ],
  nonce_unreadable: [
    "error",
    "settings.security.linked.slack.result.unconfirmed",
  ],
  superseded: ["neutral", "settings.security.linked.slack.result.expired"],
  expired: ["neutral", "settings.security.linked.slack.result.expired"],
  wrong_workspace: [
    "error",
    "settings.security.linked.slack.result.wrongWorkspace",
  ],
  unlinked: ["success", "settings.security.linked.slack.unlinked"],
  unlink_failed: ["error", "settings.security.linked.slack.unlinkFailed"],
} as const satisfies Record<string, readonly [NoticeTone, MessageKey]>;

export type SlackLinkNotice = keyof typeof NOTICES;

export const isSlackLinkNotice = (value: unknown): value is SlackLinkNotice =>
  typeof value === "string" && Object.hasOwn(NOTICES, value);

export type LinkedSlackSectionProps = {
  readonly status: SlackLinkStatus;
  readonly notice: SlackLinkNotice | null;
  readonly organizationName: string;
  readonly canManageIntegrations: boolean;
  readonly linking: boolean;
  readonly unlinking: boolean;
  readonly confirmingUnlink: boolean;
  readonly onLink: () => void;
  readonly onConfirmingUnlinkChange: (open: boolean) => void;
  readonly onUnlink: () => void;
  readonly onRetry: () => void;
};

export function LinkedSlackSection(props: LinkedSlackSectionProps) {
  const { translate } = useI18n();
  return (
    <UI.SettingsSection
      data-testid="linked-accounts"
      title={translate("settings.security.linked.title")}
      variant="stack"
    >
      <UI.Text variant="muted">
        {translate("settings.security.linked.description")}
      </UI.Text>
      <ResultNotice {...props} />
      <SlackRow {...props} />
      <UI.AlertDialog
        cancelAction={
          <UI.Button
            onClick={() => props.onConfirmingUnlinkChange(false)}
            type="button"
            variant="secondary"
          >
            {translate("settings.security.linked.slack.dialog.cancel")}
          </UI.Button>
        }
        confirmAction={
          <UI.Button
            disabled={props.unlinking}
            loading={props.unlinking}
            onClick={props.onUnlink}
            type="button"
            variant="destructive"
          >
            {translate("settings.security.linked.slack.unlink")}
          </UI.Button>
        }
        onOpenChange={props.onConfirmingUnlinkChange}
        open={props.confirmingUnlink}
        title={translate("settings.security.linked.slack.dialog.title")}
      >
        {translate("settings.security.linked.slack.dialog.body")}
      </UI.AlertDialog>
    </UI.SettingsSection>
  );
}

function ResultNotice(
  { notice, organizationName, status }: LinkedSlackSectionProps,
) {
  const { translate } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), [notice]);
  if (notice === null) return null;
  const [tone, key] = NOTICES[notice];
  const workspace = status.kind === "ready" ? status.workspaceName : null;
  return (
    <UI.InlineNotice ref={ref} tabIndex={-1} tone={tone}>
      {translate(key, {
        organization: organizationName,
        workspace: workspace ?? "none",
        name: workspace ?? "",
      })}
    </UI.InlineNotice>
  );
}

function SlackRow(props: LinkedSlackSectionProps) {
  const { translate } = useI18n();
  const { action, description } = useSlackRow(props);
  return (
    <UI.DescriptionItem
      action={action}
      actionPlacement="below"
      description={description}
      icon={<UI.IconGlyph name="plug" size="large" />}
      id="slack"
      title={translate("integrations.slack.name")}
      titleStyle="item"
    />
  );
}

function useSlackRow(
  props: LinkedSlackSectionProps,
): { readonly description: ReactNode; readonly action?: ReactNode } {
  const { translate, locale, timeZone } = useI18n();
  const { status, organizationName: organization, linking } = props;
  const date = (iso: string | null) =>
    iso === null
      ? ""
      : formatDate(new Date(iso), locale, { timeZone, dateStyle: "medium" });
  if (status.kind === "loading") return { description: <UI.Skeleton /> };
  if (status.kind === "failed") {
    return {
      description: translate("settings.security.linked.slack.loadFailed"),
      action: (
        <UI.Button onClick={props.onRetry} type="button" variant="secondary">
          {translate("settings.security.linked.slack.retry")}
        </UI.Button>
      ),
    };
  }
  if (status.state === "linked") {
    return {
      description: translate(
        status.connection === "working"
          ? "settings.security.linked.slack.linked"
          : "settings.security.linked.slack.linkedDisconnected",
        {
          workspace: status.workspaceName === null ? "none" : "named",
          name: status.workspaceName ?? "",
          date: date(status.linkedAt),
          organization,
        },
      ),
      action: (
        <UI.Button
          aria-label={translate("settings.security.linked.slack.unlinkAria")}
          onClick={() => props.onConfirmingUnlinkChange(true)}
          type="button"
          variant="secondary"
        >
          {translate("settings.security.linked.slack.unlink")}
        </UI.Button>
      ),
    };
  }
  if (status.connection !== "working") {
    const down = status.connection === "not_working";
    return {
      description: (
        <>
          {translate(
            down
              ? "settings.security.linked.slack.disconnected"
              : "settings.security.linked.slack.notConnected",
            { organization },
          )}
          {props.canManageIntegrations
            ? (
              <>
                {" "}
                <RouterLink to={INTEGRATIONS_PATH}>
                  {translate(
                    down
                      ? "settings.security.linked.slack.openIntegrations"
                      : "settings.security.linked.slack.connectInIntegrations",
                  )}
                </RouterLink>
              </>
            )
            : null}
        </>
      ),
    };
  }
  return {
    description: linking
      ? translate("settings.security.linked.slack.waiting")
      : status.state === "removed_by_admin"
      ? translate("settings.security.linked.slack.removed", {
        date: date(status.removedAt),
      })
      : translate("settings.security.linked.slack.notLinked"),
    action: (
      <UI.Button
        disabled={linking}
        loading={linking}
        onClick={props.onLink}
        type="button"
      >
        {translate("settings.security.linked.slack.link")}
      </UI.Button>
    ),
  };
}
