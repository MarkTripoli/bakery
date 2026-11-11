import { assert, assertEquals } from "@std/assert";
import {
  catalogActions,
  generateContracts,
  toJsonSchema,
} from "../../packages/contracts/src/contracts.ts";
import { implementedActions } from "../../packages/contracts/src/implemented-actions.ts";
import { createAuthV1Routes } from "../../apps/server/src/modules/auth/transport/http/v1/routes.ts";

type JsonSchema = {
  properties: Record<string, JsonSchema>;
  required?: string[];
  enum?: string[];
  items?: JsonSchema;
  type?: string | string[];
  anyOf?: JsonSchema[];
  description?: string;
};

const actions = [
  "profile.get",
  "profile.update",
  "userPreferences.get",
  "userPreferences.update",
  "installation.capabilities",
] as const;

function schemaOf(name: string): JsonSchema {
  const schemas = generateContracts().schemas as Record<string, never>;
  return toJsonSchema(schemas[name]) as JsonSchema;
}

function assertDescribed(schema: JsonSchema, path: string): void {
  assert(schema.description?.trim(), `${path} needs a description`);
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    assertDescribed(child, `${path}.${key}`);
  }
  if (schema.items) assertDescribed(schema.items, `${path}[]`);
}

Deno.test("settings actions are implemented and match their catalog entries", () => {
  for (const action of actions) {
    assert(
      (implementedActions as readonly string[]).includes(action),
      `${action} must be implemented`,
    );
  }
  const byAction = new Map(
    catalogActions.map((entry) => [entry.action, entry]),
  );
  assertEquals(byAction.get("profile.get")?.path, "/v1/me/profile");
  assertEquals(byAction.get("profile.update")?.method, "PATCH");
  assertEquals(
    byAction.get("profile.update")?.idempotency,
    "Idempotency-Key + If-Match required",
  );
  assertEquals(byAction.get("profile.update")?.access, "Authenticated");
  assertEquals(
    byAction.get("profile.update")?.organizationContext,
    "authenticated_principal_scope",
  );
  assertEquals(
    byAction.get("userPreferences.update")?.idempotency,
    "Idempotency-Key + expectedCasVersion required",
  );
  assertEquals(byAction.get("userPreferences.get")?.access, "Current member");
  assertEquals(byAction.get("installation.capabilities")?.access, "Public");
  assertEquals(
    byAction.get("installation.capabilities")?.path,
    "/v1/installation/capabilities",
  );
  for (const action of ["profile.update", "userPreferences.update"] as const) {
    assert(byAction.get(action)?.errors.includes("VERSION_CONFLICT"), action);
  }
});

Deno.test("settings schemas are fully described and shaped as designed", () => {
  for (
    const name of [
      "UserProfile",
      "UserProfileUpdate",
      "UserPreferences",
      "UserPreferencesUpdate",
      "InstallationCapabilities",
      "PrincipalIdentity",
      "Organization",
      "OrganizationUpdate",
    ]
  ) {
    assertDescribed(schemaOf(name), name);
  }
  const update = schemaOf("UserPreferencesUpdate");
  assert(update.required?.includes("expectedCasVersion"));
  assert(!update.required?.includes("theme"));
  assertEquals(update.properties.theme.enum, ["system", "light", "dark"]);
  assert(!("preferences" in update.properties));

  const preferences = schemaOf("UserPreferences");
  for (
    const field of [
      "effectiveLocale",
      "direction",
      "availableLocales",
      "casVersion",
      "theme",
      "timeZone",
      "locale",
    ]
  ) {
    assert(field in preferences.properties, field);
  }
  assertEquals(preferences.properties.availableLocales.type, "array");

  const availability = schemaOf("InstallationCapabilities");
  assertEquals(Object.keys(availability.properties).sort(), [
    "organizationCreation",
    "registration",
    "ssoAvailable",
  ]);

  const profile = schemaOf("UserProfile");
  for (
    const field of [
      "name",
      "firstName",
      "lastName",
      "title",
      "image",
      "emailVerified",
    ]
  ) {
    assert(field in profile.properties, field);
  }
  assert(profile.required?.includes("emailVerified"));
  assert(profile.required?.includes("version"));

  assert("timeZone" in schemaOf("PrincipalIdentity").properties);
  assert("defaultLocale" in schemaOf("Organization").properties);
  assert("defaultLocale" in schemaOf("OrganizationUpdate").properties);
  assert(!schemaOf("OrganizationUpdate").required?.includes("defaultLocale"));
});

Deno.test("OpenAPI declares the settings paths with the right verbs", () => {
  const openapi = generateContracts().openapi as {
    paths: Record<string, Record<string, unknown>>;
  };
  assert(openapi.paths["/v1/me/profile"]?.get);
  assert(openapi.paths["/v1/me/profile"]?.patch);
  assert(openapi.paths["/v1/user-preferences"]?.get);
  assert(openapi.paths["/v1/user-preferences"]?.patch);
  assert(openapi.paths["/v1/installation/capabilities"]?.get);
});

Deno.test("the auth router registers exactly the implemented auth actions and serves installation capabilities publicly", async () => {
  const app = createAuthV1Routes({
    auth: { api: { getSession: () => Promise.resolve(null) } },
    database: {} as never,
    store: {
      findSessionState: () => Promise.resolve(null),
      loadEnabledPrincipal: () => Promise.resolve(null),
    },
    publicBaseUrl: "http://test",
    secret: "a".repeat(32),
    installationSettings: {
      current: () =>
        Promise.resolve({
          registrationMode: "invitation",
          organizationCreationPolicy: "installation_admins",
          version: 1,
          updatedByPrincipalId: null,
          updatedAt: "2026-10-12T00:00:00.000Z",
        }),
    },
  });
  const response = await app.fetch(
    new Request("http://test/v1/installation/capabilities"),
  );
  assertEquals(response.status, 200);
  assertEquals(await response.json(), {
    registration: "invitation",
    organizationCreation: "installation_admins",
    ssoAvailable: false,
  });
  const profile = await app.fetch(new Request("http://test/v1/me/profile"));
  assertEquals(profile.status, 401);
});
