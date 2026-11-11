export const supportedLocales = ["en", "en-XA", "ar-XB"] as const;
export type SupportedLocale = (typeof supportedLocales)[number];
export type TextDirection = "ltr" | "rtl";

const supportedByLowercase = new Map(
  supportedLocales.map((locale) => [locale.toLowerCase(), locale]),
);

export function resolveLocale(requested: readonly string[]): SupportedLocale {
  for (const value of requested) {
    let canonical: string;
    try {
      // Stored preferences may contain "_"; header parsing remains strict RFC 5646.
      canonical = Intl.getCanonicalLocales(value.replaceAll("_", "-"))[0] ?? "";
    } catch {
      continue;
    }
    const exact = supportedByLowercase.get(canonical.toLowerCase());
    if (exact) return exact;
    // Only English gets a family fallback; ar-XB is a pseudo-locale for RTL tests.
    if (canonical.toLowerCase().startsWith("en-")) return "en";
  }
  return "en";
}

export function directionForLocale(locale: SupportedLocale): TextDirection {
  return locale === "ar-XB" ? "rtl" : "ltr";
}

const LANGUAGE_TAG = /^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/;
const MAX_ACCEPT_LANGUAGE_ENTRIES = 16;
const MAX_TAG_LENGTH = 35;

export function parseAcceptLanguage(
  header: string | null | undefined,
): string[] {
  if (!header || !header.trim()) return [];
  const entries = header.split(",").slice(0, MAX_ACCEPT_LANGUAGE_ENTRIES);
  const weighted: { tag: string; q: number; index: number }[] = [];
  entries.forEach((entry, index) => {
    const [rawTag, ...params] = entry.split(";").map((part) => part.trim());
    if (!rawTag || rawTag === "*") return;
    if (!LANGUAGE_TAG.test(rawTag) || rawTag.length > MAX_TAG_LENGTH) return;
    let q = 1;
    for (const param of params) {
      const [key, value] = param.split("=").map((part) => part.trim());
      if (key?.toLowerCase() !== "q") continue;
      q = Number(value);
    }
    if (!Number.isFinite(q) || q <= 0 || q > 1) return;
    weighted.push({ tag: rawTag, q, index });
  });
  return weighted
    .sort((a, b) => b.q - a.q || a.index - b.index)
    .map((entry) => entry.tag);
}

export function resolvePreferredLocale(input: {
  explicit?: string | null;
  preferred?: string | null;
  organizationDefault?: string | null;
  acceptLanguage?: string | null;
}): SupportedLocale {
  return resolveLocale(
    [
      input.explicit,
      input.preferred,
      input.organizationDefault,
      ...parseAcceptLanguage(input.acceptLanguage),
    ].filter((value): value is string =>
      typeof value === "string" && value.length > 0
    ),
  );
}
