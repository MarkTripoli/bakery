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

const API_ORIGIN = "https://slack.com/api";

const BOT_SCOPES = [
  "app_mentions:read",
  "channels:history",
  "channels:read",
  "chat:write",
  "commands",
] as const;

const tokenResponse = z.strictObject({
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
  }).optional().describe(
    "Present when the workspace is in an Enterprise Grid.",
  ),
  is_enterprise_install: z.boolean().optional().describe(
    "True when the grant is organization-wide; such an install is not supported.",
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

const BOT_TOKEN_LIFETIME_SECONDS = 365 * 24 * 60 * 60;

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
      expiresAt: new Date(Date.now() + BOT_TOKEN_LIFETIME_SECONDS * 1_000),
      placement: "bearer" as const,
    });
  },
};

const oauth2: OAuth2Profile = {
  authorizeUrl: new URL("https://slack.com/oauth/v2/authorize"),
  tokenUrl: new URL("https://slack.com/api/oauth.v2.access"),
  scopes: BOT_SCOPES,
  tokenResponse,
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
};

const lifecycle: InstallationLifecycle = {
  onEvent: () => Promise.resolve(),
};

const discovery: ResourceDiscovery = {
  list: () => Promise.resolve({ resources: [], nextCursor: null }),
};

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
      return { healthy: false, reason: "rate_limited", retryable: true };
    }
    const parsed = authTestResponse.safeParse(
      JSON.parse(new TextDecoder().decode(response.body)),
    );
    if (!parsed.success || !parsed.data.ok) {
      const error = parsed.success ? parsed.data.error : undefined;
      const revoked = error === "invalid_auth" || error === "token_revoked";
      return {
        healthy: false,
        reason: revoked ? "auth_required" : "dependency_refused",
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
  },
);

export { API_ORIGIN as SLACK_API_ORIGIN, BOT_SCOPES as SLACK_BOT_SCOPES };
