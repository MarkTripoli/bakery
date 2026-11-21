import { formatNumber, type SupportedLocale } from "@bakery/i18n";
import { sizeParts } from "./files/files-state.ts";

/**
 * A byte count in the wording the Files screens already use (#437).
 *
 * The Size row and the facts line sit next to each other, so they must not disagree:
 * "77 B" beside "Size 77 B" reads as one fact stated twice, while "0.1 KiB" beside
 * "Size 77 B" reads as two facts, one of them wrong. The unit keys are the catalog's
 * own (`files.size.bytes` and friends) and the number goes through the app's
 * formatter, at most one fraction digit, so a 1.8 KB file is "1.8 KB" both places.
 */
export function formatFileSize(
  bytes: number,
  locale: SupportedLocale,
  t: (
    key: string,
    values?: Readonly<Record<string, string | number>>,
  ) => string,
): string {
  const { value, unit } = sizeParts(bytes);
  return t(`files.size.${unit}`, {
    // Whole bytes have no fraction to show, and "77.0 B" would be a third way of
    // writing what the Size row writes as "77 B".
    value: formatNumber(value, locale, {
      maximumFractionDigits: unit === "bytes" ? 0 : 1,
    }),
  });
}
