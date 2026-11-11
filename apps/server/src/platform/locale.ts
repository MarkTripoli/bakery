import { resolvePreferredLocale, type SupportedLocale } from "@bakery/i18n";

export type LocalePreferenceHolder = {
  preferredLocale?: string | null;
};

export function requestLocale(
  request: Request | undefined,
  principal?: LocalePreferenceHolder,
  organizationDefault?: string | null,
): SupportedLocale {
  return resolvePreferredLocale({
    preferred: principal?.preferredLocale,
    organizationDefault,
    acceptLanguage: request?.headers.get("accept-language"),
  });
}
