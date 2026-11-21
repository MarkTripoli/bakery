import { useQuery } from "@tanstack/react-query";
import { useBakeryApi } from "../../api/context.tsx";
import {
  effectiveAccessQueryOptions,
  organizationMembersQueryOptions,
  repositoriesListQueryOptions,
} from "../../api/query.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { formatDollars, splitDuration } from "./batch-display.ts";

/**
 * The names the batch pages need but a batch does not carry: its repository,
 * the people who started, paused or stopped it, and what this person may do.
 * Until the server names them on the batch itself (UX server item 4) the pages
 * read them from the repository and member lists.
 */
export function useBatchLookups() {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { locale, translate } = useI18n();
  const repositories = useQuery(
    repositoriesListQueryOptions(api, scope, { limit: 100 }),
  );
  const members = useQuery(organizationMembersQueryOptions(api, scope));
  const access = useQuery(effectiveAccessQueryOptions(api, scope));

  const repositoryName = (id: string): string | null => {
    const found = repositories.data?.items.find((item) => item.id === id);
    return found === undefined ? null : `${found.owner}/${found.name}`;
  };
  const personName = (principalId: string | null): string | null =>
    principalId === null
      ? null
      : members.data?.items.find((member) => member.principalId === principalId)
        ?.displayName ?? null;
  const capabilities = access.data?.capabilities ?? [];

  /** "Nov 20, 4:12 AM": the year is left out, a batch is hours or days old. */
  const time = (iso: string): string =>
    new Intl.DateTimeFormat(locale, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(iso));
  const money = (value: number): string => formatDollars(value, locale);
  /** "3 h 41 min", "8 h", "12 min": the unit words come from the catalogue. */
  const duration = (seconds: number): string => {
    const { hours, minutes } = splitDuration(seconds);
    if (hours === 0) {
      return translate("batches.duration.minutes" as never, { minutes });
    }
    return minutes === 0
      ? translate("batches.duration.hours" as never, { hours })
      : translate("batches.duration.hoursMinutes" as never, {
        hours,
        minutes,
      });
  };

  return {
    repositories: (repositories.data?.items ?? []).map((item) => ({
      id: item.id,
      name: `${item.owner}/${item.name}`,
    })),
    repositoryName,
    personName,
    canControl: capabilities.includes("batch:control"),
    canRead: capabilities.includes("batch:read"),
    accessReady: access.isSuccess,
    time,
    money,
    duration,
  };
}
