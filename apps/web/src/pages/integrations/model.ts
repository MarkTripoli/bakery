/**
 * What a GitHub connection means to a person: the one badge it carries, the
 * sentence that explains it, the one button that fixes it, which setup steps
 * are still open, and what it may do in plain words. Pure, so the rules are
 * tested without a screen.
 *
 * The connection read carries one `status`, not a health value: the server
 * folds health into it, so an expired authorization and missing permissions
 * both read `degraded`. The finer value exists only in a "Check now" result,
 * and is used here while the page holds one.
 */

export type ConnectionStatus =
  | "pending"
  | "enabled"
  | "disabled"
  | "degraded"
  | "revoked";

/** The parts of a connection the rules read. */
export type ConnectionFacts = {
  readonly status: ConnectionStatus;
  readonly lastCheckedAt: string | null;
};

/** The finer health a "Check now" answers with. */
export type CheckedHealth =
  | "unknown"
  | "healthy"
  | "degraded"
  | "auth_required";

export type HealthKind =
  | "working"
  | "notChecked"
  | "finishSetup"
  | "needsAttention"
  | "authRequired"
  | "limited"
  | "turnedOff"
  | "removed";

/** The one button that fixes a health state, or opens the connection. */
export type FixAction =
  | "manage"
  | "checkNow"
  | "finishSetup"
  | "reconnect"
  | "turnOn"
  | "connectAgain";

export type BadgeTone = "success" | "neutral" | "warning" | "danger";

export type Health = {
  readonly kind: HealthKind;
  readonly tone: BadgeTone;
  /** Whether the page shows a problem banner for it. */
  readonly banner: boolean;
  readonly action: FixAction;
};

const HEALTH: Readonly<Record<HealthKind, Health>> = {
  working: {
    kind: "working",
    tone: "success",
    banner: false,
    action: "manage",
  },
  notChecked: {
    kind: "notChecked",
    tone: "neutral",
    banner: false,
    action: "checkNow",
  },
  finishSetup: {
    kind: "finishSetup",
    tone: "neutral",
    banner: true,
    action: "finishSetup",
  },
  needsAttention: {
    kind: "needsAttention",
    tone: "warning",
    banner: true,
    action: "reconnect",
  },
  authRequired: {
    kind: "authRequired",
    tone: "danger",
    banner: true,
    action: "reconnect",
  },
  limited: {
    kind: "limited",
    tone: "warning",
    banner: true,
    action: "reconnect",
  },
  turnedOff: {
    kind: "turnedOff",
    tone: "neutral",
    banner: true,
    action: "turnOn",
  },
  removed: {
    kind: "removed",
    tone: "danger",
    banner: true,
    action: "connectAgain",
  },
};

/**
 * The health to show. `checked` is the finer value from a "Check now" the
 * page just ran; it refines a degraded or enabled connection and never
 * overrides a connection that is off, removed or not set up.
 */
export function connectionHealth(
  connection: ConnectionFacts,
  checked: CheckedHealth | null = null,
): Health {
  switch (connection.status) {
    case "revoked":
      return HEALTH.removed;
    case "disabled":
      return HEALTH.turnedOff;
    case "pending":
      return HEALTH.finishSetup;
    case "degraded":
    case "enabled": {
      if (checked === "auth_required") return HEALTH.authRequired;
      if (checked === "degraded") return HEALTH.limited;
      if (connection.status === "degraded") return HEALTH.needsAttention;
      return connection.lastCheckedAt === null && checked === null
        ? HEALTH.notChecked
        : HEALTH.working;
    }
  }
}

export type StepId = "install" | "repositories" | "turnOn";
export type StepStatus = "done" | "waiting" | "upcoming";

export type SetupStep = { readonly id: StepId; readonly status: StepStatus };

/**
 * Setup steps are shown only while a connection is waiting to be set up.
 * A connection exists only after GitHub's install and authorize steps are both
 * done, so the first step is always done here; choosing repositories is done
 * once one is selected; turning on is the last.
 */
export function setupSteps(
  connection: ConnectionFacts,
  selectedCount: number | null,
): readonly SetupStep[] | null {
  if (connection.status !== "pending") return null;
  const chosen = selectedCount !== null && selectedCount > 0;
  return [
    { id: "install", status: "done" },
    { id: "repositories", status: chosen ? "done" : "waiting" },
    { id: "turnOn", status: chosen ? "waiting" : "upcoming" },
  ];
}

/** The permission keys the app requests, in the order they are listed. */
export const KNOWN_PERMISSIONS = [
  "metadata:read",
  "contents:write",
  "issues:write",
  "pull_requests:write",
  "checks:write",
] as const;
export type KnownPermission = (typeof KNOWN_PERMISSIONS)[number];

export type Permission = {
  /** GitHub's own name, such as `contents:write`. */
  readonly key: string;
  /** Set when the key is one the app asks for and has plain wording. */
  readonly known: KnownPermission | null;
};

/**
 * The permissions a connection was granted, from the `{scope: level}` map the
 * read carries (typed `unknown` by the contract, so anything else reads as
 * none). Known ones come first in a fixed order; any other key keeps GitHub's
 * name and has no plain wording.
 */
export function permissionsOf(granted: unknown): readonly Permission[] {
  const entries =
    granted !== null && typeof granted === "object" && !Array.isArray(granted)
      ? Object.entries(granted).filter((entry): entry is [string, string] =>
        typeof entry[1] === "string"
      )
      : [];
  const keys = entries.map(([scope, level]) => `${scope}:${level}`);
  const known = KNOWN_PERMISSIONS.filter((key) => keys.includes(key)).map((
    key,
  ): Permission => ({ key, known: key }));
  const other = keys
    .filter((key) => !(KNOWN_PERMISSIONS as readonly string[]).includes(key))
    .sort()
    .map((key): Permission => ({ key, known: null }));
  return [...known, ...other];
}

/** A repository as the selection list sees it. */
export type SelectableRepository = {
  readonly id: string;
  readonly selected: boolean;
};

export type SelectionChange = {
  readonly id: string;
  readonly selected: boolean;
};

/**
 * What saving a selection must send: the differences between what is saved
 * and what is ticked, adding before removing, so swapping repositories never
 * passes through a moment with none selected (the server refuses that for a
 * connection that is on).
 */
export function selectionChanges(
  saved: readonly SelectableRepository[],
  ticked: ReadonlySet<string>,
): readonly SelectionChange[] {
  const adds = saved.filter((item) => !item.selected && ticked.has(item.id));
  const removes = saved.filter((item) => item.selected && !ticked.has(item.id));
  return [
    ...adds.map((item) => ({ id: item.id, selected: true })),
    ...removes.map((item) => ({ id: item.id, selected: false })),
  ];
}

/** The ticked set a list starts from: what is saved. */
export function savedSelection(
  saved: readonly SelectableRepository[],
): ReadonlySet<string> {
  return new Set(saved.filter((item) => item.selected).map((item) => item.id));
}

/** Repositories whose name contains the text, ignoring case and spacing. */
export function filterRepositories<T extends { readonly name: string }>(
  items: readonly T[],
  text: string,
): readonly T[] {
  const needle = text.trim().toLowerCase();
  if (needle === "") return items;
  return items.filter((item) => item.name.toLowerCase().includes(needle));
}

/** The list shows a search field once it is longer than this. */
export const SEARCH_AFTER = 10;
