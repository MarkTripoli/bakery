import { assertEquals } from "@std/assert";
import {
  effectiveTimeZone,
  initialLocale,
  serverPresentation,
} from "../../apps/web/src/i18n/presentation.ts";
import {
  applyLocaleToDocument,
  LOCALE_STORAGE_KEY,
  parseLocaleCache,
} from "../../packages/ui/src/atoms/locale-cache.ts";

Deno.test("initial locale prefers a fixture override, then the cache, then the browser", () => {
  const browserLocales = ["en-GB"];
  assertEquals(
    initialLocale({
      fixtureLocale: "ar-XB",
      cachedLocale: "en",
      browserLocales,
    }),
    "ar-XB",
  );
  assertEquals(
    initialLocale({
      fixtureLocale: null,
      cachedLocale: "en-XA",
      browserLocales,
    }),
    "en-XA",
  );
  assertEquals(
    initialLocale({ fixtureLocale: null, cachedLocale: null, browserLocales }),
    "en",
  );
  // A fixture override only accepts the development pseudo-locales.
  assertEquals(
    initialLocale({ fixtureLocale: "fr", cachedLocale: null, browserLocales }),
    "en",
  );
});

Deno.test("the server locale wins and the preference answer outranks identity", () => {
  const identity = { locale: "en", direction: "ltr" as const, timeZone: null };
  assertEquals(serverPresentation({ identity }, "Europe/London"), {
    locale: "en",
    direction: "ltr",
    timeZone: "Europe/London",
  });
  assertEquals(
    serverPresentation({
      identity,
      preferences: {
        effectiveLocale: "ar-XB",
        direction: "rtl",
        timeZone: "Asia/Tokyo",
      },
    }, "Europe/London"),
    { locale: "ar-XB", direction: "rtl", timeZone: "Asia/Tokyo" },
  );
});

Deno.test("an unsupported server locale falls back to English with its direction", () => {
  const presentation = serverPresentation({
    identity: { locale: "fr", direction: "rtl", timeZone: null },
  }, "UTC");
  assertEquals(presentation.locale, "en");
  assertEquals(presentation.direction, "ltr");
});

Deno.test("time zone comes from the preference and falls back to the browser", () => {
  assertEquals(
    effectiveTimeZone("America/New_York", "UTC"),
    "America/New_York",
  );
  assertEquals(effectiveTimeZone(null, "Europe/Paris"), "Europe/Paris");
  assertEquals(effectiveTimeZone("Not/AZone", "Europe/Paris"), "Europe/Paris");
});

Deno.test("the locale cache accepts only a plausible tag with a known direction", () => {
  assertEquals(
    parseLocaleCache('{"locale":"ar-XB","dir":"rtl"}'),
    { locale: "ar-XB", dir: "rtl" },
  );
  assertEquals(parseLocaleCache(null), null);
  assertEquals(parseLocaleCache("not json"), null);
  assertEquals(parseLocaleCache('{"locale":"en","dir":"sideways"}'), null);
  assertEquals(parseLocaleCache('{"locale":"<script>","dir":"ltr"}'), null);
  assertEquals(
    parseLocaleCache(`{"locale":"${"a".repeat(36)}","dir":"ltr"}`),
    null,
  );
});

type FakeRoot = {
  lang: string;
  dir: string;
  dataset: Record<string, string>;
  style: Record<string, string>;
};

function fakeGlobal(stored: Record<string, string>) {
  const root: FakeRoot = { lang: "en", dir: "ltr", dataset: {}, style: {} };
  return {
    root,
    scope: {
      document: { documentElement: root },
      localStorage: { getItem: (key: string) => stored[key] ?? null },
      matchMedia: () => ({ matches: false }),
    },
  };
}

Deno.test("applyLocaleToDocument sets lang and dir", () => {
  const { root, scope } = fakeGlobal({});
  const saved = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    value: scope.document,
    configurable: true,
  });
  try {
    applyLocaleToDocument({ locale: "ar-XB", dir: "rtl" });
  } finally {
    if (saved) Object.defineProperty(globalThis, "document", saved);
    else Reflect.deleteProperty(globalThis, "document");
  }
  assertEquals([root.lang, root.dir], ["ar-XB", "rtl"]);
});

async function runBootstrap(stored: Record<string, string>): Promise<FakeRoot> {
  const source = await Deno.readTextFile(
    new URL("../../apps/web/public/theme-bootstrap.js", import.meta.url),
  );
  const { root, scope } = fakeGlobal(stored);
  new Function("globalThis", source)(scope);
  return root;
}

Deno.test("the committed bootstrap sets theme, lang and dir from the caches", async () => {
  const root = await runBootstrap({
    "bakery.theme.v1": "dark",
    [LOCALE_STORAGE_KEY]: '{"locale":"ar-XB","dir":"rtl"}',
  });
  assertEquals(root.dataset.theme, "dark");
  assertEquals(root.style.colorScheme, "dark");
  assertEquals([root.lang, root.dir], ["ar-XB", "rtl"]);
});

Deno.test("the committed bootstrap leaves lang and dir alone without a valid cache", async () => {
  const empty = await runBootstrap({});
  assertEquals([empty.lang, empty.dir], ["en", "ltr"]);
  const invalid = await runBootstrap({
    [LOCALE_STORAGE_KEY]: '{"locale":"en","dir":"up"}',
  });
  assertEquals([invalid.lang, invalid.dir], ["en", "ltr"]);
});
