import {
  readSlackEvent,
  readSlackRequestHeaders,
  verifySlackRequestSignature,
} from "./slack-request.ts";
import { isSlackAppId } from "./slack-scope.ts";
import type {
  CommitSlackReceiptResult,
  PersistedSlackDecision,
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

export type SlackSigningSecret = {
  readonly appId: string;
  readonly secret: Uint8Array<ArrayBuffer>;
};

export type SlackIntakeDependencies = {
  readonly signingSecrets: (
    appId: string,
  ) => Promise<readonly SlackSigningSecret[]>;

  readonly findInstallation: (
    appId: string,
    teamId: string,
  ) => Promise<SlackInstallationRecord | null>;

  readonly commit: (input: {
    readonly installation: SlackInstallationRecord;
    readonly eventId: string;
    readonly payloadDigest: string;
    readonly decision: PersistedSlackDecision;
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
  const nowMs = dependencies.now();
  const headers = readSlackRequestHeaders({
    signatureHeader: input.signatureHeader,
    timestampHeader: input.timestampHeader,
    nowMs,
  });
  if (!headers.ok) return refused("AUTH_INVALID");

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(input.raw));
  } catch {
    return refused("MALFORMED_REQUEST");
  }
  const record = typeof body === "object" && body !== null
    ? body as Record<string, unknown>
    : {};
  const appId = record.api_app_id;
  if (!isSlackAppId(appId)) return refused("AUTH_INVALID");

  const candidates = await dependencies.signingSecrets(appId);
  let verified = false;
  try {
    for (const candidate of candidates) {
      if (
        candidate.appId === appId &&
        await verifySlackRequestSignature({
          secret: candidate.secret,
          headers,
          raw: input.raw,
        })
      ) {
        verified = true;
        break;
      }
    }
  } finally {
    for (const candidate of candidates) candidate.secret.fill(0);
  }
  if (!verified) return refused("AUTH_INVALID");
  if (record.type === "url_verification") {
    return typeof record.challenge === "string" && record.challenge.length > 0
      ? { kind: "challenge", challenge: record.challenge }
      : refused("MALFORMED_REQUEST");
  }
  const teamId = record.team_id;
  const eventId = record.event_id;
  if (typeof teamId !== "string" || typeof eventId !== "string") {
    return refused("MALFORMED_REQUEST");
  }

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
    case "inactive":
      return refused("AUTH_INVALID");
    case "malformed":
      return refused("MALFORMED_REQUEST");
  }
}
