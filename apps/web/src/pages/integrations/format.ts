/** Formats an ISO time as a person reads it: date and time, in their zone. */
export function connectionTimeFormatter(
  locale: string,
  timeZone: string | undefined,
): (iso: string) => string {
  return (iso) =>
    new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone,
    }).format(new Date(iso));
}

/** The path of one connection's own page. */
export function connectionPath(connectionId: string): string {
  return `/settings/organization/integrations/${connectionId}`;
}
