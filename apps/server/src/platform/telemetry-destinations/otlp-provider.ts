import type { TelemetryRecord } from "@bakery/config/telemetry";
import type { ExportSink } from "@bakery/config/telemetry-export";
import { ADDRESS_REFUSED_REASON } from "./address-policy.ts";
import { isAddressRefusal, readAnswer } from "./pinned-fetch.ts";
import { createOtlpSink, otlpSignalUrl } from "../telemetry-sink.ts";
import type {
  DestinationValues,
  ProbeOutcome,
  ProviderDependencies,
  TelemetryProvider,
} from "./provider.ts";

/** The longest piece of a destination's answer kept for the person reading it. */
export const PROBE_ANSWER_MAX_CHARS = 300;

const ADDRESS_FIELD = "address";
const HEADER_NAME_FIELD = "headerName";
const HEADER_VALUE_FIELD = "headerValue";

/** An HTTP header name: letters, digits and the usual separators, no spaces. */
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/;

/**
 * A header value is visible text and tabs only, and only Latin-1: a value with a
 * line break or other control character, or a character above U+00FF (which a
 * header cannot carry), is refused on save instead of failing on every send.
 */
const HEADER_VALUE = /^[\t\x20-\x7e\u00a0-\u00ff]*$/;

function headersOf(values: DestinationValues): Record<string, string> {
  const name = values[HEADER_NAME_FIELD]?.trim();
  const value = values[HEADER_VALUE_FIELD];
  return name && value ? { [name]: value } : {};
}

/**
 * A fetch that never follows a redirect. A destination that answers with one is
 * refused as a failure, so a saved address cannot bounce the request, and the
 * sign-in header with it, to a host nobody approved.
 */
function noRedirectFetch(base: typeof fetch): typeof fetch {
  return (input, init) => base(input, { ...init, redirect: "manual" });
}

/**
 * The OpenTelemetry destination: OTLP over HTTP, to a collector or to Grafana,
 * Honeycomb and any other backend that speaks it.
 */
export const otlpProvider: TelemetryProvider = Object.freeze({
  secretBoundFields: Object.freeze([ADDRESS_FIELD, HEADER_NAME_FIELD]),
  descriptor: Object.freeze({
    kind: "otlp",
    label: "OpenTelemetry",
    fields: Object.freeze([
      Object.freeze({
        name: ADDRESS_FIELD,
        label: "Address",
        help: "Bakery adds /v1/traces and /v1/metrics. Must be https.",
        secret: false,
        required: true,
      }),
      Object.freeze({
        name: HEADER_NAME_FIELD,
        label: "Sign-in header name",
        help:
          "For example Authorization. Leave empty when the address needs none.",
        secret: false,
        required: false,
      }),
      Object.freeze({
        name: HEADER_VALUE_FIELD,
        label: "Sign-in header value",
        help:
          "Stored encrypted. It is never shown again after you save; you can only replace it.",
        secret: true,
        required: false,
      }),
    ]),
    // Only the kinds the server really emits (see measurements.ts): a kind offered
    // here that nothing maps to would be a checkbox that sends nothing.
    measurements: Object.freeze(["results", "health"] as const),
    unavailableReasons: Object.freeze({
      cost: "Bakery does not send this yet.",
      durations: "Bakery does not send this yet.",
      skills: "Bakery does not send this yet.",
      errors: "OpenTelemetry destinations receive errors as part of traces.",
    }),
  }),

  validate(values) {
    const problems: Record<string, string> = {};
    const address = values[ADDRESS_FIELD]?.trim() ?? "";
    if (address === "") {
      problems[ADDRESS_FIELD] = "Enter the address of the collector.";
    } else if (otlpSignalUrl(address, "traces") === undefined) {
      problems[ADDRESS_FIELD] =
        "Give the base address only, without /v1/traces or /v1/metrics.";
    }
    const name = values[HEADER_NAME_FIELD]?.trim() ?? "";
    const value = values[HEADER_VALUE_FIELD] ?? "";
    if (name !== "" && !HEADER_NAME.test(name)) {
      problems[HEADER_NAME_FIELD] = "That is not a valid header name.";
    }
    if (value !== "" && !HEADER_VALUE.test(value)) {
      problems[HEADER_VALUE_FIELD] =
        "The value may use Latin-1 text only: no line breaks, control characters or characters outside it.";
    }
    if (value !== "" && name === "") {
      problems[HEADER_NAME_FIELD] = "Name the header the value is sent in.";
    }
    return Promise.resolve(Object.freeze(problems));
  },

  createSink(values, dependencies): ExportSink<TelemetryRecord> {
    const address = values[ADDRESS_FIELD]?.trim() ?? "";
    const send = createOtlpSink({
      endpoint: address,
      fetch: noRedirectFetch(dependencies.fetch),
      headers: headersOf(values),
    });
    return async (batch, signal) => {
      // Checked before every send: an address that now points somewhere private
      // is a failing destination, never one that is quietly posted to.
      const verdict = await dependencies.addressPolicy(address);
      if (!verdict.ok) {
        throw new Error(`OTLP_ADDRESS_REFUSED:${verdict.reason}`);
      }
      await send(batch, signal);
    };
  },

  async probe(values, dependencies: ProviderDependencies, signal) {
    const address = values[ADDRESS_FIELD]?.trim() ?? "";
    const url = otlpSignalUrl(address, "traces");
    if (url === undefined) {
      return refused("Give the base address only, without /v1/traces.");
    }
    const verdict = await dependencies.addressPolicy(address);
    if (!verdict.ok) return refused(verdict.reason);
    try {
      const response = await noRedirectFetch(dependencies.fetch)(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headersOf(values) },
        // A valid OTLP body with nothing in it: it proves the address and the
        // sign-in work without putting a measurement in anyone's dashboard.
        body: JSON.stringify({ resourceSpans: [] }),
        signal,
      });
      const text = await readAnswer(response, PROBE_ANSWER_MAX_CHARS);
      if (response.ok) {
        return outcome(true, response.status, null, text);
      }
      return outcome(
        false,
        response.status,
        response.status >= 300 && response.status < 400
          ? "The address answered with a redirect, which Bakery does not follow."
          : response.status === 401 || response.status === 403
          ? "The sign-in header was refused."
          : "The destination did not accept the test.",
        text,
      );
    } catch (error) {
      if (isAddressRefusal(error)) return refused(ADDRESS_REFUSED_REASON);
      const timedOut = signal.aborted ||
        (error as { name?: string }).name === "AbortError";
      return refused(
        timedOut
          ? "The destination did not answer in time."
          : "Bakery could not reach the destination.",
      );
    }
  },
});

function outcome(
  ok: boolean,
  status: number | null,
  reason: string | null,
  answer: string | null,
): ProbeOutcome {
  return Object.freeze({ ok, status, reason, answer: answer || null });
}

function refused(reason: string): ProbeOutcome {
  return outcome(false, null, reason, null);
}
