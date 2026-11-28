import { type ReactNode, useEffect, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import type {
  SkillResponse,
  SkillUsage,
  SkillVersionResponse,
} from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import {
  skillQueryOptions,
  skillSourceQueryOptions,
  skillUsedByQueryOptions,
  skillUseGrantsQueryOptions,
  skillVersionsQueryOptions,
} from "../api/query.ts";
import {
  asyncKindForError,
  failureStatus,
  isForbiddenFailure,
} from "../app/async-state.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useRestoreOrganizationScope } from "../app/restore-organization.ts";
import { useShellViewport } from "../app/responsive.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { WORK_HOME } from "../shell/breadcrumb-paths.ts";
import { ShellSlot } from "../shell/shell-slots.tsx";
import { SkillToast, useSkillActions } from "./library/SkillActions.tsx";
import { SkillFileView } from "./library/SkillFileView.tsx";
import { SkillGrantRow } from "./library/SkillGrantRow.tsx";
import { SkillSourceCheckControl } from "./library/SkillSourceCheckControl.tsx";
import { SkillUseVersion } from "./library/SkillUseVersion.tsx";
import { useCanChangeSkill } from "./library/useCanChangeSkill.ts";
import { useOrganizationName } from "./library/useOrganizationName.ts";
import {
  copiedWords,
  fileSize,
  fingerprint,
  licenseShownInFiles,
  manifestFiles,
  pinnedRevisions,
  scopeWords,
  skillOrigin,
  sourceKindWords,
  usedByGroups,
  versionStatusWords,
  type Words,
} from "./library/skills-state.ts";

/** A card's own small failure: what did not load, and Try again. */
function CardError(
  { message, onRetry }: {
    readonly message: string;
    readonly onRetry: () => void;
  },
) {
  const { translate } = useI18n();
  return (
    <UI.InlineNotice
      tone="error"
      action={
        <UI.Button variant="secondary" onClick={onRetry}>
          {translate("library.retry")}
        </UI.Button>
      }
    >
      {message}
    </UI.InlineNotice>
  );
}

function Explained(
  { text, label, help }: {
    readonly text: string;
    readonly label: string;
    readonly help: string;
  },
) {
  return (
    <UI.Inline gap="compact">
      <UI.Text variant="muted">{text}</UI.Text>
      <UI.HelpTip label={label}>{help}</UI.HelpTip>
    </UI.Inline>
  );
}

/** One card of the skill page. */
function Card(
  { id, title, children }: {
    readonly id: string;
    readonly title: string;
    readonly children: ReactNode;
  },
) {
  return (
    <UI.SettingsSection data-testid={id} title={title} variant="stack">
      {children}
    </UI.SettingsSection>
  );
}

/**
 * The skill's versions, read a page at a time. The Files card needs the one in
 * use, so pages are read on until it is found.
 */
function useVersions(skill: SkillResponse) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const versions = useInfiniteQuery(
    skillVersionsQueryOptions(api, scope, skill.id),
  );
  const items: SkillVersionResponse[] =
    versions.data?.pages.flatMap((page) => page.items) ?? [];
  const active = skill.activeVersionId === null
    ? null
    : items.find((version) => version.id === skill.activeVersionId) ?? null;
  const looking = skill.activeVersionId !== null && active === null &&
    versions.hasNextPage && !versions.isFetchingNextPage;
  useEffect(() => {
    if (looking) void versions.fetchNextPage();
  }, [looking, versions]);
  return { versions, items, active };
}

function FilesCard(
  { skill, state }: {
    readonly skill: SkillResponse;
    readonly state: ReturnType<typeof useVersions>;
  },
) {
  const { translate, locale } = useI18n();
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { versions, active } = state;
  const title = translate("library.skill.files.title");
  // Where it came from says the source's licence, so this card says the skill's
  // own only when it has something that card does not (see licenseShownInFiles).
  const origin = skillOrigin(skill);
  const source = useQuery({
    ...skillSourceQueryOptions(
      api,
      scope,
      origin.kind === "source" ? origin.sourceId : "",
    ),
    enabled: origin.kind === "source",
  });
  const [opened, setOpened] = useState<string | null>(null);
  if (skill.activeVersionId === null) {
    return (
      <Card id="skill-files" title={title}>
        <UI.Text variant="muted">
          {translate("library.skill.files.none")}
        </UI.Text>
      </Card>
    );
  }
  if (versions.isError) {
    return (
      <Card id="skill-files" title={title}>
        <CardError
          message={translate("library.skill.files.error")}
          onRetry={() => void versions.refetch()}
        />
      </Card>
    );
  }
  if (active === null) {
    return (
      <Card id="skill-files" title={title}>
        {versions.isPending || versions.hasNextPage
          ? <UI.Skeleton shape="row" />
          : (
            <UI.Text variant="muted">
              {translate("library.skill.files.missing")}
            </UI.Text>
          )}
      </Card>
    );
  }
  const files = manifestFiles(active);
  const line = (file: { mediaType: string; sizeBytes: number }) =>
    file.mediaType === ""
      ? fileSize(file.sizeBytes, locale)
      : translate("library.skill.files.line", {
        size: fileSize(file.sizeBytes, locale),
        type: file.mediaType,
      });
  return (
    <Card id="skill-files" title={title}>
      <UI.Text variant="muted">
        {translate("library.skill.files.of", {
          number: active.revision,
        })}
      </UI.Text>
      <UI.Text variant="muted">
        {translate("library.skill.files.versionsKept")}
      </UI.Text>
      <UI.DescriptionList>
        <UI.DescriptionItem
          title={translate("library.skill.files.instructions")}
          description={files.entry === null
            ? active.entryPath
            : (
              <UI.Stack gap="compact">
                <UI.Stack gap="none">
                  <UI.DataText>{files.entry.path}</UI.DataText>
                  <UI.Text variant="caption">{line(files.entry)}</UI.Text>
                </UI.Stack>
                <SkillFileView versionId={active.id} file={files.entry} />
              </UI.Stack>
            )}
        />
        {files.others.length === 0 ? null : (
          <UI.DescriptionItem
            title={translate("library.skill.files.others")}
            description={
              <UI.Stack
                aria-label={translate("library.skill.files.others")}
                gap="compact"
                role="list"
              >
                {files.others.map((file) => (
                  <div key={file.path} role="listitem">
                    <UI.Stack gap="compact">
                      <UI.Stack gap="none">
                        <UI.Inline gap="compact">
                          <UI.Button
                            variant="text"
                            aria-expanded={opened === file.path}
                            onClick={() =>
                              setOpened(
                                opened === file.path ? null : file.path,
                              )}
                          >
                            {file.path}
                          </UI.Button>
                        </UI.Inline>
                        <UI.Text variant="caption">{line(file)}</UI.Text>
                      </UI.Stack>
                      {opened === file.path
                        ? <SkillFileView versionId={active.id} file={file} />
                        : null}
                    </UI.Stack>
                  </div>
                ))}
              </UI.Stack>
            }
          />
        )}
        {!licenseShownInFiles(
            files.license,
            origin.kind !== "source"
              ? "none"
              : source.isError
              ? "failed"
              : source.data === undefined
              ? "loading"
              : { license: source.data.license },
          )
          ? null
          : (
            <UI.DescriptionItem
              title={translate("library.skill.files.license")}
              description={files.license}
            />
          )}
      </UI.DescriptionList>
    </Card>
  );
}

function VersionsCard(
  { skill, state }: {
    readonly skill: SkillResponse;
    readonly state: ReturnType<typeof useVersions>;
  },
) {
  const { translate, locale, timeZone } = useI18n();
  const canChange = useCanChangeSkill(skill) === true;
  const { versions, items } = state;
  const when = (iso: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone }).format(
      new Date(iso),
    );
  const words = (entry: Words) => translate(entry.key, entry.values);
  const ordered = [...items].sort((a, b) => b.revision - a.revision);
  return (
    <Card
      id="skill-versions"
      title={translate("library.skill.versions.title")}
    >
      <Explained
        text={translate("library.skill.versions.fingerprintLine")}
        label={translate("library.skill.versions.fingerprintHelpLabel")}
        help={translate("library.skill.versions.fingerprintHelp")}
      />
      {versions.isError
        ? (
          <CardError
            message={translate("library.skill.versions.error")}
            onRetry={() => void versions.refetch()}
          />
        )
        : versions.isPending
        ? <UI.Skeleton shape="row" />
        : ordered.length === 0
        ? (
          <UI.Text variant="muted">
            {translate("library.skill.versions.empty")}
          </UI.Text>
        )
        : (
          <UI.Stack
            aria-label={translate("library.skill.versions.title")}
            gap="compact"
            role="list"
          >
            {ordered.map((version) => (
              <div
                data-version={version.id}
                key={version.id}
                role="listitem"
                tabIndex={-1}
              >
                <UI.Stack gap="compact">
                  <UI.Stack gap="none">
                    <UI.Inline gap="compact">
                      <UI.Text>
                        {version.label === null
                          ? translate("library.skills.version", {
                            number: version.revision,
                          })
                          : translate("library.skill.versions.labelled", {
                            number: version.revision,
                            label: version.label,
                          })}
                      </UI.Text>
                      {version.id === skill.activeVersionId
                        ? (
                          <UI.Badge tone="success">
                            {translate("library.skill.versions.inUse")}
                          </UI.Badge>
                        )
                        : null}
                    </UI.Inline>
                    <UI.Text variant="caption">
                      {translate("library.skill.versions.meta", {
                        status: words(versionStatusWords(version.status)),
                        date: when(version.publishedAt ?? version.createdAt),
                        fingerprint: fingerprint(version.digest),
                      })}
                    </UI.Text>
                  </UI.Stack>
                  {canChange && version.status === "published" &&
                      version.id !== skill.activeVersionId
                    ? <SkillUseVersion skill={skill} version={version} />
                    : null}
                </UI.Stack>
              </div>
            ))}
          </UI.Stack>
        )}
      {versions.hasNextPage && !versions.isError
        ? (
          <UI.Button
            loading={versions.isFetchingNextPage}
            onClick={() => void versions.fetchNextPage()}
            variant="secondary"
          >
            {translate("library.skill.more")}
          </UI.Button>
        )
        : null}
    </Card>
  );
}

function UsedByCard(
  { skill, versions }: {
    readonly skill: SkillResponse;
    readonly versions: readonly SkillVersionResponse[];
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { translate, locale } = useI18n();
  const usedBy = useInfiniteQuery(
    skillUsedByQueryOptions(api, scope, skill.id),
  );
  const groups = usedByGroups(
    usedBy.data?.pages.flatMap((page) => page.items) ?? [],
  );
  const group = (label: string, rows: SkillUsage[]) =>
    rows.length === 0 ? null : (
      <UI.DescriptionItem
        title={label}
        description={
          <UI.Stack aria-label={label} gap="none" role="list">
            {rows.map((row) => (
              <div key={row.versionId} role="listitem">
                <UI.Text>
                  {(() => {
                    // Which version of this skill the row pins, so "version 4"
                    // is not read as a version of the skill.
                    const pinned = pinnedRevisions(row, versions);
                    return pinned.length === 0
                      ? translate("library.skill.usedBy.line", {
                        name: row.definitionName,
                        revision: row.revision,
                      })
                      : translate("library.skill.usedBy.linePins", {
                        name: row.definitionName,
                        revision: row.revision,
                        count: pinned.length,
                        list: new Intl.ListFormat(locale, {
                          style: "long",
                          type: "conjunction",
                        }).format(pinned.map(String)),
                      });
                  })()}
                </UI.Text>
              </div>
            ))}
          </UI.Stack>
        }
      />
    );
  return (
    <Card id="skill-used-by" title={translate("library.skill.usedBy.title")}>
      {usedBy.isError
        ? (
          <CardError
            message={translate("library.skill.usedBy.error")}
            onRetry={() => void usedBy.refetch()}
          />
        )
        : usedBy.isPending
        ? <UI.Skeleton shape="row" />
        : groups.agents.length === 0 && groups.workflows.length === 0
        ? (
          <UI.Text variant="muted">
            {translate("library.skill.usedBy.empty")}
          </UI.Text>
        )
        : (
          <UI.DescriptionList>
            {group(translate("library.skill.usedBy.agents"), groups.agents)}
            {group(
              translate("library.skill.usedBy.workflows"),
              groups.workflows,
            )}
          </UI.DescriptionList>
        )}
      {usedBy.hasNextPage && !usedBy.isError
        ? (
          <UI.Button
            loading={usedBy.isFetchingNextPage}
            onClick={() => void usedBy.fetchNextPage()}
            variant="secondary"
          >
            {translate("library.skill.more")}
          </UI.Button>
        )
        : null}
    </Card>
  );
}

/** A private skill only. Only its owner may read the grants; anyone else is not shown the card. */
function AccessCard(
  { skill, versions }: {
    readonly skill: SkillResponse;
    readonly versions: readonly SkillVersionResponse[];
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { translate, locale, timeZone } = useI18n();
  const grants = useInfiniteQuery(
    skillUseGrantsQueryOptions(api, scope, skill.id),
  );
  if (grants.isError && isForbiddenFailure(grants.error)) return null;
  const items = grants.data?.pages.flatMap((page) => page.items) ?? [];
  const when = (iso: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone }).format(
      new Date(iso),
    );
  const revisionOf = (id: string) =>
    versions.find((version) => version.id === id)?.revision ?? null;
  return (
    <Card id="skill-access" title={translate("library.skill.access.title")}>
      {grants.isError
        ? (
          <CardError
            message={translate("library.skill.access.error")}
            onRetry={() => void grants.refetch()}
          />
        )
        : grants.isPending
        ? <UI.Skeleton shape="row" />
        : items.length === 0
        ? (
          <Explained
            text={translate("library.skill.access.empty")}
            label={translate("library.skill.access.helpLabel")}
            help={translate("library.skill.access.help")}
          />
        )
        : (
          <UI.Stack gap="compact">
            <Explained
              text={translate("library.skill.access.shared")}
              label={translate("library.skill.access.helpLabel")}
              help={translate("library.skill.access.help")}
            />
            <UI.Stack
              aria-label={translate("library.skill.access.title")}
              gap="compact"
              role="list"
            >
              {items.map((grant) => (
                <SkillGrantRow
                  key={grant.id}
                  grant={grant}
                  skill={skill}
                  revision={revisionOf(grant.skillVersionId)}
                  since={when(grant.createdAt)}
                />
              ))}
            </UI.Stack>
          </UI.Stack>
        )}
      {grants.hasNextPage && !grants.isError
        ? (
          <UI.Button
            loading={grants.isFetchingNextPage}
            onClick={() => void grants.fetchNextPage()}
            variant="secondary"
          >
            {translate("library.skill.more")}
          </UI.Button>
        )
        : null}
    </Card>
  );
}

function CopiedLine(
  { skillId, versionId }: {
    readonly skillId: string;
    readonly versionId: string | null;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { translate } = useI18n();
  const navigate = useNavigate();
  const original = useQuery(skillQueryOptions(api, scope, skillId));
  // The original's versions name the revision the copy was made from.
  const versions = useInfiniteQuery({
    ...skillVersionsQueryOptions(api, scope, skillId, 100),
    enabled: original.isSuccess && versionId !== null,
  });
  if (original.isPending) return <UI.Skeleton shape="row" />;
  const revision = versionId === null
    ? null
    : versions.data?.pages.flatMap((page) => page.items)
      .find((version) => version.id === versionId)?.revision ?? null;
  const words = copiedWords(original.data?.name ?? null, revision);
  const name = original.data?.name ?? null;
  if (name === null) {
    return <UI.Text>{translate(words.key, words.values)}</UI.Text>;
  }
  // The reader can open the original: its name is a link to its page. The whole
  // sentence stays one translation; the name is set apart and put back as the link.
  const MARK = "\u2063";
  const [before, after] = translate(words.key, { ...words.values, name: MARK })
    .split(MARK);
  const href = `/library/skills/${skillId}`;
  return (
    <UI.Text>
      {before}
      <UI.Link
        href={href}
        onClick={(event) => {
          event.preventDefault();
          void navigate({
            to: "/library/skills/$skillId",
            params: { skillId },
          });
        }}
      >
        {name}
      </UI.Link>
      {after ?? ""}
    </UI.Text>
  );
}

function SourceDetails(
  { sourceId, skill }: {
    readonly sourceId: string;
    readonly skill: SkillResponse;
  },
) {
  const canChange = useCanChangeSkill(skill) === true;
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { translate, locale, timeZone } = useI18n();
  const source = useQuery(skillSourceQueryOptions(api, scope, sourceId));
  if (source.isError) {
    return (
      <CardError
        message={translate("library.skill.origin.error")}
        onRetry={() => void source.refetch()}
      />
    );
  }
  if (source.isPending) return <UI.Skeleton shape="row" />;
  const data = source.data;
  const kind = sourceKindWords(data.sourceType);
  if (data.locator.startsWith("bakery://")) {
    return (
      <UI.Stack gap="compact">
        <UI.Text>{translate("library.skill.origin.written")}</UI.Text>
        {data.license === null ? null : (
          <UI.DescriptionList>
            <UI.DescriptionItem
              title={translate("library.skill.origin.license")}
              description={data.license}
            />
          </UI.DescriptionList>
        )}
      </UI.Stack>
    );
  }
  const versionId = skill.activeVersionId;
  const checkable = canChange && versionId !== null &&
    data.sourceType !== "local_bundle";
  const details = (
    <UI.DescriptionList>
      <UI.DescriptionItem
        title={translate("library.skill.origin.kind")}
        description={data.name === null
          ? translate(kind.key)
          : translate("library.skill.origin.kindNamed", {
            kind: translate(kind.key),
            name: data.name,
          })}
      />
      <UI.DescriptionItem
        title={translate("library.skill.origin.address")}
        description={<UI.DataText>{data.locator}</UI.DataText>}
      />
      {data.publisher === null ? null : (
        <UI.DescriptionItem
          title={translate("library.skill.origin.publisher")}
          description={data.publisher}
        />
      )}
      {data.license === null ? null : (
        <UI.DescriptionItem
          title={translate("library.skill.origin.license")}
          description={data.license}
        />
      )}
      <UI.DescriptionItem
        title={translate("library.skill.origin.checked")}
        description={data.lastCheckedAt === null
          ? translate("library.skill.origin.neverChecked")
          : new Intl.DateTimeFormat(locale, {
            dateStyle: "medium",
            timeStyle: "short",
            timeZone,
          }).format(new Date(data.lastCheckedAt))}
      />
    </UI.DescriptionList>
  );
  return checkable
    ? (
      <UI.Stack gap="standard">
        {details}
        <SkillSourceCheckControl
          address={data.locator}
          skill={{ ...skill, activeVersionId: versionId }}
        />
      </UI.Stack>
    )
    : details;
}

function OriginCard({ skill }: { readonly skill: SkillResponse }) {
  const { translate } = useI18n();
  const origin = skillOrigin(skill);
  return (
    <Card id="skill-origin" title={translate("library.skill.origin.title")}>
      {origin.kind === "written"
        ? <UI.Text>{translate("library.skill.origin.written")}</UI.Text>
        : origin.kind === "copied"
        ? <CopiedLine skillId={origin.skillId} versionId={origin.versionId} />
        : <SourceDetails skill={skill} sourceId={origin.sourceId} />}
    </Card>
  );
}

function SkillBody({ skill }: { readonly skill: SkillResponse }) {
  const state = useVersions(skill);
  return (
    <UI.FormWithSummary
      aside={
        <UI.Stack gap="spacious">
          <VersionsCard skill={skill} state={state} />
          <UsedByCard skill={skill} versions={state.items} />
          {skill.scope === "personal"
            ? <AccessCard skill={skill} versions={state.items} />
            : null}
          <OriginCard skill={skill} />
        </UI.Stack>
      }
    >
      <FilesCard skill={skill} state={state} />
    </UI.FormWithSummary>
  );
}

function SkillHeader({ skill }: { readonly skill: SkillResponse }) {
  const { translate } = useI18n();
  const organizationName = useOrganizationName();
  const canChange = useCanChangeSkill(skill);
  const words = (entry: Words) => translate(entry.key, entry.values);
  const { actions, below } = useSkillActions(skill);
  const phone = useShellViewport() === "phone";
  return (
    <>
      {!phone ? <ShellSlot name="actions">{actions}</ShellSlot> : null}
      <UI.PageHeader
        variant="list"
        flush
        title={skill.name}
        actions={phone ? actions : null}
        subtitle={
          <UI.Stack gap="compact">
            {skill.description === null || skill.description === ""
              ? null
              : <UI.Text variant="muted">{skill.description}</UI.Text>}
            <UI.Inline gap="compact">
              <UI.Badge>{words(scopeWords(skill.scope))}</UI.Badge>
              <UI.HelpTip
                label={translate("library.skill.scope.helpLabel", {
                  scope: words(scopeWords(skill.scope)),
                })}
              >
                {translate(`library.skill.scope.help.${skill.scope}`, {
                  organization: organizationName ?? "",
                })}
              </UI.HelpTip>
              {skill.enabled ? null : (
                <UI.Badge tone="warning">
                  {translate("library.skills.badge.turnedOff")}
                </UI.Badge>
              )}
            </UI.Inline>
            {skill.scope === "organization" && canChange === false
              ? (
                <UI.Text variant="muted">
                  {translate("library.skill.organizationReadOnly")}
                </UI.Text>
              )
              : null}
          </UI.Stack>
        }
      />
      {below}
    </>
  );
}

/**
 * One skill (design-ux #74, revision 3, slice 1), read only: its files as the
 * version in use lists them, its versions, what uses it, who may use a private
 * one, and where it came from. Changing a skill is a later slice.
 */
export function SkillPage({ skillId }: { readonly skillId: string }) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const navigate = useNavigate();
  const { translate } = useI18n();
  useRestoreOrganizationScope();
  const read = useQuery(skillQueryOptions(api, scope, skillId));
  const skill = read.data;

  const breadcrumbs = (
    <ShellSlot name="breadcrumbs">
      <UI.Breadcrumbs
        aria-label={translate("shell.navigation.breadcrumb")}
        items={[
          { href: WORK_HOME, label: translate("shell.navigation.workspace") },
          { href: "/library?tab=skills", label: translate("library.title") },
          {
            label: skill === undefined
              ? translate("library.skill.back")
              : skill.name,
          },
        ]}
      />
    </ShellSlot>
  );
  const heading = (
    <UI.PageHeader
      variant="list"
      flush
      title={translate("library.skill.back")}
    />
  );
  const back = () =>
    void navigate({ to: "/library", search: { tab: "skills" } });

  if (read.isPending) {
    return (
      <>
        {breadcrumbs}
        <UI.SettingsContent data-testid="skill-page" variant="wide">
          {heading}
          <UI.Stack gap="standard" aria-busy="true">
            <UI.Text variant="muted" role="status">
              {translate("library.skill.loading")}
            </UI.Text>
            <UI.Skeleton shape="row" />
            <UI.Skeleton shape="row" />
          </UI.Stack>
        </UI.SettingsContent>
      </>
    );
  }
  if (read.isError || skill === undefined) {
    const missing = failureStatus(read.error) === 404 ||
      isForbiddenFailure(read.error);
    const offline = asyncKindForError(read.error) === "offline";
    return (
      <>
        {breadcrumbs}
        <UI.SettingsContent data-testid="skill-page" variant="wide">
          {heading}
          {missing
            ? (
              <UI.EmptyState
                title={translate("library.skill.notFound.title")}
                description={translate("library.skill.notFound.description")}
                action={
                  <UI.Button variant="secondary" onClick={back}>
                    {translate("library.skill.notFound.back")}
                  </UI.Button>
                }
                variant="filtered"
              />
            )
            : (
              <UI.ErrorState
                title={translate(
                  offline ? "library.offlineTitle" : "library.skill.error",
                )}
                description={translate(
                  offline
                    ? "library.offlineDescription"
                    : "library.error.description",
                )}
                action={
                  <UI.Button
                    variant="secondary"
                    onClick={() => void read.refetch()}
                  >
                    {translate("library.retry")}
                  </UI.Button>
                }
              />
            )}
        </UI.SettingsContent>
      </>
    );
  }

  return (
    <>
      {breadcrumbs}
      <UI.SettingsContent data-testid="skill-page" variant="wide">
        <SkillToast />
        <SkillHeader skill={skill} />
        <SkillBody key={skill.id} skill={skill} />
      </UI.SettingsContent>
    </>
  );
}
