import { useEffect, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import type { SkillResponse } from "../../api/client.ts";
import { useBakeryApi } from "../../api/context.tsx";
import { skillsQueryOptions } from "../../api/query.ts";
import {
  asyncKindForError,
  isForbiddenFailure,
} from "../../app/async-state.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { useShellViewport } from "../../app/responsive.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import {
  belongsToWords,
  changedWhen,
  emptyWords,
  filterWords,
  serverScope,
  SKILL_FILTERS,
  SKILL_SEARCH_MAX,
  skillBadges,
  type SkillFilter,
  skillFilter,
  skillSearch,
  versionInUseWords,
  type Words,
} from "./skills-state.ts";

/** How long typing rests before the search is sent. */
const SEARCH_REST_MS = 300;

/**
 * The Skills tab of the Library (design-ux #74, revision 3, slice 1): every
 * skill the reader can see, filtered by who it belongs to and found by name,
 * as a table whose row opens the skill's page. Read only: making, copying and
 * changing skills are later slices, so the tab has no button for them.
 */
export function SkillsTab() {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const navigate = useNavigate();
  const { translate, locale, timeZone } = useI18n();
  const phone = useShellViewport() === "phone";
  const search = useSearch({ strict: false }) as {
    scope?: string;
    q?: string;
  };
  const filter = skillFilter(search.scope);
  const q = skillSearch(search.q);
  const [text, setText] = useState(search.q ?? "");
  const skills = useInfiniteQuery(
    skillsQueryOptions(api, scope, { scope: serverScope(filter), q }),
  );

  const go = (next: { filter?: SkillFilter; q?: string | undefined }) => {
    const nextFilter = next.filter ?? filter;
    const nextQ = "q" in next ? next.q : q;
    void navigate({
      to: "/library",
      search: {
        tab: "skills",
        ...(nextFilter === "all" ? {} : { scope: nextFilter }),
        ...(nextQ === undefined ? {} : { q: nextQ }),
      },
      replace: true,
    });
  };

  // The URL follows the field once typing rests.
  useEffect(() => {
    const wanted = skillSearch(text);
    if (wanted === q) return;
    const timer = setTimeout(() => go({ q: wanted }), SEARCH_REST_MS);
    return () => clearTimeout(timer);
  });

  const words = (entry: Words) => translate(entry.key, entry.values);
  const now = new Date();
  const rows: SkillResponse[] =
    skills.data?.pages.flatMap((page) => page.items) ?? [];
  const open = (skill: SkillResponse) =>
    void navigate({
      to: "/library/skills/$skillId",
      params: { skillId: skill.id },
    });
  const badges = (skill: SkillResponse) => {
    const list = skillBadges(skill);
    return list.length === 0 ? null : (
      <UI.Inline gap="compact">
        {list.map((badge) => (
          <UI.Badge key={badge} tone="warning">
            {translate("library.skills.badge.turnedOff")}
          </UI.Badge>
        ))}
      </UI.Inline>
    );
  };
  const versionText = (skill: SkillResponse) =>
    words(versionInUseWords(skill).words);
  const changed = (skill: SkillResponse) =>
    changedWhen(skill.updatedAt, now, locale, timeZone);

  const filterLabel = translate("library.skills.filter.label");
  const filterControl = phone
    ? (
      <UI.Combobox
        appearance="filter"
        label={filterLabel}
        name="skills-filter"
        onChange={(event) => go({ filter: skillFilter(event.target.value) })}
        options={SKILL_FILTERS.map((value) => ({
          label: translate("library.skills.filter.show", {
            choice: words(filterWords(value)),
          }),
          value,
        }))}
        value={filter}
      />
    )
    : (
      <UI.SegmentedControl
        aria-label={filterLabel}
        name="skills-filter"
        onChange={(value) => go({ filter: skillFilter(value) })}
        options={SKILL_FILTERS.map((value) => ({
          label: words(filterWords(value)),
          value,
        }))}
        value={filter}
        variant="inline"
      />
    );
  const searchField = (
    <UI.SearchField
      aria-label={translate("library.skills.search")}
      maxLength={SKILL_SEARCH_MAX}
      onChange={(event) => setText(event.currentTarget.value)}
      placeholder={translate("library.skills.search")}
      size={28}
      value={text}
    />
  );
  // One row on a wide screen, as the design draws it: the filter at its own
  // width, the search about 280px at the end. Stacked on a phone.
  const toolbar = phone
    ? (
      <UI.Stack gap="standard">
        {filterControl}
        {searchField}
      </UI.Stack>
    )
    : (
      <UI.Inline gap="standard" variant="between">
        {filterControl}
        {searchField}
      </UI.Inline>
    );

  let body;
  if (skills.isError) {
    const forbidden = isForbiddenFailure(skills.error);
    const offline = !forbidden &&
      asyncKindForError(skills.error) === "offline";
    body = forbidden
      ? (
        <UI.EmptyState
          title={translate("library.forbidden.title")}
          description={translate("library.forbidden.description")}
          variant="firstUse"
        />
      )
      : (
        <UI.ErrorState
          title={translate(
            offline ? "library.offlineTitle" : "library.skills.error",
          )}
          description={translate(
            offline
              ? "library.offlineDescription"
              : "library.error.description",
          )}
          action={
            <UI.Button
              variant="secondary"
              onClick={() => void skills.refetch()}
            >
              {translate("library.retry")}
            </UI.Button>
          }
        />
      );
  } else if (skills.isPending) {
    body = (
      <UI.Stack gap="standard" aria-busy="true">
        <UI.Text variant="muted" role="status">
          {translate("library.skills.loading")}
        </UI.Text>
        <UI.Skeleton shape="row" />
        <UI.Skeleton shape="row" />
        <UI.Skeleton shape="row" />
      </UI.Stack>
    );
  } else if (rows.length === 0) {
    const empty = emptyWords(filter, q);
    body = (
      <UI.EmptyState
        title={words(empty.title)}
        description={empty.description === null
          ? undefined
          : words(empty.description)}
        action={q === undefined ? undefined : (
          <UI.Button
            variant="secondary"
            onClick={() => {
              setText("");
              go({ q: undefined });
            }}
          >
            {translate("library.skills.clearSearch")}
          </UI.Button>
        )}
        variant={q === undefined ? "firstUse" : "filtered"}
      />
    );
  } else if (phone) {
    body = (
      <UI.Stack
        aria-label={translate("library.skills.listLabel")}
        gap="none"
        role="list"
      >
        {rows.map((skill) => (
          <UI.ListRow
            badge={badges(skill) ?? undefined}
            controlLabel={translate("library.skills.openLabel", {
              name: skill.name,
            })}
            data-skill={skill.id}
            detail={translate("library.skills.rowLine", {
              belongsTo: words(belongsToWords(skill.scope)),
              version: versionText(skill),
              changed: changed(skill),
            })}
            key={skill.id}
            onSelect={() => open(skill)}
            role="listitem"
            title={skill.name}
          />
        ))}
      </UI.Stack>
    );
  } else {
    const columns: UI.DataTableColumn<SkillResponse>[] = [
      {
        id: "name",
        header: translate("library.skills.column.name"),
        // Plain text, as the other cells are, so all four share one text line;
        // with a badge the pair is centred on that line.
        cell: (skill) =>
          badges(skill) === null ? skill.name : (
            <UI.Inline gap="compact">
              {skill.name}
              {badges(skill)}
            </UI.Inline>
          ),
      },
      {
        id: "belongsTo",
        header: translate("library.skills.column.belongsTo"),
        width: "200px",
        cell: (skill) => words(belongsToWords(skill.scope)),
      },
      {
        id: "version",
        header: translate("library.skills.column.version"),
        width: "180px",
        cell: (skill) => {
          const version = versionInUseWords(skill);
          return version.muted
            ? <UI.Text variant="muted">{words(version.words)}</UI.Text>
            : words(version.words);
        },
      },
      {
        id: "changed",
        header: translate("library.skills.column.changed"),
        width: "160px",
        cell: (skill) => changed(skill),
      },
    ];
    body = (
      <UI.DataTable
        caption={translate("library.skills.listLabel")}
        captionHidden
        columns={columns}
        getRowAttributes={(skill) => ({ "data-skill": skill.id })}
        getRowKey={(skill) => skill.id}
        onSelectRow={open}
        rows={rows}
        variant="ruled"
      />
    );
  }

  return (
    <UI.Stack gap="spacious" data-testid="library-skills">
      {toolbar}
      {body}
      {skills.hasNextPage && !skills.isError
        ? (
          <UI.Button
            loading={skills.isFetchingNextPage}
            onClick={() => void skills.fetchNextPage()}
            type="button"
            variant="secondary"
          >
            {translate("library.skills.loadMore")}
          </UI.Button>
        )
        : null}
    </UI.Stack>
  );
}
