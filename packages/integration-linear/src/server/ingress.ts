import type {
  IntakeIntent,
  WebhookIngress,
} from "@bakery/integration-sdk/provider";
import { LINEAR_STATE_TYPES } from "./status.ts";

/**
 * Linear's webhook ingress.
 *
 * Linear signs the raw body with HMAC-SHA256 and sends the digest hex-encoded in
 * `Linear-Signature`, with no `sha256=` prefix - the opposite of GitHub, which is
 * why the two providers cannot share a header parser even though both sign the
 * same way.
 *
 * Unlike GitHub, a Linear delivery carries `webhookTimestamp` in milliseconds, so a
 * replay can be refused on freshness as well as on the receipt. Both are kept: the
 * timestamp closes the window, and the receipt (keyed on delivery id when there is
 * one) closes the hole a timestamp leaves - a delivery replayed inside the window.
 */

/** The header Linear signs with. */
export const LINEAR_SIGNATURE_HEADER = "linear-signature";

/** How old a delivery may be before it is refused. */
export const LINEAR_REPLAY_WINDOW_MS = 60_000;

/** The payload shape this provider reads, after verification. */
export type LinearWebhookBody = {
  action: string;
  type: string;
  /** Milliseconds since the epoch; Linear sends it on every delivery. */
  webhookTimestamp?: number;
  webhookId?: string;
  /**
   * The workspace the delivery belongs to. Linear puts it at the top level of the
   * body, beside `webhookTimestamp`, and not inside `data`: `data` is the subject
   * entity, which for a comment or an issue carries no workspace.
   */
  organizationId?: string;
  data?: Record<string, unknown>;
  updatedFrom?: Record<string, unknown>;
};

/**
 * Whether a body is a Linear delivery.
 *
 * `type` and `action` are the two fields classification reads, and `data` is what
 * the projection needs. A body with a valid signature but no `type` is signed junk
 * from something else pointed at the endpoint, which is ignored rather than
 * refused: the signature proves who sent it, not that it is a delivery.
 */
export function isLinearWebhookBody(
  value: unknown,
): value is LinearWebhookBody {
  if (typeof value !== "object" || value === null) return false;
  const body = value as Partial<LinearWebhookBody>;
  return typeof body.type === "string" && typeof body.action === "string";
}

/** Reads the body, or `null` when it is not JSON this provider can read. */
function readBody(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
}

/**
 * Why there is no HMAC here.
 *
 * Computing one would need `node:crypto`, which rail B1f forbids in a provider
 * package, and a hand-written SHA-256 would be a second implementation of a
 * primitive the host already gets right. The host hands `verify` a constant-time
 * `signatureMatches`, so this file decides *which* secret and *which* header, and
 * the host decides the arithmetic.
 */

/** Hex text to bytes, or `null` when the text is not an even-length hex string. */
function fromHex(text: string): Uint8Array | null {
  if (text.length === 0 || text.length % 2 !== 0) return null;
  const bytes = new Uint8Array(text.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    const pair = text.slice(index * 2, index * 2 + 2);
    if (!/^[0-9a-fA-F]{2}$/.test(pair)) return null;
    bytes[index] = Number.parseInt(pair, 16);
  }
  return bytes;
}

/**
 * The status this delivery reports a ticket moved into.
 *
 * Linear sends `data.state` as the state object and `updatedFrom.stateId` as the
 * state it left. The type is on the state, so a delivery that carries no state
 * cannot fire a typed trigger - and a delivery that carries one Linear did not
 * document fires nothing rather than folding into an existing type.
 */
function movedStatus(
  body: LinearWebhookBody,
): { id: string; type: string } | null {
  const state = body.data?.state;
  if (typeof state !== "object" || state === null) return null;
  const { id, type } = state as { id?: unknown; type?: unknown };
  if (typeof id !== "string" || typeof type !== "string") return null;
  if (!LINEAR_STATE_TYPES.some((known) => known === type)) return null;
  return { id, type };
}

export const linearIngress: WebhookIngress = {
  // Linear's largest documented payload is well under this; the ceiling exists so a
  // hostile body cannot be read into memory before the signature is checked.
  maxBodyBytes: 262_144,

  verify(input) {
    const header = input.headers.get(LINEAR_SIGNATURE_HEADER);
    if (!header) return { ok: false, reason: "signature" };
    const claimed = fromHex(header);
    if (claimed === null) return { ok: false, reason: "signature" };
    const matches = input.signatureMatches;
    // No verifier means no way to tell a delivery from a forgery, and answering
    // `ok` would accept one. Refusing is the safe direction and the host is what
    // makes it recoverable.
    if (matches === undefined) return { ok: false, reason: "signature" };
    // A rotation window holds two secrets. Every candidate is tried even after a
    // match, so the work does not depend on which secret signed - a loop that
    // stopped at the first success would take measurably longer for the current
    // secret than for the previous one.
    let signed = false;
    for (const secret of input.secrets) {
      // An empty secret can never sign, and an unset secret must not verify.
      if (secret.byteLength === 0) continue;
      if (matches({ secret, body: input.body, signature: claimed })) {
        signed = true;
      }
    }
    if (!signed) return { ok: false, reason: "signature" };

    // Signature first, then freshness: an unauthenticated body must not be able to
    // do work by claiming an old or a future timestamp.
    const delivery = readBody(input.body);
    if (!isLinearWebhookBody(delivery)) {
      // A signature over a body that is not a delivery is still a signature, so
      // this is not `signature` - it is a body this provider cannot read, which it
      // acknowledges and ignores.
      return { ok: true, delivery };
    }
    // A delivery with no usable timestamp cannot be judged fresh, so it is refused
    // rather than let past the window. Linear sends the timestamp on every
    // delivery; a signed body without one was not built by Linear. `NaN` and an
    // infinite number are refused too, because every comparison with them is false
    // and would read as "inside the window".
    const sentAt = delivery.webhookTimestamp;
    if (typeof sentAt !== "number" || !Number.isFinite(sentAt)) {
      return { ok: false, reason: "malformed" };
    }
    const age = input.now.getTime() - sentAt;
    // A future timestamp is refused too: it would otherwise sit inside the
    // window for as long as the sender chose.
    if (age > LINEAR_REPLAY_WINDOW_MS || age < -LINEAR_REPLAY_WINDOW_MS) {
      return { ok: false, reason: "stale" };
    }
    // The workspace picks the installation the host routes to, so a delivery the
    // host would route has to name one. An empty id would match no installation
    // by accident and a missing one would be routed on a default.
    if (
      (delivery.type === "Issue" || delivery.type === "Comment") &&
      organizationOf(delivery) === null
    ) {
      return { ok: false, reason: "malformed" };
    }
    return {
      ok: true,
      delivery,
      // Linear sends `webhookId` per delivery. It is the receipt key, so a
      // redelivery under the same id is acknowledged rather than applied again.
      ...(typeof delivery.webhookId === "string" &&
          delivery.webhookId.length > 0
        ? { deliveryId: delivery.webhookId }
        : {}),
    };
  },

  classify(delivery) {
    if (!isLinearWebhookBody(delivery)) return { kind: "ignored" };
    const body = delivery;
    // Only issue and comment events reach the ticket family. An `Attachment` or a
    // `Document` delivery is signed and acknowledged, and moves no work.
    if (body.type !== "Issue" && body.type !== "Comment") {
      return { kind: "ignored" };
    }
    const issueId = issueIdOf(body);
    if (issueId === null) return { kind: "ignored" };

    // A status change is what a trigger can hang work off, so it is reported as a
    // refresh of the ticket: the host re-reads the issue and the status trigger
    // decides whether anything starts. Reporting the transition instead of the
    // subject would make the host resolve a state id it has no row for.
    const moved = movedStatus(body);
    const intents: IntakeIntent[] = intentsFor(body, issueId, moved);
    if (intents.length === 0) return { kind: "ignored" };
    return {
      kind: "routed",
      // Linear identifies the workspace on every delivery; the host matches it to
      // the installation it stored at connect time.
      externalAuthorizationId: organizationOf(body) ?? "",
      projection: {
        providerSlug: "linear",
        resourceExternalId: issueId,
        type: body.type,
        action: body.action,
        ...(moved === null ? {} : { statusType: moved.type }),
      },
      intents,
    };
  },
};

/** The issue a delivery is about: on an Issue it is `data.id`, on a Comment `data.issueId`. */
function issueIdOf(body: LinearWebhookBody): string | null {
  if (body.type === "Comment") {
    const issueId = body.data?.issueId;
    return typeof issueId === "string" ? issueId : null;
  }
  const id = body.data?.id;
  return typeof id === "string" ? id : null;
}

/** The workspace the delivery belongs to, or `null` when it names none. */
function organizationOf(body: LinearWebhookBody): string | null {
  const organizationId = body.organizationId;
  return typeof organizationId === "string" && organizationId.trim() !== ""
    ? organizationId
    : null;
}

/**
 * What the host should do about one delivery.
 *
 * `create`, `update` and `remove` all become a refresh of the ticket: removal is a
 * refresh because the host's projection must be told the issue is gone, and a
 * `delete` intent would be a second way of saying the same thing. A comment
 * delivery refreshes too - a comment changes what a ticket's transcript says, and
 * the host's refresh is what re-reads it.
 */
function intentsFor(
  body: LinearWebhookBody,
  issueId: string,
  moved: { id: string; type: string } | null,
): IntakeIntent[] {
  if (!["create", "update", "remove"].includes(body.action)) return [];
  const intent: IntakeIntent = {
    kind: "refresh",
    subject: "ticket",
    resourceExternalId: issueId,
    // The subject's own id is the issue; a comment delivery names no comment id the
    // host could use, and the refresh reads the issue anyway.
    subjectExternalId: issueId,
  };
  // `moved` is read by the host's status trigger through the projection, so it does
  // not change the intent list. Referenced here so the field is not silently
  // dropped if the intents ever need to branch on it.
  void moved;
  return [intent];
}
