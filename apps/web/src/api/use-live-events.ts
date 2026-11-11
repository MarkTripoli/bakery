import { useCallback, useEffect, useRef, useState } from "react";
import { contractSchemas } from "@bakery/contracts/contracts";
import { useBakeryApi } from "./context.tsx";
import { useProtectedScope } from "../app/query-scope-context.tsx";

/**
 * Where the live event channel stands. `idle` means it never connected, so the
 * page keeps polling quietly; `lost` means it was live and dropped, which the
 * page says out loud while it reconnects.
 */
export type LiveState = "idle" | "connecting" | "live" | "lost";

export type LiveScope = Readonly<{
  type: "task" | "conversation" | "application";
  id: string;
}>;

const MAX_BACKOFF_MS = 15_000;

/**
 * Subscribes the page to the organization event stream (`GET /v1/events`) for
 * the given scopes. Every event frame, and every (re)subscription, calls
 * `onActivity` once so the page re-reads its scoped queries; the stream carries
 * no state the page renders. A reconnect resubscribes from the current
 * highwater, so `onActivity` also covers anything missed while offline.
 */
export function useLiveEvents(
  scopes: readonly LiveScope[],
  onActivity: () => void,
): LiveState {
  return useLiveConnection(scopes, onActivity).state;
}

/**
 * Same stream as `useLiveEvents`, plus `reconnect()`: it discards a terminal
 * rejection and the backoff, then opens a fresh socket at once. A page offers
 * it as a manual retry.
 */
export function useLiveConnection(
  scopes: readonly LiveScope[],
  onActivity: () => void,
): Readonly<{ state: LiveState; reconnect: () => void }> {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const [state, setState] = useState<LiveState>("idle");
  const [attempt, setAttempt] = useState(0);
  const reconnect = useCallback(() => setAttempt((value) => value + 1), []);
  // Remembers which subscription was live, so a manual retry that is rejected
  // again returns to `lost` instead of silently dropping to `idle`.
  const liveBefore = useRef("");
  const activity = useRef(onActivity);
  activity.current = onActivity;
  const key = scopes.map((item) => `${item.type}:${item.id}`).join(",");
  const organizationId = scope.organizationId;
  useEffect(() => {
    if (organizationId === null || key === "") return;
    let disposed = false;
    let terminal = false;
    const identity = `${organizationId}|${key}`;
    let everLive = liveBefore.current === identity;
    let socket: WebSocket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retries = 0;
    const wanted = key.split(",").map((entry) => {
      const [type, id] = entry.split(":");
      return { type, id };
    });
    const connect = () => {
      if (disposed || terminal) return;
      const requestId = crypto.randomUUID();
      const current = new WebSocket(api.output.socketUrl(organizationId));
      socket = current;
      current.onmessage = (event) => {
        if (disposed || socket !== current) return;
        let value: unknown;
        try {
          value = JSON.parse(String(event.data));
        } catch {
          return;
        }
        const parsed = contractSchemas.WebSocketFrame.safeParse(value);
        if (!parsed.success) return;
        const frame = parsed.data;
        if (frame.type === "hello") {
          current.send(
            JSON.stringify({
              type: "subscribe",
              requestId,
              scopes: wanted,
              after: null,
            }),
          );
          return;
        }
        if (frame.type === "problem" && frame.requestId === requestId) {
          // A viewer or an expired session cannot stream; polling continues.
          terminal = true;
          setState(everLive ? "lost" : "idle");
          current.close();
          return;
        }
        if (frame.type === "reset_required") {
          // The cursor is gone: resubscribe from now and re-read everything.
          current.close();
          return;
        }
        if (
          (frame.type === "cursor" || frame.type === "events") &&
          frame.requestId === requestId
        ) {
          if (frame.type === "cursor") {
            everLive = true;
            liveBefore.current = identity;
            retries = 0;
            setState("live");
          }
          activity.current();
        }
      };
      current.onclose = () => {
        if (disposed || terminal || socket !== current) return;
        setState(everLive ? "lost" : "idle");
        timer = setTimeout(
          connect,
          Math.min(1000 * 2 ** retries++, MAX_BACKOFF_MS),
        );
      };
      current.onerror = () => current.close();
    };
    // Coming back online reconnects at once instead of waiting out the backoff.
    const online = () => {
      if (disposed || terminal || socket?.readyState === WebSocket.OPEN) return;
      clearTimeout(timer);
      retries = 0;
      socket?.close();
      connect();
    };
    globalThis.addEventListener("online", online);
    setState("connecting");
    connect();
    return () => {
      disposed = true;
      globalThis.removeEventListener("online", online);
      clearTimeout(timer);
      socket?.close();
    };
  }, [api, organizationId, key, attempt]);
  return { state, reconnect };
}
