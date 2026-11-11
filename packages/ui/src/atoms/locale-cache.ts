/** Browser cache of the server-resolved language, read before first paint. */
export const LOCALE_STORAGE_KEY = "bakery.locale.v1";

export type LocaleDirection = "ltr" | "rtl";
export type LocaleCache = Readonly<{ locale: string; dir: LocaleDirection }>;

const LANGUAGE_TAG = /^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/;
const MAX_TAG_LENGTH = 35;

/**
 * Parses a stored `{locale, dir}` value. Anything that is not a plausible
 * BCP 47 tag with a known direction is rejected, so a corrupted or hostile
 * cache can never put arbitrary text in the `lang` attribute.
 */
export function parseLocaleCache(
  raw: string | null | undefined,
): LocaleCache | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const { dir, locale } = value as { dir?: unknown; locale?: unknown };
    if (
      typeof locale !== "string" || locale.length > MAX_TAG_LENGTH ||
      !LANGUAGE_TAG.test(locale) || (dir !== "ltr" && dir !== "rtl")
    ) return null;
    return { locale, dir };
  } catch {
    return null;
  }
}

export function readStoredLocale(): LocaleCache | null {
  try {
    return parseLocaleCache(
      globalThis.localStorage?.getItem(LOCALE_STORAGE_KEY),
    );
  } catch {
    return null;
  }
}

export function persistLocale(cache: LocaleCache): void {
  try {
    globalThis.localStorage?.setItem(
      LOCALE_STORAGE_KEY,
      JSON.stringify({ locale: cache.locale, dir: cache.dir }),
    );
  } catch {
    // Storage is an optional browser capability.
  }
}

/** The one corner of the DOM this module writes; absent outside a browser. */
type DocumentHost = {
  document?: { documentElement?: { lang: string; dir: string } };
};

/** Sets `lang` and `dir` on the document element. */
export function applyLocaleToDocument(cache: LocaleCache): void {
  const root = (globalThis as DocumentHost).document?.documentElement;
  if (!root) return;
  root.lang = cache.locale;
  root.dir = cache.dir;
}
