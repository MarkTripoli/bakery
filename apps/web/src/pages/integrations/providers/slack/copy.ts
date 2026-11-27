import type { MessageKey } from "@bakery/i18n";
import type { HealthKind } from "../../model.ts";
import type { ConnectionOutcome, OutcomeCopy } from "../../outcomes.ts";

const said = (
  tone: OutcomeCopy["tone"],
  body: MessageKey,
  retry = false,
): OutcomeCopy => ({ tone, body, retry });

const TIMED_OUT = said(
  "information",
  "integrations.slack.outcome.expired",
  true,
);
const UNCONFIRMED = said(
  "error",
  "integrations.slack.outcome.unconfirmed",
  true,
);

export const SLACK_OUTCOMES: Readonly<
  Partial<Record<ConnectionOutcome, OutcomeCopy>>
> = {
  connected: said("success", "integrations.slack.outcome.connected"),
  refreshed: said("success", "integrations.slack.outcome.refreshed"),
  already_connected: said(
    "information",
    "integrations.slack.outcome.alreadyConnected",
  ),
  authorization_denied: said(
    "warning",
    "integrations.slack.outcome.cancelled",
    true,
  ),
  state_rejected: TIMED_OUT,
  expired: TIMED_OUT,
  exchange_failed: UNCONFIRMED,
  installation_check_failed: UNCONFIRMED,
  provider_unregistered: said("error", "integrations.slack.unregistered"),
  admin_required: said("error", "integrations.slack.outcome.adminRequired"),
  reconnect_unavailable: said(
    "error",
    "integrations.slack.outcome.reconnectUnavailable",
    true,
  ),
  held_elsewhere: said(
    "warning",
    "settings.connections.outcome.heldElsewhere",
  ),
  storage_failed: said(
    "error",
    "settings.connections.outcome.storageFailed",
    true,
  ),
};

export type ProviderFix = Readonly<{
  body: MessageKey;
  action: "reconnect" | "connectAgain";
}>;

const RECONNECT: ProviderFix = {
  body: "integrations.slack.banner.accessRefused",
  action: "reconnect",
};

export const SLACK_FIXES: Readonly<Partial<Record<HealthKind, ProviderFix>>> = {
  needsAttention: RECONNECT,
  authRequired: RECONNECT,
  limited: { body: "integrations.slack.banner.limited", action: "reconnect" },
  removed: {
    body: "integrations.slack.banner.removed",
    action: "connectAgain",
  },
};
