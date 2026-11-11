import { StandardError } from "@bakery/contracts/http";
import { z } from "zod";
import { rejectCredentialMetadata } from "./redaction.ts";

export const VerifiedGitHubIdentitySchema = z.object({
  provider: z.literal("github").describe(
    "Fixed provider authenticated by the user endpoint.",
  ),
  action: z.literal("identity.read").describe(
    "Only supported credential verification operation.",
  ),
  accountId: z.string().regex(/^[1-9][0-9]*$/).max(16).describe(
    "Canonical positive safe-integer GitHub account identifier.",
  ),
  login: z.string().min(1).max(39).regex(
    /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/,
    "Invalid provider identity.",
  ).describe("Safe login selected from bounded provider response."),
}).strict().describe(
  "Selected authenticated GitHub identity; no raw response fields.",
);
export type VerifiedGitHubIdentity = z.infer<
  typeof VerifiedGitHubIdentitySchema
>;

/** One fixed no-redirect read; injected fetch intercepts the same request in tests. */
export async function verifyGitHubCredential(
  value: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<VerifiedGitHubIdentity> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal.aborted) controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 5000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const bytes = new Uint8Array(65536);
  const cancelRead = () => {
    void reader?.cancel().catch(() => {});
  };
  controller.signal.addEventListener("abort", cancelRead, { once: true });
  try {
    const pending = fetcher("https://api.github.com/user", {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${value}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    const response = await new Promise<Response>((resolve, reject) => {
      const fail = () => reject(new Error("REJECTED"));
      controller.signal.addEventListener("abort", fail, { once: true });
      if (controller.signal.aborted) fail();
      pending.then((response) => {
        if (controller.signal.aborted) {
          void response.body?.cancel().catch(() => {});
          fail();
        } else resolve(response);
      }, reject).finally(() =>
        controller.signal.removeEventListener("abort", fail)
      );
    });
    if (!response.ok || response.redirected || !response.body) {
      await response.body?.cancel();
      throw new Error("REJECTED");
    }
    reader = response.body.getReader();
    let length = 0;
    while (true) {
      controller.signal.throwIfAborted();
      const result = await reader.read();
      if (result.done) break;
      if (length + result.value.byteLength > bytes.length) {
        throw new Error("REJECTED");
      }
      bytes.set(result.value, length);
      length += result.value.byteLength;
    }
    controller.signal.throwIfAborted();
    const wire: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, length),
      ),
    );
    if (!wire || typeof wire !== "object") throw new Error("REJECTED");
    const { id, login } = wire as Record<string, unknown>;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) {
      throw new Error("REJECTED");
    }
    const identity = VerifiedGitHubIdentitySchema.safeParse({
      provider: "github",
      action: "identity.read",
      accountId: String(id),
      login,
    });
    if (!identity.success) throw new Error("REJECTED");
    rejectCredentialMetadata(identity.data.login, value);
    rejectCredentialMetadata(identity.data.accountId, value);
    return identity.data;
  } catch {
    throw new StandardError({ code: "UNPROCESSABLE" });
  } finally {
    bytes.fill(0);
    controller.signal.removeEventListener("abort", cancelRead);
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
}
