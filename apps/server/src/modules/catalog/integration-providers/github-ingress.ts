import type { WebhookIngress } from "@bakery/integration-sdk";
import { INTAKE_MAX_BODY_BYTES } from "../../integrations/intake-body.ts";
import { equalDigests, hmacSha256 } from "./webhook-signature.ts";

/**
 * The GitHub App delivery ingress, as the SDK's port (chapter 09 section 12.2).
 *
 * This is the provider's own answer to "is this delivery yours, and what does it
 * ask for" - the same two questions `intake-routes.ts` answers inline for the
 * legacy receiver. It is a pure port: bytes in, a verdict out, no database, no
 * clock of its own, no secret lookup. The host supplies candidate secrets so a
 * rotation window can accept the old one briefly, and supplies `now` so a replay
 * window is testable - a provider that read its own clock would make staleness
 * untestable and unreproducible.
 *
 * Nothing here writes. `classify` names the intents a delivery asks for and
 * leaves the decision to the core: a provider that decided its own lifecycle
 * transitions would be a second authority over the same rows.
 */

/**
 * The host's own ceiling, not GitHub's documented 25 MB.
 *
 * The design caps a provider's declared ceiling at 256 KiB and the host enforces
 * the smaller of the two numbers, so declaring 25 MB here would publish a limit
 * no delivery could ever reach. GitHub's delivery ceiling is a ceiling on what it
 * will send, not a promise that Bakery accepts it.
 */
const MAX_BODY_BYTES = INTAKE_MAX_BODY_BYTES;

/** `sha256=<64 lowercase hex>`, exactly as GitHub signs. */
const SIGNATURE_HEADER = /^sha256=([0-9a-f]{64})$/;

/**
 * How old a delivery may be before it is refused as a replay, when the body
 * carries a timestamp at all.
 *
 * GitHub retries a failed delivery for up to three hours, so a window tighter
 * than that would drop legitimate redeliveries. The window is stated here for
 * the providers and payloads that do carry a send time - Slack's
 * `X-Slack-Request-Timestamp` is the obvious one - and it is not a guarantee
 * GitHub gives.
 *
 * **GitHub App deliveries carry no timestamp anywhere.** There is no
 * `X-GitHub-Delivery-Timestamp` header, and no `delivery_timestamp` or
 * `timestamp` field in the body: `installation.updated_at` is when the
 * installation changed, which has nothing to do with when this delivery was
 * sent. So this window never fires for a real GitHub delivery, and the module
 * does not pretend otherwise. The load-bearing guard against a replayed
 * delivery is the delivery id: `x-github-delivery` is idempotency's key, and
 * the receipt the host writes for it is what refuses a second application. A
 * stale signed body is therefore accepted here and refused at the receipt.
 */
export const DELIVERY_REPLAY_WINDOW_MS = 3 * 60 * 60 * 1_000;

type GitHubDelivery = {
  event: string;
  action: string | null;
  deliveryId: string;
  /**
   * The event body, or null when the bytes are not something this provider can
   * read.
   *
   * A null payload is not a refusal. GitHub sends two encodings (JSON, and the
   * legacy form-encoded `payload` field) and events this provider does not
   * mirror at all, whose bodies it has no business parsing. Whether an
   * unreadable body is an error depends on the event, and only the host knows
   * which events it consumes, so `classify` answers `ignored` and the host's own
   * projection step decides.
   */
  payload: Record<string, unknown> | null;
};

const header = (headers: Headers, name: string): string | null => {
  const value = headers.get(name);
  return value === null || value.trim().length === 0 ? null : value.trim();
};

/**
 * The fields every GitHub delivery carries, read once so `classify` never has to
 * re-open the body. `payload` stays `unknown` on purpose: each event's own shape
 * is validated where it is consumed, and validating it here would duplicate the
 * event schemas the intake already owns.
 */
function readDelivery(
  body: Uint8Array,
  headers: Headers,
): GitHubDelivery | null {
  const event = header(headers, "x-github-event");
  const deliveryId = header(headers, "x-github-delivery");
  if (event === null || deliveryId === null) return null;
  const payload = readPayload(body, headers);
  if (payload === null) {
    return { event, action: null, deliveryId, payload: null };
  }
  const action = typeof payload.action === "string" ? payload.action : null;
  return { event, action, deliveryId, payload };
}

/** The event body as an object, or null when it is not one we can read. */
function readPayload(
  body: Uint8Array,
  headers: Headers,
): Record<string, unknown> | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return null;
  }
  // GitHub sends a webhook as JSON, or - for an App configured before 2018 and
  // never migrated - as a form whose single field carries the same JSON. Both
  // are the provider's wire format, so reading them belongs here and not in the
  // host, which only ever sees the payload.
  const mediaType = (headers.get("content-type") ?? "").split(";", 1)[0]!
    .trim().toLowerCase();
  if (mediaType === "application/x-www-form-urlencoded") {
    const fields = new URLSearchParams(text);
    const only = [...fields.keys()];
    if (only.length !== 1 || only[0] !== "payload") return null;
    text = fields.get("payload") ?? "";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

/**
 * Which installation action means which lifecycle event, in the SDK's own
 * vocabulary so a delivery and a lifecycle call use one set of words.
 *
 * Only GitHub's four connection-level actions appear. `new_permissions_accepted`
 * is deliberately absent: accepting permissions does not change whether the
 * installation works, so treating it as a lifecycle event would make a permission
 * grant look like a reinstall.
 */
const LIFECYCLE_ACTIONS: Readonly<
  Record<string, "installed" | "suspended" | "unsuspended" | "revoked">
> = Object.freeze({
  created: "installed",
  suspended: "suspended",
  unsuspended: "unsuspended",
  deleted: "revoked",
});

/**
 * The installation the delivery is about, when it names one.
 *
 * A delivery with no installation cannot be routed to an organization, so it is
 * ignored rather than refused: GitHub sends some events (an App-level ping, a
 * marketplace change) that are legitimately about no installation.
 */
function installationOf(payload: Record<string, unknown>): number | null {
  const raw = payload.installation;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const id = (raw as Record<string, unknown>).id;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0
    ? id
    : null;
}

/**
 * The repository a delivery is about, by its provider-side numeric id.
 *
 * Deliberately the number the provider uses and not the owner/name pair: a
 * repository can be renamed and transferred, and a rename must not look like a
 * repository Bakery has never seen. A delivery about no repository (an
 * installation-level event) answers null.
 */
function repositoryOf(payload: Record<string, unknown>): number | null {
  const raw = payload.repository;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const id = (raw as Record<string, unknown>).id;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0
    ? id
    : null;
}

export const githubIngress: WebhookIngress = Object.freeze({
  maxBodyBytes: MAX_BODY_BYTES,

  /**
   * Checks the signature, then the delivery's age, then the headers.
   *
   * Order matters and mirrors the legacy receiver: the cheapest check that needs
   * no parsing runs first, and every failure answers a named reason without
   * disclosing which secret or which byte was wrong. A body that fails the
   * signature is never parsed, so a hostile payload cannot reach `JSON.parse`.
   *
   * `stale` compares the delivery's own timestamp, not the receipt time, so a
   * delayed retry is judged by when GitHub sent it. A delivery with no
   * parseable timestamp is `malformed` rather than `stale`: refusing it as a
   * replay would hide a body the provider could not read.
   */
  verify({ body, headers, secrets, now }) {
    const signature = parseSignature(headers.get("x-hub-signature-256"));
    if (signature === null || secrets.length === 0) {
      return { ok: false, reason: "signature" };
    }
    if (!anySecretSigns(secrets, signature, body)) {
      return { ok: false, reason: "signature" };
    }
    const delivery = readDelivery(body, headers);
    if (delivery === null) return { ok: false, reason: "malformed" };
    const sentAt = deliveryTimestamp(delivery.payload);
    if (
      sentAt !== null &&
      Math.abs(now.getTime() - sentAt) > DELIVERY_REPLAY_WINDOW_MS
    ) {
      return { ok: false, reason: "stale" };
    }
    // `x-github-delivery` is returned as the delivery's id so the host keys its
    // receipt on it: that receipt is what refuses a redelivered id, and it is
    // the one guard that works, because a GitHub payload carries no send time
    // for the staleness window below to compare against.
    return { ok: true, delivery, deliveryId: delivery.deliveryId };
  },

  /**
   * What a verified delivery asks the host to do.
   *
   * Three answers, and each one is a fact the core acts on rather than an
   * action the provider takes: a lifecycle change, a discovery sweep of what the
   * installation may now reach, and a cache refresh of one subject. `ignored`
   * is a real answer - most of what GitHub sends is about records Bakery does
   * not mirror, and inventing intents for those would make every delivery a
   * write.
   */
  classify(delivery) {
    if (!isGitHubDelivery(delivery)) return { kind: "ignored" };
    const { event, action, payload } = delivery;
    const installationId = installationOf(payload);
    if (installationId === null) return { kind: "ignored" };
    const externalAuthorizationId = String(installationId);

    // A new installation, a suspended one, an uninstalled one: all three are
    // connection facts, and the host decides what each means for existing work.
    // Looked up by action alone, but only for the `installation` event, so an
    // `issue.created` cannot be read as an install.
    // `Object.hasOwn` rather than a bare index: `LIFECYCLE_ACTIONS[action]` on
    // a plain object also answers for `constructor`, `toString` and the rest of
    // `Object.prototype`, so an installation delivery with `action: "toString"`
    // would have carried a function where a lifecycle event belongs.
    const lifecycleEvent = event === "installation" && action !== null &&
        Object.hasOwn(LIFECYCLE_ACTIONS, action)
      ? LIFECYCLE_ACTIONS[action]
      : undefined;
    if (lifecycleEvent !== undefined) {
      return {
        kind: "routed",
        externalAuthorizationId,
        projection: payload,
        intents: [{
          kind: "lifecycle",
          event: lifecycleEvent,
        }],
      };
    }

    // Any repository-level event on an installation means the set of things the
    // installation can reach may have changed, so the host re-sweeps rather than
    // trying to apply the delivery as a delta. A checkout of the intents GitHub
    // sends would be a second model of repository access.
    const repositoryId = repositoryOf(payload);
    if (repositoryId === null) {
      return {
        kind: "routed",
        externalAuthorizationId,
        projection: payload,
        intents: [{ kind: "discovery" }],
      };
    }

    // One subject per delivery, named by the provider's own id: the host decides
    // whether it mirrors that subject at all, so an unknown subject is a no-op
    // there rather than a refusal here.
    //
    // The subject follows the event, not whichever key the payload happens to
    // carry: an `issues` delivery is about a ticket and a `pull_request`
    // delivery is about a change, and answering `check` for both would hand the
    // host the wrong engine subject and have it look up an id that names
    // nothing there.
    const subject = subjectOf(event, payload);
    if (subject === null) {
      return {
        kind: "routed",
        externalAuthorizationId,
        projection: payload,
        intents: [{ kind: "discovery" }],
      };
    }
    return {
      kind: "routed",
      externalAuthorizationId,
      projection: payload,
      intents: [{
        kind: "refresh",
        subject: subject.kind,
        resourceExternalId: String(repositoryId),
        subjectExternalId: subject.externalId,
      }],
    };
  },
});

/** The 32 signature bytes from `sha256=<hex>`, or null when the header is not one. */
function parseSignature(value: string | null): Uint8Array<ArrayBuffer> | null {
  if (value === null) return null;
  const match = SIGNATURE_HEADER.exec(value.trim());
  if (match === null) return null;
  const bytes = new Uint8Array(32);
  for (let index = 0; index < 32; index += 1) {
    bytes[index] = parseInt(match[1]!.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/**
 * True when any candidate secret signs `body` to `signature`.
 *
 * Every candidate is tried even after the first match, so the work done does not
 * depend on which secret matched - a rotation window that stopped at the first
 * success would take measurably less time for the current secret than for the
 * previous one.
 */
function anySecretSigns(
  secrets: readonly Uint8Array[],
  signature: Uint8Array<ArrayBuffer>,
  body: Uint8Array,
): boolean {
  let signed = false;
  for (const secret of secrets) {
    // A zero-length secret can never sign: Web Crypto refuses to import one, and
    // an unset secret must not verify, so it is skipped rather than hashed.
    if (secret.byteLength === 0) continue;
    if (equalDigests(hmacSha256(secret, body), signature)) signed = true;
  }
  return signed;
}

function isGitHubDelivery(
  value: unknown,
): value is GitHubDelivery & { payload: Record<string, unknown> } {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.event === "string" &&
    typeof candidate.deliveryId === "string" &&
    candidate.payload !== null &&
    typeof candidate.payload === "object" &&
    !Array.isArray(candidate.payload);
}

/**
 * The engine subject a delivery is about, chosen by its event.
 *
 * The event decides the kind, and the payload only supplies the id. Searching
 * for the first key that happens to exist would let a payload's shape pick the
 * subject: an `issues` delivery has no `check_run`, but a future event carrying
 * both would be classified by accident rather than by what it says it is.
 *
 * A delivery naming an event Bakery does not mirror answers `null` and the host
 * falls back to a discovery sweep, which is cheap and cannot mislabel a record.
 */
function subjectOf(
  event: string,
  payload: Record<string, unknown>,
): { kind: "ticket" | "change" | "check"; externalId: string } | null {
  const mapping: readonly [string, "ticket" | "change" | "check", string][] = [
    ["issues", "ticket", "issue"],
    ["issue_comment", "ticket", "issue"],
    ["pull_request", "change", "pull_request"],
    ["pull_request_review", "change", "pull_request"],
    ["check_run", "check", "check_run"],
    ["workflow_run", "check", "workflow_run"],
  ];
  for (const [named, kind, key] of mapping) {
    if (event !== named) continue;
    const raw = payload[key];
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return null;
    }
    const id = (raw as Record<string, unknown>).id;
    return typeof id === "number" && Number.isSafeInteger(id) && id > 0
      ? { kind, externalId: String(id) }
      : null;
  }
  return null;
}

/**
 * The delivery's own send time, when it states one.
 *
 * GitHub App deliveries do not: there is no delivery-timestamp header, and the
 * body has no `delivery_timestamp` or `timestamp` field. This reads those two
 * names because a generic payload may carry one, and answers `null` for every
 * real GitHub delivery, so the staleness check is simply not reached.
 *
 * Nothing here falls back to a field that merely looks like a time.
 * `installation.updated_at` is when the installation changed, and treating it as
 * the send time would refuse a legitimate delivery because the installation was
 * created long ago - and accept a replay because it was changed a minute ago.
 * The delivery id is the real guard; see `DELIVERY_REPLAY_WINDOW_MS`.
 */
function deliveryTimestamp(
  payload: Record<string, unknown> | null,
): number | null {
  if (payload === null) return null;
  const raw = payload.delivery_timestamp ?? payload.timestamp;
  if (typeof raw !== "string") return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}
