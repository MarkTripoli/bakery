import { summarizePatch } from "./patch-summary.ts";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import { useBakeryApi } from "../api/context.tsx";
import {
  artifactsListQueryOptions,
  artifactVersionsQueryOptions,
  runOutputStepIdsQueryOptions,
} from "../api/query.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { protectedQueryKey } from "../app/query-scope.ts";
import type { ApiFailure, ArtifactVersionResponse } from "../api/client.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { FingerprintRow } from "./FingerprintRow.tsx";

export function TaskRunRevision(
  { taskId, runId, baseSha }: {
    readonly taskId: string;
    readonly runId: string;
    readonly baseSha: string | null;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { translate: t } = useI18n();
  const [cursor, setCursor] = useState<string | undefined>();
  const [artifactId, setArtifactId] = useState<string | undefined>();
  const steps = useQuery(runOutputStepIdsQueryOptions(api, scope, runId));
  const artifacts = useQuery(
    artifactsListQueryOptions(api, scope, {
      taskId,
      artifactType: "patch",
      cursor,
      limit: 25,
    }),
  );
  const items = artifacts.isError
    ? []
    : artifacts.data?.items.filter((artifact) =>
      artifact.taskId === taskId && artifact.artifactType === "patch"
    ) ?? [];
  const selected = items.find((artifact) => artifact.id === artifactId) ??
    items[0];
  return (
    <UI.Stack>
      {selected
        ? (
          <>
            {items.length > 1 && (
              <UI.Combobox
                label={t("tasks.run.revision.artifact")}
                options={items.map((artifact) => ({
                  label: artifact.name,
                  value: artifact.id,
                }))}
                value={selected.id}
                onChange={(event) => setArtifactId(event.target.value)}
              />
            )}
            <PatchRevisions
              key={selected.id}
              taskId={taskId}
              artifactId={selected.id}
              currentVersionId={selected.currentVersionId}
              runId={runId}
              stepIds={steps.isError ? [] : steps.data ?? []}
              baseSha={baseSha}
            />
          </>
        )
        : <UnknownRevision baseSha={baseSha} />}
      {(artifacts.isError || steps.isError) && (
        <UI.Text>{t("tasks.run.revision.unavailable")}</UI.Text>
      )}
      {cursor && (
        <UI.Button onClick={() => setCursor(undefined)}>
          {t("tasks.run.revision.first")}
        </UI.Button>
      )}
      {artifacts.data?.nextCursor && !artifacts.isError && (
        <UI.Button
          onClick={() => setCursor(artifacts.data?.nextCursor ?? undefined)}
        >
          {t("projects.onboarding.pagination.next")}
        </UI.Button>
      )}
    </UI.Stack>
  );
}

function UnknownRevision({ baseSha }: { readonly baseSha: string | null }) {
  const { translate: t } = useI18n();
  return (
    <UI.RevisionSummary
      title={t("tasks.run.revision.title")}
      baseRevision={baseSha?.slice(0, 7) ?? null}
      candidateRevision={null}
      summary={null}
      disclaimer={t("tasks.run.revision.disclaimer")}
      unknownLabel={t("tasks.run.unknown")}
    />
  );
}

function PatchRevisions(
  { taskId, runId, artifactId, currentVersionId, stepIds, baseSha }: {
    readonly taskId: string;
    readonly runId: string;
    readonly artifactId: string;
    readonly currentVersionId: string | null;
    readonly stepIds: readonly string[];
    readonly baseSha: string | null;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { translate: t } = useI18n();
  const [cursor, setCursor] = useState<string | undefined>();
  const versions = useQuery({
    ...artifactVersionsQueryOptions(api, scope, artifactId, {
      limit: 25,
      cursor,
    }),
    queryKey: protectedQueryKey(scope, "runArtifactVersions.list", {
      artifactId,
      taskId,
      runId,
      currentVersionId,
      cursor: cursor ?? null,
    }),
    refetchInterval: 5000,
  });
  const candidates = versions.isError
    ? []
    : versions.data?.items.filter((version) =>
      version.artifactId === artifactId &&
      version.runStepId !== null &&
      stepIds.includes(version.runStepId) && version.subjectHeadSha !== null
    ) ?? [];
  return (
    <UI.Stack>
      {candidates.length === 0
        ? <UnknownRevision baseSha={baseSha} />
        : candidates.map((version) => (
          <PatchContent
            key={version.id}
            taskId={taskId}
            version={version}
            baseSha={baseSha}
          />
        ))}
      {versions.isError && (
        <UI.Text>{t("tasks.run.revision.unavailable")}</UI.Text>
      )}
      {cursor && (
        <UI.Button onClick={() => setCursor(undefined)}>
          {t("tasks.run.revision.first")}
        </UI.Button>
      )}
      {versions.data?.nextCursor && !versions.isError && (
        <UI.Button
          onClick={() => setCursor(versions.data?.nextCursor ?? undefined)}
        >
          {t("projects.onboarding.pagination.next")}
        </UI.Button>
      )}
    </UI.Stack>
  );
}

function PatchContent(
  { taskId, version, baseSha }: {
    readonly taskId: string;
    readonly baseSha: string | null;
    readonly version: ArtifactVersionResponse;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { translate: t } = useI18n();
  const [open, setOpen] = useState(false);
  const content = useQuery({
    queryKey: protectedQueryKey(scope, "runPatch.content", {
      taskId,
      versionId: version.id,
      digest: version.sha256,
    }),
    enabled: scope.organizationId !== null &&
      version.sizeBytes <= 1024 * 1024,
    retry: false,
    queryFn: async ({ signal }) => {
      if (!scope.organizationId) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      const result = await api.getArtifactContent({
        organizationId: scope.organizationId,
        versionId: version.id,
        expectedSha256: version.sha256.toLowerCase(),
        signal,
      });
      if (!result.ok) throw result.error;
      if (
        result.data.status !== 200 ||
        result.data.content.byteLength !== version.sizeBytes
      ) throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      return new TextDecoder("utf-8", { fatal: true }).decode(
        result.data.content,
      );
    },
  });
  const summary = content.isError || content.data === undefined
    ? null
    : summarizePatch(content.data);
  return (
    <UI.RevisionSummary
      title={t("tasks.run.revision.title")}
      baseRevision={(version.subjectBaseSha ?? baseSha)?.slice(0, 7) ?? null}
      candidateRevision={version.subjectHeadSha?.slice(0, 7) ?? null}
      summary={summary
        ? t("tasks.run.revision.changeSummary", {
          files: summary.files,
          added: summary.added,
          removed: summary.removed,
        })
        : null}
      disclaimer={t("tasks.run.revision.disclaimer")}
      unknownLabel={t("tasks.run.unknown")}
      action={
        <UI.Button
          variant="outline"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {t(open ? "tasks.run.revision.hideDiff" : "tasks.run.revision.diff")}
        </UI.Button>
      }
    >
      {open && (
        <>
          <UI.Text>
            {t("tasks.run.revision.version", { revision: version.revision })}
          </UI.Text>
          <FingerprintRow fingerprint={version.sha256} />
          <UI.Text>
            {version.subjectBaseSha ?? baseSha} → {version.subjectHeadSha}
          </UI.Text>
          {version.sizeBytes > 1024 * 1024
            ? <UI.Text>{t("tasks.run.revision.tooLarge")}</UI.Text>
            : content.isError
            ? <UI.Text>{t("tasks.run.revision.unavailable")}</UI.Text>
            : content.isPending
            ? <UI.Text>{t("tasks.run.output.loading")}</UI.Text>
            : (
              <>
                <UI.Text>
                  {summary
                    ? t("tasks.run.revision.patchSummary", {
                      files: summary.files,
                      added: summary.added,
                      removed: summary.removed,
                    })
                    : t("tasks.run.unknown")}
                </UI.Text>
                <UI.CodeBlock code={content.data} language="diff" />
              </>
            )}
        </>
      )}
    </UI.RevisionSummary>
  );
}
