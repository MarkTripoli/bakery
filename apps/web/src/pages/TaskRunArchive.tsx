import { useEffect, useRef, useState } from "react";
import * as UI from "@bakery/ui";
import type { OutputStream } from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";

export function TaskRunArchive({ stream }: { readonly stream: OutputStream }) {
  const { translate: t } = useI18n();
  if (stream.archive !== "archived") return null;
  return stream.segments.map((segment) => (
    <TranscriptDownload
      key={segment.artifactVersionId}
      segment={segment}
      label={t("tasks.run.output.archive", {
        number: String(segment.segmentIndex + 1),
        first: segment.firstSequence,
        last: segment.lastSequence,
      })}
    />
  ));
}

function TranscriptDownload({ segment, label }: {
  readonly segment: OutputStream["segments"][number];
  readonly label: string;
}) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { translate: t } = useI18n();
  const pending = useRef<AbortController | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "error" | "expired">(
    "idle",
  );
  useEffect(() => {
    setState("idle");
    return () => {
      pending.current?.abort();
      pending.current = null;
    };
  }, [
    scope.organizationId,
    scope.sessionGeneration,
    segment.artifactVersionId,
  ]);
  const download = async () => {
    if (!scope.organizationId || pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setState("loading");
    try {
      const result = await api.getArtifactContent({
        organizationId: scope.organizationId,
        versionId: segment.artifactVersionId,
        expectedSha256: segment.sha256,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!result.ok) {
        setState(
          result.error.kind === "problem" && result.error.problem.status === 410
            ? "expired"
            : "error",
        );
        return;
      }
      if (
        result.data.status !== 200 ||
        result.data.contentLength !== segment.sizeBytes ||
        result.data.content.byteLength !== segment.sizeBytes ||
        result.data.contentDigest !== segment.sha256.toLowerCase()
      ) {
        setState("error");
        return;
      }
      const href = URL.createObjectURL(
        new Blob([
          new Uint8Array(result.data.content),
        ], { type: "application/json" }),
      );
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = `transcript-${segment.artifactVersionId}.json`;
      anchor.click();
      globalThis.setTimeout(() => URL.revokeObjectURL(href), 0);
      setState("idle");
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (!controller.signal.aborted) setState("error");
    } finally {
      if (pending.current === controller) pending.current = null;
    }
  };
  return (
    <UI.Stack>
      <UI.Button onClick={() => void download()} disabled={state === "loading"}>
        {label}
      </UI.Button>
      {state === "error" || state === "expired"
        ? (
          <UI.Text role="status">
            {t(
              state === "expired"
                ? "tasks.run.output.archiveExpired"
                : "tasks.run.output.archiveError",
            )}
          </UI.Text>
        )
        : null}
    </UI.Stack>
  );
}
