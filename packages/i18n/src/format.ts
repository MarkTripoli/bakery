import IntlMessageFormat, { type PrimitiveType } from "intl-messageformat";
import { catalogs, catalogVersion, englishCatalog } from "./catalog.ts";
import type { MessageKey } from "./keys.ts";
import type { SupportedLocale } from "./locale.ts";

export type MessageArguments = Readonly<Record<string, PrimitiveType>>;
export type MissingMessageEvent = Readonly<{
  key: string;
  requestedLocale: SupportedLocale;
  catalogVersion: string;
  surface: string;
}>;
export type MissingMessageHandler = (event: MissingMessageEvent) => void;
export type Translator = (
  key: MessageKey,
  arguments_?: MessageArguments,
) => string;

export function createTranslator({
  locale,
  onMissing,
  surface = "unknown",
}: {
  locale: SupportedLocale;
  onMissing?: MissingMessageHandler;
  surface?: string;
}): Translator {
  return (key, arguments_ = {}) => {
    const localized = catalogs[locale][key];
    const source = localized ?? englishCatalog[key];
    if (localized === undefined && locale !== "en") {
      onMissing?.({
        key,
        requestedLocale: locale,
        catalogVersion,
        surface,
      });
    }
    if (typeof source !== "string") {
      onMissing?.({
        key,
        requestedLocale: locale,
        catalogVersion,
        surface,
      });
      throw new Error(`UNKNOWN_MESSAGE_KEY:${String(key)}`);
    }
    const formatted = new IntlMessageFormat(source, locale).format(arguments_);
    return Array.isArray(formatted) ? formatted.join("") : String(formatted);
  };
}

export function formatNumber(
  value: number | bigint,
  locale: SupportedLocale,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(locale, options).format(value);
}

export function formatDate(
  value: Date | number,
  locale: SupportedLocale,
  options: Intl.DateTimeFormatOptions & { readonly timeZone: string },
): string {
  return new Intl.DateTimeFormat(locale, options).format(value);
}

export function formatList(
  values: readonly string[],
  locale: SupportedLocale,
  options?: Intl.ListFormatOptions,
): string {
  return new Intl.ListFormat(locale, options).format(values);
}
