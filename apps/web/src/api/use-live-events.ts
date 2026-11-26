import { useCallback, useEffect, useRef, useState } from "react";
import { contractSchemas } from "@bakery/contracts/contracts";
import { useBakeryApi } from "./context.tsx";
import { useProtectedScope } from "../app/query-scope-context.tsx";

export type LiveState = "idle" | "connecting" | "live" | "lost";

export type LiveScope = Readonly<{
  type: "task" | "conversation" | "application" | "memory" | "inbox";
  id: string;
}>;

const MAX_BACKOFF_MS = 15_000;

type Listener = {
  readonly scopes: readonly LiveScope[];
  readonly onActivity: () => void;
  readonly onState: (state: LiveState) => void;
};

type Channel = {
  readonly socketUrl: string;
  readonly listeners: Set<Listener>;
  online: () => void;
  socket: WebSocket | null;
  state: LiveState;
  subscribed: string;
  greeted: boolean;
  requests: Set<string>;
  everLive: boolean;
  retries: number;
  timer: ReturnType<typeof setTimeout> | null;
  terminal: boolean;
  queued: boolean;
  reconnectAtOnce: boolean;
};

const channels = new Map<string, Channel>();

const scopeKey = (scopes: readonly LiveScope[]) =>
  scopes.map((scope) => `${scope.type}:${scope.id}`).join(",");

function sharedScopes(channel: Channel): LiveScope[] {
  const shared = new Map<string, LiveScope>();
  for (const listener of channel.listeners) {
    for (const scope of listener.scopes) {
      shared.set(`${scope.type}:${scope.id}`, scope);
    }
  }
  return [...shared.values()];
}

function publish(channel: Channel, state: LiveState) {
  if (channel.state === state) return;
  channel.state = state;
  for (const listener of channel.listeners) listener.onState(state);
}

function announceActivity(channel: Channel) {
  for (const listener of channel.listeners) listener.onActivity();
}

function scheduleReconnect(channel: Channel) {
  if (channel.listeners.size === 0 || channel.terminal) return;
  const delay = channel.reconnectAtOnce
    ? 0
    : Math.min(1000 * 2 ** channel.retries++, MAX_BACKOFF_MS);
  channel.reconnectAtOnce = false;
  if (channel.timer !== null) globalThis.clearTimeout(channel.timer);
  channel.timer = globalThis.setTimeout(() => {
    channel.timer = null;
    connect(channel);
  }, delay);
}

function subscribe(channel: Channel, socket: WebSocket, scopes: LiveScope[]) {
  if (scopes.length === 0) return;
  const requestId = crypto.randomUUID();
  channel.requests.add(requestId);
  socket.send(
    JSON.stringify({
      type: "subscribe",
      requestId,
      scopes,
      after: null,
    }),
  );
}

function connect(channel: Channel) {
  if (channel.listeners.size === 0 || channel.terminal) return;
  if (sharedScopes(channel).length === 0) return;
  const socket = new WebSocket(channel.socketUrl);
  channel.socket = socket;
  channel.greeted = false;
  channel.requests = new Set();
  publish(channel, "connecting");
  socket.onmessage = (event) => {
    if (channel.socket !== socket) return;
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
      const wanted = sharedScopes(channel);
      channel.greeted = true;
      channel.subscribed = scopeKey(wanted);
      subscribe(channel, socket, wanted);
      return;
    }
    if (
      frame.type === "problem" && channel.requests.has(frame.requestId ?? "")
    ) {
      channel.terminal = true;
      channel.socket = null;
      publish(channel, channel.everLive ? "lost" : "idle");
      socket.close();
      return;
    }
    if (frame.type === "reset_required") {
      socket.close();
      return;
    }
    if (
      (frame.type === "cursor" || frame.type === "events") &&
      channel.requests.has(frame.requestId ?? "")
    ) {
      if (frame.type === "cursor") {
        channel.everLive = true;
        channel.retries = 0;
        publish(channel, "live");
      }
      announceActivity(channel);
    }
  };
  socket.onclose = () => {
    if (channel.socket !== socket) return;
    channel.socket = null;
    if (channel.terminal) return;
    publish(channel, channel.everLive ? "lost" : "idle");
    scheduleReconnect(channel);
  };
  socket.onerror = () => socket.close();
}

function teardown(channel: Channel) {
  if (channel.timer !== null) {
    globalThis.clearTimeout(channel.timer);
    channel.timer = null;
  }
  const socket = channel.socket;
  channel.socket = null;
  socket?.close();
  globalThis.removeEventListener("online", channel.online);
  for (const [key, candidate] of channels) {
    if (candidate === channel) channels.delete(key);
  }
}

function reconcile(channel: Channel) {
  if (channel.queued) return;
  channel.queued = true;
  queueMicrotask(() => {
    channel.queued = false;
    applyScopes(channel);
  });
}

function applyScopes(channel: Channel) {
  const next = sharedScopes(channel);
  if (channel.listeners.size === 0 || next.length === 0) {
    teardown(channel);
    return;
  }
  if (channel.socket === null) {
    if (channel.timer === null) connect(channel);
    return;
  }
  if (!channel.greeted) return;
  const subscribed = scopeKey(next);
  if (channel.subscribed === subscribed) return;
  const nextKeys = new Set(next.map((scope) => `${scope.type}:${scope.id}`));
  const held = channel.subscribed.split(",");
  const dropped = held.some((entry) => entry !== "" && !nextKeys.has(entry));
  if (dropped) {
    channel.reconnectAtOnce = true;
    channel.socket.close();
    return;
  }
  const heldKeys = new Set(held);
  subscribe(
    channel,
    channel.socket,
    next.filter((scope) => !heldKeys.has(`${scope.type}:${scope.id}`)),
  );
  channel.subscribed = subscribed;
}

function channelFor(socketUrl: string): Channel {
  const existing = channels.get(socketUrl);
  if (existing !== undefined) return existing;
  const channel: Channel = {
    everLive: false,
    listeners: new Set(),
    online: () => {},
    queued: false,
    reconnectAtOnce: false,
    retries: 0,
    requests: new Set(),
    socket: null,
    socketUrl,
    state: "idle",
    subscribed: "",
    greeted: false,
    terminal: false,
    timer: null,
  };
  channel.online = () => {
    if (channel.terminal || channel.socket !== null) return;
    if (channel.timer !== null) {
      globalThis.clearTimeout(channel.timer);
      channel.timer = null;
    }
    channel.retries = 0;
    connect(channel);
  };
  globalThis.addEventListener("online", channel.online);
  channels.set(socketUrl, channel);
  return channel;
}

function retry(channel: Channel) {
  if (channel.timer !== null) {
    globalThis.clearTimeout(channel.timer);
    channel.timer = null;
  }
  channel.terminal = false;
  channel.retries = 0;
  const socket = channel.socket;
  channel.socket = null;
  channel.reconnectAtOnce = true;
  socket?.close();
  if (socket === null) connect(channel);
}

export function useLiveEvents(
  scopes: readonly LiveScope[],
  onActivity: () => void,
): LiveState {
  return useLiveConnection(scopes, onActivity).state;
}

export function useLiveConnection(
  scopes: readonly LiveScope[],
  onActivity: () => void,
): Readonly<{ state: LiveState; reconnect: () => void }> {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const organizationId = scope.organizationId;
  const key = scopeKey(scopes);
  const [state, setState] = useState<LiveState>("idle");
  const activity = useRef(onActivity);
  activity.current = onActivity;
  const joined = useRef<Channel | null>(null);

  useEffect(() => {
    if (organizationId === null || key === "") {
      setState("idle");
      return;
    }
    const channel = channelFor(api.output.socketUrl(organizationId));
    const listener: Listener = {
      onActivity: () => activity.current(),
      onState: setState,
      scopes: key.split(",").map((entry) => {
        const [type, id] = entry.split(":");
        return { type, id } as LiveScope;
      }),
    };
    joined.current = channel;
    channel.listeners.add(listener);
    reconcile(channel);
    setState(channel.state);
    return () => {
      channel.listeners.delete(listener);
      joined.current = null;
      reconcile(channel);
    };
  }, [api, key, organizationId]);

  const reconnect = useCallback(() => {
    const channel = joined.current;
    if (channel !== null) retry(channel);
  }, []);

  return { reconnect, state };
}
