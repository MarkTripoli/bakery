import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import type {
  ApiFailure,
  SkillImportRun,
  SkillResponse,
  SkillSourceCheck,
} from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import {
  skillQueryOptions,
  skillSourceCheckQueryOptions,
  skillSourceQueryOptions,
  skillUsedByQueryOptions,
  skillVersionsQueryOptions,
} from "../api/query.ts";
import { protectedQueryKey } from "../app/query-scope.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useRestoreOrganizationScope } from "../app/restore-organization.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { WORK_HOME } from "../shell/breadcrumb-paths.ts";
import { ShellSlot } from "../shell/shell-slots.tsx";
import { sayAboutSkill } from "./library/SkillActions.tsx";
import {
  useCheckedWhen,
  useSourceProblemSentence,
} from "./library/SkillSourceCheckControl.tsx";
import { importFailureKind } from "./library/skill-source-state.ts";
import {
  type FileChange as Change,
  fileChanges,
  nextRevision,
  shortRevision,
  type TakeRefusal,
  takeRefusal,
  versionHolding,
} from "./library/skill-update-state.ts";
import { fileSize, usedByGroups } from "./library/skills-state.ts";
import { useCanChangeSkill } from "./library/useCanChangeSkill.ts";

const POLL_MS = 1500;

const OMITTED = {
  binary: "library.skills.update.binary",
  too_large: "library.skills.update.tooLarge",
  mode_only: "library.skills.update.modeOnly",
} as const;

const TONES = {
  added: "success",
  changed: "information",
  removed: "danger",
} as const;

const REFUSALS = {
  moved: "library.skills.update.moved",
  changed: "library.skills.update.skillChanged",
  installed: "library.skills.update.takeFailed",
  held: "library.skills.update.heldAlready",
  unavailable: "library.skills.update.takeFailed",
  forbidden: "library.skills.update.forbiddenNow",
  offline: "library.skills.update.offline",
  failed: "library.skills.update.takeFailed",
} as const satisfies Record<TakeRefusal, string>;

function FileChange(
  { file, first }: { readonly file: Change; readonly first: boolean },
) {
  const { translate, locale } = useI18n();
  const size = (bytes: number | null) =>
    bytes === null ? null : fileSize(bytes, locale);
  const before = size(file.installedSizeBytes);
  const after = size(file.latestSizeBytes);
  const sizes = before !== null && after !== null && before !== after
    ? translate("library.skills.update.sizes", { before, after })
    : after ?? before ?? "";
  return (
    <div data-file={file.path} role="listitem">
      <UI.Disclosure
        defaultOpen={first}
        variant="row"
        summary={
          <>
            <UI.DataText>{file.path}</UI.DataText>{" "}
            <UI.Badge tone={TONES[file.change]}>
              {translate(`library.skills.update.${file.change}`)}
            </UI.Badge>{" "}
            <UI.DataText>{sizes}</UI.DataText>
          </>
        }
      >
        {file.diff === null
          ? (
            <UI.Text variant="muted">
              {translate(OMITTED[file.diffOmitted ?? "binary"])}
            </UI.Text>
          )
          : (
            <UI.CodeBlock
              aria-label={translate("library.skills.update.diffOf", {
                file: file.path,
              })}
              code={file.diff}
              role="region"
              state="overflowing"
              language="diff"
            />
          )}
      </UI.Disclosure>
    </div>
  );
}

function Consequences(
  { skill, next, existing }: {
    readonly skill: SkillResponse;
    readonly next: number | null;
    readonly existing: number | null;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { translate } = useI18n();
  const usedBy = useInfiniteQuery(
    skillUsedByQueryOptions(api, scope, skill.id),
  );
  const groups = usedByGroups(
    usedBy.data?.pages.flatMap((page) => page.items) ?? [],
  );
  const used = groups.agents.length + groups.workflows.length > 0;
  return (
    <UI.SettingsSection
      title={translate("library.skills.update.aside.title")}
      variant="stack"
    >
      <UI.Text>
        {existing !== null
          ? translate("library.skills.update.aside.existing", {
            number: existing,
          })
          : next === null
          ? translate("library.skills.update.aside.unknownVersion")
          : translate("library.skills.update.aside.version", { number: next })}
      </UI.Text>
      {used && skill.activeRevision !== null
        ? (
          <UI.Text>
            {translate("library.skills.update.aside.keep", {
              agents: groups.agents.length,
              workflows: groups.workflows.length,
              number: skill.activeRevision,
            })}
          </UI.Text>
        )
        : null}
    </UI.SettingsSection>
  );
}

function Review(
  { skill, check, address, archive, onStale }: {
    readonly archive: boolean;
    readonly skill: SkillResponse;
    readonly check: SkillSourceCheck & { readonly latestRevision: string };
    readonly address: string;
    readonly onStale: () => Promise<unknown>;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { translate } = useI18n();
  const organizationId = scope.organizationId as string;
  const versions = useInfiniteQuery(
    skillVersionsQueryOptions(api, scope, skill.id, 100),
  );
  const listed = versions.data?.pages.flatMap((page) => page.items) ?? [];
  const next = nextRevision(listed);
  const existing = versionHolding(
    listed,
    check.latestRevision,
    skill.activeVersionId,
  );
  const [unchanged, setUnchanged] = useState(false);
  const arrive = async (number: number) => {
    sayAboutSkill(translate("library.skills.update.done", { number }));
    await navigate({
      to: "/library/skills/$skillId",
      params: { skillId: skill.id },
    });
    void queryClient.invalidateQueries({ queryKey: ["protected"] });
  };
  const switchTo = useMutation<SkillResponse, ApiFailure, string>({
    mutationKey: ["skills.setActiveVersion"],
    mutationFn: async (versionId) => {
      const result = await api.setSkillActiveVersion({
        organizationId,
        id: skill.id,
        versionId,
        version: skill.version,
        idempotencyKey: crypto.randomUUID(),
      });
      if (!result.ok) throw result.error;
      return result.data;
    },
    onSuccess: (taken) => void arrive(taken.activeRevision ?? 0),
    onError: (error) => {
      if (takeRefusal(error) === "changed") void onStale();
    },
  });
  const [runId, setRunId] = useState<string | null>(null);
  const intent = useRef<string | null>(null);
  const finished = useRef<string | null>(null);
  const back = () =>
    void navigate({
      to: "/library/skills/$skillId",
      params: { skillId: skill.id },
    });
  const take = useMutation<SkillImportRun, ApiFailure>({
    mutationKey: ["skills.takeSourceUpdate"],
    mutationFn: async () => {
      const result = await api.takeSkillSourceUpdate({
        organizationId,
        id: skill.id,
        revision: check.latestRevision,
        version: skill.version,
        idempotencyKey: intent.current ??= crypto.randomUUID(),
      });
      if (!result.ok) throw result.error;
      return result.data;
    },
    onMutate: () => setRunId(null),
    onSuccess: (run) => {
      intent.current = null;
      setRunId(run.id);
    },
    onError: (error) => {
      if (error.kind === "problem" && error.problem.status < 500) {
        intent.current = null;
      }
      const refusal = takeRefusal(error);
      if (refusal === "installed") back();
      if (
        refusal === "moved" || refusal === "changed" || refusal === "held"
      ) void onStale();
    },
  });
  const run = useQuery({
    queryKey: protectedQueryKey(scope, "skillImports.get", {
      id: runId ?? "",
    }),
    queryFn: async ({ signal }) => {
      const read = await api.getSkillImport({
        organizationId,
        id: runId!,
        signal,
      });
      if (!read.ok) throw read.error;
      return read.data;
    },
    enabled: runId !== null,
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state === "completed" || state === "failed" ? false : POLL_MS;
    },
  });
  const outcome = runId === null ? undefined : run.data;
  useEffect(() => {
    if (outcome?.state !== "completed" || finished.current === runId) return;
    finished.current = runId;
    const open = async () => {
      const read = await api.getSkill({ organizationId, id: skill.id });
      if (read.ok && read.data.activeVersionId === skill.activeVersionId) {
        setUnchanged(true);
        setRunId(null);
        return;
      }
      await arrive((read.ok ? read.data.activeRevision : next) ?? 0);
    };
    void open();
  });
  const taking = take.isPending || switchTo.isPending ||
    runId !== null && outcome?.state !== "failed";
  const failed = outcome?.state === "failed"
    ? translate(
      `library.skills.add.failure.${
        importFailureKind(
          outcome.failureCode,
          address,
          check.latestRevision,
          archive,
        )
      }`,
      {
        address,
        host: URL.canParse(address) ? new URL(address).host : address,
        folder: address,
        revision: shortRevision(check.latestRevision),
      },
    )
    : take.isError
    ? translate(REFUSALS[takeRefusal(take.error)])
    : switchTo.isError
    ? translate(REFUSALS[takeRefusal(switchTo.error)])
    : unchanged
    ? translate("library.skills.update.unchanged", {
      number: skill.activeRevision ?? 0,
    })
    : null;
  const changes = fileChanges(check.changes);
  return (
    <UI.FormWithSummary
      actions={
        <>
          <UI.Button disabled={taking} onClick={back} variant="secondary">
            {translate("library.skills.update.notNow")}
          </UI.Button>
          <UI.Button
            disabled={!skill.enabled || versions.isPending}
            loading={taking}
            onClick={() => {
              if (taking) return;
              setUnchanged(false);
              if (existing === null) take.mutate();
              else switchTo.mutate(existing.id);
            }}
            variant="primary"
          >
            {translate("library.skills.update.take")}
          </UI.Button>
        </>
      }
      aside={
        <Consequences
          existing={existing?.revision ?? null}
          next={next}
          skill={skill}
        />
      }
      data-testid="skill-update-review"
    >
      <UI.Stack gap="standard">
        {failed === null ? null : (
          <UI.InlineNotice role="alert" tone="error">
            {failed}
          </UI.InlineNotice>
        )}
        <UI.Text variant="strong">
          {check.changesTruncated
            ? translate("library.skills.update.truncated", {
              count: changes.length,
            })
            : translate("library.skills.update.files", {
              count: changes.length,
            })}
        </UI.Text>
        <UI.Stack gap="compact" role="list">
          {changes.map((file, index) => (
            <FileChange file={file} first={index === 0} key={file.path} />
          ))}
        </UI.Stack>
        {skill.enabled ? null : (
          <UI.InlineNotice tone="warning">
            {translate("library.skills.update.turnedOff")}
          </UI.InlineNotice>
        )}
        {taking
          ? (
            <UI.Text role="status" variant="muted">
              {translate("library.skills.update.taking")}
            </UI.Text>
          )
          : null}
      </UI.Stack>
    </UI.FormWithSummary>
  );
}

function UpdateBody({ skill }: { readonly skill: SkillResponse }) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { translate } = useI18n();
  const when = useCheckedWhen();
  const problemSentence = useSourceProblemSentence();
  const source = useQuery({
    ...skillSourceQueryOptions(api, scope, skill.sourceId ?? ""),
    enabled: skill.sourceId !== null,
  });
  const check = useQuery({
    ...skillSourceCheckQueryOptions(
      api,
      scope,
      skill.id,
      skill.activeVersionId ?? "",
    ),
    enabled: skill.sourceId !== null && skill.activeVersionId !== null,
    gcTime: 0,
  });
  const address = source.data?.locator ?? "";
  const back = (
    <UI.Button
      onClick={() =>
        void navigate({
          to: "/library/skills/$skillId",
          params: { skillId: skill.id },
        })}
      variant="secondary"
    >
      {translate("library.skills.update.notNow")}
    </UI.Button>
  );
  const retry = (
    <UI.Button onClick={() => void check.refetch()} variant="secondary">
      {translate("library.skills.update.checkAgain")}
    </UI.Button>
  );
  const title = translate("library.skills.update.title", { name: skill.name });
  const frame = (children: ReactNode, subtitle?: string) => (
    <>
      <UI.PageHeader
        flush
        subtitle={subtitle}
        title={title}
        variant="list"
      />
      <UI.Stack gap="standard">{children}</UI.Stack>
    </>
  );
  if (skill.sourceId === null || skill.activeVersionId === null) {
    return frame(
      <UI.EmptyState
        action={back}
        title={translate("library.skills.update.noSource")}
        variant="filtered"
      />,
    );
  }
  if (check.isPending || source.isPending) {
    return frame(
      <>
        <UI.Text role="status" variant="muted">
          {translate("library.skills.update.reading")}
        </UI.Text>
        <UI.Skeleton shape="row" />
        <UI.Skeleton shape="row" />
      </>,
    );
  }
  if (check.isError) {
    return frame(
      <UI.ErrorState
        action={retry}
        description={translate("library.error.description")}
        title={translate("library.skills.update.checkFailed")}
      />,
    );
  }
  const result = check.data;
  const subtitle = result.latestRevision === null
    ? undefined
    : translate("library.skills.update.subtitle", {
      number: skill.activeRevision ?? 0,
      installed: shortRevision(result.installedRevision),
      latest: shortRevision(result.latestRevision),
      time: when(result.lastCheckedAt),
    });
  if (result.status === "unreachable") {
    return frame(
      <>
        <UI.InlineNotice role="status" tone="warning">
          {problemSentence(
            result,
            address,
            source.data?.sourceType === "url",
          )} {translate("library.skills.update.stillWorks")}
        </UI.InlineNotice>
        <UI.Inline gap="compact">
          {back}
          {retry}
        </UI.Inline>
      </>,
    );
  }
  if (result.status === "current" || result.latestRevision === null) {
    return frame(
      <>
        <UI.Text role="status">
          {translate("library.skills.update.current", {
            revision: shortRevision(result.requestedRevision),
            time: when(result.lastCheckedAt),
          })}
        </UI.Text>
        <UI.Inline>{back}</UI.Inline>
      </>,
    );
  }
  return frame(
    <Review
      address={address}
      archive={source.data?.sourceType === "url"}
      check={{ ...result, latestRevision: result.latestRevision }}
      onStale={() => queryClient.invalidateQueries({ queryKey: ["protected"] })}
      skill={skill}
    />,
    subtitle,
  );
}

export function SkillUpdatePage({ skillId }: { readonly skillId: string }) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const navigate = useNavigate();
  const { translate } = useI18n();
  useRestoreOrganizationScope();
  const read = useQuery(skillQueryOptions(api, scope, skillId));
  const skill = read.data;
  const canChange = useCanChangeSkill(skill);
  const breadcrumbs = (
    <ShellSlot name="breadcrumbs">
      <UI.Breadcrumbs
        aria-label={translate("shell.navigation.breadcrumb")}
        items={[
          { href: WORK_HOME, label: translate("shell.navigation.workspace") },
          { href: "/library?tab=skills", label: translate("library.title") },
          {
            href: `/library/skills/${skillId}`,
            label: skill?.name ?? translate("library.skill.back"),
          },
          { label: translate("library.skills.update.crumb") },
        ]}
      />
    </ShellSlot>
  );
  const heading = (
    <UI.PageHeader
      flush
      title={translate("library.skills.update.crumb")}
      variant="list"
    />
  );
  const body = read.isError
    ? (
      <UI.ErrorState
        action={
          <UI.Button onClick={() => void read.refetch()} variant="secondary">
            {translate("library.retry")}
          </UI.Button>
        }
        description={translate("library.error.description")}
        title={translate("library.skill.error")}
      />
    )
    : skill === undefined || canChange === undefined
    ? <UI.Skeleton shape="row" />
    : !canChange
    ? (
      <UI.EmptyState
        action={
          <UI.Button
            onClick={() =>
              void navigate({
                to: "/library/skills/$skillId",
                params: { skillId },
              })}
            variant="secondary"
          >
            {translate("library.skills.update.notNow")}
          </UI.Button>
        }
        description={translate("library.skills.update.forbidden.description")}
        title={translate("library.skills.update.forbidden.title")}
        variant="filtered"
      />
    )
    : <UpdateBody key={skill.id} skill={skill} />;
  return (
    <>
      {breadcrumbs}
      <UI.SettingsContent data-testid="skill-update-page" variant="wide">
        {skill !== undefined && canChange === true ? null : heading}
        {body}
      </UI.SettingsContent>
    </>
  );
}
