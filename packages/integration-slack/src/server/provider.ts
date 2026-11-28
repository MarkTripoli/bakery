import { z } from "zod";
import { defineServerProvider } from "@bakery/integration-sdk/provider";
import type {
  CredentialStrategy,
  DriverContext,
  HealthProbe,
  InstallationLifecycle,
  OAuth2Profile,
  ResourceDiscovery,
} from "@bakery/integration-sdk/provider";
import { slackProviderManifest } from "../manifest.ts";
import {
  SLACK_DM_OPEN,
  SLACK_MESSAGE_EPHEMERAL,
  SLACK_MESSAGE_POST,
  SLACK_MESSAGE_UPDATE,
  SLACK_WORKSPACE_KIND,
  slackGate,
} from "./gate.ts";

const API_ORIGIN = "https://slack.com/api";

const BOT_SCOPES = [
  "app_mentions:read",
  "channels:history",
  "channels:read",
  "chat:write",
  "commands",
  "im:history",
  "im:read",
  "im:write",
] as const;

export const slackTokenResponseSchema = z.strictObject({
  ok: z.literal(true).describe("Slack reports the exchange succeeded."),
  access_token: z.string().min(1).describe(
    "The bot token the host stores; never returned to a person or an action.",
  ),
  token_type: z.string().optional().describe(
    "Slack's token scheme, `bot` for a workspace install.",
  ),
  scope: z.string().optional().describe(
    "Space-separated bot scopes Slack granted.",
  ),
  expires_in: z.number().int().positive().optional().describe(
    "Seconds until the bot access token expires when token rotation is enabled.",
  ),
  refresh_token: z.string().min(1).optional().describe(
    "The bot refresh token the host stores when token rotation is enabled.",
  ),
  bot_user_id: z.string().min(1).describe("The bot user in this workspace."),
  app_id: z.string().regex(/^A[A-Z0-9]{2,31}$/).describe(
    "The Slack app the installation belongs to.",
  ),
  team: z.strictObject({
    id: z.string().regex(/^T[A-Z0-9]{2,31}$/).describe("The workspace id."),
    name: z.string().optional().describe("The workspace name."),
  }).describe("The workspace the bot was installed into."),
  enterprise: z.strictObject({
    id: z.string().regex(/^E[A-Z0-9]{2,31}$/).describe(
      "The Enterprise Grid organization id.",
    ),
    name: z.string().optional().describe("The organization name."),
  }).nullable().optional().describe(
    "Present when the workspace is in an Enterprise Grid, null when Slack reports none.",
  ),
  authed_user: z.strictObject({
    id: z.string().optional().describe(
      "The person whose approval carried the installation.",
    ),
    scope: z.string().optional().describe(
      "Space-separated user scopes Slack granted, when the install asked for any.",
    ),
    access_token: z.string().optional().describe(
      "A user token Slack issued; it is never stored, the bot token is the credential.",
    ),
    token_type: z.string().optional().describe("The user token's scheme."),
    expires_in: z.number().int().positive().optional().describe(
      "Seconds until the user access token expires when token rotation is enabled.",
    ),
    refresh_token: z.string().min(1).optional().describe(
      "The user refresh token Slack returns when user-token rotation is enabled; Bakery never stores it.",
    ),
  }).optional().describe(
    "The approving person as Slack reports them; Slack omits it on some installs.",
  ),
  warning: z.string().min(1).optional().describe(
    "A non-fatal Slack warning that does not invalidate the installation.",
  ),
  response_metadata: z.strictObject({
    warnings: z.array(
      z.string().min(1).describe("A non-fatal Slack warning code."),
    ).describe(
      "Non-fatal warning codes returned with a successful installation.",
    ),
  }).optional().describe(
    "Slack's structured metadata for non-fatal response warnings.",
  ),
  is_enterprise_install: z.literal(false).optional().describe(
    "Slack omits it unless the grant is organization-wide; an organization-wide grant is refused as enterprise_install before this response is read.",
  ),
}).describe(
  "Slack's oauth.v2.access response for a bot installation: the bot identity, the workspace and whether the grant is organization-wide.",
);

const authTestResponse = z.object({
  ok: z.boolean().describe("False when Slack refused the credential."),
  error: z.string().optional().describe("Slack's reason code, shown as-is."),
  team_id: z.string().regex(/^T[A-Z0-9]{2,31}$/).optional().describe(
    "The workspace the credential belongs to.",
  ),
  team: z.string().optional().describe("The workspace name."),
  bot_id: z.string().optional().describe("The bot the credential acts as."),
}).describe("Slack's auth.test response.");

const decode = (bytes: Uint8Array | undefined): string =>
  bytes === undefined ? "" : new TextDecoder().decode(bytes).trim();

const credentials: CredentialStrategy = {
  secretSlots: ["access_token"],
  mint({ secrets }) {
    const token = decode(secrets.access_token);
    if (token.length === 0) {
      throw new Error("Slack needs a bot token in the access_token slot.");
    }
    return Promise.resolve({
      token,
      expiresAt: null,
      placement: "bearer" as const,
    });
  },
};

const oauth2: OAuth2Profile = {
  authorizeUrl: new URL("https://slack.com/oauth/v2/authorize"),
  tokenUrl: new URL("https://slack.com/api/oauth.v2.access"),
  scopes: BOT_SCOPES,
  scopeDelimiter: ",",
  apiBaseUrl: new URL(API_ORIGIN),
  webBaseUrl: new URL("https://slack.com"),
  tokenResponse: slackTokenResponseSchema,
  refusal(tokenResponse: unknown) {
    const raw = tokenResponse as { is_enterprise_install?: unknown } | null;
    return raw?.is_enterprise_install === true ? "enterprise_install" : null;
  },
  async identify(ctx: DriverContext) {
    const response = await ctx.provider.send({
      method: "POST",
      path: "/auth.test",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      maxResponseBytes: 16_384,
    });
    const parsed = authTestResponse.parse(
      JSON.parse(new TextDecoder().decode(response.body)),
    );
    if (!parsed.ok || parsed.team_id === undefined) {
      throw new Error(
        `Slack did not identify the installation: ${
          parsed.error ?? "no workspace"
        }.`,
      );
    }
    return {
      externalAccountId: parsed.team_id,
      accountLabel: parsed.team ?? parsed.team_id,
    };
  },
  connectedResource({ tokenResponse, externalAccountId, accountLabel }) {
    const token = slackTokenResponseSchema.parse(tokenResponse);
    if (token.team.id !== externalAccountId) {
      throw new Error("Slack named a different workspace than the bot token.");
    }
    return {
      kind: SLACK_WORKSPACE_KIND,
      externalId: externalAccountId,
      displayName: accountLabel,
      binding: { teamId: externalAccountId, botUserId: token.bot_user_id },
      signedEventSource: {
        appId: token.app_id,
        workspaceId: externalAccountId,
        ...(token.enterprise ? { enterpriseId: token.enterprise.id } : {}),
        botUserId: token.bot_user_id,
      },
      servicePrincipalName: "Slack delivery",
      servicePurpose: "slack.delivery",
      serviceGrants: [
        SLACK_DM_OPEN,
        SLACK_MESSAGE_POST,
        SLACK_MESSAGE_UPDATE,
        SLACK_MESSAGE_EPHEMERAL,
      ]
        .map((action) => ({
          capability: action.id,
          actionVersion: action.version,
        })),
    };
  },
};

const lifecycle: InstallationLifecycle = {
  onEvent: () => Promise.resolve(),
};

const discovery: ResourceDiscovery = {
  list: () => Promise.resolve({ resources: [], nextCursor: null }),
};

const SLACK_SIGN_IN_AGAIN = new Set([
  "invalid_auth",
  "token_revoked",
  "account_inactive",
  "token_expired",
  "not_authed",
]);

function retryAfter(
  headers: Readonly<Record<string, string>>,
): number | undefined {
  const value = Number(headers["retry-after"]);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function readAuthTest(body: Uint8Array) {
  try {
    return authTestResponse.safeParse(
      JSON.parse(new TextDecoder().decode(body)),
    );
  } catch {
    return null;
  }
}

const health: HealthProbe = {
  async check(ctx) {
    let response;
    try {
      response = await ctx.provider.send({
        method: "POST",
        path: "/auth.test",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        maxResponseBytes: 16_384,
      });
    } catch {
      return {
        healthy: false,
        reason: "dependency_unreachable",
        retryable: true,
      };
    }
    if (response.status === 429) {
      const seconds = retryAfter(response.headers ?? {});
      return {
        healthy: false,
        reason: "rate_limited",
        retryable: true,
        ...(seconds === undefined ? {} : { retryAfterSeconds: seconds }),
      };
    }
    const parsed = readAuthTest(response.body);
    if (parsed === null || !parsed.success) {
      return { healthy: false, reason: "dependency_refused", retryable: true };
    }
    if (!parsed.data.ok) {
      const error = parsed.data.error ?? "";
      const revoked = SLACK_SIGN_IN_AGAIN.has(error);
      return {
        healthy: false,
        reason: error === "token_revoked"
          ? "provider_removed"
          : revoked
          ? "auth_required"
          : "dependency_refused",
        retryable: !revoked,
      };
    }
    return { healthy: true };
  },
};

export const slackServerProvider = defineServerProvider(
  slackProviderManifest,
  {
    connect: oauth2,
    credentials,
    ingress: undefined,
    lifecycle,
    discovery,
    health,
    hostProfile: "slack-bot",
    gate: slackGate,
  },
);

export { API_ORIGIN as SLACK_API_ORIGIN, BOT_SCOPES as SLACK_BOT_SCOPES };
