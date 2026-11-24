import { type FormEvent, useRef, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import { useBakeryApi } from "../../api/context.tsx";
import {
  conversationMessagesQueryOptions,
  conversationParticipantsQueryOptions,
} from "../../api/query.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { useSession } from "../../app/session-context.tsx";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import {
  type LandingSearch,
  parseLanding,
} from "../../notifications/landing.ts";
import { useLandingArrival } from "../../notifications/useLandingArrival.ts";
import { useLandingMessageSearch } from "../../notifications/useLandingMessageSearch.ts";
import { useTaskLanding } from "../../notifications/useTaskLanding.ts";
import { chronological, participantsOf } from "../task-conversation/model.ts";
import { SharedFrame } from "./SharedFrame.tsx";
import { sharedReasonOf, SharedUnavailable } from "./SharedUnavailable.tsx";

const POLL_MS = 15_000;
const MESSAGE_MAX = 20_000;

export function SharedConversationPage(
  { conversationId, message, landing: current, stripLanding }: {
    conversationId: string;
    message: string | undefined;
    landing: LandingSearch;
    stripLanding: () => void;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const session = useSession();
  const landing = useRef(current).current;
  const { translate: t } = useI18n();
  const organizationId = scope.organizationId;
  const principalId = session.identity?.principalId ?? null;
  const scoped = organizationId !== null;
  const messages = useInfiniteQuery({
    ...conversationMessagesQueryOptions(api, scope, conversationId),
    enabled: scoped,
    refetchInterval: POLL_MS,
  });
  const participants = useQuery({
    ...conversationParticipantsQueryOptions(api, scope, conversationId),
    enabled: scoped,
  });
  const anchored = parseLanding(landing.at);
  const targetId = landing.gone === true
    ? null
    : message ?? (anchored?.kind === "message" ? anchored.id : null);
  const { searching } = useLandingMessageSearch(messages, targetId);
  const landed = useTaskLanding(
    { ...landing, at: targetId === null ? undefined : `message:${targetId}` },
    scoped && messages.data !== undefined && targetId !== null,
    searching,
  );
  const arrival = useLandingArrival({
    search: landing,
    ready: messages.isError ||
      (messages.data !== undefined && (targetId === null || landed.settled)),
    strip: stripLanding,
  });

  const [body, setBody] = useState("");
  const [phase, setPhase] = useState<"idle" | "sending" | "failed">("idle");
  const sendId = useRef<string | null>(null);
  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (organizationId === null || body.trim() === "") return;
    const id = sendId.current ?? crypto.randomUUID();
    sendId.current = id;
    setPhase("sending");
    const result = await api.createMessage({
      organizationId,
      conversationId,
      idempotencyKey: id,
      input: {
        body: body.trim(),
        clientMessageId: id,
        intent: "discussion",
      },
    });
    if (result.ok) {
      sendId.current = null;
      setBody("");
      setPhase("idle");
      void messages.refetch();
    } else {
      setPhase("failed");
    }
  };

  if (messages.isError && messages.data === undefined) {
    return (
      <SharedUnavailable
        kind="conversation"
        reason={sharedReasonOf(messages.error)}
        landing={landing}
      />
    );
  }
  const transcript = chronological(messages.data?.pages ?? []);
  const people = participantsOf(
    transcript.map((item) =>
      item.messageType === "user" ? item.authorId : null
    ),
    participants.data?.items ?? [],
    principalId,
    (id) =>
      id === principalId
        ? t("tasks.conversation.author.you")
        : t("tasks.conversation.author.member"),
  );
  const author = (item: (typeof transcript)[number]) =>
    item.messageType === "user"
      ? item.authorId === principalId
        ? t("tasks.conversation.author.you")
        : people.find((person) => person.id === item.authorId)?.name ??
          t("tasks.conversation.author.member")
      : item.messageType === "system"
      ? t("tasks.conversation.author.system")
      : t("tasks.conversation.author.agent");
  const time = (iso: string) =>
    new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(iso));
  const tooLong = body.length > MESSAGE_MAX;
  return (
    <SharedFrame
      testId="shared-conversation-page"
      title={t("shared.conversation.title" as never)}
      notice={t("shared.conversation.notice" as never)}
    >
      <UI.VisuallyHidden aria-live="polite" as="div" role="status">
        {arrival}
      </UI.VisuallyHidden>
      {landing.gone === true || landed.missing
        ? (
          <UI.InlineNotice tone="information">
            {t("notifications.landing.partGone")}
          </UI.InlineNotice>
        )
        : null}
      {messages.data === undefined
        ? (
          <UI.Stack
            aria-busy="true"
            aria-label={t("notifications.loading")}
            gap="compact"
          >
            {Array.from({ length: 3 }).map((_, index) => (
              <UI.Skeleton key={index} shape="text" />
            ))}
          </UI.Stack>
        )
        : (
          <UI.Stack gap="standard">
            {messages.hasNextPage
              ? (
                <UI.Button
                  variant="outline"
                  loading={messages.isFetchingNextPage}
                  onClick={() => void messages.fetchNextPage()}
                >
                  {t("tasks.conversation.loadEarlier")}
                </UI.Button>
              )
              : null}
            {transcript.map((item) => (
              <UI.ConversationMessage
                key={item.id}
                author={author(item)}
                timestamp={time(item.createdAt)}
                variant={item.messageType === "user"
                  ? "person"
                  : item.messageType === "system"
                  ? "system"
                  : "agent"}
                data-message-id={item.id}
              >
                {item.body}
              </UI.ConversationMessage>
            ))}
          </UI.Stack>
        )}
      <UI.MessageComposer
        aria-label={t("shared.conversation.reply.label" as never)}
        state={phase === "sending" ? "sending" : "default"}
        onSubmit={(event) => void send(event)}
        notices={phase === "failed"
          ? (
            <UI.InlineNotice layout="bar" role="alert" tone="error">
              {t("tasks.conversation.composer.failed")}
            </UI.InlineNotice>
          )
          : tooLong
          ? (
            <UI.InlineNotice layout="bar" role="alert" tone="error">
              {t("tasks.conversation.composer.tooLong", {
                max: String(MESSAGE_MAX),
              })}
            </UI.InlineNotice>
          )
          : undefined}
        field={
          <textarea
            name="message"
            aria-label={t("shared.conversation.reply.label" as never)}
            rows={1}
            placeholder={t("shared.conversation.reply.placeholder" as never)}
            value={body}
            readOnly={phase === "sending"}
            aria-invalid={tooLong || undefined}
            onChange={(event) => {
              setBody(event.target.value);
              if (phase === "failed") setPhase("idle");
            }}
          />
        }
        send={
          <UI.Button
            type="submit"
            disabled={phase === "sending" || body.trim() === "" || tooLong}
            loading={phase === "sending"}
          >
            <UI.IconGlyph name="arrow" size="small" />
            {t(
              phase === "sending"
                ? "tasks.conversation.composer.sending"
                : "tasks.conversation.composer.send",
            )}
          </UI.Button>
        }
      />
    </SharedFrame>
  );
}
