import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { contractSchemas } from "@bakery/contracts/contracts";
import type { AgentSessionPageResponse } from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import { createSseParser } from "../api/session-feed-sse.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import {
  backoffDelay,
  createFeedWindow,
  LIVE_SESSION_STATUSES as LIVE,
  pickSession,
  type SessionFeedItem,
} from "./session-thread-model.ts";

export type AgentSession = AgentSessionPageResponse["items"][number];

/** The reader asks again for a session's status this often while it runs. */
const STATUS_POLL_MS = 10_000;
/** History is read in pages of this size, at most this many pages. */
const HISTORY_PAGES = 50;
/** The thread keeps this many of a session's newest events in memory. */
const MAX_ITEMS = 1_000;
/** A stream that stayed open this long was healthy, even without a frame. */
const HEALTHY_CONNECTION_MS = 10_000;

export type SessionThreadSource = Readonly<{
  /**
   * `idle` has nothing to read (no step chosen), `none` means the step has no
   * agent session, `error` means the session read failed.
   */
  phase: "idle" | "loading" | "none" | "error" | "ready";
  session: AgentSession | null;
  items: readonly SessionFeedItem[];
  /** The session is longer than the thread holds: older events are only in the raw output. */
  truncated: boolean;
  /** The live stream is connected, or has dropped and is being retried. */
  connection: "live" | "lost" | "closed";
  /** When the stream dropped, if it has. */
  lostSince: string | null;
  /** Reads everything again after a failed load. */
  retry: () => void;
  /** Ends the wait before the stream's next attempt and tries now. */
  reconnect: () => void;
}>;

const NOTHING: Omit<SessionThreadSource, "retry" | "reconnect"> = {
  phase: "idle",
  session: null,
  items: [],
  truncated: false,
  connection: "closed",
  lostSince: null,
};

type Snapshot = Omit<SessionThreadSource, "retry" | "reconnect">;

const LOADING: Snapshot = { ...NOTHING, phase: "loading" };

/**
 * Everything the thread needs for one run step: which session it was, the
 * session's history (read once, in pages), and, while the session runs, the
 * live stream that keeps the history current.
 *
 * A run step carries no session id, so the session is resolved the way any
 * client must: list the step's sessions, take the newest live one. The stream
 * resumes after the last sequence it has, so a dropped connection loses nothing
 * and shows nothing twice.
 */
export function useSessionThread(
  runStepId: string | null,
): SessionThreadSource {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const organizationId = scope.organizationId;
  const authority = `${scope.sessionGeneration}:${organizationId}:${runStepId}`;
  const [attempt, setAttempt] = useState(0);
  const [snapshot, setSnapshot] = useState<
    { authority: string; value: Snapshot }
  >({ authority, value: NOTHING });
  const wake = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!organizationId || !runStepId) return;
    const controller = new AbortController();
    const { signal } = controller;
    // The window the reader sees: bounded, in sequence order, deduplicated.
    const feed = createFeedWindow(MAX_ITEMS);
    let session: AgentSession | null = null;
    let phase: Snapshot["phase"] = "loading";
    let connection: Snapshot["connection"] = "closed";
    let lostSince: string | null = null;
    const publish = () => {
      if (signal.aborted) return;
      setSnapshot({
        authority,
        value: {
          phase,
          session,
          items: feed.items(),
          truncated: feed.truncated(),
          connection,
          lostSince,
        },
      });
    };
    const run = async () => {
      publish();
      const listed = await api.sessions.list(organizationId, runStepId, signal);
      if (signal.aborted) return;
      if (!listed.ok) {
        phase = "error";
        return publish();
      }
      session = pickSession(listed.data.items);
      if (!session) {
        phase = "none";
        return publish();
      }
      const id = session.id;
      let cursor: string | undefined;
      for (let page = 0; page < HISTORY_PAGES; page += 1) {
        const read = await api.sessions.feed(
          organizationId,
          id,
          cursor,
          signal,
        );
        if (signal.aborted) return;
        if (!read.ok) {
          phase = "error";
          return publish();
        }
        for (const item of read.data.items) feed.take(item);
        cursor = read.data.nextCursor ?? undefined;
        if (!cursor) break;
      }
      // A session longer than the pages read says so instead of looking whole.
      if (cursor) feed.markTruncated();
      phase = "ready";
      publish();

      // The session's status is read again while it runs, so the thread knows
      // when it has finished and the stream can stop. A different session for
      // the step (a new attempt) starts the whole read again, so the stream
      // never tails one session while the thread shows another.
      const poll = setInterval(async () => {
        const again = await api.sessions.list(
          organizationId,
          runStepId,
          signal,
        );
        if (signal.aborted || !again.ok) return;
        const next = pickSession(again.data.items);
        if (!next) return;
        if (next.id !== id) {
          clearInterval(poll);
          setAttempt((value) => value + 1);
          return;
        }
        if (next.status !== session?.status) {
          session = next;
          publish();
        }
      }, STATUS_POLL_MS);
      signal.addEventListener("abort", () => clearInterval(poll), {
        once: true,
      });

      let retries = 0;
      while (!signal.aborted && session && LIVE.has(session.status)) {
        const opened = await api.sessions.stream(
          organizationId,
          id,
          feed.newest(),
          signal,
        );
        if (signal.aborted) return;
        if (opened.ok) {
          connection = "live";
          lostSince = null;
          publish();
          const openedAt = Date.now();
          const decoder = new TextDecoder();
          const parse = createSseParser();
          const reader = opened.data.getReader();
          try {
            while (!signal.aborted) {
              const { done, value } = await reader.read();
              if (done) break;
              for (
                const event of parse(decoder.decode(value, { stream: true }))
              ) {
                // The server has spoken: the connection is healthy, so the
                // next drop starts its backoff again from the shortest wait.
                retries = 0;
                if (event.event !== "feed") continue;
                try {
                  const parsed = contractSchemas.SessionFeedItem.safeParse(
                    JSON.parse(event.data),
                  );
                  if (parsed.success) feed.take(parsed.data as SessionFeedItem);
                } catch {
                  // A frame that is not JSON is not an item.
                }
              }
              publish();
              if (session && !LIVE.has(session.status)) break;
            }
          } catch {
            // A dropped connection is handled below, the same as a refused one.
          } finally {
            reader.cancel().catch(() => undefined);
          }
          // A connection that stayed up this long was working, frame or not.
          if (Date.now() - openedAt >= HEALTHY_CONNECTION_MS) retries = 0;
        }
        if (signal.aborted || !session || !LIVE.has(session.status)) break;
        connection = "lost";
        lostSince ??= new Date().toISOString();
        publish();
        const delay = backoffDelay(retries);
        retries += 1;
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            wake.current = null;
            resolve();
          };
          const timer = setTimeout(done, delay);
          wake.current = done;
          signal.addEventListener("abort", done, { once: true });
        });
      }
      connection = "closed";
      lostSince = null;
      publish();
    };
    void run();
    return () => {
      controller.abort();
      wake.current = null;
    };
  }, [api, authority, organizationId, runStepId, attempt]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const reconnect = useCallback(() => wake.current?.(), []);
  const value = snapshot.authority === authority
    ? snapshot.value
    : organizationId && runStepId
    ? LOADING
    : NOTHING;
  // Stable while nothing changed, so a caller can depend on it.
  return useMemo(() => ({ ...value, retry, reconnect }), [
    value,
    retry,
    reconnect,
  ]);
}
