import { z } from "zod";
import {
  ActionReferenceSchema,
  IntegrationScopeSchema,
  ProviderPermissionLevelSchema,
  ResourceKindIdSchema,
} from "@bakery/contracts/integrations";
import { requestTemplateSchema } from "./request.ts";

export const INTEGRATION_EVENT_TYPES = [
  "tasks.created",
  "tasks.updated",
] as const;

export const OptionalFeatureSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_-]*$/).max(64).describe(
    "Stable identifier of the optional feature within this integration.",
  ),
  description: z.string().min(10).max(500).describe(
    "Administrator-facing summary of what the feature does and why it needs the listed access.",
  ),
  scopes: z.array(IntegrationScopeSchema).describe(
    "Optional Bakery scopes the feature uses; each must also be listed in bakery.optional.",
  ),
  actions: z.array(ActionReferenceSchema).describe(
    "Declared actions the feature enables; each must appear in the manifest actions.",
  ),
  providerPermissions: z.record(
    z.string().regex(/^[a-z][a-z0-9_]*$/).describe(
      "Provider permission name from the host profile vocabulary.",
    ),
    ProviderPermissionLevelSchema,
  ).describe(
    "Provider permissions the feature needs beyond the base integration; absent means the feature reports unsupported.",
  ),
}).describe(
  "Optional integration feature gated by optional scopes and provider permissions; reported as unsupported, never silently dropped.",
);
export type OptionalFeature = z.infer<typeof OptionalFeatureSchema>;

const refKey = (r: { id: string; version: number }) => `${r.id}@${r.version}`;

export const integrationManifestSchema = z.strictObject({
  sdkVersion: z.literal(1).describe(
    "Integration SDK contract revision; only revision 1 is supported.",
  ),
  id: z.string().regex(/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/).max(100).describe(
    "Stable publisher-qualified integration identifier, such as bakery.github.",
  ),
  version: z.string().regex(/^\d+\.\d+\.\d+$/).describe(
    "Integration release version in major.minor.patch form.",
  ),
  authenticationProfile: z.string().regex(/^[a-z][a-z0-9-]*$/).max(100)
    .describe(
      "Host-owned authentication profile identifier; never credentials, an origin or an issuer URL.",
    ),
  bakery: z.strictObject({
    required: z.array(IntegrationScopeSchema).describe(
      "Exact Bakery scopes an administrator must approve before enabling; no wildcards.",
    ),
    optional: z.array(IntegrationScopeSchema).describe(
      "Exact Bakery scopes used only by optional features; declaration alone grants nothing.",
    ),
  }).describe(
    "Required and optional Bakery scopes; entries must be unique across both lists.",
  ),
  actions: z.array(ActionReferenceSchema).describe(
    "Unique action id and version pairs this integration declares; execution still needs an exact live grant.",
  ),
  resourceKinds: z.array(ResourceKindIdSchema).min(1).describe(
    "Unique provider resource kinds the integration operates on; must exist in the host authentication profile.",
  ),
  requests: z.array(requestTemplateSchema).describe(
    "Unique broker request templates by id and version; actions may only use templates declared here.",
  ),
  optionalFeatures: z.array(OptionalFeatureSchema).describe(
    "Optional features with their own scopes, actions and provider permissions.",
  ),
  subscriptions: z.array(
    z.enum(INTEGRATION_EVENT_TYPES).describe(
      "Public task event this integration asks to receive.",
    ),
  ).describe(
    "Requested task events; any subscription requires events:subscribe and tasks:read.",
  ),
}).superRefine((m, ctx) => {
  const issue = (message: string, path: (string | number)[]) =>
    ctx.addIssue({ code: "custom", message, path });
  const scopes = [...m.bakery.required, ...m.bakery.optional];
  if (new Set(scopes).size !== scopes.length) {
    issue("scopes must be unique across required and optional", ["bakery"]);
  }
  if (new Set(m.actions.map(refKey)).size !== m.actions.length) {
    issue("action versions must be unique", ["actions"]);
  }
  if (new Set(m.resourceKinds).size !== m.resourceKinds.length) {
    issue("resource kinds must be unique", ["resourceKinds"]);
  }
  if (new Set(m.requests.map(refKey)).size !== m.requests.length) {
    issue("request templates must be unique by id and version", ["requests"]);
  }
  for (const [i, request] of m.requests.entries()) {
    if (!m.resourceKinds.includes(request.resourceKind)) {
      issue("request resource kind is not declared", ["requests", i]);
    }
  }
  if (m.subscriptions.length) {
    if (
      !scopes.includes("events:subscribe") || !scopes.includes("tasks:read")
    ) {
      issue("subscriptions require events:subscribe and tasks:read", [
        "subscriptions",
      ]);
    }
    if (new Set(m.subscriptions).size !== m.subscriptions.length) {
      issue("subscriptions must be unique", ["subscriptions"]);
    }
  }
  const declared = new Set(m.actions.map(refKey));
  const featureIds = new Set<string>();
  for (const [i, feature] of m.optionalFeatures.entries()) {
    if (featureIds.has(feature.id)) {
      issue("optional feature ids must be unique", ["optionalFeatures", i]);
    }
    featureIds.add(feature.id);
    for (const scope of feature.scopes) {
      if (!m.bakery.optional.includes(scope)) {
        issue(`feature scope ${scope} is not in bakery.optional`, [
          "optionalFeatures",
          i,
          "scopes",
        ]);
      }
    }
    for (const action of feature.actions) {
      if (!declared.has(refKey(action))) {
        issue(`feature action ${refKey(action)} is not declared`, [
          "optionalFeatures",
          i,
          "actions",
        ]);
      }
    }
  }
}).describe(
  "Versioned integration manifest: identity, host-owned auth profile, Bakery scopes, exact actions, resource kinds, request templates, optional features and event subscriptions. Strict: URL, header and secret fields are rejected.",
);
export type IntegrationManifest = z.infer<typeof integrationManifestSchema>;
