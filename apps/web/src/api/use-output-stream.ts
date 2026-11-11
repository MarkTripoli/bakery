import { useCallback, useEffect, useRef, useState } from "react";
import { contractSchemas } from "@bakery/contracts/contracts";
import { isOutputSocketServerFrame } from "@bakery/contracts/client";
import { useBakeryApi } from "./context.tsx";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import {
  applyOutputFrame,
  emptyOutputReplay,
  type OutputReplay,
} from "./output-replay.ts";

type Connection =
  | "connecting"
  | "live"
  | "reconnecting"
  | "expired"
  | "error"
  | "forbidden";
type Observation = Readonly<
  { authority: string; replay: OutputReplay; connection: Connection }
>;

export function useOutputStream(streamId: string) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const authority =
    `${scope.sessionGeneration}:${scope.organizationId}:${streamId}`;
  const [observed, setObserved] = useState<Observation>({
    authority,
    replay: emptyOutputReplay(streamId),
    connection: "connecting",
  });
  const retryConnection = useRef<(() => void) | null>(null);
  const reconnect = useCallback(() => retryConnection.current?.(), []);
  useEffect(() => {
    const org = scope.organizationId;
    if (!org) return;
    let replay = emptyOutputReplay(streamId);
    let disposed = false;
    let terminal = false;
    let socket: WebSocket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retries = 0;
    const publish = (connection: Connection) => {
      if (!disposed) setObserved({ authority, replay, connection });
    };
    const connect = () => {
      if (disposed || terminal) return;
      // A reconnect resumes only the last cursor, while sequence dedupe retains
      // batches delivered before a lost cursor frame.
      replay = { ...replay, gap: false };
      const requestId = crypto.randomUUID();
      socket = new WebSocket(api.output.socketUrl(org));
      const current = socket;
      current.onopen = () =>
        current.send(
          JSON.stringify({
            type: "output.subscribe",
            requestId,
            streamId,
            after: replay.cursor,
          }),
        );
      current.onmessage = (event) => {
        if (disposed || socket !== current || terminal) return;
        let value: unknown;
        try {
          value = JSON.parse(String(event.data));
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          terminal = true;
          publish("error");
          current.close();
          return;
        }
        const parsed = contractSchemas.WebSocketFrame.safeParse(value);
        if (!parsed.success) {
          terminal = true;
          publish("error");
          current.close();
          return;
        }
        const frame = parsed.data;
        if (
          frame.type === "reset_required" && frame.reason === "scope_revoked"
        ) {
          terminal = true;
          replay = emptyOutputReplay(streamId);
          publish("forbidden");
          current.close();
          return;
        }
        if (frame.type === "problem" && frame.requestId === requestId) {
          terminal = true;
          replay = emptyOutputReplay(streamId);
          publish(
            frame.problem.status === 403 || frame.problem.status === 401
              ? "forbidden"
              : "error",
          );
          current.close();
          return;
        }
        if (
          !isOutputSocketServerFrame(frame) || frame.requestId !== requestId
        ) return;
        replay = applyOutputFrame(replay, frame);
        if (replay.reset) {
          terminal = true;
          publish("expired");
          current.close();
          return;
        }
        if (replay.gap) {
          publish("reconnecting");
          current.close();
          return;
        }
        retries = 0;
        publish("live");
      };
      current.onclose = (event) => {
        if (disposed || terminal || socket !== current) return;
        if (
          (event.code === 1008 && event.reason !== "backpressure") ||
          event.code === 4401 || event.code === 4403
        ) {
          terminal = true;
          replay = emptyOutputReplay(streamId);
          publish("forbidden");
          return;
        }
        publish("reconnecting");
        timer = setTimeout(connect, Math.min(1000 * 2 ** retries++, 15000));
      };
      current.onerror = () => current.close();
    };
    retryConnection.current = () => {
      if (disposed || terminal) return;
      clearTimeout(timer);
      socket?.close();
      publish("reconnecting");
      connect();
    };
    publish("connecting");
    connect();
    return () => {
      disposed = true;
      retryConnection.current = null;
      clearTimeout(timer);
      socket?.close();
    };
  }, [api, authority, scope.organizationId, streamId]);
  const current = observed.authority === authority ? observed : {
    authority,
    replay: emptyOutputReplay(streamId),
    connection: "connecting" as const,
  };
  return { ...current, reconnect };
}
