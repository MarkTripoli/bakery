/**
 * The provider-neutral event vocabulary a workflow start matches (one engine O8).
 *
 * A start names a neutral kind such as `change_request.opened`, never a
 * provider's own event name. Each provider declares here, beside its adapter,
 * how its verified deliveries translate into that vocabulary, so the start
 * matcher reads one closed list and names no provider. The same list answers
 * the question an author asks at save time: could anything ever fire this
 * start. A start that nothing can fire is refused when it is written, not left
 * to sit silent inside an immutable published version.
 *
 * The translation is a closed table of (event, action) pairs. A provider
 * action that is not listed here (GitHub's `synchronize` is renamed, its
 * `locked` is not carried) produces no neutral event, so the vocabulary does
 * not grow by accident when a provider adds an action.
 */
import { GITHUB_PROVIDER } from "./registry.ts";

/** The type a filter value must have for a declared field. */
export type NeutralFieldType = "number" | "string";

/** One neutral event: its kind and the scalar fields a start may compare. */
export type NeutralEvent = Readonly<{
  kind: string;
  fields: Readonly<Record<string, string | number>>;
}>;

/** What a verified receipt keeps of one delivery, before translation. */
export type NeutralEventFacts = Readonly<{
  kind: string;
  action: string | null;
  number: number | null;
  headSha: string | null;
  repositoryId: number | null;
}>;

/** The fields every neutral event of the shipped providers may carry. */
const COMMON_FIELDS: Readonly<Record<string, NeutralFieldType>> = Object.freeze(
  { number: "number", headSha: "string", repositoryId: "number" },
);

/**
 * Neutral kinds a source emits today, each with the fields a start may filter
 * on. A kind appears here only when a verified delivery can produce it.
 */
const EMITTED_KINDS: Readonly<
  Record<string, Readonly<Record<string, NeutralFieldType>>>
> = Object.freeze({
  "work_item.opened": COMMON_FIELDS,
  "work_item.edited": COMMON_FIELDS,
  "work_item.closed": COMMON_FIELDS,
  "work_item.reopened": COMMON_FIELDS,
  "work_item.labeled": COMMON_FIELDS,
  "work_item.unlabeled": COMMON_FIELDS,
  "change_request.opened": COMMON_FIELDS,
  "change_request.updated": COMMON_FIELDS,
  "change_request.closed": COMMON_FIELDS,
  "change_request.reopened": COMMON_FIELDS,
  "change_request.ready": COMMON_FIELDS,
  "check.completed": COMMON_FIELDS,
});

/**
 * Kinds a start may name before any source here emits them, because another
 * item owns the source. `work_item.ready` is ticket admission's (#407); its
 * fields are declared by that item, so a filter on it is refused until then.
 */
const RESERVED_KINDS: Readonly<
  Record<string, Readonly<Record<string, NeutralFieldType>>>
> = Object.freeze({ "work_item.ready": Object.freeze({}) });

/** Provider event name, then action, to the neutral kind it produces. */
const TRANSLATIONS: Readonly<
  Record<string, Readonly<Record<string, Readonly<Record<string, string>>>>>
> = Object.freeze({
  [GITHUB_PROVIDER]: Object.freeze({
    issues: Object.freeze({
      opened: "work_item.opened",
      edited: "work_item.edited",
      closed: "work_item.closed",
      reopened: "work_item.reopened",
      labeled: "work_item.labeled",
      unlabeled: "work_item.unlabeled",
    }),
    pull_request: Object.freeze({
      opened: "change_request.opened",
      synchronize: "change_request.updated",
      closed: "change_request.closed",
      reopened: "change_request.reopened",
      ready_for_review: "change_request.ready",
    }),
    check_run: Object.freeze({ completed: "check.completed" }),
    check_suite: Object.freeze({ completed: "check.completed" }),
  }),
});

/**
 * The neutral kinds one provider event name can produce, whatever its action.
 * The receipt gate asks it before the action is read: does any start listen
 * for a kind this delivery could be.
 */
export function neutralKindsOf(provider: string, eventName: string): string[] {
  if (!Object.hasOwn(TRANSLATIONS, provider)) return [];
  const byAction = TRANSLATIONS[provider];
  if (!Object.hasOwn(byAction, eventName)) return [];
  return [...new Set(Object.values(byAction[eventName]))];
}

/**
 * The fields a start of this neutral kind may filter on and their types, or
 * undefined when nothing emits or reserves the kind.
 */
export function neutralFieldsOf(
  kind: string,
): Readonly<Record<string, NeutralFieldType>> | undefined {
  if (Object.hasOwn(EMITTED_KINDS, kind)) return EMITTED_KINDS[kind];
  if (Object.hasOwn(RESERVED_KINDS, kind)) return RESERVED_KINDS[kind];
  return undefined;
}

/**
 * Translates one verified delivery into a neutral event, or null when the
 * provider is unknown or the (event, action) pair has no neutral meaning. A
 * field the delivery does not carry is left out, so a filter on it never
 * matches.
 */
export function neutralEventOf(
  provider: string,
  facts: NeutralEventFacts,
): NeutralEvent | null {
  if (!Object.hasOwn(TRANSLATIONS, provider)) return null;
  const byAction = TRANSLATIONS[provider];
  if (!Object.hasOwn(byAction, facts.kind) || facts.action === null) {
    return null;
  }
  const actions = byAction[facts.kind];
  if (!Object.hasOwn(actions, facts.action)) return null;
  const fields: Record<string, string | number> = {};
  if (facts.number !== null) fields.number = facts.number;
  if (facts.headSha !== null) fields.headSha = facts.headSha;
  if (facts.repositoryId !== null) fields.repositoryId = facts.repositoryId;
  return { kind: actions[facts.action], fields };
}
