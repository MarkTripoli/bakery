import { assert, assertEquals, assertThrows } from "@std/assert";
import { createNormalizedCommandMetadata } from "../../packages/contracts/src/http.ts";
import { availableLocalesFor } from "../../packages/config/src/env.ts";
import { requestLocale } from "../../apps/server/src/platform/locale.ts";
import {
  isAcceptableProfileImage,
  prepareProfileUpdate,
} from "../../apps/server/src/modules/auth/application/profile.ts";
import {
  isThemePreference,
  normalizeLocaleTag,
  normalizeTimeZone,
} from "../../apps/server/src/modules/auth/application/preferences.ts";
import { getIdentity } from "../../apps/server/src/modules/auth/application/identity.ts";
import { principalId } from "../../packages/contracts/src/contracts.ts";

function request(language?: string): Request {
  return new Request(
    "http://test/v1/me",
    language ? { headers: { "accept-language": language } } : undefined,
  );
}

Deno.test("locale resolution falls back preference, organization default, Accept-Language, English", () => {
  assertEquals(
    requestLocale(request("ar-XB"), { preferredLocale: "en-XA" }, "ar-XB"),
    "en-XA",
  );
  assertEquals(requestLocale(request("en-XA"), undefined, "ar-XB"), "ar-XB");
  assertEquals(requestLocale(request("en-XA"), {}, null), "en-XA");
  assertEquals(requestLocale(request("fr"), undefined, undefined), "en");
  assertEquals(requestLocale(request(), { preferredLocale: null }, "xx"), "en");
});

Deno.test("available locales are English only in production", () => {
  assertEquals(availableLocalesFor("production"), ["en"]);
  assertEquals(availableLocalesFor("test"), ["en", "en-XA", "ar-XB"]);
  assertEquals(availableLocalesFor("development"), ["en", "en-XA", "ar-XB"]);
});

Deno.test("locale tags and time zones normalize against what the server offers", () => {
  assertEquals(normalizeLocaleTag("EN-xa", ["en", "en-XA"]), "en-XA");
  assertEquals(normalizeLocaleTag("fr", ["en", "en-XA"]), undefined);
  assertEquals(normalizeTimeZone("europe/berlin"), "Europe/Berlin");
  assertEquals(normalizeTimeZone("UTC"), "UTC");
  assertEquals(normalizeTimeZone("Not/AZone"), undefined);
  assertEquals(normalizeTimeZone("../etc"), undefined);
  assertEquals(normalizeTimeZone(""), undefined);
  assert(isThemePreference("dark"));
  assert(!isThemePreference("sepia"));
});

Deno.test("profile update trims, clears blanks and omits untouched fields", () => {
  assertEquals(
    prepareProfileUpdate({
      name: "  Ada Lovelace ",
      firstName: "  ",
      lastName: null,
      title: " Engineer ",
    }),
    {
      name: "Ada Lovelace",
      firstName: null,
      lastName: null,
      title: "Engineer",
    },
  );
  assertEquals(prepareProfileUpdate({ title: "Lead" }), { title: "Lead" });
  assertEquals(prepareProfileUpdate({ image: null }), { image: null });
});

Deno.test("profile update rejects empty updates, blank names and overlong text", () => {
  assertThrows(() => prepareProfileUpdate({}));
  assertThrows(() => prepareProfileUpdate({ name: "   " }));
  assertThrows(() => prepareProfileUpdate({ name: "x".repeat(201) }));
  assertThrows(() => prepareProfileUpdate({ firstName: "x".repeat(101) }));
  assertThrows(() => prepareProfileUpdate({ title: "x".repeat(121) }));
  assertEquals(
    prepareProfileUpdate({ name: "😀".repeat(200) }).name?.length,
    400,
  );
});

Deno.test("profile image must be a bounded absolute HTTPS URL without credentials", () => {
  assert(isAcceptableProfileImage("https://cdn.example.test/a.png?x=1"));
  assert(!isAcceptableProfileImage("http://cdn.example.test/a.png"));
  assert(!isAcceptableProfileImage("data:image/png;base64,AAAA"));
  assert(!isAcceptableProfileImage("https://user:pw@cdn.example.test/a.png"));
  assert(!isAcceptableProfileImage("https://cdn.example.test/a b.png"));
  assert(!isAcceptableProfileImage(`https://example.test/${"a".repeat(2048)}`));
  assert(!isAcceptableProfileImage("/relative.png"));
  assertThrows(() => prepareProfileUpdate({ image: "javascript:alert(1)" }));
});

Deno.test("identity carries the effective time zone and defaults it to null", () => {
  const principal = {
    principalId: principalId(crypto.randomUUID()),
    principalType: "human" as const,
    displayName: "Ada",
    email: "ada@example.test",
  };
  assertEquals(getIdentity(principal, "en", null).timeZone, null);
  assertEquals(
    getIdentity(principal, "ar-XB", 3, "Europe/Berlin").timeZone,
    "Europe/Berlin",
  );
  assertEquals(getIdentity(principal, "ar-XB", null).direction, "rtl");
});

Deno.test("explicit idempotency requires a key and only some PATCH actions need If-Match", () => {
  const base = {
    name: "userPreferences.update" as const,
    method: "PATCH" as never,
    path: "/v1/user-preferences",
    input: {} as never,
  };
  const withKey = (headers: Record<string, string>) =>
    new Request("http://test/v1/user-preferences", {
      method: "PATCH",
      headers,
    });
  const keyOnly = { ...base, explicitIdempotency: "key" as const };
  assertEquals(
    createNormalizedCommandMetadata(
      keyOnly,
      withKey({ "idempotency-key": "k1" }),
      {},
    )
      .expectedVersion,
    undefined,
  );
  assertThrows(() => createNormalizedCommandMetadata(keyOnly, withKey({}), {}));
  const keyAndMatch = {
    ...base,
    explicitIdempotency: "key-and-if-match" as const,
  };
  assertThrows(() =>
    createNormalizedCommandMetadata(
      keyAndMatch,
      withKey({ "idempotency-key": "k1" }),
      {},
    )
  );
  assertEquals(
    createNormalizedCommandMetadata(
      keyAndMatch,
      withKey({ "idempotency-key": "k1", "if-match": '"v7"' }),
      {},
    ).expectedVersion,
    7,
  );
  assertThrows(() =>
    createNormalizedCommandMetadata(
      base,
      withKey({ "idempotency-key": "k1" }),
      {},
    )
  );
});
