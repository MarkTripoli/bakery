import { StandardError } from "@bakery/contracts/http";
import type {
  BoundInvocation,
  ProviderRequestPort,
} from "../catalog/integration-gate.ts";
import {
  markProviderFailure,
  providerFailureClass,
} from "../catalog/integration-provider-outcome.ts";
import type { RequestRecord } from "./classify.ts";

/**
 * Wraps a provider request port so the executor knows, whatever the handler
 * does, which requests started and how each settled. A request is recorded
 * when it starts, not when it settles, so a handler that fires a request and
 * never awaits it still leaves an unsettled record. Once `close` runs, later
 * requests are refused before they reach the inner port.
 */
export type ObservedPort = Readonly<{
  port: ProviderRequestPort;
  /** Snapshot of every request started so far with its current state. */
  records(): readonly RequestRecord[];
  /** Refuses further requests; called when the handler call has ended. */
  close(): void;
}>;

type MutableRecord = {
  ref: string;
  state: RequestRecord["state"];
  retryable: boolean;
  retryAfterSeconds?: number;
};

export function observeProviderRequests(
  inner: ProviderRequestPort,
): ObservedPort {
  const records: MutableRecord[] = [];
  let closed = false;

  const settleRejected = (record: MutableRecord, error: unknown) => {
    const cls = providerFailureClass(error);
    if (cls === undefined) {
      record.state = "unknown";
      return;
    }
    record.state = cls.kind;
    record.retryable = cls.retryable;
    if (cls.kind === "rejected" && cls.retryAfterSeconds !== undefined) {
      record.retryAfterSeconds = cls.retryAfterSeconds;
    }
  };

  const port: ProviderRequestPort = {
    request(bound: BoundInvocation, ref, input, allowed, signal) {
      if (closed) {
        return Promise.reject(
          markProviderFailure(
            new StandardError({
              code: "STATE_CONFLICT",
              detail: "dispatch_closed",
              params: { reason: "dispatch_closed" },
            }),
            { kind: "not_sent", retryable: false },
          ),
        );
      }
      const record: MutableRecord = {
        ref: `${ref.id}@${ref.version}`,
        state: "pending",
        retryable: false,
      };
      records.push(record);
      let started: Promise<unknown>;
      try {
        started = Promise.resolve(
          inner.request(bound, ref, input, allowed, signal),
        );
      } catch (error) {
        settleRejected(record, error);
        return Promise.reject(error);
      }
      return started.then(
        (value) => {
          record.state = "fulfilled";
          return value;
        },
        (error: unknown) => {
          settleRejected(record, error);
          throw error;
        },
      );
    },
  };

  return {
    port,
    records: () => records.map((r) => ({ ...r })),
    close: () => {
      closed = true;
    },
  };
}
