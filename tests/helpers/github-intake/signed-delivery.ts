const encoder = new TextEncoder();

function bodyBytes(
  body: string | Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> {
  return typeof body === "string" ? encoder.encode(body) : body;
}

/**
 * The `X-Hub-Signature-256` value GitHub sends: `sha256=` plus the lowercase
 * hex HMAC-SHA256 of the exact body bytes under the webhook secret. Encoded
 * here without the receiver's own helpers so a bug there cannot hide.
 */
export async function signDelivery(
  secret: string,
  body: string | Uint8Array<ArrayBuffer>,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, bodyBytes(body)),
  );
  return `sha256=${
    Array.from(mac, (byte) => byte.toString(16).padStart(2, "0")).join("")
  }`;
}

/** The form encoding GitHub uses when a webhook's content type is `application/x-www-form-urlencoded`. */
export function formEncodedPayload(json: string): string {
  return `payload=${encodeURIComponent(json)}`;
}

export type DeliveryRequestOptions = {
  /** Absolute receiver URL, such as `https://bakery.test/v1/webhooks/github`. */
  url: string;
  /** Webhook secret the body is signed with. */
  secret: string;
  /** Value of `X-GitHub-Event`. */
  eventName: string;
  /** Value of `X-GitHub-Delivery`. */
  deliveryId: string;
  /** Exact body bytes; a string is encoded as UTF-8. */
  body: string | Uint8Array<ArrayBuffer>;
  /** Value of `Content-Type`. */
  contentType: string;
  /**
   * `undefined` signs the body with `secret`; `null` omits the header; a
   * string is sent as given, which is how tests send forged signatures.
   */
  signature?: string | null;
};

/** Builds the POST GitHub would send for one delivery. */
export async function deliveryRequest(
  options: DeliveryRequestOptions,
): Promise<Request> {
  const headers = new Headers({
    "content-type": options.contentType,
    "user-agent": "GitHub-Hookshot/bakery-test",
    "x-github-delivery": options.deliveryId,
    "x-github-event": options.eventName,
  });
  const signature = options.signature === undefined
    ? await signDelivery(options.secret, options.body)
    : options.signature;
  if (signature !== null) headers.set("x-hub-signature-256", signature);
  return new Request(options.url, {
    method: "POST",
    headers,
    body: bodyBytes(options.body),
  });
}
