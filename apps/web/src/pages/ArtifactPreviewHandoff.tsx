import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import {
  type ArtifactPreviewGrantResponse,
  type ArtifactVersionResponse,
} from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import { artifactPreviewAvailabilityQueryOptions } from "../api/query.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { isPreviewableMediaType } from "./artifact-media.ts";

/**
 * What the visitor sees of one preview. The grant secret exists only while
 * `ready`: it lives in this component's memory and in one hidden form field,
 * is never stored, cached, logged or put in a URL, and is dropped as soon as
 * the form is submitted or the 30 seconds pass.
 */
export type PreviewHandoffState =
  | { readonly kind: "idle" }
  | { readonly kind: "preparing" }
  | {
    readonly kind: "ready";
    readonly grant: ArtifactPreviewGrantResponse;
    readonly secondsLeft: number;
  }
  | { readonly kind: "opened"; readonly grant: GrantReference }
  | { readonly kind: "expired"; readonly grant: GrantReference }
  | { readonly kind: "revoked" }
  | { readonly kind: "failed" }
  | { readonly kind: "closeFailed"; readonly grant: GrantReference };

type GrantReference = Pick<
  ArtifactPreviewGrantResponse,
  "grantId" | "revisionPath"
>;

export type PreviewHandoffViewProps = {
  readonly state: PreviewHandoffState;
  readonly revision: number;
  readonly onPrepare: () => void;
  readonly onClose: () => void;
  /** Runs after the browser has taken the form data for its own submit. */
  readonly onSubmitted: () => void;
  readonly busyClosing: boolean;
};

const HANDOFF_FORM_ID = "artifact-preview-handoff-form";

/** Presentation of the handoff controls; every state is reachable in tests. */
export function ArtifactPreviewHandoffView(props: PreviewHandoffViewProps) {
  const { translate } = useI18n();
  const { state } = props;
  const reference: GrantReference | null = state.kind === "ready" ||
      state.kind === "opened" || state.kind === "expired" ||
      state.kind === "closeFailed"
    ? state.grant
    : null;
  return (
    <UI.Stack gap="compact" data-testid="artifact-preview-handoff">
      {state.kind === "ready"
        ? (
          // A real form POST in a new browsing context: the visitor's own click
          // submits it, so popup blockers stay quiet and the grant travels in
          // the request body, never in a URL. No `noreferrer`: the exchange
          // needs the Origin header to prove the post came from this page. The
          // opener link is severed anyway, because the preview response sets
          // `Cross-Origin-Opener-Policy: same-origin` and lives on another
          // origin, so the new tab lands in its own browsing context group.
          <>
            <UI.HandoffForm
              action={state.grant.exchangeUrl}
              data-testid="artifact-preview-form"
              fields={{ grant: state.grant.grant }}
              id={HANDOFF_FORM_ID}
              onSubmit={props.onSubmitted}
              target="_blank"
            />
            <UI.Button
              type="submit"
              form={HANDOFF_FORM_ID}
              data-testid="artifact-preview-open"
            >
              {translate("artifact.handoff.open")}
            </UI.Button>
          </>
        )
        : state.kind === "preparing"
        ? (
          <UI.Button
            variant="outline"
            state="loading"
            data-testid="artifact-preview-prepare"
          >
            {translate("artifact.handoff.preparing")}
          </UI.Button>
        )
        : (
          <UI.Button
            variant="outline"
            data-testid="artifact-preview-prepare"
            onClick={props.onPrepare}
          >
            {translate("artifact.handoff.prepare")}
          </UI.Button>
        )}
      {state.kind === "ready"
        ? (
          <UI.Text variant="caption" role="timer" aria-live="off">
            {translate("artifact.handoff.ready", {
              seconds: state.secondsLeft,
            })}
          </UI.Text>
        )
        : null}
      {state.kind === "opened"
        ? (
          <UI.InlineNotice tone="information">
            {translate("artifact.handoff.opened")}
          </UI.InlineNotice>
        )
        : null}
      {state.kind === "expired"
        ? (
          <UI.InlineNotice tone="warning">
            {translate("artifact.handoff.expired")}
          </UI.InlineNotice>
        )
        : null}
      {state.kind === "revoked"
        ? (
          <UI.InlineNotice tone="success">
            {translate("artifact.handoff.revoked")}
          </UI.InlineNotice>
        )
        : null}
      {state.kind === "failed"
        ? (
          <UI.InlineNotice tone="error">
            {translate("artifact.handoff.failed")}
          </UI.InlineNotice>
        )
        : null}
      {state.kind === "closeFailed"
        ? (
          <UI.InlineNotice tone="error">
            {translate("artifact.handoff.closeFailed")}
          </UI.InlineNotice>
        )
        : null}
      {reference
        ? (
          <UI.Inline gap="compact">
            <UI.Button
              variant="outline"
              state={props.busyClosing ? "loading" : "default"}
              data-testid="artifact-preview-close"
              onClick={props.onClose}
            >
              {translate("artifact.handoff.close")}
            </UI.Button>
            <UI.Link
              data-testid="artifact-preview-revision-link"
              href={reference.revisionPath}
            >
              {translate("artifact.handoff.revisionLink", {
                revision: props.revision,
              })}
            </UI.Link>
          </UI.Inline>
        )
        : null}
    </UI.Stack>
  );
}

/**
 * Action next to Download for previewable media. It renders nothing until the
 * deployment reports a configured preview origin; when none is configured the
 * action stays hidden behind one short note.
 */
export function ArtifactPreviewHandoff(
  { version }: { readonly version: ArtifactVersionResponse },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { translate } = useI18n();
  const [state, setState] = useState<PreviewHandoffState>({ kind: "idle" });
  const [notConfigured, setNotConfigured] = useState(false);
  const [busyClosing, setBusyClosing] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const previewable = !version.purgedAt &&
    isPreviewableMediaType(version.mediaType);
  const availability = useQuery({
    ...artifactPreviewAvailabilityQueryOptions(api, scope),
    enabled: scope.organizationId !== null && previewable,
  });

  useEffect(() => () => controller.current?.abort(), []);

  // The countdown is the only timer: it ends the grant window truthfully and
  // drops the secret from memory when the server would refuse it.
  const readyGrant = state.kind === "ready" ? state.grant : null;
  useEffect(() => {
    if (!readyGrant) return;
    const tick = () => {
      const remaining = Math.ceil(
        (new Date(readyGrant.expiresAt).getTime() - Date.now()) / 1000,
      );
      if (remaining <= 0) {
        setState({
          kind: "expired",
          grant: {
            grantId: readyGrant.grantId,
            revisionPath: readyGrant.revisionPath,
          },
        });
        return;
      }
      setState((current) =>
        current.kind === "ready" && current.secondsLeft !== remaining
          ? { ...current, secondsLeft: remaining }
          : current
      );
    };
    const timer = globalThis.setInterval(tick, 500);
    return () => globalThis.clearInterval(timer);
  }, [readyGrant]);

  if (!previewable || availability.data === undefined) return null;
  if (!availability.data.available || notConfigured) {
    return (
      <UI.Text variant="caption" data-testid="artifact-preview-unavailable">
        {translate("artifact.handoff.notConfigured")}
      </UI.Text>
    );
  }

  const prepare = async () => {
    if (scope.organizationId === null || state.kind === "preparing") return;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setState({ kind: "preparing" });
    const result = await api.createArtifactPreview({
      organizationId: scope.organizationId,
      versionId: version.id,
      signal: abort.signal,
    });
    if (abort.signal.aborted) return;
    if (!result.ok) {
      const problem = result.error.kind === "problem"
        ? result.error.problem
        : null;
      if (problem?.reason === "preview_origin_not_configured") {
        setNotConfigured(true);
      }
      setState({ kind: "failed" });
      return;
    }
    const grant = result.data;
    setState({
      kind: "ready",
      grant,
      secondsLeft: Math.max(
        1,
        Math.ceil((new Date(grant.expiresAt).getTime() - Date.now()) / 1000),
      ),
    });
  };

  const close = async () => {
    const reference = state.kind === "ready" || state.kind === "opened" ||
        state.kind === "expired" || state.kind === "closeFailed"
      ? state.grant
      : null;
    if (reference === null || scope.organizationId === null || busyClosing) {
      return;
    }
    const abort = new AbortController();
    controller.current?.abort();
    controller.current = abort;
    setBusyClosing(true);
    const result = await api.revokeArtifactPreview({
      organizationId: scope.organizationId,
      grantId: reference.grantId,
      idempotencyKey: crypto.randomUUID(),
      signal: abort.signal,
    });
    if (abort.signal.aborted) return;
    setBusyClosing(false);
    setState(
      result.ok ? { kind: "revoked" } : {
        kind: "closeFailed",
        grant: {
          grantId: reference.grantId,
          revisionPath: reference.revisionPath,
        },
      },
    );
  };

  return (
    <ArtifactPreviewHandoffView
      state={state}
      revision={version.revision}
      busyClosing={busyClosing}
      onPrepare={() => void prepare()}
      onClose={() => void close()}
      onSubmitted={() => {
        // After the browser has built the form data for its own submit, drop
        // the secret from this page; a task keeps React from unmounting the
        // hidden field before the submission reads it.
        globalThis.setTimeout(() =>
          setState((current) =>
            current.kind === "ready"
              ? {
                kind: "opened",
                grant: {
                  grantId: current.grant.grantId,
                  revisionPath: current.grant.revisionPath,
                },
              }
              : current
          ), 0);
      }}
    />
  );
}
