import type { MessageKey } from "@bakery/i18n";

/**
 * Coarse provider callback outcome the server carries in `?githubConnection=`
 * (integrations/callbacks.ts `ConnectionOutcome`); never a provider detail.
 */
export const CONNECTION_OUTCOMES = [
  "connected",
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
  "held_elsewhere",
  "storage_failed",
  "enterprise_install",
  "wrong_app",
] as const;
export type ConnectionOutcome = (typeof CONNECTION_OUTCOMES)[number];

export type OutcomeCopy = {
  readonly tone: "success" | "information" | "warning" | "error";
  readonly body: MessageKey;
  /** Offer to connect again beside the message. */
  readonly retry: boolean;
};

type SlackOnlyOutcome = "enterprise_install" | "wrong_app";

const OUTCOME_COPY: Readonly<
  Record<
    Exclude<ConnectionOutcome, "connected" | SlackOnlyOutcome>,
    OutcomeCopy
  >
> = {
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
  held_elsewhere: {
    tone: "warning",
    body: "settings.connections.outcome.heldElsewhere",
    retry: false,
  },
  storage_failed: {
    tone: "error",
    body: "settings.connections.outcome.storageFailed",
    retry: true,
  },
};

export const outcomeCopy = (outcome: ConnectionOutcome): OutcomeCopy | null =>
  outcome === "connected" || outcome === "enterprise_install" ||
    outcome === "wrong_app"
    ? null
    : OUTCOME_COPY[outcome];
