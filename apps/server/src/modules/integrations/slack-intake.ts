/**
 * One Slack events delivery, from raw bytes to the answer Slack gets back.
 *
 * The order is the contract. The signature is checked over the exact bytes
 * before anything is trusted; the only thing read from the body beforehand is
 * the app id, used to choose which signing secret to try, and a body that names
 * no known app simply has no secret to verify against. Every authentication
 * failure answers the same `AUTH_INVALID`, so a caller learns nothing about
 * which check refused it. Only a verified delivery is read as an event.
 *
 * Slack is acknowledged only after the receipt is committed. An ignored event
 * (a bot echo, an unlinked message, another workspace's event) commits a
 * receipt with no content, so its retry is recognised without its text ever
 * being stored. A database failure is not caught here: it propagates, so the
 * caller answers a retryable error instead of claiming the work was queued.
 *
 * Storage is injected. The route supplies a transaction-backed implementation;
 * the tests supply fakes, so each rule is exercised without a database.
 */
import { verifySlackRequest } from "./slack-request.ts";
import { readSlackEvent, type SlackEventDecision } from "./slack-request.ts";
import type {
  CommitSlackReceiptResult,
  SlackInstallationRecord,
  SlackReceiptOutcome,
} from "./slack-receipts.ts";

/** The answer, before the route turns it into HTTP. */
export type SlackIntakeResult =
  /** Slack's handshake: answer with the challenge and admit nothing. */
  | { readonly kind: "challenge"; readonly challenge: string }
  | {
    readonly kind: "acknowledged";
    readonly disposition: "accepted" | "duplicate" | "rejected";
    readonly receiptId: string | null;
  }
  | {
    readonly kind: "refused";
    readonly code:
      | "AUTH_INVALID"
      | "MALFORMED_REQUEST"
      | "IDEMPOTENCY_PAYLOAD_MISMATCH";
  };

/** What the host does with a verified event Bakery should keep. */
export type SlackAdmission = {
  readonly outcome: SlackReceiptOutcome;
};

export type SlackIntakeDependencies = {
  /**
   * Signing secrets to try for a body naming this app, or every configured
   * app's when it names none (the handshake carries no app id). The caller
   * zeroes nothing: this function zeroes each secret it was given.
   */
  readonly signingSecrets: (
    appId: string | null,
  ) => Promise<readonly Uint8Array<ArrayBuffer>[]>;
  /** The active installation for a verified app and workspace, or null. */
  readonly findInstallation: (
    appId: string,
    teamId: string,
  ) => Promise<SlackInstallationRecord | null>;
  /**
   * Commits the receipt and, when it is new and the event is one to keep,
   * admits it, in one transaction: the receipt and the admission stand or fall
   * together, so Slack is never told "accepted" for work that was not kept.
   */
  readonly commit: (input: {
    readonly installation: SlackInstallationRecord;
    readonly eventId: string;
    readonly payloadDigest: string;
    readonly decision: SlackEventDecision;
  }) => Promise<CommitSlackReceiptResult>;
  readonly sha256Hex: (raw: Uint8Array<ArrayBuffer>) => Promise<string>;
  readonly now: () => number;
};

const refused = (
  code: "AUTH_INVALID" | "MALFORMED_REQUEST" | "IDEMPOTENCY_PAYLOAD_MISMATCH",
): SlackIntakeResult => ({ kind: "refused", code });

/** Reads only the app id out of an unverified body, to choose a secret. */
function peekAppId(raw: Uint8Array<ArrayBuffer>): string | null {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(raw));
    if (typeof parsed !== "object" || parsed === null) return null;
    const id = (parsed as Record<string, unknown>).api_app_id;
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}

export async function receiveSlackEvent(
  input: {
    readonly raw: Uint8Array<ArrayBuffer>;
    readonly signatureHeader: string | null;
    readonly timestampHeader: string | null;
  },
  dependencies: SlackIntakeDependencies,
): Promise<SlackIntakeResult> {
  const secrets = await dependencies.signingSecrets(peekAppId(input.raw));
  let verified = false;
  try {
    for (const secret of secrets) {
      const result = await verifySlackRequest({
        secret,
        signatureHeader: input.signatureHeader,
        timestampHeader: input.timestampHeader,
        raw: input.raw,
        nowMs: dependencies.now(),
      });
      if (result.ok) {
        verified = true;
        break;
      }
    }
  } finally {
    for (const secret of secrets) secret.fill(0);
  }
  if (!verified) return refused("AUTH_INVALID");

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(input.raw));
  } catch {
    return refused("MALFORMED_REQUEST");
  }
  const record = typeof body === "object" && body !== null
    ? body as Record<string, unknown>
    : {};
  if (record.type === "url_verification") {
    return typeof record.challenge === "string" && record.challenge.length > 0
      ? { kind: "challenge", challenge: record.challenge }
      : refused("MALFORMED_REQUEST");
  }
  const appId = record.api_app_id;
  const teamId = record.team_id;
  const eventId = record.event_id;
  if (
    typeof appId !== "string" || typeof teamId !== "string" ||
    typeof eventId !== "string"
  ) return refused("MALFORMED_REQUEST");

  const installation = await dependencies.findInstallation(appId, teamId);
  // A verified delivery for a workspace nobody installed here is not ours.
  if (installation === null) return refused("AUTH_INVALID");

  const decision = readSlackEvent(body, {
    appId: installation.appId,
    teamId: installation.teamId,
    botUserId: installation.botUserId,
  });
  if (decision.kind === "challenge") {
    return { kind: "challenge", challenge: decision.challenge };
  }
  const committed = await dependencies.commit({
    installation,
    eventId,
    payloadDigest: await dependencies.sha256Hex(input.raw),
    decision,
  });
  switch (committed.kind) {
    case "recorded":
      return {
        kind: "acknowledged",
        disposition: decision.kind === "ignore" ? "rejected" : "accepted",
        receiptId: committed.receiptId,
      };
    case "duplicate":
      return {
        kind: "acknowledged",
        disposition: "duplicate",
        receiptId: committed.receiptId,
      };
    case "conflict":
      return refused("IDEMPOTENCY_PAYLOAD_MISMATCH");
    case "malformed":
      return refused("MALFORMED_REQUEST");
  }
}
