import {
  directionForLocale,
  resolveLocale,
  type SupportedLocale,
  type TextDirection,
} from "@bakery/i18n";

/** The language, direction and time zone the document is presented in. */
export type Presentation = Readonly<{
  locale: SupportedLocale;
  direction: TextDirection;
  /** IANA zone name used to format dates. */
  timeZone: string;
}>;

/** The fields of the server's identity and preferences that drive presentation. */
export type ServerPresentationSource = Readonly<{
  /** `identity.get`: effective locale with no organization context. */
  identity: Readonly<{
    locale: string;
    direction: TextDirection;
    timeZone: string | null;
  }>;
  /**
   * `userPreferences.get` once an organization is selected: its effective
   * locale also reflects the organization default.
   */
  preferences?:
    | Readonly<{
      effectiveLocale: string;
      direction: TextDirection;
      timeZone: string | null;
    }>
    | null;
}>;

/** The browser's own zone, used when no preference names one. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** True when `zone` is an IANA name this runtime can format with. */
export function isUsableTimeZone(zone: string | null | undefined): boolean {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The preference's zone when it is usable, otherwise the browser's. */
export function effectiveTimeZone(
  preferred: string | null | undefined,
  browser: string = browserTimeZone(),
): string {
  return isUsableTimeZone(preferred) ? preferred as string : browser;
}

/**
 * The language to render before the server has answered: a development
 * fixture override, then the cached server choice from the last visit, then
 * the browser's language list.
 */
export function initialLocale(input: {
  fixtureLocale: string | null;
  cachedLocale: string | null;
  browserLocales: readonly string[];
}): SupportedLocale {
  if (input.fixtureLocale === "en-XA" || input.fixtureLocale === "ar-XB") {
    return input.fixtureLocale;
  }
  if (input.cachedLocale) return resolveLocale([input.cachedLocale]);
  return resolveLocale(input.browserLocales);
}

/**
 * The server's choice wins over the cache and the browser. The preference
 * answer is preferred over the identity answer because it also reflects the
 * organization default. When the web app has no catalog for the server's
 * tag it falls back (to English) and so does the direction.
 */
export function serverPresentation(
  source: ServerPresentationSource,
  browser: string = browserTimeZone(),
): Presentation {
  const answer = source.preferences ?? source.identity;
  const tag = source.preferences?.effectiveLocale ?? source.identity.locale;
  const locale = resolveLocale([tag]);
  return {
    locale,
    direction: locale === tag ? answer.direction : directionForLocale(locale),
    timeZone: effectiveTimeZone(
      source.preferences?.timeZone ?? source.identity.timeZone,
      browser,
    ),
  };
}
