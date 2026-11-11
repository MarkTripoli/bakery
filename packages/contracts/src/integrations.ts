import { z } from "zod";
import type { CatalogActionName } from "./catalog-literals.ts";

export const INTEGRATION_SCOPES = [
  "tickets:ingest",
  "tasks:read",
  "tasks:create",
  "runs:start",
  "runs:control",
  "conversations:read",
  "conversations:post",
  "questions:answer",
  "artifacts:read",
  "artifacts:comment",
  "events:subscribe",
  "integrations:invoke",
] as const;

export const IntegrationScopeSchema = z.enum(INTEGRATION_SCOPES).describe(
  "Exact Bakery operation scope an integration may request; no wildcard or prefix forms exist and declaring one never grants access.",
);
export type IntegrationScope = z.infer<typeof IntegrationScopeSchema>;

/**
 * Central scope to domain-operation map. Manifests cannot invent scopes.
 * `tickets:ingest` and `events:subscribe` gate non-catalog paths (provider
 * receipt import, domain-event subscriptions), so they map to no operation.
 *
 * Deviation from the plan, deliberate: `artifacts:read` maps to the catalog
 * read actions `artifacts.get` and `artifacts.list` (the catalog has no
 * `artifactVersions.content` action), and `conversations:read` also allows
 * `conversations.list` so an integration can discover a conversation before
 * reading its messages.
 */
export const INTEGRATION_SCOPE_OPERATIONS = {
  "tickets:ingest": [],
  "tasks:read": ["tasks.get", "tasks.list"],
  "tasks:create": ["tasks.create"],
  "runs:start": ["runs.create"],
  "runs:control": ["runs.control"],
  "conversations:read": [
    "conversations.get",
    "conversations.list",
    "messages.list",
  ],
  "conversations:post": ["messages.create"],
  "questions:answer": ["questions.answer"],
  "artifacts:read": ["artifacts.get", "artifacts.list"],
  "artifacts:comment": ["artifactComments.create"],
  "events:subscribe": [],
  "integrations:invoke": ["integrationConnections.invoke"],
} as const satisfies Readonly<
  Record<IntegrationScope, readonly CatalogActionName[]>
>;

const ACTION_ID_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/;

const actionReferenceObject = z.object({
  id: z.string().regex(ACTION_ID_PATTERN).max(128).describe(
    "Namespaced registered action identifier such as github.issue.comment.create; wildcards and prefixes are rejected.",
  ),
  version: z.number().int().positive().describe(
    "Explicit positive integer action contract version; latest or ranges are never accepted.",
  ),
}).strict().describe(
  "Closed action reference shape with exactly an id and a version.",
);
// Unknown keys fail parse instead of being stripped.
export const ActionReferenceSchema = actionReferenceObject.catchall(
  z.never().describe(
    "Unknown action reference fields are rejected; a reference carries only id and version.",
  ),
).describe(
  "Exact registered action id and version an integration declares or is granted; one version per reference.",
) as typeof actionReferenceObject;

export type ActionReference = z.infer<typeof ActionReferenceSchema>;

export function formatActionReference(reference: ActionReference): string {
  const parsed = ActionReferenceSchema.parse(reference);
  return `${parsed.id}@${parsed.version}`;
}

/** Parses `id@N`; returns null for wildcards, `@latest`, missing or zero versions. */
export function parseActionReference(value: string): ActionReference | null {
  const match = /^([^@]+)@([1-9][0-9]*)$/.exec(value);
  if (!match) return null;
  const parsed = ActionReferenceSchema.safeParse({
    id: match[1],
    version: Number(match[2]),
  });
  return parsed.success ? parsed.data : null;
}

export const ResourceKindIdSchema = z.string().regex(
  /^[a-z][a-z0-9]*\.[a-z][a-z0-9_]*$/,
).max(96).describe(
  "Namespaced provider resource kind such as github.repository; selects a registered resource type, never an instance.",
);
export type ResourceKindId = z.infer<typeof ResourceKindIdSchema>;

export const ProviderPermissionLevelSchema = z.enum(["read", "write"]).describe(
  "Provider-side permission level a connection holds for a capability: read observes, write may change provider state.",
);
export type ProviderPermissionLevel = z.infer<
  typeof ProviderPermissionLevelSchema
>;
