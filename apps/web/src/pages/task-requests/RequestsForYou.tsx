import { useState } from "react";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import { formatDate, type MessageKey } from "@bakery/i18n";
import { useBakeryApi } from "../../api/context.tsx";
import type { RunRequestResponse } from "../../api/client.ts";
import {
  artifactsListQueryOptions,
  artifactVersionsQueryOptions,
  myRunRequestsQueryOptions,
  taskRunIdsQueryOptions,
} from "../../api/query.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { RouterLink } from "../../app/router-link.tsx";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { actionOf, stepWords, visibleRequests } from "./model.ts";

type RequestKey = MessageKey extends infer Key
  ? Key extends `tasks.requests.${infer Suffix}` ? Suffix : never
  : never;

type Copy = (key: RequestKey, values?: Record<string, string>) => string;

type Props = Readonly<{
  taskId: string;
  currentRunId: string | null;
  online: boolean;
  onReviewStep: () => void;
  onShowQuestion: (questionId: string) => void;
}>;

export function RequestsForYou(props: Props) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { translate } = useI18n();
  const copy: Copy = (key, values) =>
    translate(`tasks.requests.${key}`, values);
  const runs = useQuery(taskRunIdsQueryOptions(api, scope, props.taskId));
  const runIds = [
    ...new Set([
      ...(props.currentRunId === null ? [] : [props.currentRunId]),
      ...(runs.data ?? []),
    ]),
  ];
  const reads = useQueries({
    queries: runIds.map((runId) =>
      myRunRequestsQueryOptions(api, scope, runId)
    ),
  });
  const requests = visibleRequests(
    reads.flatMap((read) => read.data?.requests ?? []),
  );
  const failed = reads.some((read) => read.isError)
    ? (
      <UI.InlineNotice tone="warning">
        <UI.Stack gap="compact">
          <UI.Text>{copy("loadFailed")}</UI.Text>
          <UI.Inline gap="compact">
            <UI.Button
              variant="outline"
              onClick={() => reads.forEach((read) => void read.refetch())}
            >
              {translate("tasks.conversation.retry")}
            </UI.Button>
          </UI.Inline>
        </UI.Stack>
      </UI.InlineNotice>
    )
    : null;
  if (requests.length === 0) return failed;
  return (
    <UI.Stack
      aria-label={copy("heading")}
      data-ui-region="requests-for-you"
      gap="standard"
      role="region"
    >
      <UI.Heading level="section">{copy("heading")}</UI.Heading>
      {failed}
      {requests.map((request) => (
        <RequestItem
          {...props}
          copy={copy}
          key={request.id}
          request={request}
        />
      ))}
    </UI.Stack>
  );
}

function RequestItem(
  { request, copy, ...props }: Props & {
    readonly request: RunRequestResponse;
    readonly copy: Copy;
  },
) {
  const { locale, timeZone } = useI18n();
  const date = formatDate(new Date(request.expiresAt), locale, {
    timeZone,
    dateStyle: "medium",
  });
  const asker = request.askedBy?.displayName ??
    copy(request.askedByKind === "workflow" ? "theWorkflow" : "someone");
  const group = request.audience?.name;
  const step = stepWords(request);
  const action = actionOf(request);
  const title = group === undefined
    ? copy(`title.${request.intent}`, { asker })
    : copy(`titleGroup.${request.intent}`, { asker, group });
  const details = [
    step === null ? null : copy("step", { step }),
    group === undefined ? null : copy("anyOne"),
  ].filter((line) => line !== null).join(" ");
  return (
    <UI.Stack
      gap="tight"
      data-request-id={request.id}
      data-request-status={request.status}
    >
      <UI.Text variant={action === null ? "muted" : "strong"}>{title}</UI.Text>
      {details === "" ? null : <UI.Text variant="hint">{details}</UI.Text>}
      {request.note === null ? null : <UI.Text>{request.note}</UI.Text>}
      {request.fallbackForName === null ? null : (
        <UI.Text variant="hint">
          {copy("ownerFallback", { name: request.fallbackForName })}
        </UI.Text>
      )}
      {action === "fyi"
        ? null
        : request.status === "open"
        ? <UI.Text variant="hint">{copy("expires", { date })}</UI.Text>
        : (
          <UI.Text variant="muted">
            {copy(`closed.${request.status}`, { asker, date })}
          </UI.Text>
        )}
      {action === "approve"
        ? request.runId === props.currentRunId
          ? (
            <UI.Inline gap="compact">
              <UI.Button onClick={props.onReviewStep}>
                {copy("decide")}
              </UI.Button>
            </UI.Inline>
          )
          : <UI.Text variant="hint">{copy("runMovedOn")}</UI.Text>
        : null}
      {action === "answer"
        ? (
          <UI.Inline gap="compact">
            <UI.Button
              onClick={() => props.onShowQuestion(request.questionId!)}
            >
              {copy("goToQuestion")}
            </UI.Button>
          </UI.Inline>
        )
        : null}
      {action === "review"
        ? (
          <ReviewLink
            copy={copy}
            taskId={props.taskId}
            versionId={request.artifactVersionId!}
          />
        )
        : null}
      {action === "take_over"
        ? <TakeOver copy={copy} online={props.online} request={request} />
        : null}
      {action === "fyi"
        ? <UI.Text variant="hint">{copy("nothingToDo")}</UI.Text>
        : null}
    </UI.Stack>
  );
}

function ReviewLink(
  { copy, taskId, versionId }: {
    readonly copy: Copy;
    readonly taskId: string;
    readonly versionId: string;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const artifacts = useQuery(
    artifactsListQueryOptions(api, scope, { taskId }),
  );
  const ids = (artifacts.data?.items ?? []).map((artifact) => artifact.id);
  const versions = useQueries({
    queries: ids.map((id) => artifactVersionsQueryOptions(api, scope, id)),
  });
  const at = versions.findIndex((read) =>
    read.data?.items.some((version) => version.id === versionId)
  );
  if (artifacts.isError || (at < 0 && versions.some((read) => read.isError))) {
    return <UI.Text variant="hint">{copy("documentUnread")}</UI.Text>;
  }
  if (at < 0) {
    const pending = artifacts.isPending ||
      versions.some((read) => read.isPending);
    return pending
      ? <UI.Skeleton shape="row" />
      : <UI.Text variant="hint">{copy("documentGone")}</UI.Text>;
  }
  return (
    <UI.Stack gap="tight">
      <RouterLink
        to="/tasks/$taskId/artifacts/$artifactId"
        params={{ taskId, artifactId: ids[at] }}
        search={{ version: versionId }}
      >
        {copy("openDocument")}
      </RouterLink>
      <UI.Text variant="hint">{copy("commentAnswers")}</UI.Text>
    </UI.Stack>
  );
}

function TakeOver(
  { copy, online, request }: {
    readonly copy: Copy;
    readonly online: boolean;
    readonly request: RunRequestResponse;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");
  const [key] = useState(() => crypto.randomUUID());
  const restart = useMutation({
    mutationKey: ["runSteps.takeOver"],
    mutationFn: async () => {
      const result = await api.restartRunStep({
        organizationId: scope.organizationId as string,
        runId: request.runId,
        stepKey: request.stepKey!,
        ...(note.trim() === "" ? {} : { note: note.trim() }),
        idempotencyKey: key,
      });
      if (!result.ok) throw result.error;
    },
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: ["protected"] }),
  });
  const id = `request-note-${request.id}`;
  return (
    <UI.Stack gap="compact">
      <UI.Field
        hint={copy("noteHint")}
        htmlFor={id}
        label={copy("noteLabel")}
        variant="textarea"
      >
        <textarea
          id={id}
          maxLength={4000}
          name="note"
          onChange={(event) => setNote(event.target.value)}
          rows={3}
          value={note}
        />
      </UI.Field>
      {restart.isError
        ? (
          <UI.InlineNotice role="alert" tone="error">
            {copy("restartFailed")}
          </UI.InlineNotice>
        )
        : null}
      <UI.Inline gap="compact">
        <UI.Button
          disabled={!online || restart.isPending || restart.isSuccess}
          loading={restart.isPending}
          onClick={() => restart.mutate()}
        >
          {copy("restart")}
        </UI.Button>
      </UI.Inline>
    </UI.Stack>
  );
}
