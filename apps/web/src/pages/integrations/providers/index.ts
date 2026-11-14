/**
 * Where a provider's pieces are bound to the generic integrations pages. The
 * generic files import from here by generic names; a second provider is
 * added here and the pages choose by a connection's provider.
 */
export { useGitHubConnect as useProviderConnect } from "./github/use-github-connect.ts";
export type { ConnectOptions } from "./github/use-github-connect.ts";
export { GITHUB_IDENTITY as PROVIDER_IDENTITY } from "./github/identity.ts";
