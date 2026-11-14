import { useI18n } from "../../i18n/I18nProvider.tsx";

/** Formats a profile creation time as the Paper date, e.g. "Oct 9, 2026". */
export function useProfileDate(): (value: string) => string {
  const { locale, timeZone } = useI18n();
  return (value) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone })
      .format(new Date(value));
}
