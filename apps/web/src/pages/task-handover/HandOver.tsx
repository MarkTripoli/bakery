import { useEffect, useRef, useState } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import { formatDate } from "@bakery/i18n";
import { useBakeryApi } from "../../api/context.tsx";
import {
  artifactQueryOptions,
  artifactVersionAmongQueryOptions,
  handoffManifestQueryOptions,
  storageFileAtVersionQueryOptions,
} from "../../api/query.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { useShellViewport } from "../../app/responsive.ts";
import { stepTitle } from "../task-timeline.ts";
import {
  type CarryOn,
  carryOn,
  type ManifestView,
  outcomeUnknown,
  reasonKey,
  refusalOf,
  viewManifest,
} from "./model.ts";

export type HandOverStep = Readonly<{
  id: string;
  stepKey: string;
  status: string;
  handoffManifest: Readonly<{ id: string; status: string }> | null;
}>;

type Notice = Readonly<{
  stepId: string;
  tone: "success" | "warning" | "information";
  text: string;
}>;

const DECISIONS_SHOWN = 5;
const DOCUMENTS_SHOWN = 5;

export function HandOver(
  { taskId, runId, runVersion, steps, canControl, online }: {
    readonly taskId: string;
    readonly runId: string;
    readonly runVersion: number;
    readonly steps: readonly HandOverStep[];
    readonly canControl: boolean;
    readonly online: boolean;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const cache = useQueryClient();
  const { translate: t } = useI18n();
  const [openStep, setOpenStep] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [tries, setTries] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const alive = useRef(true);
  const opener = useRef<HTMLElement | null>(null);
  const pending = useRef<{ signature: string; key: string } | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const offered = canControl
    ? steps.filter((step) =>
      step.status === "running" && step.handoffManifest?.status === "pending"
    )
    : [];
  const open = offered.find((step) => step.id === openStep) ?? null;
  const manifest = useQuery({
    ...handoffManifestQueryOptions(
      api,
      scope,
      open?.handoffManifest?.id ?? "",
    ),
    enabled: open !== null && scope.organizationId !== null,
    staleTime: 0,
    refetchOnMount: "always",
  });

  const closeCard = () => {
    setOpenStep(null);
    setProblem(null);
    pending.current = null;
    const button = opener.current;
    requestAnimationFrame(() => {
      if (button?.isConnected) button.focus();
    });
  };

  useEffect(() => {
    if (openStep === null || working || open !== null) return;
    setOpenStep(null);
    setProblem(null);
    pending.current = null;
  }, [openStep, working, open]);

  const refresh = async () => {
    try {
      await cache.invalidateQueries({
        predicate: ({ queryKey: key }) => {
          if (
            key[0] !== "protected" || key[1] !== scope.sessionGeneration ||
            key[2] !== scope.organizationId
          ) return false;
          if (key[3] === "handoffManifests.get") return true;
          const input = key[4];
          if (typeof input !== "object" || input === null) return false;
          return ("id" in input && input.id === taskId) ||
            ("taskId" in input && input.taskId === taskId) ||
            ("runId" in input && input.runId === runId);
        },
      });
    } catch {
      return;
    }
  };

  const view = manifest.data ? viewManifest(manifest.data.manifest) : null;
  const settledState: ReadState = manifest.data !== undefined
    ? manifest.data.status !== "pending"
      ? "gone"
      : view === null
      ? "failed"
      : "ok"
    : manifest.isError
    ? notFound(manifest.error) ? "gone" : "failed"
    : manifest.fetchStatus === "paused"
    ? "offline"
    : "ok";
  const held = useRef<ReadState>("ok");
  const rereading = manifest.isPending && tries > 0;
  if (!rereading) held.current = settledState;
  const readState = rereading ? held.current : settledState;
  const way: CarryOn | null = manifest.data && view
    ? carryOn(manifest.data, view)
    : null;

  const submit = async () => {
    const organizationId = scope.organizationId;
    if (
      open === null || open.handoffManifest === null || working ||
      organizationId === null || !online || manifest.data === undefined ||
      view === null || view.capturePaused
    ) return;
    const manifestId = open.handoffManifest.id;
    const input = { runVersion };
    const signature = JSON.stringify({ manifestId, input });
    const key = pending.current?.signature === signature
      ? pending.current.key
      : crypto.randomUUID();
    pending.current = { signature, key };
    setWorking(true);
    setProblem(null);
    const result = await api.continueHandoff({
      organizationId,
      manifestId,
      input,
      idempotencyKey: key,
    });
    if (!alive.current) return;
    setWorking(false);
    if (result.ok) {
      closeCard();
      setNotice(null);
      await refresh();
      return;
    }
    if (!outcomeUnknown(result.error)) pending.current = null;
    const refusal = refusalOf(result.error);
    if (refusal.where === "page") {
      closeCard();
      setNotice({
        stepId: open.id,
        tone: "warning",
        text: t(refusal.key as never),
      });
    } else {
      setProblem(t(refusal.key as never));
    }
    if (refusal.reload) void refresh();
  };

  if (offered.length === 0 && notice === null) return null;

  return (
    <UI.Stack gap="standard" data-testid="handover">
      {offered.map((step) => {
        const isOpen = openStep === step.id;
        return (
          <UI.Stack gap="standard" key={step.id}>
            <UI.Inline gap="compact">
              <UI.Text variant="muted">{stepTitle(t, step.stepKey)}</UI.Text>
              <UI.Button
                aria-expanded={isOpen}
                data-testid="handover-open"
                data-step-key={step.stepKey}
                disabled={working}
                variant="secondary"
                onClick={(event) => {
                  if (isOpen) {
                    closeCard();
                    return;
                  }
                  opener.current = event.currentTarget;
                  setProblem(null);
                  setNotice(null);
                  pending.current = null;
                  setOpenStep(step.id);
                }}
              >
                {t("tasks.run.handover.button")}
              </UI.Button>
            </UI.Inline>
            {isOpen
              ? (
                <Card
                  key={step.id}
                  stepName={stepTitle(t, step.stepKey)}
                  loading={manifest.isPending &&
                    manifest.fetchStatus !== "paused" && tries === 0}
                  readState={readState}
                  tries={tries}
                  retrying={manifest.isFetching}
                  onRetry={() => {
                    setTries((count) => count + 1);
                    void manifest.refetch();
                  }}
                  savedAt={step.handoffManifest?.status === "pending"
                    ? manifest.data?.createdAt ?? null
                    : null}
                  machine={manifest.data?.machineName ?? null}
                  view={view}
                  way={way}
                  online={online}
                  working={working}
                  problem={problem}
                  onKeep={closeCard}
                  onConfirm={() => void submit()}
                />
              )
              : null}
          </UI.Stack>
        );
      })}
      {notice === null ? null : (
        <UI.InlineNotice
          data-testid="handover-notice"
          onDismiss={() => setNotice(null)}
          tone={notice.tone}
        >
          {notice.text}
        </UI.InlineNotice>
      )}
    </UI.Stack>
  );
}

type ReadState = "ok" | "gone" | "failed" | "offline";

function notFound(error: unknown): boolean {
  const failure = error as { kind?: string; problem?: { status: number } };
  return failure?.kind === "problem" && failure.problem?.status === 404;
}

function Card(
  {
    stepName,
    loading,
    readState,
    tries,
    retrying,
    onRetry,
    savedAt,
    machine,
    view,
    way,
    online,
    working,
    problem,
    onKeep,
    onConfirm,
  }: {
    readonly stepName: string;
    readonly loading: boolean;
    readonly readState: ReadState;
    readonly tries: number;
    readonly retrying: boolean;
    readonly onRetry: () => void;
    readonly savedAt: string | null;
    readonly machine: string | null;
    readonly view: ManifestView | null;
    readonly way: CarryOn | null;
    readonly online: boolean;
    readonly working: boolean;
    readonly problem: string | null;
    readonly onKeep: () => void;
    readonly onConfirm: () => void;
  },
) {
  const { translate: t, locale, timeZone } = useI18n();
  const phone = useShellViewport() === "phone";
  const wasRetrying = useRef(false);
  useEffect(() => {
    if (wasRetrying.current && !retrying) {
      const focused = document.activeElement;
      if (focused === null || focused === document.body) {
        document.getElementById("handover-retry")?.focus();
      }
    }
    wasRetrying.current = retrying;
  }, [retrying]);
  const opened = useRef(true);
  useEffect(() => {
    const heading = document.getElementById("handover-heading");
    if (heading === null) return;
    const focused = document.activeElement;
    const stays = opened.current || focused === null ||
      focused === document.body ||
      heading.closest('[data-testid="handover-card"]')?.contains(focused) ===
        true;
    opened.current = false;
    heading.setAttribute("tabindex", "-1");
    if (stays) heading.focus();
  }, [loading, readState]);
  const when = savedAt === null ? "" : formatDate(new Date(savedAt), locale, {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  });

  if (loading) {
    return (
      <UI.Stack gap="compact" data-testid="handover-card" aria-busy="true">
        <UI.Text variant="muted" role="status">
          {t("tasks.run.handover.loading")}
        </UI.Text>
        <UI.Skeleton shape="surface" />
      </UI.Stack>
    );
  }
  if (readState !== "ok" || view === null || way === null) {
    const failed = readState === "failed" || readState === "offline" ||
      view === null || way === null;
    return (
      <UI.Stack gap="standard" data-testid="handover-card">
        <UI.Heading level="subsection" rank={3} id="handover-heading">
          {t("tasks.run.handover.title", { step: stepName })}
        </UI.Heading>
        {readState === "gone" || !failed
          ? (
            <UI.Text role="status" data-testid="handover-gone">
              {t("tasks.run.handover.gone")}
            </UI.Text>
          )
          : (
            <UI.InlineNotice
              key={tries}
              tone="warning"
              role="status"
              data-testid="handover-read-failed"
            >
              {t(
                (readState === "offline"
                  ? "tasks.run.handover.readOffline"
                  : "tasks.run.handover.readFailed") as never,
              )}
            </UI.InlineNotice>
          )}
        <UI.Inline variant={phone ? "actions" : "end"} gap="compact">
          {phone && readState === "failed"
            ? (
              <UI.Button
                id="handover-retry"
                data-testid="handover-retry"
                variant="primary"
                loading={retrying}
                onClick={onRetry}
              >
                {t("core.actions.retry")}
              </UI.Button>
            )
            : null}
          <UI.Button
            data-testid="handover-keep"
            variant="secondary"
            onClick={onKeep}
          >
            {t("tasks.run.handover.keep")}
          </UI.Button>
          {!phone && readState === "failed"
            ? (
              <UI.Button
                id="handover-retry"
                data-testid="handover-retry"
                variant="primary"
                loading={retrying}
                onClick={onRetry}
              >
                {t("core.actions.retry")}
              </UI.Button>
            )
            : null}
        </UI.Inline>
      </UI.Stack>
    );
  }
  const blockedReason = !online
    ? t("tasks.run.handover.offline")
    : view.capturePaused
    ? t("tasks.run.handover.capturePaused")
    : null;
  const actions = (
    <>
      <UI.Button
        data-testid="handover-keep"
        disabled={working}
        variant="secondary"
        onClick={onKeep}
      >
        {t("tasks.run.handover.keep")}
      </UI.Button>
      <UI.Button
        data-testid="handover-confirm"
        loading={working}
        variant="primary"
        onClick={() => {
          if (blockedReason !== null) {
            document.getElementById("handover-blocked")?.focus();
            return;
          }
          onConfirm();
        }}
      >
        {t("tasks.run.handover.confirm")}
      </UI.Button>
    </>
  );
  return (
    <UI.Stack gap="standard" data-testid="handover-card">
      <UI.Heading level="subsection" rank={3} id="handover-heading">
        {t("tasks.run.handover.title", { step: stepName })}
      </UI.Heading>
      <UI.Text>
        {machine === null
          ? t("tasks.run.handover.leadNoMachine")
          : t("tasks.run.handover.lead", { machine })}
      </UI.Text>
      <UI.InlineNotice
        data-testid="handover-way"
        data-way={way.kind}
        tone={way.kind === "exact" ? "information" : "warning"}
      >
        <UI.Stack gap="tight">
          <UI.Text variant="strong">
            {way.kind === "exact"
              ? t("tasks.run.handover.exact.title")
              : t("tasks.run.handover.fresh.title")}
          </UI.Text>
          <UI.Text>
            {way.kind === "exact"
              ? t("tasks.run.handover.exact.body", { time: when })
              : t("tasks.run.handover.fresh.body")}
          </UI.Text>
          {way.kind === "exact"
            ? (
              <UI.Text variant="muted">
                {t("tasks.run.handover.exact.caption")}
              </UI.Text>
            )
            : (
              <>
                <UI.Text variant="muted">
                  {t("tasks.run.handover.fresh.why")}
                </UI.Text>
                <UI.Text data-testid="handover-reason">
                  {t(reasonKey(way.reason) as never, {
                    count: view.unconfirmedEffects,
                  })}
                </UI.Text>
              </>
            )}
        </UI.Stack>
      </UI.InlineNotice>
      <Given
        view={view}
        reasonIsOutside={way.kind === "fresh" &&
          way.reason === "effects_unresolved"}
      />
      {problem === null
        ? null
        : (
          <UI.InlineNotice tone="warning" data-testid="handover-problem">
            {problem}
          </UI.InlineNotice>
        )}
      {blockedReason === null ? null : (
        <UI.InlineNotice
          tone="warning"
          id="handover-blocked"
          tabIndex={-1}
          role="status"
          data-testid="handover-blocked"
        >
          {blockedReason}
        </UI.InlineNotice>
      )}
      {phone
        ? (
          <>
            <UI.Inline variant="actions" gap="compact">{actions}</UI.Inline>
            <UI.Text variant="caption">{t("tasks.run.handover.same")}</UI.Text>
          </>
        )
        : (
          <UI.Inline variant="between" gap="compact">
            <UI.Text variant="caption">{t("tasks.run.handover.same")}</UI.Text>
            <UI.Inline gap="compact">{actions}</UI.Inline>
          </UI.Inline>
        )}
    </UI.Stack>
  );
}

function Given(
  { view, reasonIsOutside }: {
    readonly view: ManifestView;
    readonly reasonIsOutside: boolean;
  },
) {
  const { translate: t } = useI18n();
  const [allDecisions, setAllDecisions] = useState(false);
  const decisions = allDecisions
    ? view.decisions
    : view.decisions.slice(0, DECISIONS_SHOWN);
  return (
    <UI.DescriptionList data-testid="handover-given">
      <UI.DescriptionItem
        title={t("tasks.run.handover.next")}
        description={
          <UI.Stack gap="tight">
            <UI.Text>{view.goal}</UI.Text>
            <UI.Text>{view.nextAction}</UI.Text>
          </UI.Stack>
        }
      />
      {view.decisions.length === 0 ? null : (
        <UI.DescriptionItem
          title={t("tasks.run.handover.decisions", {
            count: view.decisions.length,
          })}
          description={
            <UI.Stack gap="tight">
              {decisions.map((decision, index) => (
                <UI.Text key={index}>{decision}</UI.Text>
              ))}
              {view.decisions.length > DECISIONS_SHOWN && !allDecisions
                ? (
                  <UI.Inline>
                    <UI.Button
                      variant="quiet"
                      onClick={() => setAllDecisions(true)}
                    >
                      {t("tasks.run.handover.showAll", {
                        count: view.decisions.length,
                      })}
                    </UI.Button>
                  </UI.Inline>
                )
                : null}
            </UI.Stack>
          }
        />
      )}
      <Documents refs={view.documents} />
      <UI.DescriptionItem
        title={t("tasks.run.handover.code")}
        description={view.hasPatch
          ? t("tasks.run.handover.codeWithPatch", { sha: view.commitShort })
          : t("tasks.run.handover.codeCommit", { sha: view.commitShort })}
      />
      {view.checks.length === 0 ? null : (
        <UI.DescriptionItem
          title={t("tasks.run.handover.checks", { count: view.checks.length })}
          description={
            <UI.Stack gap="tight">
              {view.checks.map((check, index) => (
                <UI.Inline gap="compact" key={index}>
                  <UI.DataText fit variant="code">{check.command}</UI.DataText>
                  <UI.Inline gap="compact">
                    <UI.Badge
                      tone={check.result === "passed"
                        ? "success"
                        : check.result === "failed"
                        ? "danger"
                        : "neutral"}
                    >
                      {t(`tasks.run.handover.check.${check.result}` as never)}
                    </UI.Badge>
                    {check.evidenceVersionId === null ? null : (
                      <UI.Link
                        href={`/files/versions/${check.evidenceVersionId}`}
                      >
                        {t("tasks.run.handover.checkEvidence")}
                      </UI.Link>
                    )}
                  </UI.Inline>
                </UI.Inline>
              ))}
            </UI.Stack>
          }
        />
      )}
      <UI.DescriptionItem
        title={t("tasks.run.handover.outside")}
        description={view.unconfirmedEffects === 0
          ? t("tasks.run.handover.outsideNone")
          : (
            <UI.Stack gap="tight">
              <UI.Inline gap="compact">
                <UI.Badge tone="warning">
                  {t("tasks.run.handover.outsideUnconfirmed", {
                    count: view.unconfirmedEffects,
                  })}
                </UI.Badge>
              </UI.Inline>
              {reasonIsOutside ? null : (
                <UI.Text>
                  {t("tasks.run.handover.outsideUnconfirmedBody")}
                </UI.Text>
              )}
            </UI.Stack>
          )}
      />
    </UI.DescriptionList>
  );
}

function Documents(
  { refs }: { readonly refs: ManifestView["documents"] },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { translate: t } = useI18n();
  const [all, setAll] = useState(false);
  const files = useQueries({
    queries: refs.map((ref) =>
      storageFileAtVersionQueryOptions(api, scope, ref.versionId)
    ),
  });
  const artifacts = useQueries({
    queries: refs.map((ref, index) => ({
      ...artifactQueryOptions(api, scope, ref.artifactId),
      enabled: files[index]?.isError === true,
    })),
  });
  const versions = useQueries({
    queries: refs.map((ref, index) => ({
      ...artifactVersionAmongQueryOptions(
        api,
        scope,
        ref.artifactId,
        ref.versionId,
      ),
      enabled: files[index]?.isError === true,
    })),
  });
  const known = refs.flatMap((ref, index) => {
    const file = files[index]?.data;
    if (file) {
      return [{
        versionId: ref.versionId,
        name: file.file.path.split("/").pop() ?? file.file.path,
        revision: file.revision,
      }];
    }
    const artifact = artifacts[index]?.data;
    const version = versions[index]?.data;
    return artifact && version
      ? [{
        versionId: ref.versionId,
        name: artifact.name,
        revision: version.revision,
      }]
      : [];
  });
  const noAccess = (error: unknown) => {
    const failure = error as { kind?: string; problem?: { status: number } };
    return failure?.kind === "problem" &&
      (failure.problem?.status === 403 || failure.problem?.status === 404);
  };
  const hidden = refs.filter((_, index) => {
    if (!files[index]?.isError) return false;
    return noAccess(artifacts[index]?.error);
  }).length;
  const gone = refs.filter((_, index) =>
    files[index]?.isError === true &&
    artifacts[index]?.data !== undefined &&
    versions[index]?.isSuccess === true && versions[index]?.data === null
  ).length;
  const unchecked = refs.filter((_, index) => {
    if (!files[index]?.isError) return false;
    const artifactError = artifacts[index]?.error;
    const versionError = versions[index]?.error;
    return (artifactError && !noAccess(artifactError)) ||
      (versionError && !noAccess(versionError));
  }).length;
  const shown = all ? known : known.slice(0, DOCUMENTS_SHOWN);
  return (
    <UI.DescriptionItem
      title={t("tasks.run.handover.documents", { count: refs.length })}
      description={refs.length === 0
        ? t("tasks.run.handover.documentsNone")
        : (
          <UI.Stack gap="tight">
            {shown.map((document) => (
              <UI.Link
                key={document.versionId}
                variant="sentence"
                href={`/files/versions/${document.versionId}`}
              >
                {t("tasks.run.handover.documentVersion", {
                  name: document.name,
                  version: document.revision,
                })}
              </UI.Link>
            ))}
            {known.length > DOCUMENTS_SHOWN && !all
              ? (
                <UI.Button variant="quiet" onClick={() => setAll(true)}>
                  {t("tasks.run.handover.showAll", { count: known.length })}
                </UI.Button>
              )
              : null}
            {unchecked === 0 ? null : (
              <UI.Text
                variant="muted"
                data-testid="handover-documents-unchecked"
              >
                {t("tasks.run.handover.documentsUnchecked", {
                  count: unchecked,
                })}
              </UI.Text>
            )}
            {gone === 0
              ? null
              : (
                <UI.Text variant="muted" data-testid="handover-documents-gone">
                  {t("tasks.run.handover.documentsGone", { count: gone })}
                </UI.Text>
              )}
            {hidden === 0 ? null : (
              <UI.Text
                variant="muted"
                data-testid="handover-documents-hidden"
              >
                {t("tasks.run.handover.documentsHidden", { count: hidden })}
              </UI.Text>
            )}
          </UI.Stack>
        )}
    />
  );
}
