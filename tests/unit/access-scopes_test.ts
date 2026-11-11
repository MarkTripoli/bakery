import { assert, assertEquals } from "@std/assert";
import {
  minimalScopes,
  minimalScopesFor,
  scopeAllows,
} from "../../apps/server/src/modules/auth/application/scopes.ts";

Deno.test("read scope covers only :read keys", () => {
  assert(scopeAllows("task:read", ["bakery:read"]));
  assert(!scopeAllows("task:write", ["bakery:read"]));
  assert(!scopeAllows("accessToken:manage", ["bakery:read"]));
});

Deno.test("operate covers writes but never manage keys", () => {
  assert(scopeAllows("task:read", ["bakery:operate"]));
  assert(scopeAllows("run:control", ["bakery:operate"]));
  assert(!scopeAllows("principal:manage", ["bakery:operate"]));
});

Deno.test("admin covers everything and unknown scopes cover nothing", () => {
  assert(scopeAllows("principal:manage", ["bakery:admin"]));
  assert(!scopeAllows("task:read", ["bakery:unknown", ""]));
  assert(!scopeAllows("task:read", []));
});

Deno.test("minimal bundles are the narrowest covering scope", () => {
  assertEquals(minimalScopes("task:read"), ["bakery:read"]);
  assertEquals(minimalScopes("task:write"), ["bakery:operate"]);
  assertEquals(minimalScopes("secret:manage"), ["bakery:admin"]);
  assertEquals(
    minimalScopesFor(["task:read", "task:write"]),
    ["bakery:operate"],
  );
  assertEquals(minimalScopesFor([]), []);
});

import {
  bearerAccessTokenSecret,
  generateAccessTokenSecret,
  normalizeTokenScopes,
  sha256Hex,
  tokenExpiryAllowed,
} from "../../apps/server/src/modules/auth/application/access-tokens.ts";

Deno.test("generated secrets are bearer-parsable and stored only as a digest", async () => {
  const minted = await generateAccessTokenSecret();
  assertEquals(
    bearerAccessTokenSecret(`Bearer ${minted.secret}`),
    minted.secret,
  );
  assertEquals(minted.digest, await sha256Hex(minted.secret));
  assert(minted.secret.startsWith(minted.prefix));
  assert(minted.prefix.length < minted.secret.length);
  assertEquals(bearerAccessTokenSecret("Bearer eyJhbGciOi.x.y"), null);
  assertEquals(bearerAccessTokenSecret(null), null);
});

Deno.test("token scopes normalize and reject unknown or empty sets", () => {
  assertEquals(
    normalizeTokenScopes(["bakery:operate", "bakery:read", "bakery:read"]),
    ["bakery:read", "bakery:operate"],
  );
  assertEquals(normalizeTokenScopes([]), null);
  assertEquals(normalizeTokenScopes(["bakery:read", "admin"]), null);
});

Deno.test("token expiry must be future and within a year", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  assert(tokenExpiryAllowed(new Date("2026-06-01T00:00:00Z"), now));
  assert(!tokenExpiryAllowed(new Date("2025-12-31T00:00:00Z"), now));
  assert(!tokenExpiryAllowed(new Date("2028-01-01T00:00:00Z"), now));
});
