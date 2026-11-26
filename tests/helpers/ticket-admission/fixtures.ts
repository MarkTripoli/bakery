import { issueNumberFromRef } from "../../../apps/server/src/modules/integrations/ticket-reads.ts";
/**
 * Shared fixtures for the issue 82 lanes. This is not a test module: it only
 * exports, and it registers no `Deno.test`.
 *
 * - `createMemoryTicketReader` is an in-memory `TicketSourceReader` with
 *   scripted answers and a call log; it never touches GitHub.
 * - `openTicketFixture` builds one organization with a connected GitHub
 *   connection and a selected repository resource (through the fake GitHub
 *   fixtures), a Bakery application and repository whose fixed-coding preset
 *   is ready, a Developer who can be the delegation principal, and helpers to
 *   insert sources and count what admission wrote. Transactions run as the
 *   application role (`bakery_app`), so grants are real; seeding and counting
 *   use the owner role.
 *
 * Provider reads are checked against open transactions by wrapping the pool
 * (`watchTransactions`): a begin counts up, a commit or rollback counts down,
 * and a reader call made while the count is above zero is recorded.
 */
import { onboardObserved } from "../review-repair/preset-integration-cases.ts";
import {
  type PgDatabase,
  type PgTransactionClient,
  withPgTransaction,
} from "../../../apps/server/src/platform/database.ts";
import { resolveOrganizationActor } from "../../../apps/server/src/modules/auth/adapters/authority-postgres.ts";
import { installBuiltInWorkflow } from "../../../apps/server/src/modules/work/ticket-workflow.ts";
import type { TicketPresetId } from "../../../packages/contracts/src/ticket-admission.ts";
import { TICKET_PRESET_IDS } from "../../../packages/contracts/src/workflow-presets.ts";
import type { OrganizationActor } from "../../../apps/server/src/modules/auth/application/authority.ts";
import {
  organizationId as toOrganizationId,
  principalId as toPrincipalId,
} from "../../../packages/contracts/src/contracts.ts";
import {
  defaultTicketSourcePolicy,
  type TicketRequestIntent,
  type TicketRequestOrigin,
  type TicketSourcePolicy,
} from "../../../packages/contracts/src/ticket-admission.ts";
import {
  type AdmissionCall,
  type AdmissionDeps,
  type AdmissionResult,
  admitTicket,
  advanceRequest,
  type RecheckOrigin,
  type RecheckResult,
  recheckTicket,
  recordReadiness,
} from "../../../apps/server/src/modules/work/ticket-admission.ts";
import type { TicketPrefetch } from "../../../apps/server/src/modules/work/ticket-prefetch.ts";
import type {
  TicketNoteRequest,
  TicketNoteResult,
  TicketNoteWriter,
} from "../../../apps/server/src/modules/work/ticket-notes.ts";
import type {
  RemoteTicketCreator,
  RemoteTicketRequest,
  RemoteTicketResult,
} from "../../../apps/server/src/modules/work/ticket-create.ts";
import type {
  IssueRef,
  PredecessorProof,
  TicketActorRole,
  TicketFactIndex,
  TicketIssueRead,
  TicketLabel,
  TicketLabelProvenance,
  TicketLinksRead,
  TicketReadFailure,
  TicketRef,
  TicketSourceHandle,
  TicketSourceReader,
} from "../../../apps/server/src/modules/work/ticket-source-reader.ts";
import {
  enabledConnection,
  type GitHubAppFixture,
  openGitHubAppFixture,
  type ResourceRow,
} from "../github-app-registration.ts";
import {
  createPresetTask,
  presetBudgetEnv,
  presetBudgetPolicy,
  seedFundedCodingAgent,
  seedPresetRepository,
  startPresetRun,
} from "../fixed-coding-preset.ts";

export type {
  IssueRef,
  PredecessorProof,
  TicketFactIndex,
  TicketReadFailure,
  TicketSourceHandle,
  TicketSourceReader,
} from "../../../apps/server/src/modules/work/ticket-source-reader.ts";

/** Body with an Acceptance criteria section, so a ticket is ready on its text. */
export const ACCEPTANCE_BODY =
  "Make the upload retry.\n\n## Acceptance criteria\n- it retries twice\n";

/** The labels of the default policy. */
export const EXECUTE_LABEL = "ready for agent";
export const PLAN_LABEL = "ready for planning";
export const HOLD_LABEL = "bakery:hold";

/** GitHub user id and login the fixture allowlists for automatic admission. */
export const LABELER_ID = "4242";
export const LABELER_LOGIN = "labeler";

/** The automatic window opens at `SINCE`; a label applied `AFTER_SINCE` is inside it. */
export const SINCE = "2026-01-01T00:00:00Z";
export const AFTER_SINCE = "2026-07-01T00:00:00Z";
export const BEFORE_SINCE = "2025-06-01T00:00:00Z";

/** One call a reader received. */
export type ReaderCall = {
  method: string;
  number: number | null;
  /**
   * Whether `readStatuses` was handed the issue snapshot by its caller, so a
   * test can tell "used the read already in hand" from "asked the provider
   * again". Undefined for every other method.
   */
  hadSnapshot?: boolean;
};

/** What `setIssue` accepts; every field has a default. */
export type IssueInit = {
  number: number;
  id?: string;
  title?: string;
  body?: string;
  labels?: string[];
  /**
   * Provider label ids, one per label; defaults to the names themselves.
   * Null models a reader that names no label ids.
   */
  labelIds?: string[] | null;
  state?: "open" | "closed";
  stateReason?: string | null;
  repositoryFullName?: string;
  /** Provider `updated_at`; by default each `setIssue` moves it forward one second. */
  updatedAt?: string;
  visibility?: "public" | "private";
};

type IssueSeed = Required<Omit<IssueInit, "repositoryFullName">> & {
  repositoryFullName: string | null;
};

/** The permission names a GitHub role can hold. */
type RolePermission = "admin" | "write" | "read" | "none";

/** GitHub's own ladder, the one the real reader maps into the contract band. */
const GITHUB_ROLE_RANK: Record<RolePermission, number> = {
  none: 0,
  read: 1,
  write: 2,
  admin: 3,
};

/** A blocker reference as a test may state it: a repository, not a container. */
type LegacyRef = { id: string; number: number; repositoryFullName: string };

function asContainerRef(
  ref: LegacyRef | IssueRef,
): IssueRef {
  if ("container" in ref) return ref;
  return {
    id: ref.id,
    number: ref.number,
    container: {
      kind: "repository",
      externalId: ref.repositoryFullName,
      displayName: ref.repositoryFullName,
    },
  };
}

/** Scripted in-memory reader with a call log. */
export type MemoryTicketReader = TicketSourceReader & {
  calls: ReaderCall[];
  /** Runs at the start of every read; the transaction watch hangs here. */
  onCall: ((call: ReaderCall) => void) | null;
  /** Awaited at the start of every read, so a test can make the provider slow. */
  pause: ((call: ReaderCall) => Promise<void>) | null;
  setIssue(init: IssueInit): void;
  /** Replaces the issue answer with gone, moved, pull_request or a failure. */
  setIssueRead(number: number, read: TicketIssueRead): void;
  /**
   * Blockers may be stated either way: a container, or the repository this
   * GitHub-shaped double is standing in for.
   */
  setLinks(
    number: number,
    links:
      & Omit<
        Partial<Extract<TicketLinksRead, { kind: "present" }>>,
        "blockedBy"
      >
      & {
        blockedBy?: (IssueRef | LegacyRef)[];
      },
  ): void;
  setLinksRead(number: number, read: TicketLinksRead): void;
  setProof(
    blockerId: string,
    proof: PredecessorProof | TicketReadFailure,
  ): void;
  setLabelApplied(
    number: number,
    label: string,
    by?: { actorId?: string; actorLogin?: string; appliedAt?: string },
  ): void;
  setProvenance(
    number: number,
    label: string,
    answer: TicketLabelProvenance,
  ): void;
  /**
   * A present role may omit its rank: this double is the provider, so it maps
   * its own permission names to the contract's ladder the way the real reader
   * does.
   */
  setRole(
    login: string,
    answer:
      | Exclude<TicketActorRole, { kind: "present" }>
      | {
        kind: "present";
        userId: string;
        permission: RolePermission;
        rank?: number;
      },
  ): void;
  /** Makes the next call of a method answer with a failure. */
  failNext(method: keyof TicketSourceReader, failure?: TicketReadFailure): void;
  /** The provider's labels, served in pages of `pageSize`; `unsupported` for a tracker without labels. */
  setLabels(
    labels: TicketLabel[] | { kind: "unsupported" },
    pageSize?: number,
  ): void;
  callsOf(method: keyof TicketSourceReader): ReaderCall[];
  clearCalls(): void;
};

/**
 * Whether a reference names the seeded ticket, when it names an id at all.
 *
 * The live reader refuses a key that resolves to a different id, so the double
 * does too: without this a test could pass a mismatched id and be told a ticket
 * that a real provider would have refused.
 */
const seededIds = new Map<number, string>();

const knownId = (ref: TicketRef, number: number): boolean => {
  if (ref.externalId === null) return true;
  return seededIds.get(number) === ref.externalId;
};

const BASE_MARKER = Date.parse("2026-06-01T00:00:00.000Z");

/** The failure shape the live reader answers with, built once so it reads the same. */
const providerError = (): TicketReadFailure => ({
  kind: "unavailable",
  reason: "provider_error",
  retryAfterSeconds: null,
});

export const UNAVAILABLE: TicketReadFailure = Object.freeze({
  kind: "unavailable",
  reason: "provider_error",
  retryAfterSeconds: null,
});

export function createMemoryTicketReader(): MemoryTicketReader {
  const issues = new Map<number, IssueSeed | TicketIssueRead>();
  const links = new Map<number, TicketLinksRead>();
  const proofs = new Map<string, PredecessorProof | TicketReadFailure>();
  const provenance = new Map<string, TicketLabelProvenance>();
  const roles = new Map<string, TicketActorRole>();
  let labels: TicketLabel[] | { kind: "unsupported" } = [];
  let labelPageSize = 50;
  const failures = new Map<string, TicketReadFailure[]>();
  let tick = 0;

  const nextMarker = () =>
    new Date(BASE_MARKER + (++tick) * 1000).toISOString();

  const enter = async (
    method: string,
    number: number | null,
    extra?: { hadSnapshot?: boolean },
  ) => {
    const call = { method, number, ...extra };
    reader.calls.push(call);
    reader.onCall?.(call);
    await reader.pause?.(call);
    const queued = failures.get(method);
    return queued?.shift() ?? null;
  };

  const reader: MemoryTicketReader = {
    calls: [],
    onCall: null,
    pause: null,
    setIssue(init) {
      seededIds.set(init.number, init.id ?? String(1000 + init.number));
      issues.set(init.number, {
        number: init.number,
        id: init.id ?? String(1000 + init.number),
        title: init.title ?? `Issue ${init.number}`,
        body: init.body ?? ACCEPTANCE_BODY,
        labels: init.labels ?? [],
        labelIds: init.labelIds === null
          ? null
          : init.labelIds ?? init.labels ?? [],
        state: init.state ?? "open",
        stateReason: init.stateReason ?? null,
        repositoryFullName: init.repositoryFullName ?? null,
        updatedAt: init.updatedAt ?? nextMarker(),
        visibility: init.visibility ?? "private",
      });
    },
    setIssueRead(number, read) {
      issues.set(number, read);
    },
    setLinks(number, partial) {
      // This double stands in for the GitHub reader, which knows a ticket by
      // its repository. The contract stores a container, so the conversion is
      // the double's job, exactly as the real reader's is: a test can keep
      // saying "owner/repo".
      links.set(number, {
        kind: "present",
        parent: null,
        subIssuesTotal: 0,
        blockingTotal: 0,
        truncated: false,
        ...partial,
        // After the spread: the caller's blockedBy is in the double's own
        // vocabulary, and this is the line that converts it.
        blockedBy: (partial.blockedBy ?? []).map(asContainerRef),
      });
    },
    setLinksRead(number, read) {
      links.set(number, read);
    },
    setProof(blockerId, proof) {
      proofs.set(blockerId, proof);
    },
    setLabelApplied(number, label, by = {}) {
      provenance.set(`${number}\u0000${label}`, {
        kind: "applied",
        actorId: by.actorId ?? LABELER_ID,
        actorLogin: by.actorLogin ?? LABELER_LOGIN,
        appliedAt: by.appliedAt ?? "2026-07-01T00:00:00Z",
      });
    },
    setProvenance(number, label, answer) {
      provenance.set(`${number}\u0000${label}`, answer);
    },
    setRole(login, answer) {
      roles.set(
        login,
        answer.kind === "present" && answer.rank === undefined
          ? { ...answer, rank: GITHUB_ROLE_RANK[answer.permission] }
          : answer as TicketActorRole,
      );
    },
    setLabels(next, pageSize = 50) {
      labels = next;
      labelPageSize = pageSize;
    },
    async readLabels(_handle, request) {
      const failure = await enter("readLabels", request.page);
      if (failure) return failure;
      if (!Array.isArray(labels)) return labels;
      const start = (request.page - 1) * labelPageSize;
      return {
        kind: "present" as const,
        labels: labels.slice(start, start + labelPageSize),
        hasNext: start + labelPageSize < labels.length,
      };
    },
    failNext(method, failure = UNAVAILABLE) {
      failures.set(method, [...(failures.get(method) ?? []), failure]);
    },
    callsOf(method) {
      return reader.calls.filter((call) => call.method === method);
    },
    clearCalls() {
      reader.calls.length = 0;
    },
    async readIssue(handle: TicketSourceHandle, ref: TicketRef) {
      // Seeded by GitHub's ordinal, and parsed by the same function the live
      // reader uses, so the double cannot answer a question the real reader
      // would refuse: a key that is not a number, or that now resolves to a
      // different id, is unavailable rather than some other ticket.
      const number = issueNumberFromRef(ref);
      if (number === null || !knownId(ref, number)) {
        return Promise.resolve(providerError());
      }
      const failure = await enter("readIssue", number);
      if (failure) return Promise.resolve(failure);
      const seeded = issues.get(number);
      if (seeded === undefined) {
        return Promise.resolve({ kind: "gone" as const });
      }
      if ("kind" in seeded) return Promise.resolve(seeded);
      return Promise.resolve({
        kind: "present" as const,
        snapshot: {
          externalId: seeded.id,
          number: seeded.number,
          title: seeded.title,
          body: seeded.body,
          bodyTooLarge: false,
          labels: seeded.labels,
          ...(seeded.labelIds === null ? {} : { labelIds: seeded.labelIds }),
          state: seeded.state,
          stateReason: seeded.stateReason,
          locked: false,
          container: {
            kind: "repository",
            externalId: seeded.repositoryFullName ?? handle.repositoryFullName,
            displayName: seeded.repositoryFullName ?? handle.repositoryFullName,
          },
        },
        providerUpdatedAt: seeded.updatedAt,
        visibility: seeded.visibility,
      });
    },
    async readLinks(_handle, ref: TicketRef) {
      const number = issueNumberFromRef(ref);
      const failure = await enter("readLinks", number);
      if (number === null || !knownId(ref, number)) {
        return Promise.resolve(providerError());
      }
      if (failure) return Promise.resolve(failure);
      return Promise.resolve(
        links.get(number) ?? {
          kind: "present" as const,
          parent: null,
          subIssuesTotal: 0,
          blockedBy: [],
          blockingTotal: 0,
          truncated: false,
        },
      );
    },
    async readPredecessorProof(_handle, blocker: IssueRef) {
      const failure = await enter("readPredecessorProof", blocker.number);
      if (failure) return Promise.resolve(failure);
      return Promise.resolve(
        proofs.get(blocker.id) ??
          { kind: "proof_unavailable" as const, detail: "unseeded" },
      );
    },
    async readLabelProvenance(_handle, ref: TicketRef, label) {
      const number = issueNumberFromRef(ref);
      const failure = await enter("readLabelProvenance", number);
      if (number === null || !knownId(ref, number)) {
        return Promise.resolve(providerError());
      }
      if (failure) return Promise.resolve(failure);
      return Promise.resolve(
        provenance.get(`${number}\u0000${label}`) ??
          { kind: "absent" as const },
      );
    },
    async readStatuses(_handle, ref: TicketRef, _signal, issue) {
      const failure = await enter("readStatuses", null, {
        hadSnapshot: issue !== undefined,
      });
      if (failure) return Promise.resolve(failure);
      const number = issueNumberFromRef(ref);
      if (number === null || !knownId(ref, number)) {
        return Promise.resolve(providerError());
      }
      // A double stands in for the provider, so it answers the way GitHub does:
      // the issue's own state, with the close reason when there is one.
      const seed = issues.get(number);
      if (seed === undefined) {
        return Promise.resolve({ kind: "unsupported" as const });
      }
      if ("kind" in seed) {
        return Promise.resolve({ kind: "unsupported" as const });
      }
      const reason = seed.stateReason ?? null;
      return Promise.resolve({
        kind: "present" as const,
        statuses: [{
          id: seed.state === "closed" && reason
            ? `closed:${reason}`
            : seed.state,
          name: seed.state === "closed" && reason
            ? `closed (${reason})`
            : seed.state,
        }],
      });
    },
    async readActorRole(_handle, login) {
      const failure = await enter("readActorRole", null);
      if (failure) return Promise.resolve(failure);
      return Promise.resolve(roles.get(login) ?? { kind: "absent" as const });
    },
    async listIssues() {
      const failure = await enter("listIssues", null);
      if (failure) return failure;
      // The open issues seeded with `setIssue`, as the provider's issue list shows them.
      const open = [...issues.values()].filter((seed): seed is IssueSeed =>
        !("kind" in seed) && seed.state === "open"
      );
      return {
        kind: "present" as const,
        numbers: open.sort((a, b) => a.number - b.number).map((seed) => ({
          number: seed.number,
          updatedAt: seed.updatedAt,
          labels: seed.labels,
        })),
        hasNext: false,
      };
    },
  };
  return reader;
}

/** In-memory `TicketFactIndex` with the live index's order, exclusive marker, keyset and row bound. */
export type MemoryFactIndex = TicketFactIndex & {
  /** Records the issue fact for `number`; a later call for the same number replaces it. */
  set(number: number, providerUpdatedAt: string, labels?: string[]): void;
  remove(number: number): void;
};

/** The live index never answers more than this many numbers at once. */
const MEMORY_FACT_INDEX_LIMIT = 100;

export function createMemoryFactIndex(): MemoryFactIndex {
  const facts = new Map<
    number,
    { providerUpdatedAt: string; labels: string[] }
  >();
  return {
    set(number, providerUpdatedAt, labels = []) {
      facts.set(number, { providerUpdatedAt, labels });
    },
    remove(number) {
      facts.delete(number);
    },
    listIssueNumbers(_transaction, request) {
      const marker = request.afterMarker === null
        ? null
        : Date.parse(request.afterMarker);
      const after = request.afterNumber ?? null;
      const ordered = [...facts.entries()]
        .map(([number, fact]) => ({
          number,
          at: Date.parse(fact.providerUpdatedAt),
          ...fact,
        }))
        .filter((fact) =>
          marker === null || fact.at > marker ||
          (after !== null && fact.at === marker && fact.number > after)
        )
        .sort((a, b) => a.at - b.at || a.number - b.number);
      const limit = Math.min(
        MEMORY_FACT_INDEX_LIMIT,
        Math.max(1, Math.trunc(request.limit)),
      );
      return Promise.resolve(
        ordered.slice(0, limit).map((
          { number, providerUpdatedAt, labels },
        ) => ({
          number,
          providerUpdatedAt,
          labels,
        })),
      );
    },
  };
}

/** Counts of a pool's open transactions, and the begin and commit statements it saw. */
export type TransactionWatch = {
  database: PgDatabase;
  open(): number;
  /** Largest number of transactions open at once. */
  peak(): number;
};

/**
 * Wraps a pool so every client it lends reports its `begin`, `commit` and
 * `rollback`. `withPgTransaction` is the only way the admission code opens a
 * transaction, so a reader call made while `open()` is above zero is a
 * provider read inside a transaction.
 */
export function watchTransactions(pool: PgDatabase): TransactionWatch {
  let open = 0;
  let peak = 0;
  type Lent = { query: (...args: unknown[]) => unknown };
  const wrapClient = (client: Lent) =>
    new Proxy(client, {
      get(target, property, receiver) {
        if (property === "query") {
          return (...args: unknown[]) => {
            const text = typeof args[0] === "string"
              ? args[0]
              : (args[0] as { text?: string })?.text ?? "";
            const verb = text.trim().split(/\s+/, 1)[0]?.toLowerCase();
            if (verb === "begin") {
              open += 1;
              peak = Math.max(peak, open);
            } else if (verb === "commit" || verb === "rollback") {
              open = Math.max(0, open - 1);
            }
            return target.query(...args);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const database = new Proxy(pool, {
    get(target, property, receiver) {
      if (property === "connect") {
        return async () =>
          wrapClient(await (target.connect() as unknown as Promise<Lent>));
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { database, open: () => open, peak: () => peak };
}

/** Rows the ticket tables, tasks and runs hold for one source. */
export type SourceCounts = {
  tickets: number;
  reports: number;
  links: number;
  requests: number;
  nonterminalRequests: number;
  tasks: number;
  conversations: number;
  runs: number;
};

/** A Developer-level delegation principal and the GitHub actor allowlisted for it. */
export type TicketFixture = Awaited<ReturnType<typeof openTicketFixture>>;

export type PolicyOverrides = {
  delegation?: boolean | { principalId?: string; externalActorIds?: string[] };
  automatic?: { enabled: boolean; since: string | null };
  approval?: "automatic" | "human_approval";
  requireAcceptanceCriteria?: boolean;
  /**
   * Statuses the source requires, by provider id. Omitted leaves readiness
   * deciding on the label alone, which is what every existing source does.
   */
  statuses?: string[];
  /** What counts as delivery; omitted keeps the default, `merged`. */
  completion?: "task" | "merged" | "deployed_healthy";
};

/**
 * Opens the fixture; call `close()` in a `finally`. The production app mounts
 * the ticket routes with the fixture's in-memory reader and fact index.
 * `budget` gives the app the server budget policy (so a ready issue can be
 * admitted over HTTP); `liveFactIndex` leaves the app its stored-fact index.
 */
/**
 * An in-memory status-note writer standing in for the provider: it keeps the
 * comments it holds by id, rewrites one in place when the request names it,
 * and posts a new one (recreated) when the named comment was deleted.
 */
export type MemoryNoteWriter = TicketNoteWriter & {
  posts: TicketNoteRequest[];
  /** The comments the fake provider holds: id to body. */
  comments: Map<string, string>;
  /** Answers of the next posts, oldest first; an empty queue posts comment ids 1001, 1002, ... */
  next: TicketNoteResult[];
  /** Awaited inside a post, before it answers; lets a test hold a write in flight. */
  hold: Promise<void> | null;
};

export function createMemoryNoteWriter(): MemoryNoteWriter {
  let counter = 1000;
  const writer: MemoryNoteWriter = {
    posts: [],
    comments: new Map(),
    next: [],
    hold: null,
    async post(request) {
      writer.posts.push(request);
      if (writer.hold !== null) await writer.hold;
      const scripted = writer.next.shift();
      if (scripted !== undefined) {
        if (scripted.kind === "posted") {
          writer.comments.set(scripted.externalId, request.body);
        }
        return scripted;
      }
      const existing = request.existingExternalId;
      if (existing !== null && writer.comments.has(existing)) {
        writer.comments.set(existing, request.body);
        return { kind: "posted", externalId: existing, recreated: false };
      }
      const id = String(++counter);
      writer.comments.set(id, request.body);
      return { kind: "posted", externalId: id, recreated: existing !== null };
    },
  };
  return writer;
}

/**
 * An in-memory remote-ticket creator standing in for the provider: it records
 * each request, answers a fresh effect id, and replays the same one for a
 * repeated idempotency key, as the ledger does.
 */
export type MemoryTicketCreator = RemoteTicketCreator & {
  requests: RemoteTicketRequest[];
  /** Answers of the next sends, oldest first; an empty queue answers `submitted`. */
  next: RemoteTicketResult[];
};

export function createMemoryTicketCreator(): MemoryTicketCreator {
  const effects = new Map<string, string>();
  const creator: MemoryTicketCreator = {
    requests: [],
    next: [],
    actionFor: (provider) =>
      provider === "github" ? "github.issue.create" : null,
    create(request) {
      creator.requests.push(request);
      const scripted = creator.next.shift();
      if (scripted !== undefined) return Promise.resolve(scripted);
      const effectId = effects.get(request.idempotencyKey) ??
        crypto.randomUUID();
      effects.set(request.idempotencyKey, effectId);
      return Promise.resolve({ kind: "sent", effectId, status: "submitted" });
    },
  };
  return creator;
}

export async function openTicketFixture(
  options: {
    label?: string;
    budget?: boolean;
    liveFactIndex?: boolean;
    /** Also bind review and repair agents, so the reviewed preset is ready. */
    reviewed?: boolean;
  } = {},
) {
  const reader = createMemoryTicketReader();
  const facts = createMemoryFactIndex();
  const notes = createMemoryNoteWriter();
  const creator = createMemoryTicketCreator();
  const f: GitHubAppFixture = await openGitHubAppFixture({
    ticketReader: reader,
    ticketNoteWriter: notes,
    ticketCreator: creator,
    ticketFactIndex: options.liveFactIndex ? undefined : facts,
    env: options.budget ? presetBudgetEnv : undefined,
  });
  try {
    const connection = await enabledConnection(f, { selected: 1 });
    const resource: ResourceRow = connection.selected[0];
    const scope = {
      organizationId: f.organizationId,
      principalId: f.adminId,
      adminCookie: f.adminCookie,
    };
    const agentVersionId = await seedFundedCodingAgent(
      f,
      scope,
      options.label ?? "issue82",
    );
    const label = options.label ?? "issue82";
    // The reviewed workflow runs only on an observed (v2) profile, so that
    // repository goes through a real inspection instead of a seeded profile.
    const repository = options.reviewed === true
      ? await onboardObserved({
        pgDatabase: f.pgDatabase,
        runtimePgDatabase: f.runtimePgDatabase!,
        organizationId: f.organizationId,
        principalId: f.adminId,
      }, {
        "harness.implement": agentVersionId,
        "harness.repair": await seedFundedCodingAgent(
          f,
          scope,
          `${label}-repair`,
        ),
        "review.independent": await seedFundedCodingAgent(
          f,
          scope,
          `${label}-review`,
        ),
      })
      : await seedPresetRepository(f.pgDatabase, scope, { agentVersionId });
    // `ticketSources.create` accepts the repository its resource maps to: the
    // same connection and the provider's repository id.
    await f.pgDatabase.query(
      `update bakery.repositories
          set integration_connection_id = $3, provider_repo_id = $4
        where organization_id = $1 and id = $2`,
      [
        f.organizationId,
        repository.repositoryId,
        connection.connectionId,
        resource.external_id,
      ],
    );
    if (f.developerId === undefined) throw new Error("developer is seeded");
    const runtime = f.runtimePgDatabase!;
    const sourceIds: string[] = [];

    const builtIns = new Map<TicketPresetId, string>();
    for (const id of TICKET_PRESET_IDS) {
      builtIns.set(
        id,
        await withPgTransaction(
          f.pgDatabase,
          (transaction) =>
            installBuiltInWorkflow(
              transaction,
              f.organizationId,
              f.adminId,
              id,
            ),
        ),
      );
    }
    const builtInWorkflow = (id: TicketPresetId) => ({
      workflowId: builtIns.get(id)!,
      builtIn: id,
    });
    const policy = (overrides: PolicyOverrides = {}): TicketSourcePolicy => {
      const base: TicketSourcePolicy = {
        ...defaultTicketSourcePolicy(),
        workflow: builtInWorkflow("fixed-coding"),
      };
      const delegation = overrides.delegation === undefined ||
          overrides.delegation === false
        ? null
        : {
          principalId: f.developerId!,
          externalActorIds: [LABELER_ID],
          ...(overrides.delegation === true ? {} : overrides.delegation),
        };
      return {
        ...base,
        delegation,
        automatic: overrides.automatic ?? base.automatic,
        approval: { plan: overrides.approval ?? "automatic" },
        completion: overrides.completion ?? base.completion,
        readiness: {
          requireAcceptanceCriteria: overrides.requireAcceptanceCriteria ??
            true,
          ...(overrides.statuses === undefined
            ? {}
            : { statuses: overrides.statuses }),
        },
      };
    };

    const fixture = {
      f,
      reader,
      facts,
      notes,
      creator,
      organizationId: f.organizationId,
      adminId: f.adminId,
      developerId: f.developerId,
      connectionId: connection.connectionId,
      resource,
      repositoryFullName: resource.display_name,
      applicationId: repository.applicationId,
      repositoryId: repository.repositoryId,
      repository,
      runtime,
      owner: f.pgDatabase,
      policy,
      builtInWorkflow,

      /** Inserts a source for the fixture repository as the owner role; returns its id. */
      async insertSource(
        options: {
          policy?: TicketSourcePolicy;
          enabled?: boolean;
          repositoryId?: string | null;
          /**
           * The source's application. Defaults to the fixture's, and may be
           * null: a provider-neutral source has none, and admission must still
           * serialise on something.
           */
          applicationId?: string | null;
          /** The container id; unique per connection. Defaults to the resource's, then a numbered one. */
          externalContainerId?: string;
        } = {},
      ): Promise<string> {
        const id = crypto.randomUUID();
        await f.pgDatabase.query(
          `insert into bakery.ticket_sources (
             id, organization_id, provider, integration_connection_id,
             integration_resource_id, application_id, repository_id,
             external_container_id, enabled, policy
           ) values ($1, $2, 'github', $3, $4, $5, $6, $7, $8, $9::jsonb)`,
          [
            id,
            f.organizationId,
            connection.connectionId,
            resource.id,
            options.applicationId === undefined
              ? repository.applicationId
              : options.applicationId,
            options.repositoryId === undefined
              ? repository.repositoryId
              : options.repositoryId,
            // The container id is unique per connection: the resource id is
            // unique per resource, and a second source on it takes a suffix.
            options.externalContainerId ??
              (sourceIds.length === 0
                ? resource.external_id
                : `${resource.external_id}-${sourceIds.length}`),
            options.enabled ?? true,
            JSON.stringify(options.policy ?? policy()),
          ],
        );
        sourceIds.push(id);
        return id;
      },

      /** The live organization actor of a principal, resolved as the application role. */
      async actor(principalId: string): Promise<OrganizationActor> {
        return await withPgTransaction(
          runtime,
          (transaction) =>
            resolveOrganizationActor(
              transaction,
              toPrincipalId(principalId),
              toOrganizationId(f.organizationId),
            ),
        );
      },

      inTransaction<T>(work: (tx: PgTransactionClient) => Promise<T>) {
        return withPgTransaction(runtime, work);
      },

      /**
       * HTTP `runs.create` for a task with the fixed-coding preset, as the
       * Admin, through the production app. Returns the status and body text.
       */
      async startRun(
        taskId: string,
        extra: Record<string, unknown> = {},
      ): Promise<{ status: number; text: string }> {
        const response = await startPresetRun(
          f,
          scope,
          { id: taskId, conversationId: "" },
          repository,
          { extra },
        );
        return { status: response.status, text: await response.text() };
      },

      /** A task created through the API for the fixture repository, unrelated to any ticket. */
      async createPlainTask(): Promise<string> {
        return (await createPresetTask(f, scope, repository)).id;
      },

      /** Operation-mode dependencies around an open transaction. */
      operationDeps(transaction: PgTransactionClient): AdmissionDeps {
        return {
          reader,
          budget: presetBudgetPolicy,
          readsAllowed: false,
          transaction,
        };
      },

      /** Automation-mode dependencies: admission opens its own transaction. */
      automationDeps(database: PgDatabase = runtime): AdmissionDeps {
        return {
          reader,
          budget: presetBudgetPolicy,
          readsAllowed: true,
          database,
        };
      },

      /**
       * One automation-mode admission. The caller defaults to the Admin for an
       * explicit origin and to none for webhook and poll.
       */
      async admit(
        sourceId: string,
        call: {
          number: number;
          origin?: TicketRequestOrigin;
          intent?: TicketRequestIntent | null;
          caller?: OrganizationActor | null;
          prefetch?: TicketPrefetch | null;
          requirementsDigest?: string | null;
          requirePlanApproval?: boolean;
          deps?: AdmissionDeps;
        },
      ): Promise<AdmissionResult> {
        const origin = call.origin ?? "manual";
        const explicit = origin === "manual" || origin === "adoption";
        const caller = call.caller !== undefined
          ? call.caller
          : explicit
          ? await fixture.actor(f.adminId)
          : null;
        const request: AdmissionCall = {
          organizationId: f.organizationId,
          sourceId,
          number: call.number,
          intent: call.intent === undefined
            ? explicit ? "start" : null
            : call.intent,
          origin,
          caller,
          prefetch: call.prefetch ?? null,
          signal: new AbortController().signal,
          requirementsDigest: call.requirementsDigest ?? null,
          requirePlanApproval: call.requirePlanApproval,
        };
        return await admitTicket(
          call.deps ?? fixture.automationDeps(),
          request,
        );
      },

      /** One automation-mode recheck of a ticket's nonterminal request. */
      async recheck(
        ticketId: string,
        call: {
          origin?: RecheckOrigin;
          prefetch?: TicketPrefetch | null;
          deps?: AdmissionDeps;
        } = {},
      ): Promise<RecheckResult> {
        return await recheckTicket(call.deps ?? fixture.automationDeps(), {
          organizationId: f.organizationId,
          ticketId,
          origin: call.origin ?? "poll",
          prefetch: call.prefetch ?? null,
          signal: new AbortController().signal,
        });
      },

      /** One automation-mode advance of a request. */
      async advance(
        requestId: string,
        call: { deps?: AdmissionDeps; prefetch?: TicketPrefetch | null } = {},
      ): Promise<RecheckResult> {
        return await advanceRequest(call.deps ?? fixture.automationDeps(), {
          organizationId: f.organizationId,
          requestId,
          prefetch: call.prefetch ?? null,
          signal: new AbortController().signal,
        });
      },

      /** Counts of everything one source's tickets own. */
      async counts(sourceId: string): Promise<SourceCounts> {
        const result = await f.pgDatabase.query<Record<string, string>>(
          `with tickets as (
             select id from bakery.external_tickets
              where organization_id = $1 and ticket_source_id = $2),
           links as (
             select task_id from bakery.ticket_task_links
              where organization_id = $1
                and external_ticket_id in (select id from tickets))
           select
             (select count(*) from tickets) as tickets,
             (select count(*) from bakery.ticket_readiness_reports
               where external_ticket_id in (select id from tickets)) as reports,
             (select count(*) from links) as links,
             (select count(*) from bakery.ticket_requests
               where external_ticket_id in (select id from tickets)) as requests,
             (select count(*) from bakery.ticket_requests
               where external_ticket_id in (select id from tickets)
                 and disposition in ('waiting', 'admitted', 'active', 'suspended'))
               as "nonterminalRequests",
             (select count(*) from bakery.tasks
               where organization_id = $1
                 and id in (select task_id from links)) as tasks,
             (select count(*) from bakery.conversations
               where organization_id = $1
                 and id in (select conversation_id from bakery.tasks
                             where id in (select task_id from links)))
               as conversations,
             (select count(*) from bakery.workflow_runs
               where organization_id = $1
                 and task_id in (select task_id from links)) as runs`,
          [f.organizationId, sourceId],
        );
        const row = result.rows[0];
        return Object.fromEntries(
          Object.entries(row).map(([key, value]) => [key, Number(value)]),
        ) as SourceCounts;
      },

      /** Audit and domain-event rows written for one ticket request. */
      async requestFacts(requestId: string) {
        const audit = await f.pgDatabase.query<{ operation: string }>(
          `select operation from bakery.audit_events
            where organization_id = $1 and resource_type = 'ticket_request'
              and resource_id = $2 order by created_at, id`,
          [f.organizationId, requestId],
        );
        const events = await f.pgDatabase.query<{ payload: unknown }>(
          `select payload from bakery.domain_events
            where organization_id = $1 and aggregate_id = $2
              and event_type = 'ticket.request.updated'
            order by sequence`,
          [f.organizationId, requestId],
        );
        const outbox = await f.pgDatabase.query(
          `select 1 from bakery.outbox outbox
             join bakery.domain_events event on event.id = outbox.event_id
            where event.organization_id = $1 and event.aggregate_id = $2
              and event.event_type = 'ticket.request.updated'`,
          [f.organizationId, requestId],
        );
        return {
          audit: audit.rows.map((row) => row.operation),
          events: events.rows.map((row) => row.payload),
          outbox: outbox.rows.length,
        };
      },

      /** Moves the single nonterminal request of a source's ticket to a terminal state (owner role). */
      async finishRequests(
        sourceId: string,
        disposition: "completed" | "failed" | "canceled" = "completed",
      ): Promise<void> {
        await f.pgDatabase.query(
          `update bakery.ticket_requests set disposition = $3,
                  updated_at = now(), version = version + 1
            where organization_id = $1
              and disposition in ('waiting', 'admitted', 'active', 'suspended')
              and external_ticket_id in (
                select id from bakery.external_tickets
                 where organization_id = $1 and ticket_source_id = $2)`,
          [f.organizationId, sourceId, disposition],
        );
      },

      /**
       * Registers a pull request of a task of this source's repository, with
       * the status the provider last reported (owner role): the delivery
       * evidence a completion policy reads.
       */
      async registerPullRequest(options: {
        sourceId: string;
        taskId: string;
        number: number;
        status: "open" | "closed" | "merged";
      }): Promise<void> {
        const sha = (char: string) => char.repeat(40);
        await f.pgDatabase.query(
          `insert into bakery.pull_requests (
             id, organization_id, task_id, repository_id, provider_number, url,
             head_sha, base_sha, status, merged_sha, version
           )
           select gen_random_uuid(), $1::uuid, $2::uuid, source.repository_id,
                  $3::integer,
                  'https://github.com/acme/widgets/pull/' || $3::integer::text,
                  $4::text, $5::text, $6::text,
                  case when $6::text = 'merged' then $7::text end, 1
             from bakery.ticket_sources as source
            where source.organization_id = $1::uuid and source.id = $8::uuid`,
          [
            f.organizationId,
            options.taskId,
            options.number,
            sha("a"),
            sha("b"),
            options.status,
            sha("c"),
            options.sourceId,
          ],
        );
      },

      /**
       * Gives a principal a live out-of-Bakery grant for one action on the
       * fixture's repository resource (owner role); the guard of
       * `externalTickets.create` reads it.
       */
      async grantAction(
        principalId: string,
        capability = "github.issue.create",
      ): Promise<void> {
        await f.pgDatabase.query(
          `insert into bakery.integration_grants (
             id, organization_id, connection_id, subject_type,
             subject_principal_id, direction, capability, action_version,
             resource_id, granted_by
           ) values ($1, $2, $3, 'principal', $4, 'out_of_bakery', $5, 1, $6, $7)`,
          [
            crypto.randomUUID(),
            f.organizationId,
            connection.connectionId,
            principalId,
            capability,
            resource.id,
            f.adminId,
          ],
        );
      },

      async close(): Promise<void> {
        await f.finish();
      },
    };
    return fixture;
  } catch (error) {
    await f.finish();
    throw error;
  }
}

/** A delegated, automatic-admission source policy: the labeler may admit as the Developer. */
export function automaticPolicy(
  fx: TicketFixture,
  overrides: Parameters<TicketFixture["policy"]>[0] = {},
) {
  return fx.policy({
    delegation: true,
    automatic: { enabled: true, since: SINCE },
    ...overrides,
  });
}

/** Seeds the repository role of the allowlisted labeler. */
export function seedLabeler(
  fx: Pick<TicketFixture, "reader">,
  permission: "admin" | "write" | "read" | "none" = "write",
) {
  fx.reader.setRole(LABELER_LOGIN, {
    kind: "present",
    userId: LABELER_ID,
    permission,
    // GitHub's own ladder, so the helper states a real rank rather than a
    // placeholder that would satisfy the type and prove nothing.
    rank: { none: 0, read: 1, write: 2, admin: 3 }[permission],
  });
}

/** Runs `work` with a fixture and closes it whatever `work` does. */
export async function withTicketFixture<T>(
  work: (fixture: TicketFixture) => Promise<T>,
  options: Parameters<typeof openTicketFixture>[0] = {},
): Promise<T> {
  const fixture = await openTicketFixture(options);
  try {
    return await work(fixture);
  } finally {
    await fixture.close();
  }
}

/** Inserts a task and its conversation as the owner role, for rows that need a task but not an admission. */
export async function insertBareTask(
  fixture: Pick<
    TicketFixture,
    "owner" | "organizationId" | "applicationId" | "adminId"
  >,
): Promise<string> {
  const conversationId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  await fixture.owner.query(
    `insert into bakery.conversations (
       id, organization_id, application_id, title, created_by
     ) values ($1, $2, $3, 'bare', $4)`,
    [
      conversationId,
      fixture.organizationId,
      fixture.applicationId,
      fixture.adminId,
    ],
  );
  await fixture.owner.query(
    `insert into bakery.tasks (
       id, organization_id, application_id, conversation_id, title, task_type,
       status, priority, created_by
     ) values ($1, $2, $3, $4, 'bare', 'feature', 'draft', 50, $5)`,
    [
      taskId,
      fixture.organizationId,
      fixture.applicationId,
      conversationId,
      fixture.adminId,
    ],
  );
  return taskId;
}

/**
 * Records every open seeded issue of a source as a poll would: a ticket row
 * and a report each. `ticketSources.preview` stores nothing (#69), so tests
 * that need recorded tickets go through `recordReadiness`, the path a poll
 * takes, in automation mode.
 */
export async function recordOpenIssues(
  fixture: Pick<TicketFixture, "reader" | "organizationId" | "automationDeps">,
  sourceId: string,
): Promise<void> {
  const signal = new AbortController().signal;
  const page = await fixture.reader.listIssues(
    undefined as never,
    { page: 1, since: null },
    signal,
  );
  if (page.kind !== "present") throw new Error("the seeded page lists");
  for (const { number } of page.numbers) {
    await recordReadiness(fixture.automationDeps(), {
      organizationId: fixture.organizationId,
      sourceId,
      number,
      intent: null,
      origin: "poll",
      caller: null,
      prefetch: null,
      signal,
    });
  }
}
