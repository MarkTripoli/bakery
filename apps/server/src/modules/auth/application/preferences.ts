/**
 * Pure rules for the member's private presentation preferences: the closed
 * theme set, the stored document version, and normalization of the language
 * tag and IANA time zone a client may submit.
 */
export const PREFERENCES_SCHEMA_VERSION = 1;

export const themePreferences = ["system", "light", "dark"] as const;
export type ThemePreference = (typeof themePreferences)[number];

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === "string" &&
    (themePreferences as readonly string[]).includes(value);
}

/**
 * The offered locale that equals `value` ignoring case, or undefined when the
 * server does not offer it. Never returns a tag the server does not list.
 */
export function normalizeLocaleTag(
  value: string,
  availableLocales: readonly string[],
): string | undefined {
  const lowered = value.trim().toLowerCase();
  return availableLocales.find((locale) => locale.toLowerCase() === lowered);
}

/** Canonical IANA zone name, or undefined when the runtime does not know it. */
export function normalizeTimeZone(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return undefined;
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(trimmed)) return undefined;
  try {
    return new Intl.DateTimeFormat("en", { timeZone: trimmed })
      .resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}
