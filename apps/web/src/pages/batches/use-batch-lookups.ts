import { useQuery } from "@tanstack/react-query";
import { useBakeryApi } from "../../api/context.tsx";
import {
  effectiveAccessQueryOptions,
  organizationMembersQueryOptions,
  repositoriesAllQueryOptions,
  ticketSourcesAllQueryOptions,
} from "../../api/query.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { presetOfPolicy } from "../issue-sources.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import {
  formatBatchTime,
  formatDollars,
  splitDuration,
} from "./batch-display.ts";

/**
 * The names the batch pages need but a batch does not carry: its repository,
 * the people who started, paused or stopped it, and what this person may do.
 * Until the server names them on the batch itself (UX server item 4) the pages
 * read them from the lists the web already has.
 *
 * A repository is named from every page of the issue sources (which carry its
 * `owner/name`) and every page of the repository list, up to the bounds those
 * pages use, so an organization with more than a page of repositories can still
 * pick and see any of them.
 */
export function useBatchLookups() {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { locale, timeZone, translate } = useI18n();
  const repositories = useQuery(repositoriesAllQueryOptions(api, scope));
  const sources = useQuery(ticketSourcesAllQueryOptions(api, scope, true));
  const members = useQuery(organizationMembersQueryOptions(api, scope));
  const access = useQuery(effectiveAccessQueryOptions(api, scope));

  // The repository list is the authority on a name; a source's own copy fills in what it lacks.
  const names = new Map<string, string>();
  for (const source of sources.data ?? []) {
    if (source.repositoryId !== null && source.externalContainerId !== "") {
      names.set(source.repositoryId, source.externalContainerId);
    }
  }
  for (const item of repositories.data ?? []) {
    names.set(item.id, `${item.owner}/${item.name}`);
  }
  const byName = (
    a: { name: string },
    b: { name: string },
  ) => a.name.localeCompare(b.name);
  const takingIds = new Set<string>();
  for (const source of sources.data ?? []) {
    if (source.enabled && source.repositoryId !== null) {
      takingIds.add(source.repositoryId);
    }
  }

  const repositoryName = (id: string): string | null => names.get(id) ?? null;
  const presetOf = (id: string) =>
    presetOfPolicy(
      sources.data?.find((source) =>
        source.enabled && source.repositoryId === id
      )?.policy,
    );
  const personName = (principalId: string | null): string | null =>
    principalId === null
      ? null
      : members.data?.items.find((member) => member.principalId === principalId)
        ?.displayName ?? null;
  const capabilities = access.data?.capabilities ?? [];

  /** A time in the person's own zone, as the other pages show theirs. */
  const time = (iso: string): string => formatBatchTime(iso, locale, timeZone);
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
    /** Every repository an issue source or the repository list names, for the list's filter. */
    repositories: [...names].map(([id, name]) => ({ id, name })).sort(byName),
    /** The repositories that are taking issues, which a batch can run in. */
    takingIssues: [...names]
      .filter(([id]) => takingIds.has(id))
      .map(([id, name]) => ({ id, name }))
      .sort(byName),
    /** True once the issue sources have been read, so "none are taking issues" can be said. */
    sourcesReady: sources.isSuccess,
    repositoryName,
    presetOf,
    personName,
    canControl: capabilities.includes("batch:control"),
    canRead: capabilities.includes("batch:read"),
    accessReady: access.isSuccess,
    time,
    money,
    duration,
  };
}
