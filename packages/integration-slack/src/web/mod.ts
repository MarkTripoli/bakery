import { defineWebProvider } from "@bakery/integration-sdk/web";
import { slackProviderManifest } from "../manifest.ts";

export const slackWebProvider = defineWebProvider({
  manifest: slackProviderManifest,
  ConnectStep: undefined,
  connectAvailable: true,
  registrationGuideUrl: "https://api.slack.com/apps",
  describePermission: (permission, level) =>
    level === "write"
      ? { key: "integrations.slack.permission.write" }
      : level === "read"
      ? { key: "integrations.slack.permission.read" }
      : {
        key: "integrations.slack.permission.other",
        arguments: { scope: permission },
      },
});
