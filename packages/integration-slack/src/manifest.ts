import type { ProviderManifest } from "@bakery/integration-sdk/provider";

export const slackProviderManifest = {
  slug: "slack",
  integrationId: "bakery.slack",
  providerUuid: "f4c75b1b-c525-586e-a4b7-bfabcd153eef",
  nameKey: "integrations.slack.name",
  families: [],
  appRegistration: {
    kind: "client-credentials",
    fields: [
      {
        id: "client_id",
        labelKey: "integrations.slack.fields.client_id",
        secret: false,
        format: "text",
      },
      {
        id: "client_secret",
        labelKey: "integrations.slack.fields.client_secret",
        secret: true,
        format: "text",
      },
    ],
  },
  connect: {
    kind: "oauth2",
    siteSelection: true,
    secretSlots: ["access_token"],
  },
  ingress: null,
  resourceKinds: [],
} as const satisfies ProviderManifest;
