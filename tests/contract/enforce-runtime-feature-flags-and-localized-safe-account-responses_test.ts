import { assert, assertEquals } from "@std/assert";
import {
  generateContracts,
  toJsonSchema,
} from "../../packages/contracts/src/contracts.ts";
import { createAuthV1Routes } from "../../apps/server/src/modules/auth/transport/http/v1/routes.ts";

type JsonSchema = {
  properties: Record<string, JsonSchema>;
  required?: string[];
  enum?: string[];
  items?: JsonSchema;
  format?: string;
  description?: string;
};

Deno.test("unauthenticated /v1/me carries a localized Problem title and locale headers", async () => {
  const app = createAuthV1Routes({
    auth: { api: { getSession: () => Promise.resolve(null) } },
    database: {} as never,
    store: {
      findSessionState: () => Promise.resolve(null),
      loadEnabledPrincipal: () => Promise.resolve(null),
    },
    publicBaseUrl: "http://test",
    secret: "a".repeat(32),
  });

  const pseudoLocale = await app.fetch(
    new Request("http://test/v1/me", {
      headers: { "accept-language": "ar-XB" },
    }),
  );
  assertEquals(pseudoLocale.status, 401);
  assertEquals(pseudoLocale.headers.get("content-language"), "ar-XB");
  assert(pseudoLocale.headers.get("vary")?.includes("Accept-Language"));
  const pseudoBody = await pseudoLocale.json();
  assertEquals(pseudoBody.code, "AUTH_REQUIRED");
  assert((pseudoBody.title as string).startsWith("⟪"));

  const unsupported = await app.fetch(
    new Request("http://test/v1/me", {
      headers: { "accept-language": "fr" },
    }),
  );
  assertEquals(unsupported.status, 401);
  assertEquals(unsupported.headers.get("content-language"), "en");
});

Deno.test("PrincipalIdentity contract requires locale, direction, and catalogVersion", () => {
  const schemas = generateContracts().schemas;
  const json = toJsonSchema(schemas.PrincipalIdentity) as JsonSchema;
  assert(json.required?.includes("locale"));
  assert(json.required?.includes("direction"));
  assert(json.required?.includes("catalogVersion"));
  assertEquals(json.properties.direction.enum, ["ltr", "rtl"]);
});
