import { z } from "zod";
import { CredentialFieldSchema } from "./credential-fields.ts";

/**
 * The provider manifest (chapter 09 section 12.2).
 *
 * A manifest is data, not behaviour: it is the part of a provider the host, the
 * gate and the web bundle all need to read without importing the provider's
 * driver. That is why it is a strict Zod object rather than a TypeScript type -
 * it crosses a boundary at runtime, so it has to be checked at runtime.
 *
 * Two rules make the shape carry its own invariants instead of leaving them to
 * `activateProviders`:
 * - a capability that requires a family cannot appear without it (`tickets`,
 *   `code`), because a manifest that declares a port it cannot serve would fail
 *   at the first call rather than at startup;
 * - `ingress` is either absent or a scope, never an empty object, so "no ingress"
 *   has exactly one spelling.
 */

/**
 * The slugs this SDK reserves.
 *
 * A slug names a provider in a URL, an i18n key and a package name, so a
 * collision is not recoverable by renaming one of the three later. Reserving the
 * set up front means the check is a list rather than a hope.
 */
export const RESERVED_PROVIDER_SLUGS = [
  "admin",
  "api",
  "app",
  "apps",
  "auth",
  "core",
  "health",
  "integrations",
  "internal",
  "settings",
  "system",
  "webhooks",
] as const;

/** Provider slugs are lowercase identifiers because they appear in URLs and keys. */
export const ProviderSlugSchema = z.string().regex(/^[a-z][a-z0-9-]*$/).min(2)
  .max(32).describe(
    "Provider slug, such as github or linear; lowercase, in URLs and i18n keys, and never a reserved word.",
  );

/**
 * The integration id the gate routes by. Publisher-qualified and always prefixed
 * `bakery.`, so a provider id cannot impersonate a reserved route.
 */
export const IntegrationIdSchema = z.string().regex(
  /^bakery\.[a-z][a-z0-9-]*$/,
).max(64).describe(
  "Gate integration identifier, always bakery.<slug>; the prefix keeps a provider id out of the reserved route namespace.",
);

/**
 * Which family of ports a provider serves. `chat` is deliberately absent: section
 * 12.3 defers it rather than inventing a shape nothing can fill yet.
 */
export const ProviderFamilySchema = z.enum(["tickets", "code", "storage"])
  .describe(
    "Port family the provider serves; a capability requiring a family is only valid when the family is listed.",
  );

/**
 * How a provider's app is registered. Separate from connect: registration is
 * installation-level and happens once, while connecting is per organization.
 */
export const AppRegistrationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("github-manifest").describe(
      "The provider registers its app from a manifest the host posts; GitHub is the only shape that works this way.",
    ),
  }).describe("Manifest-driven app registration."),
  z.strictObject({
    kind: z.literal("client-credentials").describe(
      "The administrator supplies a client id and secret that were created outside Bakery.",
    ),
    fields: z.array(CredentialFieldSchema).min(1).max(8).describe(
      "Exactly which credential fields the administrator supplies, so the form needs no provider code.",
    ),
  }).describe("Administrator-supplied client credentials."),
]).describe(
  "How the provider's app is registered; null when the provider needs none.",
);

/**
 * How an organization connects. The union is closed because each arm changes who
 * holds the secret: core runs one audited OAuth2 flow, core stores an API token,
 * and only an app installation delegates to the provider.
 */
export const ConnectKindSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("github-app").describe(
      "An app installation the provider completes itself; the only provider-authored connect code.",
    ),
  }).describe("App installation connect."),
  z.strictObject({
    kind: z.literal("oauth2").describe(
      "Core runs one audited PKCE and refresh flow parameterised by the provider's profile.",
    ),
    siteSelection: z.boolean().describe(
      "Whether the flow lets a person pick a site or workspace before granting, which changes the redirect handling.",
    ),
    secretSlots: z.array(
      z.string().regex(/^[a-z][a-z0-9_]*$/).max(64).describe(
        "One secret slot name the flow stores; lowercase, so it matches the key the host decrypts into.",
      ),
    ).min(1).max(8)
      .describe(
        "Secret slot names the OAuth2 flow stores once it completes, such as access_token and refresh_token; the provider's credential strategy mints from these, and declaring them here is what lets the host check that every slot it is asked for can exist.",
      ),
  }).describe("OAuth2 connect."),
  z.strictObject({
    kind: z.literal("api-token").describe(
      "A person pastes a token; core encrypts and stores it and the provider only proves it works.",
    ),
    fields: z.array(CredentialFieldSchema).min(1).max(8).describe(
      "Exactly which fields the person fills in, so the form needs no provider code.",
    ),
  }).describe("API token connect."),
]).describe(
  "How an organization connects to the provider; the arm decides who holds the secret.",
);

/** Whether webhook deliveries arrive for the whole app or per connection. */
export const IngressScopeSchema = z.strictObject({
  scope: z.enum(["app", "connection"]).describe(
    "App when one registration receives every delivery, connection when each connection has its own secret.",
  ),
}).describe(
  "Webhook ingress declaration; absent means the provider sends no webhooks.",
);

/**
 * A resource kind the provider can discover. `serves` names the engine facts the
 * resource can satisfy, so the host can tell a caller which kinds answer a question
 * without importing provider code.
 */
export const ResourceKindSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_]*$/).max(64).describe(
    "Stable resource kind id, such as repository or project; the SDK's vocabulary, not the provider's.",
  ),
  nameKey: z.string().min(1).max(200).describe(
    "i18n key for the kind's display name; never a raw English string.",
  ),
  serves: z.array(
    z.string().regex(/^[a-z][a-z0-9_.]*$/).max(80).describe(
      "One engine fact this kind can satisfy, such as projects or changes.",
    ),
  ).min(1).max(16).describe(
    "Engine facts this kind can satisfy, so a caller can choose a kind without provider knowledge.",
  ),
}).describe("A resource kind a provider discovers.");

export const ProviderManifestSchema = z.strictObject({
  slug: ProviderSlugSchema,
  integrationId: IntegrationIdSchema,
  providerUuid: z.string().regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  ).describe(
    "Stable provider row identifier; fixed for the provider's lifetime so a rename never orphans an installation.",
  ),
  nameKey: z.string().min(1).max(200).describe(
    "i18n key for the provider's display name; never a raw English string.",
  ),
  families: z.array(ProviderFamilySchema).max(3).describe(
    "Port families the provider serves; empty when it only contributes facts.",
  ),
  appRegistration: AppRegistrationSchema.nullable(),
  connect: ConnectKindSchema,
  ingress: IngressScopeSchema.nullable().describe(
    "Webhook ingress declaration, or null when the provider sends none.",
  ),
  resourceKinds: z.array(ResourceKindSchema).max(32).describe(
    "Resource kinds the provider discovers and what facts each can serve.",
  ),
}).describe(
  "Provider manifest: the data the host, the gate and the web bundle read without importing provider code.",
);

export type ProviderManifest = z.infer<typeof ProviderManifestSchema>;
export type ProviderFamily = z.infer<typeof ProviderFamilySchema>;
export type ResourceKind = z.infer<typeof ResourceKindSchema>;
export type AppRegistration = z.infer<typeof AppRegistrationSchema>;
export type ConnectKind = z.infer<typeof ConnectKindSchema>;

/** Whether a manifest claims a family, which decides whether its family port is required. */
export function servesFamily<M extends ProviderManifest>(
  manifest: M,
  family: ProviderFamily,
): boolean {
  return manifest.families.includes(family);
}

/**
 * Manifest defects a person can act on, checked without loading any provider code.
 *
 * These are the checks `activateProviders` will fail startup on (section 12.2 B8).
 * They live here so a provider can be validated in a test, and so the same
 * function serves the startup path and the rail.
 */
export function manifestDefects(manifest: ProviderManifest): string[] {
  const defects: string[] = [];
  const reserved = new Set<string>(RESERVED_PROVIDER_SLUGS);
  if (reserved.has(manifest.slug)) {
    defects.push(
      `The slug ${manifest.slug} is reserved; pick a provider name that is not a route or a namespace.`,
    );
  }
  // The gate routes by integrationId, so an id whose slug half disagrees with the
  // manifest slug would send a delivery to a provider that does not exist.
  if (manifest.integrationId !== `bakery.${manifest.slug}`) {
    defects.push(
      `integrationId is ${manifest.integrationId} but the slug is ${manifest.slug}; the id must be bakery.<slug> so the gate and the manifest agree.`,
    );
  }
  if (new Set(manifest.families).size !== manifest.families.length) {
    defects.push("families lists the same family twice.");
  }
  const kindIds = manifest.resourceKinds.map((kind) => kind.id);
  if (new Set(kindIds).size !== kindIds.length) {
    defects.push("resourceKinds repeats a kind id.");
  }
  return defects;
}
