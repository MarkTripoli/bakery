import {
  type ActionAuthorityRunner,
  ActionKind,
  ActionRegistry,
  assertRegisteredActions,
  HttpMethod,
} from "@bakery/contracts/action-registry";
import {
  ActionAccess,
  contractSchemas,
  OrganizationContextPolicy,
} from "@bakery/contracts/contracts";
import {
  assertImplementedActionRegistry,
  SecretsImplementedAction,
  secretsImplementedActions,
} from "@bakery/contracts/implemented-actions";
import { createPostgresCommandRunner } from "../../platform/command-replay.ts";
import {
  createSecret,
  createSecretsListHandler,
  getSecret,
  revokeSecret,
  rotateSecret,
  updateSecretPolicy,
} from "./postgres.ts";

export function createSecretsActionRegistry(
  authority: ActionAuthorityRunner,
  cursorSecret: string,
): ActionRegistry {
  const registry = new ActionRegistry(authority, createPostgresCommandRunner());
  const policy = {
    type: ActionKind.Query,
    access: ActionAccess.Admin,
    organizationContext: OrganizationContextPolicy.RequiredAuthenticatedContext,
  };
  registry.register({
    name: SecretsImplementedAction.List,
    method: HttpMethod.Get,
    path: "/v1/secrets",
    input: contractSchemas.SecretList,
    output: contractSchemas["Page<SecretMetadata>"],
    policy,
    handler: createSecretsListHandler(cursorSecret),
  });
  registry.register({
    name: SecretsImplementedAction.Get,
    method: HttpMethod.Get,
    path: "/v1/secrets/:id",
    input: contractSchemas.SecretGet,
    output: contractSchemas.SecretMetadata,
    policy,
    handler: getSecret,
  });
  registry.register({
    name: SecretsImplementedAction.Create,
    method: HttpMethod.Post,
    path: "/v1/secrets",
    input: contractSchemas.SecretCreate,
    output: contractSchemas.SecretMetadata,
    policy: { ...policy, type: ActionKind.Command },
    handler: createSecret,
  });
  registry.register({
    name: SecretsImplementedAction.Rotate,
    method: HttpMethod.Post,
    path: "/v1/secrets/:id/versions",
    input: contractSchemas.SecretRotation,
    output: contractSchemas.SecretMetadata,
    policy: { ...policy, type: ActionKind.Command },
    handler: rotateSecret,
  });
  registry.register({
    name: SecretsImplementedAction.UpdatePolicy,
    method: HttpMethod.Patch,
    path: "/v1/secrets/:id",
    input: contractSchemas.SecretPolicyUpdate,
    output: contractSchemas.SecretMetadata,
    policy: { ...policy, type: ActionKind.Command },
    handler: updateSecretPolicy,
  });
  registry.register({
    name: SecretsImplementedAction.Revoke,
    method: HttpMethod.Delete,
    path: "/v1/secrets/:id",
    input: contractSchemas.SecretRevoke,
    output: contractSchemas.NoContent,
    policy: { ...policy, type: ActionKind.Command },
    naturalIdempotency: true,
    handler: revokeSecret,
  });
  assertRegisteredActions(registry);
  assertImplementedActionRegistry(registry, secretsImplementedActions);
  return registry;
}
