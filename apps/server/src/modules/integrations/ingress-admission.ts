import type { IntakeIntent, WebhookIngress } from "@bakery/integration-sdk";
import { StandardError } from "@bakery/contracts/http";

/**
 * The host's side of the provider ingress port (#408 slice 6, wired).
 *
 * `github-ingress.ts` answers two questions and writes nothing: is this
 * delivery ours, and what does it ask for. Nothing called it. This is the
 * caller - the seam that runs a port over a real request and turns its answer
 * into work the engine already knows how to do.
 *
 * The split is deliberate and it is the reason the port exists at all. A
 * provider that verified its own signature and then applied its own state would
 * be a second authority over the same rows, with its own idea of what an
 * install means. So this module does only three things:
 *
 *   - it reads the body under a bound before anything is authenticated, so a
 *     hostile payload cannot exhaust memory on its way to a signature check;
 *   - it runs `verify`, and refuses every failure with one answer, so a wrong
 *     secret and a forgery look the same;
 *   - it runs `classify` and translates the intents into the host's own work.
 *
 * It decides nothing about lifecycle transitions, caching or discovery: those
 * are the engine's, and an intent is a request to it rather than an action
 * taken on its behalf.
 */

/**
 * What the host is allowed to do with one delivery, after classification.
 *
 * Each field is a job the caller already has a path for; none is an action this
 * module performs. `refresh` names an engine subject, `discovery` asks for a
 * sweep, `lifecycle` reports a connection fact, and an intent this host does not
 * implement yet is `unrouted` rather than silently dropped - a delivery that is
 * acknowledged but does nothing must be visible as such.
 */
export type RoutedDelivery =
  | { kind: "ignored" }
  | { kind: "lifecycle"; event: string }
  | { kind: "discovery" }
  | {
    kind: "refresh";
    subject: "ticket" | "change" | "check";
    resourceExternalId: string;
    subjectExternalId: string;
  }
  | { kind: "unrouted"; intent: string };

/** One verified, classified delivery, as the route hands it to the engine. */
export type AdmittedDelivery = {
  /** The provider's own id for this delivery; the receipt's dedupe key. */
  deliveryId: string;
  /** What the delivery asks for, in the order the provider named it. */
  routed: readonly RoutedDelivery[];
  /** The provider's payload, untouched, for the projection step that follows. */
  projection: unknown;
};

/**
 * Runs a port over a request body the caller has already read and bounded.
 *
 * The body is passed in rather than read here so the caller owns the deadline
 * and the ceiling, and so this function is a pure step in a test: bytes in, a
 * verdict out. `now` is likewise supplied, because a module that read its own
 * clock would make a freshness rule untestable.
 */
export function admitDelivery(
  ingress: WebhookIngress,
  input: {
    body: Uint8Array;
    headers: Headers;
    /** Candidate secrets: more than one during a rotation window. */
    secrets: readonly Uint8Array[];
    now: Date;
    /**
     * Called once the secrets have been used, whatever the outcome.
     *
     * The caller owns what a secret's lifetime is: the stored webhook secret is
     * wiped here rather than left in memory after a comparison that may have
     * failed. This module does not read or wipe the bytes itself, because a port
     * that owned a secret's lifetime would be a second rule about secrets.
     */
    releaseSecrets?: () => void;
  },
): AdmittedDelivery {
  // One `finally` around everything, not just the verify call.
  //
  // The secrets must be released on every exit: a refusal that returns before
  // a later `try` would leave them in memory. The size check is the case that
  // makes this load-bearing - it runs before verification, so a `finally`
  // scoped to `verify` alone would leak whenever a provider's ceiling is
  // smaller than the body the host was willing to read.
  try {
    return admitWithin(input, ingress);
  } finally {
    input.releaseSecrets?.();
  }
}

/**
 * The admission steps themselves, run inside `admitDelivery`'s `finally` so no
 * exit path can skip releasing the secrets.
 */
function admitWithin(
  input: {
    body: Uint8Array;
    headers: Headers;
    secrets: readonly Uint8Array[];
    now: Date;
  },
  ingress: WebhookIngress,
): AdmittedDelivery {
  // The declared ceiling is the provider's own bound, and the caller enforces
  // the smaller of it and the host's. Checking it here too means a caller that
  // forgets cannot turn a provider's promise into a memory problem.
  if (input.body.byteLength > ingress.maxBodyBytes) {
    throw new StandardError({ code: "BODY_TOO_LARGE" });
  }

  const verified = ingress.verify(input);
  if (!verified.ok) {
    // `malformed` is only ever answered after the signature has verified (the
    // port refuses to read a body it could not authenticate), so it is the one
    // refusal that says nothing about a secret: the sender holds the secret and
    // sent something unreadable or without its delivery headers. That is a
    // malformed request, not an authentication failure.
    if (verified.reason === "malformed") {
      throw new StandardError({ code: "MALFORMED_REQUEST" });
    }
    // One answer for every other failure. A caller that could tell "wrong
    // secret" from "forged" could use a delivery endpoint to test candidate
    // secrets.
    throw new StandardError({ code: "AUTH_INVALID" });
  }

  const classified = ingress.classify(verified.delivery);
  if (classified.kind === "ignored") {
    return {
      deliveryId: verified.deliveryId ?? "",
      routed: [{ kind: "ignored" }],
      projection: null,
    };
  }
  if (classified.kind === "challenge") {
    // A challenge is the provider proving the endpoint is live. It is answered
    // by the caller and carries no work, so it routes as ignored with the
    // response kept for the caller to send.
    return {
      deliveryId: verified.deliveryId ?? "",
      routed: [{ kind: "ignored" }],
      projection: classified.response,
    };
  }

  // A delivery with no id cannot be deduplicated, so a redelivery of it would
  // be applied twice. GitHub always sends one; a provider that does not must be
  // refused here rather than deduplicated on a digest the caller has not been
  // told to compute.
  const deliveryId = verified.deliveryId;
  if (typeof deliveryId !== "string" || deliveryId.trim().length === 0) {
    throw new StandardError({ code: "MALFORMED_REQUEST" });
  }

  return {
    deliveryId,
    routed: classified.intents.map(routeIntent),
    projection: classified.projection,
  };
}

/**
 * One SDK intent as the host's own vocabulary.
 *
 * The mapping is exhaustive over the SDK's intents, and the default arm exists
 * so that adding an intent to the port is a visible behaviour here - an
 * `unrouted` result the caller can count - rather than a delivery that silently
 * does nothing.
 */
function routeIntent(intent: IntakeIntent): RoutedDelivery {
  switch (intent.kind) {
    case "lifecycle":
      return { kind: "lifecycle", event: intent.event };
    case "discovery":
      return { kind: "discovery" };
    case "refresh":
      return {
        kind: "refresh",
        subject: intent.subject,
        resourceExternalId: intent.resourceExternalId,
        subjectExternalId: intent.subjectExternalId,
      };
    default: {
      // TypeScript proves this unreachable for today's union; the cast keeps it
      // honest if the port grows a kind this host has not learned to run.
      const unknownIntent = intent as { kind?: unknown };
      return {
        kind: "unrouted",
        intent: String(unknownIntent.kind ?? "unknown"),
      };
    }
  }
}
