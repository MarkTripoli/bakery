import { assert, assertEquals, assertMatch, assertThrows } from "@std/assert";
import {
  catalogs,
  catalogVersion,
  createTranslator,
  directionForLocale,
  formatDate,
  formatList,
  formatNumber,
  type MessageKey,
  messageKeys,
  resolveLocale,
} from "../../packages/i18n/src/index.ts";
import {
  fillMissingRows,
  minimumPseudoLength,
  pseudoAccented,
  pseudoBidi,
} from "../../packages/i18n/scripts/pseudo.ts";
import { validateCatalogSources } from "../../packages/i18n/scripts/validate-catalogs.ts";

Deno.test("locale negotiation normalizes supported locales and falls back", () => {
  assertEquals(resolveLocale(["fr-CA", "en-GB"]), "en");
  assertEquals(resolveLocale(["en_xa"]), "en-XA");
  assertEquals(resolveLocale(["ar-xb"]), "ar-XB");
  assertEquals(resolveLocale(["not a locale"]), "en");
  assertEquals(directionForLocale("en"), "ltr");
  assertEquals(directionForLocale("ar-XB"), "rtl");
});

Deno.test("translator formats ICU plural and select arguments", () => {
  const translate = createTranslator({ locale: "en", surface: "unit" });
  assertEquals(translate("core.actions.items", { count: 0 }), "No items");
  assertEquals(translate("core.actions.items", { count: 1 }), "1 item");
  assertEquals(translate("core.actions.items", { count: 3 }), "3 items");
  assertEquals(
    translate("core.actions.mode", { mode: "automatic" }),
    "Automatic",
  );
});

Deno.test("pseudo catalogs expand copy, preserve arguments, and expose RTL", () => {
  const english = createTranslator({ locale: "en" })("shell.health.version", {
    version: "1.2.3",
  });
  const accented = createTranslator({ locale: "en-XA" })(
    "shell.health.version",
    { version: "1.2.3" },
  );
  const bidi = createTranslator({ locale: "ar-XB" })(
    "problems.UNKNOWN.requestId",
    { requestId: "request-7" },
  );
  assert(accented.length > english.length);
  assertMatch(accented, /^⟦/);
  assert(accented.includes("1.2.3"));
  assertMatch(bidi, /^⟪/);
  assert(bidi.includes("request-7"));
});

Deno.test("Intl helpers format number, date, and list deterministically", () => {
  assertEquals(formatNumber(1234.5, "en"), "1,234.5");
  assertEquals(
    formatDate(new Date("2020-01-02T03:04:05Z"), "en", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }),
    "01/02/2020",
  );
  assertEquals(
    formatList(["one", "two", "three"], "en"),
    "one, two, and three",
  );
});

Deno.test("catalogs retain key and ICU argument parity", () => {
  const expected = [...messageKeys].sort();
  for (const catalog of Object.values(catalogs)) {
    assertEquals(Object.keys(catalog).sort(), expected);
  }
});

Deno.test("missing-key fallback telemetry never contains message arguments", () => {
  const pseudo = catalogs["en-XA"] as Record<string, string>;
  const key = "shell.health.version";
  const retained = pseudo[key];
  delete pseudo[key];
  try {
    const events: unknown[] = [];
    const translate = createTranslator({
      locale: "en-XA",
      surface: "health",
      onMissing: (event) => events.push(event),
    });
    assertEquals(
      translate(key, { version: "secret-value" }),
      "Version secret-value",
    );
    assertEquals(events, [{
      key,
      requestedLocale: "en-XA",
      catalogVersion,
      surface: "health",
    }]);
  } finally {
    pseudo[key] = retained;
  }
});

Deno.test("unknown keys fail closed after redacted telemetry", () => {
  const events: unknown[] = [];
  const translate = createTranslator({
    locale: "en",
    surface: "unknown-key-test",
    onMissing: (event) => events.push(event),
  });
  assertThrows(
    () => translate("outside.namespace" as MessageKey, { value: "secret" }),
    Error,
    "UNKNOWN_MESSAGE_KEY",
  );
  assertEquals(events, [{
    key: "outside.namespace",
    requestedLocale: "en",
    catalogVersion,
    surface: "unknown-key-test",
  }]);
});

Deno.test("catalog validation rejects drift, escapes, duplicates, and rich tags", () => {
  const errors = validateCatalogSources({
    en:
      '{"core.actions.open":"Open {name}","core.actions.open":"Again {name}","outside.key":"<b>unsafe</b>"}',
    "en-XA": '{"core.actions.open":"Open {other}","outside.key":"safe"}',
  });
  assert(
    errors.some((error) => error.includes("duplicate key core.actions.open")),
  );
  assert(
    errors.some((error) => error.includes("namespace escape outside.key")),
  );
  assert(errors.some((error) => error.includes("unsafe rich tag")));
  assert(errors.some((error) => error.includes("ICU argument drift")));
});

Deno.test("pseudo generator expands en-XA by 35% and keeps ICU arguments", () => {
  for (
    const source of [
      "Save",
      "Profile",
      "{count, plural, one {# passkey} other {# passkeys}}",
      "Signed in as {name}",
    ]
  ) {
    const accented = pseudoAccented(source);
    assertMatch(accented, /^⟦.*⟧$/u);
    assert(accented.length >= minimumPseudoLength(source.length));
    assertEquals(pseudoAccented(source), accented);
    assertEquals(
      validateCatalogSources({
        en: JSON.stringify({ "settings.x": source }),
        "en-XA": JSON.stringify({ "settings.x": accented }),
      }),
      [],
    );
  }
  assert(pseudoAccented("Signed in as {name}").includes("{name}"));
  assertEquals(pseudoBidi("Save"), "⟪Save⟫");
});

Deno.test("pseudo generator fills only missing rows", () => {
  const filled = fillMissingRows(
    { "settings.a": "Alpha", "settings.b": "Beta" },
    { "settings.a": "kept as is" },
    pseudoBidi,
  );
  assertEquals(filled, { "settings.a": "kept as is", "settings.b": "⟪Beta⟫" });
});

Deno.test("new namespaces must carry generated pseudo rows", () => {
  const sources = (xa: string, xb: string) => ({
    en: JSON.stringify({ "settings.title": "Appearance" }),
    "en-XA": JSON.stringify({ "settings.title": xa }),
    "ar-XB": JSON.stringify({ "settings.title": xb }),
  });
  assertEquals(
    validateCatalogSources(
      sources(pseudoAccented("Appearance"), pseudoBidi("Appearance")),
    ),
    [],
  );
  const errors = validateCatalogSources(sources("⟦Appearance⟧", "Appearance"));
  assert(errors.some((error) => error.includes("35% longer")));
  assert(errors.some((error) => error.includes("wrapped in")));
});
