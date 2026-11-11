import type { DurableSyncConnectivity } from "../api/durable-sync.ts";

/**
 * What the browser can say about the network right now. This is the
 * `DurableSyncConnectivity` vocabulary minus `unknown`, which only the
 * durable task sync can report (it has not polled yet).
 */
export type Connectivity = Exclude<DurableSyncConnectivity, "unknown">;

/** Connectivity plus the bookkeeping `reconnecting` needs. */
export type ConnectivityState = Readonly<{
  connectivity: Connectivity;
  /** Back online after an outage and waiting for one read to settle. */
  awaitingRefetch: boolean;
  /** The awaited read has started since the browser came back online. */
  sawRefetch: boolean;
}>;

/** Events that move connectivity. */
export type ConnectivitySignal =
  | "online"
  | "offline"
  | "refetch-started"
  | "refetch-settled"
  | "data-updated";

/** Connectivity at mount: `navigator.onLine === false` is offline. */
export function initialConnectivityState(
  onLine: boolean | undefined,
): ConnectivityState {
  return {
    connectivity: onLine === false ? "offline" : "online",
    awaitingRefetch: false,
    sawRefetch: false,
  };
}

/**
 * Pure transition. `reconnecting` exists only between an `online` event that
 * ended an outage and the first read that settles afterwards; a routine
 * background refetch while the browser stayed online never produces it
 * (review F8). Without `tracksRefetch` the caller has no read to wait for, so
 * the browser coming back is simply `online`.
 */
export function reduceConnectivity(
  state: ConnectivityState,
  signal: ConnectivitySignal,
  tracksRefetch: boolean,
): ConnectivityState {
  switch (signal) {
    case "offline":
      return {
        connectivity: "offline",
        awaitingRefetch: false,
        sawRefetch: false,
      };
    case "online":
      // A repeated `online` while the awaited read is still pending must not
      // end `reconnecting` early.
      if (state.awaitingRefetch) return state;
      if (!tracksRefetch || state.connectivity !== "offline") {
        return state.connectivity === "online" && !state.awaitingRefetch
          ? state
          : {
            connectivity: "online",
            awaitingRefetch: false,
            sawRefetch: false,
          };
      }
      return {
        connectivity: "reconnecting",
        awaitingRefetch: true,
        sawRefetch: false,
      };
    case "refetch-started":
      return state.awaitingRefetch && !state.sawRefetch
        ? { ...state, sawRefetch: true }
        : state;
    case "refetch-settled":
      return state.awaitingRefetch && state.sawRefetch
        ? { connectivity: "online", awaitingRefetch: false, sawRefetch: false }
        : state;
    case "data-updated":
      return state.awaitingRefetch
        ? { connectivity: "online", awaitingRefetch: false, sawRefetch: false }
        : state;
  }
}
