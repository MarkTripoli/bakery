import { z } from "zod";
import {
  InngestPrivateHostSuffixSchema,
  isInngestPrivateHostUrl,
} from "@bakery/config";

const MAX_ACK_BYTES = 16_384;
export const DEFAULT_ENGINE_EVENT_TIMEOUT_MS = 5_000;
export const ENGINE_EVENT_CLOCK_SKEW_MARGIN_MS = 1_000;

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" ||
    /^127(?:\.[0-9]{1,3}){3}$/.test(hostname);
}

export const EngineEventIdSchema = z.string().trim().min(1).brand<
  "EngineEventId"
>().describe("Nonblank acknowledgement identifier returned by Inngest.");
export type EngineEventId = z.infer<typeof EngineEventIdSchema>;

const EngineAckSchema = z.object({
  status: z.literal(200).describe("Successful Inngest acknowledgement status."),
  ids: z.array(EngineEventIdSchema).min(1).describe(
    "At least one nonblank event identifier returned by Inngest.",
  ),
}).describe("Bounded acknowledgement envelope accepted from Inngest.");

export type EngineEvent = {
  readonly id: string;
  readonly name: string;
  readonly ts: number;
  readonly data: Readonly<Record<string, unknown>>;
};

export type EngineEventClient = {
  readonly timeoutMs?: number;
  send(event: EngineEvent, signal?: AbortSignal): Promise<EngineEventId>;
};

export class OutboxDeliveryError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(code);
    this.name = "OutboxDeliveryError";
  }
}

export class OutboxDeliveryUncertainError extends OutboxDeliveryError {
  constructor(code: string, status?: number) {
    super(code, true, status);
    this.name = "OutboxDeliveryUncertainError";
  }
}

async function readBoundedText(response: Response): Promise<string> {
  if (!response.body) {
    throw new OutboxDeliveryUncertainError("ENGINE_ACK_EMPTY");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let byteCount = 0;
  let text = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    byteCount += chunk.value.byteLength;
    if (byteCount > MAX_ACK_BYTES) {
      await reader.cancel();
      throw new OutboxDeliveryUncertainError("ENGINE_ACK_TOO_LARGE");
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text + decoder.decode();
}

function parseEngineEventId(text: string): EngineEventId {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new OutboxDeliveryUncertainError("ENGINE_ACK_INVALID");
  }
  const result = EngineAckSchema.safeParse(value);
  if (!result.success) {
    throw new OutboxDeliveryUncertainError("ENGINE_ACK_INVALID");
  }
  return result.data.ids[0];
}

export function createInngestEventClient(options: {
  readonly baseUrl: string;
  readonly eventKey: string;
  readonly timeoutMs?: number;
  readonly privateHostSuffix?: string;
}): EngineEventClient {
  const endpoint = new URL(options.baseUrl);
  if (
    endpoint.username !== "" || endpoint.password !== "" ||
    endpoint.search !== "" || endpoint.hash !== ""
  ) throw new TypeError("INNGEST_URL_INVALID");
  const localCompose = endpoint.hostname === "inngest" &&
    (endpoint.port === "" || endpoint.port === "8288") &&
    endpoint.pathname === "/";
  let privateHost = false;
  if (options.privateHostSuffix !== undefined) {
    const suffix = InngestPrivateHostSuffixSchema.safeParse(
      options.privateHostSuffix,
    );
    if (!suffix.success) throw new TypeError("INNGEST_URL_INVALID");
    privateHost = isInngestPrivateHostUrl(endpoint, suffix.data);
  }
  if (
    endpoint.protocol !== "https:" &&
    !(endpoint.protocol === "http:" &&
      (isLoopbackHost(endpoint.hostname) || localCompose || privateHost))
  ) throw new TypeError("INNGEST_URL_INVALID");
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/e/${
    encodeURIComponent(options.eventKey)
  }`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_ENGINE_EVENT_TIMEOUT_MS;
  return {
    timeoutMs,
    async send(event, signal) {
      const signals = [AbortSignal.timeout(timeoutMs)];
      if (signal) signals.push(signal);
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(event),
          redirect: "error",
          signal: AbortSignal.any(signals),
        });
      } catch {
        throw new OutboxDeliveryUncertainError("ENGINE_UNREACHABLE");
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 408 || response.status >= 500) {
          throw new OutboxDeliveryUncertainError(
            "ENGINE_REJECTED",
            response.status,
          );
        }
        throw new OutboxDeliveryError(
          "ENGINE_REJECTED",
          response.status === 429,
          response.status,
        );
      }
      return parseEngineEventId(await readBoundedText(response));
    },
  };
}
