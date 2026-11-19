import type { ProviderManifest } from "@bakery/integration-sdk/provider";

/**
 * The Linear provider manifest (chapter 09 section 12.2).
 *
 * Data only: the host, the gate and the web bundle read this without importing the
 * driver, which is why it is a Zod-validated object rather than a TypeScript type.
 *
 * Two choices are worth recording because neither is forced by the schema:
 *
 * - **`connect` is OAuth2, not an API token.** Linear supports both, and a token
 *   is easier to start with. OAuth2 is the arm that survives a person leaving: a
 *   personal API key dies with their account and takes every run hanging off the
 *   connection with it. The token arm stays available to providers where no OAuth
 *   grant exists; this item is explicitly the `OAuth2Profile` one.
 * - **`ingress` is app-scoped.** Linear signs one webhook with one secret per
 *   registration, and the delivery carries the organization it belongs to, so a
 *   per-connection secret would mean registering a webhook per connection and
 *   solving a problem the signature already solves.
 */
export const linearProviderManifest = {
  slug: "linear",
  integrationId: "bakery.linear",
  // UUIDv5 in the URL namespace of `urn:bakery:integration-provider:linear`,
  // derived the same way as the GitHub row's id. Pinned: it is the
  // `integration_providers` primary key, so changing it orphans every connection.
  providerUuid: "7884e080-6d1f-5aa0-80a7-d03a941cef11",
  nameKey: "integrations.linear.name",
  // Tickets only. Linear has no code family - it stores no branches and no
  // reviews - so claiming the family would put a port nothing can serve on the
  // engine's list of places to look for a pull request.
  families: ["tickets"],
  // Linear has no manifest-posted app registration: an administrator creates an
  // OAuth application in Linear and supplies its client id and secret.
  appRegistration: {
    kind: "client-credentials",
    fields: [
      {
        id: "client_id",
        labelKey: "integrations.linear.fields.client_id",
        secret: false,
        format: "text",
      },
      {
        id: "client_secret",
        labelKey: "integrations.linear.fields.client_secret",
        secret: true,
        format: "text",
      },
    ],
  },
  connect: {
    kind: "oauth2",
    // Linear grants access to one workspace per authorization, chosen inside
    // Linear's own consent screen; there is no site picker for Bakery to render.
    siteSelection: false,
    // What the exchange stores. The refresh token is declared even though `mint`
    // reads only the access token: the host is what refreshes, and it needs to know
    // a refresh token exists to decide it can.
    secretSlots: ["access_token", "refresh_token"],
  },
  ingress: { scope: "app" },
  resourceKinds: [
    {
      id: "issue",
      nameKey: "integrations.linear.kinds.issue",
      // The ticket family is served by issues and by nothing else: a Linear
      // project is a container, not work a person claims.
      serves: ["tickets"],
    },
    {
      id: "project",
      nameKey: "integrations.linear.kinds.project",
      serves: ["tickets.project"],
    },
  ],
} as const satisfies ProviderManifest;
