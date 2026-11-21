/**
 * `@bakery/integration-linear/web` - the Linear provider, web tier.
 *
 * Only `apps/web/src/integrations/registry.ts` imports this entry (boundary rule
 * B1b), so a component cannot reach the GraphQL documents, the signature check or
 * the token code from the browser side.
 */
import { defineWebProvider } from "@bakery/integration-sdk/web";
import { linearProviderManifest } from "../manifest.ts";

/**
 * What Linear adds to a rendered connection.
 *
 * There is no `ConnectStep`, and that is a decision rather than an omission: the
 * manifest connects with `oauth2`, which core drives end to end - PKCE, state, the
 * exchange and the refresh. A component here would be a second implementation of
 * the same flow, and the one the person sees would be the untested one.
 *
 * What a person does need from a provider is vocabulary: Linear calls a ticket an
 * *issue* and puts it in a *team*, so a picker that says "repository" is telling
 * them about GitHub. The two descriptions are the whole web surface.
 */
export const linearWebProvider = defineWebProvider({
  manifest: linearProviderManifest,
  ConnectStep: undefined,
  /**
   * Core's OAuth2 connect flow has no Linear route yet (#670 shipped the manifest and
   * the ticket reads, not the connection), so Connect would fail. Remove this line
   * when the flow lands.
   */
  connectAvailable: false,
  registrationGuideUrl: "https://linear.app/settings/api",
  /**
   * What kind of thing a Linear resource is, in the person's language.
   *
   * The resource's own name is data and the host renders it as data; this says
   * which kind of container it is, which is the part a person needs to tell a
   * project from a team.
   */
  describeResource: (resource) =>
    resource.resourceKindId === "team"
      ? { key: "integrations.linear.resource.team" }
      : { key: "integrations.linear.resource.project" },
  /**
   * Linear's permissions are scopes (`read`, `write`), not installation
   * permissions, so the sentence names what the scope lets Bakery do rather than
   * restating the token. A scope this build does not use is said plainly instead
   * of being described as if it were one of the two.
   */
  describePermission: (permission, level) =>
    level === "write"
      ? { key: "integrations.linear.permission.write" }
      : level === "read"
      ? { key: "integrations.linear.permission.read" }
      : {
        key: "integrations.linear.permission.other",
        arguments: { scope: permission },
      },
});
