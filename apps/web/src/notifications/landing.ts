import type { NotificationTargetResponse } from "../api/client.ts";

/** The parts of a task or document a notification can land on. */
export type LandingKind =
  | "step"
  | "approval"
  | "question"
  | "message"
  | "comment"
  | "version";

/** One exact place inside a page, from the address's `at` value. */
export type Landing = Readonly<{ kind: LandingKind; id: string }>;

/**
 * What the address of a landing carries, so a reload or a shared link opens
 * the same place: where (`at`), that the part is gone (`gone`), and which
 * notification to mark read once the page is up (`n` with its revision `r`).
 */
export type LandingSearch = Readonly<{
  at?: string;
  gone?: true;
  n?: string;
  r?: number;
}>;

const KINDS: readonly LandingKind[] = [
  "step",
  "approval",
  "question",
  "message",
  "comment",
  "version",
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `kind:id` (a uuid) or `version:N`; anything else is no landing at all. */
export function parseLanding(value: unknown): Landing | null {
  if (typeof value !== "string") return null;
  const split = value.indexOf(":");
  if (split < 1) return null;
  const kind = value.slice(0, split);
  const id = value.slice(split + 1);
  if (!(KINDS as readonly string[]).includes(kind)) return null;
  if (kind === "version") {
    return /^[1-9][0-9]{0,8}$/.test(id) ? { kind, id } : null;
  }
  return UUID.test(id) ? { kind: kind as LandingKind, id } : null;
}

/** The landing keys of a route's search, each kept only when it is well formed. */
export function landingSearch(search: Record<string, unknown>): LandingSearch {
  const at = parseLanding(search.at) === null ? undefined : String(search.at);
  const revision = Number(search.r);
  return {
    ...(at === undefined ? {} : { at }),
    ...(search.gone === true || search.gone === "1"
      ? { gone: true as const }
      : {}),
    ...(typeof search.n === "string" && UUID.test(search.n)
      ? { n: search.n }
      : {}),
    ...(Number.isInteger(revision) && revision >= 1 ? { r: revision } : {}),
  };
}

/** The two routes a notification can open, with their params. */
export type LandingRoute =
  | Readonly<{ to: "/tasks/$taskId"; params: { taskId: string } }>
  | Readonly<
    {
      to: "/tasks/$taskId/artifacts/$artifactId";
      params: { taskId: string; artifactId: string };
    }
  >;

const TASK_PATH =
  /^\/tasks\/([0-9a-f-]{36})(?:\/artifacts\/([0-9a-f-]{36}))?$/i;

/** Splits a resolved path into one of the two task routes, or null for anything else. */
export function landingRoute(path: string | null): LandingRoute | null {
  const match = path === null ? null : TASK_PATH.exec(path);
  if (match === null || !UUID.test(match[1]!)) return null;
  if (match[2] === undefined) {
    return { to: "/tasks/$taskId", params: { taskId: match[1]! } };
  }
  return UUID.test(match[2])
    ? {
      to: "/tasks/$taskId/artifacts/$artifactId",
      params: { taskId: match[1]!, artifactId: match[2] },
    }
    : null;
}

/**
 * Where to go for a resolved target, or null when there is nowhere to go.
 * The server already validates the path; this refuses anything that is not
 * one of the two task routes, so an unexpected value is never navigated to.
 */
export function landingDestination(
  target: Pick<NotificationTargetResponse, "status" | "path" | "anchor">,
  notification: Readonly<{ id: string; revision: number | null }>,
): { route: LandingRoute; search: LandingSearch } | null {
  if (target.status === "unavailable") return null;
  const route = landingRoute(target.path);
  if (route === null) return null;
  const at =
    target.status === "available" && parseLanding(target.anchor) !== null
      ? (target.anchor as string)
      : undefined;
  return {
    route,
    search: {
      ...(at === undefined ? {} : { at }),
      ...(target.status === "part_unavailable" ? { gone: true as const } : {}),
      n: notification.id,
      ...(notification.revision === null ? {} : { r: notification.revision }),
    },
  };
}
