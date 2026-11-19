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
   * A Linear issue reads as `ENG-123 · title`, because the identifier is what a
   * person quotes and searching by title is how they find the wrong one.
   */
  describeResource: (resource) => resource.name,
  /**
   * Linear's permissions are scopes (`read`, `write`), not installation
   * permissions, so the sentence names what the scope lets Bakery do rather than
   * restating the token.
   */
  describePermission: (permission, level) =>
    level === "write"
      ? `${permission}: Bakery can change Linear issues and post comments`
      : `${permission}: Bakery can read Linear issues and projects`,
});
