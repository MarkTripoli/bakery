import { verifySlackRequest } from "./slack-request.ts";
import { readSlackEvent, type SlackEventDecision } from "./slack-request.ts";
import type {
  CommitSlackReceiptResult,
  SlackInstallationRecord,
  SlackReceiptOutcome,
} from "./slack-receipts.ts";

export type SlackIntakeResult =
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

export type SlackAdmission = {
  readonly outcome: SlackReceiptOutcome;
};

export type SlackIntakeDependencies = {
  readonly signingSecrets: (
    appId: string | null,
  ) => Promise<readonly Uint8Array<ArrayBuffer>[]>;

  readonly findInstallation: (
    appId: string,
    teamId: string,
  ) => Promise<SlackInstallationRecord | null>;

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

export async function receiveSlackEvent(
  input: {
    readonly raw: Uint8Array<ArrayBuffer>;
    readonly signatureHeader: string | null;
    readonly timestampHeader: string | null;
  },
  dependencies: SlackIntakeDependencies,
): Promise<SlackIntakeResult> {
  const secrets = await dependencies.signingSecrets(null);
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
