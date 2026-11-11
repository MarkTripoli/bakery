import { useEffect, useReducer, useRef } from "react";
import {
  type Connectivity,
  type ConnectivitySignal,
  type ConnectivityState,
  initialConnectivityState,
  reduceConnectivity,
} from "./connectivity-state.ts";

export type { Connectivity } from "./connectivity-state.ts";

export type UseConnectivityOptions = Readonly<{
  /** The caller's read is in flight; pass it to get `reconnecting`. */
  refetching?: boolean;
  /** `dataUpdatedAt` of the caller's read; a new value settles `reconnecting`. */
  dataUpdatedAt?: number;
  /**
   * Re-reads the caller's data. Called once when the browser comes back, so
   * `reconnecting` always ends: a fresh cache would otherwise never refetch.
   */
  refetch?: () => unknown;
}>;

/**
 * One app-level answer to "is the network usable": `online`, `offline`, or
 * `reconnecting` (back online, waiting for the caller's read to settle).
 * Replaces the per-page `online`/`offline` listeners (design R12).
 */
export function useConnectivity(
  options: UseConnectivityOptions = {},
): Connectivity {
  const { dataUpdatedAt, refetch, refetching } = options;
  const tracksRefetch = refetching !== undefined;
  const [state, dispatch] = useReducer(
    (current: ConnectivityState, signal: ConnectivitySignal) =>
      reduceConnectivity(current, signal, tracksRefetch),
    globalThis.navigator?.onLine,
    initialConnectivityState,
  );
  useEffect(() => {
    const online = () => dispatch("online");
    const offline = () => dispatch("offline");
    globalThis.addEventListener("online", online);
    globalThis.addEventListener("offline", offline);
    return () => {
      globalThis.removeEventListener("online", online);
      globalThis.removeEventListener("offline", offline);
    };
  }, []);
  const latestRefetch = useRef(refetch);
  latestRefetch.current = refetch;
  const reconnecting = state.connectivity === "reconnecting";
  useEffect(() => {
    if (reconnecting) void latestRefetch.current?.();
  }, [reconnecting]);
  useEffect(() => {
    if (refetching === undefined) return;
    dispatch(refetching ? "refetch-started" : "refetch-settled");
  }, [refetching]);
  useEffect(() => {
    if (dataUpdatedAt !== undefined) dispatch("data-updated");
  }, [dataUpdatedAt]);
  return state.connectivity;
}
