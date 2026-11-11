import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import { ArtifactRevisionDetailsView } from "./ArtifactRevisionDetailsView.tsx";
import {
  type ArtifactExtractionResponse,
  type ArtifactResponse,
  type ArtifactVersionResponse,
  authProblemCode,
} from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import { useLiveConnection } from "../api/use-live-events.ts";
import {
  artifactExtractionQueryOptions,
  artifactQueryOptions,
  artifactsListQueryOptions,
  artifactStorageQueryOptions,
  artifactVersionsQueryOptions,
} from "../api/query.ts";
import {
  ORGANIZATIONS_PATH,
  RECOVERY_CODE_PATH,
  SIGN_IN_PATH,
  TWO_FACTOR_PATH,
} from "../app/auth-required.tsx";
import { rememberDestination } from "../app/auth-return.ts";
import * as organizationSelection from "../app/organization-selection.ts";
import {
  useProtectedScope,
  useQueryScopeController,
} from "../app/query-scope-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import {
  ArtifactPreviewView,
  ArtifactRetrievalView,
  ArtifactUnavailableView,
} from "./ArtifactRetrievalView.tsx";
import { useCursorPages } from "./projects-onboarding/useCursorPages.ts";
import { ArtifactStorageStatus } from "./ArtifactStorageStatus.tsx";
import { ArtifactPinControl } from "./ArtifactPinControl.tsx";
import { ArtifactPreviewHandoff } from "./ArtifactPreviewHandoff.tsx";
import { ArtifactComments } from "./ArtifactComments.tsx";
import { ArtifactContentPreview } from "./ArtifactContentPreview.tsx";
import { isExtractableMediaType } from "./artifact-media.ts";
import { invalidateArtifactQueries } from "./artifact-live.ts";

const MAX_EXTRACTION_BYTES = 65_536;
/** Session Problems meaning "authenticate again", not "this artifact failed". */
const SESSION_FAILURE_CODES: Record<string, true> = {
  AUTH_REQUIRED: true,
  AUTH_INVALID: true,
  AUTH_EXPIRED: true,
  AUTH_FACTOR_REQUIRED: true,
};

type ArtifactPageProps = Readonly<{
  taskId: string;
  artifactId: string;
}>;

type DownloadState = "idle" | "loading" | "success";

/**
 * Which whole-route surface is rendered. Every failure is decided *before*
 * the loading gate, and the loading gate reads the same `currentVersionId`
 * the dependent query's own `enabled` flag reads — so a disabled (and
 * therefore permanently `pending`) `versions` query can no longer pin the
 * route to the skeleton when the artifact request itself failed.
 */
type RetrievalView =
  | { readonly kind: "loading" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "auth-required" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "offline" }
  | { readonly kind: "error" }
  | { readonly kind: "ready"; readonly artifact: ArtifactResponse };

type OrganizationResolutionState = "loading" | "error";
type RetryFocusRequest = Readonly<{
  readonly location: string;
  readonly taskId: string;
  readonly artifactId: string;
  readonly sessionGeneration: number;
  readonly organizationId: string | null;
  readonly organizationResolutionAttempt: number | null;
}>;

type OrganizationResolutionRun = Readonly<{
  readonly location: string;
  readonly taskId: string;
  readonly artifactId: string;
  readonly sessionGeneration: number;
  readonly organizationId: string | null;
  readonly attempt: number;
  readonly status: "active" | "selected" | "choose" | "failed" | "aborted";
}>;

/** Attachment-safe file name: transliterated, bounded, and revision-pinned. */
function safeDownloadName(name: string, revision: number): string {
  const normalized = name.normalize("NFKC").replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "").slice(0, 80);
  return `${normalized || "artifact"}-r${revision}.bin`;
}

function failureCode(error: unknown): string | null {
  const authCode = authProblemCode(error);
  if (authCode !== null) return authCode;
  if (
    typeof error !== "object" || error === null || !("kind" in error) ||
    !("problem" in error)
  ) {
    return null;
  }
  const candidate = error;
  if (
    candidate.kind !== "problem" || candidate.problem === null ||
    typeof candidate.problem !== "object" || !("code" in candidate.problem)
  ) {
    return null;
  }
  const code = candidate.problem.code;
  return typeof code === "string" ? code : null;
}

function isNetworkFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null && "kind" in error &&
    error.kind === "network";
}

function validExtraction(
  extraction: ArtifactExtractionResponse,
  version: ArtifactVersionResponse,
): boolean {
  const byteLength = new TextEncoder().encode(extraction.text).byteLength;
  return extraction.versionId === version.id &&
    extraction.sha256.toLowerCase() === version.sha256.toLowerCase() &&
    isExtractableMediaType(extraction.mediaType) &&
    Number.isSafeInteger(extraction.startByte) && extraction.startByte >= 0 &&
    Number.isSafeInteger(extraction.endByteExclusive) &&
    extraction.endByteExclusive >= extraction.startByte &&
    extraction.endByteExclusive - extraction.startByte === byteLength &&
    extraction.endByteExclusive <= version.sizeBytes &&
    extraction.hasMore === extraction.endByteExclusive < version.sizeBytes &&
    byteLength <= MAX_EXTRACTION_BYTES;
}

export function ArtifactRetrievalPage(
  { artifactId, taskId }: ArtifactPageProps,
) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const api = useBakeryApi();
  const queryClient = useQueryClient();
  const queryScope = useQueryScopeController();
  const scope = useProtectedScope();
  const navigate = useNavigate();
  const location = useRouterState({ select: (state) => state.location });
  const { translate } = useI18n();
  const [organizationResolutionState, setOrganizationResolutionState] =
    useState<OrganizationResolutionState>("loading");
  const [organizationResolutionError, setOrganizationResolutionError] =
    useState<unknown>(null);
  const [organizationResolutionAttempt, setOrganizationResolutionAttempt] =
    useState(0);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(
    null,
  );
  const downloadRequest = useRef(0);
  const downloadAbort = useRef<AbortController | null>(null);
  const [downloadState, setDownloadState] = useState<DownloadState>("idle");
  const [downloadError, setDownloadError] = useState(false);
  const [startByteInput, setStartByteInput] = useState("0");
  const [extractionInput, setExtractionInput] = useState<
    {
      readonly startByte: number;
      readonly maxBytes: number;
    } | null
  >(null);
  const [extractionValidationError, setExtractionValidationError] = useState<
    string | null
  >(null);
  const [online, setOnline] = useState(() =>
    globalThis.navigator?.onLine ?? true
  );
  const retryFocusRequest = useRef<RetryFocusRequest | null>(null);
  const organizationResolutionRun = useRef<OrganizationResolutionRun | null>(
    null,
  );

  const scoped = scope.organizationId !== null;
  const locationToken = `${location.pathname}${location.searchStr}${
    location.hash ? `#${location.hash}` : ""
  }`;

  // A bookmark, a refresh, a new tab or `window.open` reaches this protected
  // route with the in-memory `QueryScopeController` still at its initial
  // `organizationId: null`, because `setIdentity` is only reached from the
  // authentication transitions. Hydrate the scope with the same shared
  // `organizationSelection.resolve` those transitions use — it re-selects the
  // remembered organization and auto-selects a sole membership — and when the
  // principal genuinely has to pick, keep this artifact deep link and hand
  // them to the picker that already consumes it.
  const locationRef = useRef(location);
  // Navigating to the picker must not replace the original protected deep link
  // while the outstanding organization-resolution effect is still settling.
  if (location.pathname === `/tasks/${taskId}/artifacts/${artifactId}`) {
    locationRef.current = location;
  }
  useEffect(() => {
    if (scoped) {
      setOrganizationResolutionState("loading");
      setOrganizationResolutionError(null);
      return;
    }
    const resolutionRun: OrganizationResolutionRun = {
      location: locationToken,
      taskId,
      artifactId,
      sessionGeneration: scope.sessionGeneration,
      organizationId: scope.organizationId,
      attempt: organizationResolutionAttempt,
      status: "active",
    };
    organizationResolutionRun.current = resolutionRun;
    const setResolutionRunStatus = (
      status: OrganizationResolutionRun["status"],
    ) => {
      const current = organizationResolutionRun.current;
      if (
        current !== null &&
        current.location === resolutionRun.location &&
        current.taskId === resolutionRun.taskId &&
        current.artifactId === resolutionRun.artifactId &&
        current.sessionGeneration === resolutionRun.sessionGeneration &&
        current.organizationId === resolutionRun.organizationId &&
        current.attempt === resolutionRun.attempt
      ) {
        organizationResolutionRun.current = { ...current, status };
      }
    };
    setOrganizationResolutionState("loading");
    const controller = new AbortController();
    void (async () => {
      try {
        const outcome = await organizationSelection.resolve(
          api,
          queryScope,
          undefined,
          controller.signal,
        );
        if (outcome === "selected") {
          setResolutionRunStatus("selected");
          return;
        }
        setResolutionRunStatus("choose");
        if (controller.signal.aborted) return;
        rememberDestination(locationRef.current);
        void navigate({ to: ORGANIZATIONS_PATH });
      } catch (error) {
        if (controller.signal.aborted) {
          const currentScope = queryScope.getSnapshot();
          if (
            currentScope.sessionGeneration ===
              resolutionRun.sessionGeneration &&
            currentScope.organizationId === resolutionRun.organizationId
          ) {
            setResolutionRunStatus("aborted");
          }
          return;
        }
        setResolutionRunStatus("failed");
        setOrganizationResolutionError(error);
        setOrganizationResolutionState("error");
      }
    })();
    return () => controller.abort();
  }, [
    api,
    artifactId,
    locationToken,
    navigate,
    organizationResolutionAttempt,
    queryScope,
    scope.organizationId,
    scope.sessionGeneration,
    taskId,
    scoped,
  ]);

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    globalThis.addEventListener("online", goOnline);
    globalThis.addEventListener("offline", goOffline);
    return () => {
      globalThis.removeEventListener("online", goOnline);
      globalThis.removeEventListener("offline", goOffline);
    };
  }, []);

  // Version, update and comment events carry no bodies; they only tell the page
  // to re-read its authorized artifact, version and comment queries. A reconnect
  // resubscribes and calls this once more, so missed events are covered too.
  const { state: live, reconnect } = useLiveConnection(
    [{ type: "task", id: taskId }],
    useCallback(
      () => void invalidateArtifactQueries(queryClient, scope),
      [queryClient, scope],
    ),
  );

  const artifactList = useQuery({
    ...artifactsListQueryOptions(api, scope, { taskId }),
    enabled: scoped,
  });
  const artifact = useQuery({
    ...artifactQueryOptions(api, scope, artifactId),
    enabled: scoped,
  });
  const versions = useQuery({
    ...artifactVersionsQueryOptions(api, scope, artifactId, { limit: 100 }),
    enabled: scoped && artifact.data !== undefined &&
      artifact.data.currentVersionId !== null,
  });

  const versionPages = useCursorPages(
    versions,
    `${scope.sessionGeneration}:${scope.organizationId}:${artifactId}`,
    useCallback((cursor: string) =>
      queryClient.fetchQuery(
        artifactVersionsQueryOptions(api, scope, artifactId, {
          cursor,
          limit: 100,
        }),
      ), [api, scope, artifactId, queryClient]),
  );

  /**
   * Abandons any in-flight download: the counter invalidates a response that
   * is already being awaited — so no late `anchor.click()` saves a file for a
   * route the principal has left, or under a scope they no longer hold — and
   * the controller stops the transfer itself rather than streaming an entire
   * artifact body to nobody.
   */
  const cancelDownload = useCallback(() => {
    downloadRequest.current += 1;
    downloadAbort.current?.abort();
    downloadAbort.current = null;
  }, []);

  useEffect(() => cancelDownload, [cancelDownload]);

  // An organization switch or a sign-out (both advance the scope generation)
  // must drop a transfer authorized under the previous scope.
  useEffect(() => {
    cancelDownload();
    setDownloadState("idle");
    setDownloadError(false);
  }, [cancelDownload, scope.organizationId, scope.sessionGeneration]);

  const linkedCommentId = new URLSearchParams(location.searchStr).get(
    "comment",
  );
  const linkedVersionId = new URLSearchParams(location.searchStr).get(
    "version",
  );
  const currentVersionId = artifact.data?.currentVersionId ?? null;
  // The newest id moves whenever someone else publishes; that must not drop a
  // transfer of the revision being read. Only the viewed revision or the
  // artifact changing resets the download.
  const viewedVersionId = linkedVersionId ?? selectedVersionId;
  const downloadKey = `${artifactId}:${viewedVersionId ?? ""}`;
  const downloadKeyRef = useRef(downloadKey);
  useEffect(() => {
    if (downloadKeyRef.current === downloadKey) return;
    downloadKeyRef.current = downloadKey;
    cancelDownload();
    setDownloadState("idle");
    setDownloadError(false);
    setExtractionInput(null);
    setExtractionValidationError(null);
  }, [cancelDownload, downloadKey]);
  useEffect(() => {
    setSelectedVersionId((prior) =>
      linkedVersionId ??
        (versionPages.items.some((version) => version.id === prior)
          ? prior
          : currentVersionId)
    );
  }, [currentVersionId, linkedVersionId]);

  const selectedVersion =
    versionPages.items.find((version) => version.id === selectedVersionId) ??
      null;
  useEffect(() => {
    if (
      linkedVersionId && selectedVersion === null && versionPages.hasNext &&
      !versionPages.loadingMore && !versionPages.moreError
    ) versionPages.loadMore();
  }, [linkedVersionId, selectedVersion, versionPages]);
  const extraction = useQuery({
    ...artifactExtractionQueryOptions(
      api,
      scope,
      selectedVersionId ?? artifactId,
      extractionInput ?? { startByte: 0, maxBytes: MAX_EXTRACTION_BYTES },
    ),
    enabled: scoped && selectedVersion !== null && extractionInput !== null,
  });

  // `artifactList` is deliberately absent from the gates below: it only feeds
  // one caption, so its failure must neither mask the artifact's own failure
  // code nor deny a principal the artifact they are authorized to read.
  const queryError = artifact.error ?? versions.error;
  const routeError = !scoped
    ? organizationResolutionError ?? queryError
    : queryError;
  const routeFailureCode = failureCode(routeError);
  const hasFailure = (!scoped && organizationResolutionError !== null) ||
    artifact.isError || versions.isError;
  const retrying = (!scoped && organizationResolutionState === "loading") ||
    artifact.isFetching || versions.isFetching;
  const extractionResult = extraction.data;
  const extractionIsValid = selectedVersion !== null && extractionResult !==
      undefined &&
    validExtraction(extractionResult, selectedVersion);

  const rememberAuthDestination = () => {
    rememberDestination(locationRef.current);
  };
  const authRecoveryAction = routeFailureCode === "AUTH_FACTOR_REQUIRED"
    ? (
      <UI.Inline gap="compact" variant="actions">
        <UI.Button
          data-testid="artifact-retrieval-auth-action"
          onClick={() => {
            rememberAuthDestination();
            void navigate({ to: TWO_FACTOR_PATH });
          }}
        >
          {translate("auth.twoFactor.verify")}
        </UI.Button>
        <UI.Link
          data-testid="artifact-retrieval-recovery-action"
          href={RECOVERY_CODE_PATH}
          onClick={(event) => {
            event.preventDefault();
            rememberAuthDestination();
            void navigate({ to: RECOVERY_CODE_PATH });
          }}
        >
          {translate("auth.twoFactor.useBackupCode")}
        </UI.Link>
      </UI.Inline>
    )
    : (
      <UI.Button
        data-testid="artifact-retrieval-auth-action"
        onClick={() => {
          rememberAuthDestination();
          if (
            routeFailureCode === "AUTH_EXPIRED" ||
            routeFailureCode === "AUTH_INVALID"
          ) {
            void navigate({
              to: SIGN_IN_PATH,
              search: { reason: "expired" },
            });
          } else {
            void navigate({ to: SIGN_IN_PATH });
          }
        }}
      >
        {translate("auth.signIn.submit")}
      </UI.Button>
    );

  const view: RetrievalView = routeFailureCode === "AUTH_FORBIDDEN"
    ? { kind: "forbidden" }
    : routeFailureCode !== null &&
        Object.hasOwn(SESSION_FAILURE_CODES, routeFailureCode)
    ? { kind: "auth-required" }
    : routeFailureCode === "RESOURCE_NOT_FOUND"
    ? { kind: "unavailable" }
    : !scoped
    ? organizationResolutionError === null
      ? { kind: "loading" }
      : hasFailure && (!online || isNetworkFailure(routeError))
      ? { kind: "offline" }
      : { kind: "error" }
    : hasFailure && (!online || isNetworkFailure(routeError))
    ? { kind: "offline" }
    : hasFailure
    ? { kind: "error" }
    : artifact.isPending || (currentVersionId !== null && versions.isPending)
    ? { kind: "loading" }
    : artifact.data === undefined || artifact.data.taskId !== taskId
    ? { kind: "unavailable" }
    : { kind: "ready", artifact: artifact.data };

  const detailState = view.kind === "loading"
    ? "loading"
    : retrying
    ? "reconnecting"
    : view.kind === "forbidden"
    ? "forbidden"
    : view.kind === "ready"
    ? "ready"
    : "error";

  useEffect(() => {
    const cancelRetryFocus = () => {
      retryFocusRequest.current = null;
    };
    document.addEventListener("keydown", cancelRetryFocus, true);
    document.addEventListener("pointerdown", cancelRetryFocus, true);
    return () => {
      document.removeEventListener("keydown", cancelRetryFocus, true);
      document.removeEventListener("pointerdown", cancelRetryFocus, true);
    };
  }, []);

  useEffect(() => {
    const request = retryFocusRequest.current;
    if (request === null) return;
    const sameScope = request.sessionGeneration === scope.sessionGeneration &&
      request.organizationId === scope.organizationId;
    // A retry from an unscoped page may legitimately cross null -> the
    // selected organization while this resolver is still settling. That one
    // generation step is allowed only for the matching resolution run; any
    // later tenant, session, task, artifact, or full-location change drops it.
    const organizationResolutionScopeChange = request.organizationId === null &&
      scope.organizationId !== null &&
      scope.sessionGeneration === request.sessionGeneration + 1 &&
      request.organizationResolutionAttempt !== null &&
      organizationResolutionRun.current !== null &&
      organizationResolutionRun.current.location === request.location &&
      organizationResolutionRun.current.taskId === request.taskId &&
      organizationResolutionRun.current.artifactId === request.artifactId &&
      organizationResolutionRun.current.sessionGeneration ===
        request.sessionGeneration &&
      organizationResolutionRun.current.attempt ===
        request.organizationResolutionAttempt &&
      (
        organizationResolutionRun.current.status === "active" ||
        organizationResolutionRun.current.status === "selected"
      );
    if (
      request.location !== locationToken ||
      request.taskId !== taskId ||
      request.artifactId !== artifactId ||
      (!sameScope && !organizationResolutionScopeChange)
    ) {
      retryFocusRequest.current = null;
      return;
    }
    if (retrying || view.kind !== "ready") return;
    retryFocusRequest.current = null;
    const heading = document.querySelector(
      "[data-artifact-retrieval-detail] h1",
    );
    if (!(heading instanceof HTMLElement)) return;
    heading.tabIndex = -1;
    heading.focus();
  }, [
    artifactId,
    locationToken,
    retrying,
    scope.organizationId,
    scope.sessionGeneration,
    taskId,
    view.kind,
  ]);

  const download = async () => {
    if (
      downloadState === "loading" || scope.organizationId === null ||
      artifact.data === undefined || selectedVersion === null
    ) {
      return;
    }
    cancelDownload();
    const controller = new AbortController();
    downloadAbort.current = controller;
    const request = downloadRequest.current;
    setDownloadState("loading");
    setDownloadError(false);
    try {
      const result = await api.getArtifactContent({
        organizationId: scope.organizationId,
        versionId: selectedVersion.id,
        expectedSha256: selectedVersion.sha256.toLowerCase(),
        signal: controller.signal,
      });
      if (!result.ok) throw result.error;
      if (request !== downloadRequest.current) return;
      const content = result.data;
      if (
        content.status !== 200 || content.content === null ||
        content.contentDigest !== selectedVersion.sha256.toLowerCase() ||
        content.contentLength !== selectedVersion.sizeBytes ||
        content.content.byteLength !== selectedVersion.sizeBytes
      ) {
        throw new Error("ARTIFACT_DOWNLOAD_DIGEST_MISMATCH");
      }
      const blob = new Blob([content.content.buffer as ArrayBuffer], {
        type: content.contentType,
      });
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = safeDownloadName(
        artifact.data.name,
        selectedVersion.revision,
      );
      anchor.hidden = true;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      globalThis.setTimeout(() => URL.revokeObjectURL(href), 0);
      setDownloadState("success");
    } catch {
      if (request !== downloadRequest.current) return;
      setDownloadState("idle");
      setDownloadError(true);
    } finally {
      if (downloadAbort.current === controller) downloadAbort.current = null;
    }
  };

  const extract = () => {
    if (selectedVersion === null || extraction.isFetching) return;
    const value = startByteInput.trim();
    if (!/^(?:0|[1-9]\d*)$/.test(value)) {
      setExtractionValidationError(
        translate("artifact.retrieval.invalidOffsetDescription"),
      );
      return;
    }
    const startByte = Number(value);
    if (
      !Number.isSafeInteger(startByte) || startByte > selectedVersion.sizeBytes
    ) {
      setExtractionValidationError(
        translate("artifact.retrieval.invalidOffsetDescription"),
      );
      return;
    }
    setExtractionValidationError(null);
    setExtractionInput({ startByte, maxBytes: MAX_EXTRACTION_BYTES });
  };

  // Recoverable failures keep an in-place retry. A keyboard-initiated retry
  // returns focus to the stable page heading after the replacement succeeds.
  const retryAction = (
    <UI.Button
      aria-busy={retrying || undefined}
      data-testid="artifact-retrieval-retry"
      onClick={(event) => {
        const keyboardRetry = event.detail === 0 &&
          document.activeElement === event.currentTarget;
        retryFocusRequest.current = keyboardRetry
          ? {
            location: locationToken,
            taskId,
            artifactId,
            sessionGeneration: scope.sessionGeneration,
            organizationId: scope.organizationId,
            organizationResolutionAttempt:
              !scoped && organizationResolutionError !== null
                ? organizationResolutionAttempt + 1
                : null,
          }
          : null;
        if (!scoped && organizationResolutionError !== null) {
          setOrganizationResolutionAttempt((attempt) => attempt + 1);
          return;
        }
        void artifact.refetch();
        void versions.refetch();
      }}
      state={retrying ? "busy" : "default"}
      variant="secondary"
    >
      {translate("core.actions.retry")}
    </UI.Button>
  );

  const title = view.kind === "ready"
    ? view.artifact.name
    : view.kind === "loading"
    ? translate("artifact.retrieval.loadingTitle")
    : view.kind === "forbidden"
    ? translate("artifact.retrieval.forbiddenTitle")
    : view.kind === "auth-required"
    ? translate("artifact.retrieval.authRequiredTitle")
    : view.kind === "unavailable"
    ? translate("artifact.retrieval.unavailableTitle")
    : view.kind === "offline"
    ? translate("shell.states.offlineTitle")
    : translate("artifact.retrieval.errorTitle");

  const versionItems = versionPages.items;

  const downloadFeedback = selectedVersion
    ? (
      <>
        {downloadError
          ? (
            <UI.InlineNotice tone="error">
              {translate("artifact.retrieval.downloadFailed")}
            </UI.InlineNotice>
          )
          : downloadState === "success"
          ? (
            <UI.InlineNotice
              data-testid="artifact-retrieval-download-verified"
              tone="success"
            >
              {translate("artifact.retrieval.downloadVerified", {
                digest: selectedVersion.sha256,
              })}
            </UI.InlineNotice>
          )
          : null}
        {selectedVersion.sizeBytes === 0
          ? (
            <UI.InlineNotice
              data-testid="artifact-retrieval-empty-content"
              tone="information"
            >
              {translate(
                "artifact.retrieval.emptyContentDescription",
              )}
            </UI.InlineNotice>
          )
          : null}
      </>
    )
    : null;

  const content = (
    <>
      {view.kind === "loading" || view.kind === "forbidden"
        ? null
        : view.kind === "auth-required"
        ? (
          <UI.ErrorState
            action={authRecoveryAction}
            data-testid="artifact-retrieval-auth-required"
            description={translate(
              "artifact.retrieval.authRequiredDescription",
            )}
            title={translate("artifact.retrieval.authRequiredTitle")}
            variant="region"
          />
        )
        : view.kind === "unavailable"
        ? (
          <UI.ErrorState
            data-testid="artifact-retrieval-unavailable"
            description={translate("artifact.retrieval.unavailableDescription")}
            title={translate("artifact.retrieval.unavailableTitle")}
            variant="region"
          />
        )
        : view.kind === "offline"
        ? (
          <UI.ErrorState
            action={retryAction}
            data-testid="artifact-retrieval-offline"
            description={translate("shell.states.offlineDescription")}
            state={retrying ? "retrying" : "default"}
            title={translate("shell.states.offlineTitle")}
            variant="region"
          />
        )
        : view.kind === "error"
        ? (
          <UI.ErrorState
            action={retryAction}
            data-testid="artifact-retrieval-error"
            description={translate("artifact.retrieval.errorDescription")}
            state={retrying ? "retrying" : "default"}
            title={translate("artifact.retrieval.errorTitle")}
            variant="region"
          />
        )
        : (
          <ArtifactRevisionDetailsView
            artifact={view.artifact}
            organizationId={scope.organizationId}
            artifactCount={artifactList.data?.nextCursor === null
              ? artifactList.data.items.length
              : undefined}
            retrying={retrying}
            selectedVersion={selectedVersion}
            versionItems={versionItems}
            onSelectVersion={(versionId) => {
              cancelDownload();
              setSelectedVersionId(versionId);
              void navigate({
                to: "/tasks/$taskId/artifacts/$artifactId",
                params: { taskId, artifactId },
                search: { version: versionId },
              });
              setExtractionInput(null);
              setExtractionValidationError(null);
              setDownloadState("idle");
              setDownloadError(false);
            }}
            extraction={{
              maxBytes: MAX_EXTRACTION_BYTES,
              startByte: startByteInput,
              onStartByteChange: setStartByteInput,
              onExtract: extract,
              validationError: extractionValidationError,
              loading: extraction.isFetching,
              failed: extraction.isError,
              requested: extractionInput !== null,
              invalid: extractionResult !== undefined && !extractionIsValid,
              result: extractionIsValid ? extractionResult : null,
            }}
          />
        )}
    </>
  );
  if (view.kind === "ready") {
    // The newest revision may have moved since this one was opened. Keep the
    // reader on the immutable revision they chose and offer the newest one.
    const newestId = view.artifact.currentVersionId;
    const newest = newestId === null
      ? undefined
      : versionItems.find((item) => item.id === newestId);
    const notices: UI.ArtifactLayoutNotice[] = [];
    if (live === "lost") {
      notices.push({
        id: "reconnecting",
        title: translate("artifact.live.reconnectingTitle"),
        description: translate("artifact.live.reconnectingDescription"),
        tone: "warning",
        actions: (
          <UI.Button
            variant="outline"
            onClick={() => {
              reconnect();
              void invalidateArtifactQueries(queryClient, scope);
            }}
          >
            {translate("artifact.live.retry")}
          </UI.Button>
        ),
      });
    }
    if (
      selectedVersion !== null && newestId !== null &&
      selectedVersion.id !== newestId
    ) {
      const openNewest = () =>
        void navigate({
          to: "/tasks/$taskId/artifacts/$artifactId",
          params: { taskId, artifactId },
          search: { version: newestId },
        });
      notices.push({
        id: "stale",
        title: translate("artifact.live.staleTitle"),
        description: translate("artifact.live.staleDescription", {
          revision: selectedVersion.revision,
        }),
        tone: "information",
        actions: (
          <UI.Link
            data-testid="artifact-retrieval-open-newest"
            href={`/tasks/${taskId}/artifacts/${artifactId}?version=${newestId}`}
            onClick={(event) => {
              event.preventDefault();
              openNewest();
            }}
          >
            {newest
              ? translate("artifact.live.staleOpen", {
                revision: newest.revision,
              })
              : translate("artifact.live.staleOpenNewest")}
          </UI.Link>
        ),
      });
    }
    const discussion = selectedVersion
      ? (
        <ArtifactComments
          key={`comments:${scope.sessionGeneration}:${selectedVersion.id}`}
          artifact={view.artifact}
          version={selectedVersion}
          commentId={new URLSearchParams(location.searchStr).get("comment") ??
            undefined}
        />
      )
      : null;
    return (
      <ArtifactRetrievalView
        testId="artifact-retrieval-page"
        title={title}
        artifactLabel={translate("artifact.view.eyebrow")}
        kind={selectedVersion?.mediaType ?? view.artifact.artifactType}
        revision={selectedVersion
          ? translate("artifact.version.label", {
            revision: selectedVersion.revision,
          })
          : translate("artifact.retrieval.noCurrentVersion")}
        description={selectedVersion
          ? translate("artifact.view.description", {
            author: selectedVersion.authorId,
            step: selectedVersion.runStepId ??
              translate("artifact.retrieval.notAvailable"),
            size: selectedVersion.sizeBytes,
          })
          : translate("artifact.retrieval.emptyNotice")}
        versionLabel={translate("artifact.retrieval.versionsTitle")}
        versionId={selectedVersion?.id ?? ""}
        versions={versionItems.map((version) => ({
          id: version.id,
          label: translate("artifact.version.label", {
            revision: version.revision,
          }),
        }))}
        onVersionChange={(version) => {
          void navigate({
            to: "/tasks/$taskId/artifacts/$artifactId",
            params: { taskId, artifactId },
            search: { version },
          });
        }}
        download={selectedVersion
          ? {
            label: downloadState === "loading"
              ? translate("artifact.retrieval.downloading")
              : translate("artifact.retrieval.download"),
            busy: downloadState === "loading",
            onClick: () => void download(),
            testId: "artifact-retrieval-download",
          }
          : undefined}
        pinControl={
          <ArtifactPinControl
            key={`pin:${scope.sessionGeneration}:${artifactId}`}
            artifact={view.artifact}
            onUpdated={async () => {
              await Promise.all([
                artifact.refetch(),
                queryClient.invalidateQueries({
                  queryKey: artifactStorageQueryOptions(api, scope).queryKey,
                }),
              ]);
            }}
          />
        }
        previewHandoff={selectedVersion
          ? (
            <ArtifactPreviewHandoff
              key={`handoff:${scope.sessionGeneration}:${selectedVersion.id}`}
              version={selectedVersion}
            />
          )
          : null}
        notices={notices}
        banner={
          <>
            <ArtifactStorageStatus
              key={`storage:${scope.sessionGeneration}:${scope.organizationId}`}
            />
            {downloadFeedback}
          </>
        }
        evidence={{
          title: translate("artifact.view.evidence"),
          baseLabel: translate("artifact.view.base"),
          headLabel: translate("artifact.view.head"),
          context: translate("artifact.view.context", {
            task: taskId,
            step: selectedVersion?.runStepId ??
              translate("artifact.retrieval.notAvailable"),
          }),
          base: selectedVersion?.subjectBaseSha ??
            translate("artifact.retrieval.notAvailable"),
          head: selectedVersion?.subjectHeadSha ??
            translate("artifact.retrieval.notAvailable"),
          digest: selectedVersion?.sha256 ??
            translate("artifact.retrieval.notAvailable"),
          taskAction: {
            label: translate("artifact.view.openTask"),
            onClick: () => {
              void navigate({ to: "/tasks/$taskId", params: { taskId } });
            },
          },
          details: {
            label: translate("artifact.view.details"),
            open: detailsOpen,
            onOpenChange: setDetailsOpen,
            content: (
              <>
                {versionPages.hasNext
                  ? (
                    <UI.Button
                      variant="secondary"
                      onClick={versionPages.loadMore}
                      disabled={versionPages.loadingMore}
                    >
                      {translate("artifact.version.more")}
                    </UI.Button>
                  )
                  : null}
                {content}
              </>
            ),
          },
        }}
        preview={selectedVersion
          ? (
            <ArtifactContentPreview
              key={`${scope.sessionGeneration}:${selectedVersion.id}`}
              version={selectedVersion}
              onDownload={() => void download()}
              onViewDetails={() => setDetailsOpen(true)}
            />
          )
          : (
            <ArtifactPreviewView
              label={translate("artifact.preview.title")}
              state="unavailable"
              unavailable={{
                title: translate(
                  view.artifact.currentVersionId === null
                    ? "artifact.retrieval.emptyNotice"
                    : "artifact.retrieval.missingVersionTitle",
                ),
                description: translate(
                  view.artifact.currentVersionId === null
                    ? "artifact.retrieval.description"
                    : "artifact.retrieval.missingVersionDescription",
                ),
                action: {
                  label: translate("artifact.view.openTask"),
                  onClick: () => {
                    void navigate({ to: "/tasks/$taskId", params: { taskId } });
                  },
                },
              }}
            />
          )}
        discussion={discussion}
        comments={{
          title: translate("artifact.comments.title"),
          openLabel: translate("artifact.comments.title"),
          linkedCommentId,
        }}
      />
    );
  }
  if (view.kind === "loading") {
    return (
      <ArtifactUnavailableView
        title={title}
        description={translate("artifact.view.loadingDescription")}
        testId="artifact-retrieval-loading"
        preview={{
          state: "unavailable",
          label: translate("artifact.preview.title"),
          unavailable: {
            title,
            description: translate("artifact.view.loadingDescription"),
            action: {
              label: translate("artifact.view.openTask"),
              onClick: () => {
                void navigate({ to: "/tasks/$taskId", params: { taskId } });
              },
            },
          },
        }}
      />
    );
  }
  if (view.kind === "forbidden") {
    return (
      <ArtifactUnavailableView
        title={title}
        description={translate("artifact.retrieval.forbiddenDescription")}
        testId="artifact-retrieval-forbidden"
        preview={{
          state: "denied",
          label: translate("artifact.view.accessDenied"),
          denied: {
            title,
            description: translate("artifact.retrieval.forbiddenDescription"),
            action: {
              label: translate("artifact.view.openTask"),
              onClick: () => {
                void navigate({ to: "/tasks/$taskId", params: { taskId } });
              },
            },
          },
        }}
      />
    );
  }
  return (
    <UI.TaskDetail
      data-artifact-retrieval-detail="true"
      state={detailState}
      title={title}
    >
      {content}
    </UI.TaskDetail>
  );
}
