import { z } from "zod";
import { defineServerProvider } from "@bakery/integration-sdk/provider";
import type {
  CredentialStrategy,
  DriverContext,
  InstallationLifecycle,
  OAuth2Profile,
} from "@bakery/integration-sdk/provider";
import { linearIngress } from "./ingress.ts";
import { linearProviderManifest } from "../manifest.ts";
import {
  LINEAR_GRAPHQL_PATH,
  linearDiscovery,
  linearHealth,
  linearTickets,
} from "./tickets.ts";
import { VIEWER } from "./graphql.ts";

/**
 * The Linear server provider (chapter 09 section 12.2).
 *
 * The manifest says what Linear serves; this says how. Every member that needs a
 * decision records it below rather than in a comment on the manifest, because the
 * decision is about behaviour and the manifest is data.
 */

/**
 * Linear's OAuth2 endpoints.
 *
 * Both are the hosted service's, and both are constants rather than settings: a
 * self-managed Linear does not exist, so a configurable origin would be a setting
 * whose only correct value is this one. If Linear ever ships a data-region variant
 * the profile grows a field then, with a test for the region it adds.
 */
const AUTHORIZE_URL = new URL("https://linear.app/oauth/authorize");
const TOKEN_URL = new URL("https://api.linear.app/oauth/token");

/**
 * The scopes Bakery asks for.
 *
 * `read` is the whole workspace; `issues:create` and `comments:create` are the two
 * writes the ticket port makes. `write` is deliberately absent: it grants every
 * mutation Linear has, and the engine only ever adds a comment or moves a state, so
 * asking for it would be asking for more than the port can use.
 */
const SCOPES = ["read", "issues:create", "comments:create"] as const;

/**
 * Linear's token response.
 *
 * `expires_in` is a number of seconds and Linear always sends it, but it is
 * accepted as optional so a future response without one does not fail validation -
 * the host requires an absolute expiry, and the profile supplies a conservative
 * one when the field is missing.
 */
const tokenResponse = z.strictObject({
  access_token: z.string().min(1).describe(
    "The bearer token to send on every Linear request.",
  ),
  token_type: z.string().optional().describe(
    "The scheme Linear named for the token; `Bearer` when present.",
  ),
  expires_in: z.number().int().positive().optional().describe(
    "Token lifetime in seconds; absent means the host uses its conservative default.",
  ),
  scope: z.string().optional().describe(
    "Space-separated scopes Linear actually granted, which may be narrower than those requested.",
  ),
}).describe(
  "Linear's OAuth2 token response; access_token, an optional token_type, the lifetime in seconds and the granted scope.",
);

/** Fallback lifetime when Linear omits `expires_in`: five minutes, refreshed early. */
const DEFAULT_TOKEN_LIFETIME_SECONDS = 300;

/**
 * How a request reaches Linear.
 *
 * One secret slot: the OAuth access token the host decrypted. There is no second
 * slot, because Linear has no separate tenant id to send - the token itself is
 * bound to one workspace, which is what makes `identify` necessary.
 */
const credentials: CredentialStrategy = {
  secretSlots: ["access_token"],
  mint({ secrets }) {
    const raw = secrets.access_token;
    // The slot holds bytes because the host decrypts to bytes; the wire wants text,
    // so the decode happens once, here, rather than at each call site.
    const token = raw ? new TextDecoder().decode(raw).trim() : "";
    if (token.length === 0) {
      throw new Error(
        "Linear needs an access token in the access_token secret slot.",
      );
    }
    return Promise.resolve({
      token,
      // The expiry is the host's clock, not the token's: `mint` may be called to
      // serve a request that is already in flight, and the host refreshes on its
      // own schedule. Reporting a lifetime the host did not measure would make it
      // refresh either too early on every call or too late once.
      expiresAt: new Date(Date.now() + DEFAULT_TOKEN_LIFETIME_SECONDS * 1_000),
      placement: "bearer" as const,
    });
  },
};

/**
 * The OAuth2 profile core drives.
 *
 * `identify` is what makes the workspace explicit: Linear's grant is per
 * workspace, and a person can belong to several. Recording the workspace id at
 * connect time is what lets a second authorization to a different workspace be a
 * reconnect rather than a silent repoint of every connection that used the first.
 */
const oauth2: OAuth2Profile = {
  authorizeUrl: AUTHORIZE_URL,
  tokenUrl: TOKEN_URL,
  scopes: SCOPES,
  tokenResponse,
  async identify(ctx: DriverContext) {
    const response = await ctx.provider.send({
      method: "POST",
      path: LINEAR_GRAPHQL_PATH,
      headers: { "content-type": "application/json" },
      body: new TextEncoder().encode(
        JSON.stringify({ query: VIEWER, variables: {} }),
      ),
      maxResponseBytes: 65_536,
    });
    const parsed = JSON.parse(new TextDecoder().decode(response.body)) as {
      data?: {
        viewer?: { id?: string; name?: string };
        organization?: { id?: string; name?: string };
      };
    };
    const viewer = parsed.data?.viewer;
    const organization = parsed.data?.organization;
    if (!viewer?.id || !organization?.id) {
      throw new Error(
        "Linear did not identify the account: the grant has no viewer or no workspace.",
      );
    }
    // The account is the workspace, not the person. Two people authorizing the same
    // workspace must land on one connection, and a person authorizing two
    // workspaces must land on two - so the id is the organization's, and the
    // person's name is only a label.
    return {
      externalAccountId: organization.id,
      accountLabel: organization.name ?? viewer.name ?? organization.id,
    };
  },
};

/**
 * The ingress: Linear signs, and signs differently from GitHub.
 *
 * The signature, the freshness window and the classification all live in
 * `ingress.ts`, because each of them is a decision with a failure mode worth
 * testing on its own; this file only names the port.
 */

/**
 * Lifecycle hooks are deliberately empty.
 *
 * Every one of them would be Linear telling Bakery something the signature on a
 * delivery already implies, and the host owns installation state: an
 * `onEvent` that wrote a row would be a provider writing a table. `revoked` is the
 * one a caller might expect to do work, and the work is the host's - it marks the
 * connection and stops brokering.
 */
const lifecycle: InstallationLifecycle = {
  onEvent() {
    return Promise.resolve();
  },
};

export const linearServerProvider = defineServerProvider(
  linearProviderManifest,
  {
    connect: oauth2,
    credentials,
    ingress: linearIngress,
    lifecycle,
    discovery: linearDiscovery,
    health: linearHealth,
    hostProfile: "linear-oauth2",
    tickets: linearTickets,
  },
);
