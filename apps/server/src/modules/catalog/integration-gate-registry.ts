import { githubIntegration } from "./integration-providers/github.ts";

/**
 * Natives deployed with this server build. Static on purpose: no dynamic
 * import, no discovery from disk. Adding a provider is a code change.
 */
export const deployedIntegrations = [githubIntegration] as const;
