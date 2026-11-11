import type { BetterAuthPlugin } from "better-auth";
import { createSsoEnforcementPlugin } from "./enforcement.ts";
import { createSsoAuthPlugins, type SsoModuleDependencies } from "./plugin.ts";

export { SSO_AUDIT_OPERATIONS } from "./operations.ts";
export type { SsoModuleDependencies } from "./plugin.ts";

/** Every Better Auth plugin the SSO module registers, in registration order. */
export function createSsoModules(
  dependencies: SsoModuleDependencies,
): BetterAuthPlugin[] {
  return [
    ...createSsoAuthPlugins(dependencies),
    createSsoEnforcementPlugin(dependencies),
  ];
}
