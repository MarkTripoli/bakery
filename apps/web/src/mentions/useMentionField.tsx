import {
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import type {
  ApiFailure,
  ConversationSharer,
  MentionSource,
} from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import {
  conversationAccessQueryOptions,
  conversationSharersQueryOptions,
  mentionCandidatesQueryOptions,
  organizationQueryOptions,
} from "../api/query.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import {
  addMention,
  appendLine,
  insertMention,
  markGainsAccess,
  markNeedsSharer,
  MAX_MENTIONS,
  type Mention,
  nameParts,
  needsSharer,
  offered,
  reconcile,
  type RefusalCode,
  refusalsOf,
  refusedPeople,
  rowKind,
  triggerAt,
  withoutAtSign,
  withoutMention,
} from "./mentions-state.ts";

/** What a composer needs from the mention field: the props for its text field, and the parts to draw. */
export type MentionField = {
  /** Everyone chosen and still named in the text, in the order sent as `mentions`. */
  readonly mentions: readonly Mention[];
  /** Props for the message textarea: they replace its own `value` and `onChange`. */
  readonly fieldProps: {
    readonly ref: RefObject<HTMLTextAreaElement | null>;
    readonly value: string;
    readonly onChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
    readonly onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
    readonly onKeyUp: () => void;
    readonly onClick: () => void;
    readonly "aria-autocomplete": "list";
    readonly "aria-controls": string | undefined;
    readonly "aria-activedescendant": string | undefined;
  };
  /** The picker, hung above the box; null while closed. */
  readonly picker: ReactNode;
  /** The "Will be notified" row, its access sentence and the offline note; null with nothing to say. */
  readonly row: ReactNode;
  /** One or more chosen people were refused: Send stays off until they are removed. */
  readonly refused: boolean;
  /** What the send button says while an offer is open ("Give access and send"); null with no offer. */
  readonly sendLabel: string | null;
  /** How many people the send would give access to. */
  readonly offered: number;
  /** The "Not sent." sentence for what the server refused; null otherwise. */
  readonly notice: string | null;
  /** A chosen person needs someone else to give them access: Send stays off until that mention is removed or someone is asked. */
  readonly blocked: boolean;
  /** Why Send is off while `blocked`, in words ("Ask Dana Lee or remove the mention to send."); null otherwise. */
  readonly sendReason: string | null;
  /** What to say when a send that was giving access failed on the server's side; null with no offer open. */
  readonly failed: { readonly line: string; readonly detail: string } | null;
  /** Reads a failed send: marks the refused people and returns true when it was a mention refusal. */
  readonly refuse: (failure: ApiFailure) => boolean;
  /** Forgets the chips and refusals, after a send. */
  readonly clear: () => void;
};

const DEBOUNCE_MS = 150;

/**
 * The mention field of a composer or comment editor (design-ux #73). The text
 * stays ordinary characters: a chip is only what is sent as `mentions`, and
 * editing the inserted name drops it.
 */
export function useMentionField(
  options: {
    readonly source: MentionSource;
    readonly value: string;
    readonly onValue: (text: string) => void;
    readonly offline: boolean;
    readonly disabled: boolean;
  },
): MentionField {
  const { source, value, onValue, offline, disabled } = options;
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { translate } = useI18n();
  const organization = useQuery(organizationQueryOptions(api, scope));
  const organizationName = organization.data?.name ?? "";
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const listId = `mention-list-${source.kind}`;
  const [caret, setCaret] = useState(value.length);
  const [mentions, setMentions] = useState<readonly Mention[]>([]);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const [refusals, setRefusals] = useState<
    readonly { mention: Mention; code: RefusalCode }[]
  >([]);
  // The server said the writer may not share after all: the block says "Not sent.".
  const [notSent, setNotSent] = useState(false);
  // The server said a person has no access after all: the offer says "Not sent.".
  const [offerNotSent, setOfferNotSent] = useState(false);
  // What a send that gave access left behind: the line with its Undo, then its result.
  const [sent, setSent] = useState<
    {
      readonly people: readonly { principalId: string; name: string }[];
      readonly state: "done" | "undoing" | "undone" | "failed";
    } | null
  >(null);
  const queryClient = useQueryClient();

  const trigger = triggerAt(value, Math.min(caret, value.length));
  const wanted = trigger !== null && !disabled;
  const open = wanted && !offline && dismissed !== trigger.start;
  useEffect(() => {
    if (trigger === null) setDismissed(null);
  }, [trigger === null]);

  // The search follows the typing a moment later, so a fast typist asks once.
  const [text, setText] = useState("");
  useEffect(() => {
    const query = trigger?.query ?? "";
    const timer = setTimeout(() => setText(query), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [trigger?.query]);
  const read = useInfiniteQuery({
    ...mentionCandidatesQueryOptions(api, scope, source, text),
    enabled: Boolean(scope.organizationId) && open,
  });
  const candidates = offered(
    read.data?.pages.flatMap((page) => page.items) ?? [],
    mentions,
  );
  useEffect(() => setActive(0), [text, candidates.length === 0]);
  // Everyone on the pages read so far may already be chosen: read on, so the
  // picker never says "no one" while more people are waiting.
  const nothingLeft = candidates.length === 0;
  useEffect(() => {
    if (open && nothingLeft && read.hasNextPage && !read.isFetchingNextPage) {
      void read.fetchNextPage();
    }
  }, [open, nothingLeft, read.hasNextPage, read.isFetchingNextPage]);

  const full = mentions.length >= MAX_MENTIONS;
  const rows = candidates.map((candidate) => {
    const kind = rowKind(candidate, source.kind);
    return { candidate, kind, asks: needsSharer(candidate, source.kind) };
  });
  const optionsForPicker = rows.map(({ candidate, kind }) => ({
    id: candidate.principalId,
    name: candidate.displayName,
    kind,
    label: kind === "ready"
      ? candidate.displayName
      : kind === "gains"
      ? translate("mentions.row.optionGains", { name: candidate.displayName })
      // Only a comment has a row that cannot be chosen: it never gives access.
      : translate("mentions.row.optionBlockedComment", {
        name: candidate.displayName,
      }),
    ...(kind === "gains"
      ? { note: translate("mentions.row.gains") }
      : kind === "blocked"
      ? { note: translate("mentions.row.blockedComment") }
      : {}),
  }));
  const activeId =
    optionsForPicker[Math.min(active, optionsForPicker.length - 1)]
      ?.id ?? null;
  const showing = open && !full && optionsForPicker.length > 0 && !read.isError;

  const choose = (principalId: string) => {
    const row = rows.find((entry) =>
      entry.candidate.principalId === principalId
    );
    if (row === undefined || row.kind === "blocked" || trigger === null) return;
    if (mentions.length >= MAX_MENTIONS) return;
    const mention: Mention = {
      principalId,
      name: row.candidate.displayName,
      gainsAccess: row.kind === "gains" && !row.asks,
      needsSharer: row.asks,
    };
    setSent(null);
    const inserted = insertMention(
      value,
      trigger,
      Math.min(caret, value.length),
      mention.name,
    );
    setMentions((current) => addMention(current, mention));
    onValue(inserted.text);
    setCaret(inserted.caret);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(inserted.caret, inserted.caret);
    });
  };

  const body = full
    ? translate(
      source.kind === "conversation"
        ? "mentions.limit"
        : "mentions.limitComment",
    )
    : read.isError
    ? translate("mentions.failed")
    : candidates.length === 0 && !read.isPending && !read.hasNextPage
    ? translate("mentions.empty", { organization: organizationName })
    : null;
  const pickerState = full
    ? "limit" as const
    : read.isError
    ? "error" as const
    : read.isPending || (candidates.length === 0 && read.hasNextPage)
    ? "loading" as const
    : candidates.length === 0
    ? "empty" as const
    : "options" as const;
  const hasGains = rows.some((entry) => entry.kind === "gains" && !entry.asks);
  const hasAsks = rows.some((entry) => entry.asks);
  const picker = open
    ? (
      <UI.MentionPicker
        activeId={activeId}
        footer={source.kind === "comment"
          ? translate("mentions.footer.comment")
          : pickerState !== "options"
          ? undefined
          : hasGains
          ? translate("mentions.footer.conversation")
          : hasAsks
          ? translate("mentions.footer.conversationAsk")
          : undefined}
        label={translate("mentions.picker.label")}
        listId={listId}
        message={body}
        onChoose={choose}
        onEnd={() => {
          if (read.hasNextPage && !read.isFetchingNextPage) {
            void read.fetchNextPage();
          }
        }}
        options={optionsForPicker}
        retry={{
          label: translate("core.actions.retry"),
          onRetry: () => void read.refetch(),
        }}
        state={pickerState}
      />
    )
    : null;

  const refusedIds = new Set(
    refusals.map((entry) => entry.mention.principalId),
  );
  // A refused person gains nothing, so the offer leaves them out.
  const offering = source.kind === "conversation"
    ? mentions.filter((mention) =>
      mention.gainsAccess && !refusedIds.has(mention.principalId)
    )
    : [];
  // A person the writer may not give access to: someone who can share has to be asked.
  const blocking = source.kind === "conversation"
    ? mentions.filter((mention) =>
      mention.needsSharer && !refusedIds.has(mention.principalId)
    )
    : [];
  const sharersRead = useQuery(
    conversationSharersQueryOptions(
      api,
      scope,
      source.id,
      blocking.length > 0,
    ),
  );
  // The line names up to two of the (at most three) people who can share.
  const sharers = (sharersRead.data?.items ?? []).slice(0, 2);
  const joined = (names: readonly string[]) =>
    translate("mentions.names", nameParts(names));
  /** Swaps the blocked chip for the sharer's and adds a selected line that asks them. */
  const ask = (sharer: ConversationSharer) => {
    let next = value;
    for (const mention of blocking) next = withoutAtSign(next, mention);
    const appended = appendLine(
      next,
      translate("mentions.share.askLine", {
        sharer: `@${sharer.displayName}`,
        names: joined(blocking.map((mention) => mention.name)),
      }),
    );
    const sharerMention: Mention = {
      principalId: sharer.principalId,
      name: sharer.displayName,
      gainsAccess: false,
      needsSharer: false,
    };
    setMentions((current) =>
      addMention(
        current.filter((mention) => !mention.needsSharer),
        sharerMention,
      )
    );
    setRefusals([]);
    setNotSent(false);
    setOfferNotSent(false);
    onValue(appended.text);
    setCaret(appended.end);
    requestAnimationFrame(() => {
      ref.current?.focus();
      // The new line is selected, so typing replaces it.
      ref.current?.setSelectionRange(appended.start, appended.end);
    });
  };
  /** Takes back the access the last send gave: the live grants of those people, each revoked. */
  const undo = async () => {
    if (sent === null || source.kind !== "conversation") return;
    if (!scope.organizationId) return;
    const organizationId = scope.organizationId;
    const undoing = sent;
    setSent({ ...undoing, state: "undoing" });
    let state: "undone" | "failed" = "failed";
    try {
      const grants = await queryClient.fetchQuery({
        ...conversationAccessQueryOptions(api, scope, source.id),
        staleTime: 0,
      });
      const people = new Set(
        undoing.people.map((person) => person.principalId),
      );
      const results = await Promise.all(
        grants.filter((grant) => people.has(grant.principalId)).map((grant) =>
          api.revokeConversationAccess({
            organizationId,
            conversationId: source.id,
            principalId: grant.principalId,
            version: grant.version,
            idempotencyKey: `${grant.id}:undo:${grant.version}`,
          })
        ),
      );
      if (results.every((result) => result.ok)) state = "undone";
    } catch {
      state = "failed";
    }
    void queryClient.invalidateQueries({
      queryKey: conversationAccessQueryOptions(api, scope, source.id).queryKey,
    });
    setSent((current) => current === null ? null : { ...current, state });
  };
  // "Don't mention" keeps the name as words; the chip's remove cuts the whole word.
  const removeMention = (mention: Mention, keepName = false) => {
    onValue(
      keepName ? withoutAtSign(value, mention) : withoutMention(value, mention),
    );
    setMentions((current) =>
      current.filter((entry) => entry.principalId !== mention.principalId)
    );
    setRefusals((current) =>
      current.filter((entry) =>
        entry.mention.principalId !== mention.principalId
      )
    );
    ref.current?.focus();
  };
  const row = mentions.length === 0 && sent === null && !(wanted && offline)
    ? null
    : (
      <>
        {mentions.length > 0
          ? (
            <UI.Inline
              gap="compact"
              aria-label={translate("mentions.notified.label")}
            >
              <UI.Text variant="caption">
                {translate("mentions.notified.label")}
              </UI.Text>
              {mentions.map((mention) => (
                <UI.Inline gap="compact" key={mention.principalId}>
                  <UI.Badge
                    tone={refusedIds.has(mention.principalId)
                      ? "danger"
                      : mention.gainsAccess || mention.needsSharer
                      ? "warning"
                      : "neutral"}
                  >
                    {(mention.gainsAccess || mention.needsSharer) &&
                        !refusedIds.has(mention.principalId)
                      ? translate("mentions.chip.gains", { name: mention.name })
                      : mention.name}
                  </UI.Badge>
                  <UI.IconButton
                    label={translate("mentions.chip.remove", {
                      name: mention.name,
                    })}
                    onClick={() =>
                      removeMention(mention)}
                    variant="compact"
                  >
                    <UI.IconGlyph name="close" size="small" />
                  </UI.IconButton>
                </UI.Inline>
              ))}
            </UI.Inline>
          )
          : null}
        {offering.length > 0
          ? (
            <UI.AccessOffer
              caption={offering.length > 1
                ? translate("mentions.offer.leaveOut")
                : undefined}
              decline={offering.length === 1
                ? {
                  label: translate("mentions.offer.decline", {
                    name: offering[0].name,
                  }),
                  onDecline: () => removeMention(offering[0], true),
                }
                : undefined}
              detail={translate("mentions.offer.detail")}
              question={translate(
                offerNotSent
                  ? "mentions.offer.questionNotSent"
                  : "mentions.offer.question",
                { count: offering.length, name: offering[0].name },
              )}
              // While the send that gives the access is under way, the offer is read-only.
              state={disabled ? "busy" : "default"}
            />
          )
          : null}
        {blocking.length > 0
          ? (
            <UI.AccessOffer
              actions={sharersRead.isError
                // A read that failed is not a dead end: it can be asked again.
                ? [{
                  label: translate("core.actions.retry"),
                  onClick: () => void sharersRead.refetch(),
                }]
                : sharers.map((sharer) => ({
                  label: translate("mentions.share.ask", {
                    name: sharer.displayName,
                  }),
                  onClick: () => ask(sharer),
                }))}
              // The way out is here too, after the buttons, as in the offer.
              caption={blocking.length > 1
                ? translate("mentions.offer.leaveOut")
                : undefined}
              decline={blocking.length === 1
                ? {
                  label: translate("mentions.offer.decline", {
                    name: blocking[0].name,
                  }),
                  onDecline: () => removeMention(blocking[0], true),
                }
                : undefined}
              detail={sharersRead.isError
                ? translate("mentions.share.failed")
                : sharersRead.isPending
                ? translate("mentions.share.loading")
                : sharers.length === 0
                ? translate("mentions.share.lineNone", {
                  organization: organizationName,
                })
                : translate("mentions.share.line", {
                  names: translate(
                    "mentions.share.names",
                    nameParts(sharers.map((sharer) => sharer.displayName)),
                  ),
                })}
              question={translate(
                notSent
                  ? "mentions.share.questionNotSent"
                  : "mentions.share.question",
                { count: blocking.length, name: blocking[0].name },
              )}
              state={disabled ? "busy" : "default"}
            />
          )
          : null}
        {sent !== null
          ? sent.state === "undone"
            ? (
              <UI.AccessOffer
                tone="success"
                question={translate("mentions.sent.undone", {
                  names: joined(sent.people.map((person) => person.name)),
                })}
              />
            )
            : (
              <UI.AccessOffer
                actions={[{
                  label: translate("mentions.sent.undo"),
                  onClick: () => void undo(),
                }]}
                detail={sent.state === "failed"
                  ? translate("mentions.sent.undoFailed")
                  : undefined}
                question={translate("mentions.sent.line", {
                  names: joined(sent.people.map((person) => person.name)),
                })}
                state={sent.state === "undoing" ? "busy" : "default"}
                // Good news is not warning-coloured; a failed undo keeps the warning.
                tone={sent.state === "failed" ? "warning" : "success"}
              />
            )
          : null}
        {wanted && offline
          ? (
            <UI.Text role="status" variant="caption">
              {translate("mentions.offline")}
            </UI.Text>
          )
          : null}
      </>
    );

  const notice = refusals.length === 0
    ? null
    : refusals.length > 1
    ? translate("mentions.refused.several", { count: refusals.length })
    : translate(
      refusals[0].code === "not_member"
        ? "mentions.refused.notMember"
        : "mentions.refused.noThreadAccess",
      { name: refusals[0].mention.name, organization: organizationName },
    );

  return {
    mentions,
    fieldProps: {
      ref,
      value,
      onChange: (event) => {
        const next = event.currentTarget.value;
        setSent(null);
        setCaret(event.currentTarget.selectionStart ?? next.length);
        setMentions((current) => reconcile(next, current));
        setRefusals((current) =>
          current.filter((entry) => reconcile(next, [entry.mention]).length > 0)
        );
        onValue(next);
      },
      onKeyDown: (event) => {
        if (!showing || event.metaKey || event.ctrlKey) {
          if (open && event.key === "Escape") {
            event.preventDefault();
            if (trigger !== null) setDismissed(trigger.start);
          }
          return;
        }
        const last = optionsForPicker.length - 1;
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setActive((current) => Math.min(current + 1, last));
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          setActive((current) => Math.max(current - 1, 0));
        } else if (event.key === "Enter" || event.key === "Tab") {
          if (activeId !== null) {
            event.preventDefault();
            choose(activeId);
          }
        } else if (event.key === "Escape") {
          event.preventDefault();
          if (trigger !== null) setDismissed(trigger.start);
        }
      },
      onKeyUp: () => setCaret(ref.current?.selectionStart ?? value.length),
      onClick: () => setCaret(ref.current?.selectionStart ?? value.length),
      "aria-autocomplete": "list",
      "aria-controls": showing ? listId : undefined,
      "aria-activedescendant": showing && activeId !== null
        ? UI.mentionOptionId(listId, activeId)
        : undefined,
    },
    picker,
    row,
    offered: offering.length,
    sendLabel: offering.length > 0
      ? translate("mentions.offer.send", { count: offering.length })
      : null,
    refused: refusals.length > 0,
    notice,
    blocked: blocking.length > 0,
    sendReason: blocking.length === 0 ? null : sharers.length > 0
      ? translate(
        "mentions.share.reason",
        nameParts(sharers.map((sharer) => sharer.displayName)),
      )
      : translate("mentions.share.reasonNone"),
    failed: offering.length === 0 ? null : {
      line: translate("mentions.failed.line"),
      detail: translate("mentions.failed.detail", {
        names: joined(offering.map((mention) => mention.name)),
      }),
    },
    refuse: (failure) => {
      const found = refusedPeople(mentions, refusalsOf(failure));
      if (found.length === 0) return false;
      // The writer may not share after all: nothing is red, the block asks someone who can.
      const noShare = found.filter((entry) => entry.code === "share_forbidden");
      if (noShare.length > 0) {
        setMentions((current) =>
          markNeedsSharer(
            current,
            new Set(noShare.map((entry) => entry.mention.principalId)),
          )
        );
        setNotSent(true);
      }
      // A person has no access after all, in a conversation: the offer comes back,
      // starting "Not sent.", and the same Send gives the access. A comment never gives it.
      const lost = source.kind === "conversation"
        ? found.filter((entry) => entry.code === "no_thread_access")
        : [];
      if (lost.length > 0) {
        setMentions((current) =>
          markGainsAccess(
            current,
            new Set(lost.map((entry) => entry.mention.principalId)),
          )
        );
        setOfferNotSent(true);
      }
      setRefusals(
        found.filter((entry) =>
          entry.code !== "share_forbidden" && !lost.includes(entry)
        ),
      );
      return true;
    },
    clear: () => {
      if (offering.length > 0 && source.kind === "conversation") {
        setSent({
          people: offering.map((mention) => ({
            principalId: mention.principalId,
            name: mention.name,
          })),
          state: "done",
        });
      }
      setMentions([]);
      setRefusals([]);
      setNotSent(false);
      setOfferNotSent(false);
    },
  };
}
