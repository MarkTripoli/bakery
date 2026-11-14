import { BootstrapError } from "./errors.ts";

/**
 * The fixed-origin download (#18, slice 3). The installer verifies a signed
 * manifest and then a digest and size; this is the part before them that keeps
 * a hostile or broken network from making the download itself expensive or
 * misdirected: one origin, a short redirect chain that never leaves it, no
 * compression (a few bytes that expand into gigabytes), a size that may not
 * exceed what the signed manifest declares, and a stream that may not stall or
 * run on. It returns the iterable `installRelease` takes as `download`.
 *
 * The release is a single binary verified by digest, not an archive, so there
 * is no archive to expand, list or unpack here; encoded and archive-like
 * responses are refused rather than decoded.
 */

export type DownloadOptions = Readonly<{
  /** The fixed release origin: https, or http on this machine for local test releases. */
  origin: string;
  /** An absolute path on that origin to the one file, built by the caller from the signed manifest. */
  path: string;
  /** The size the signed manifest declares: the download may never exceed it. */
  expectedBytes: number;
  fetch: typeof fetch;
  /** Default 3. Every hop must stay on the origin. */
  maxRedirects?: number;
  /** Default ten minutes for the whole download. */
  timeoutMs?: number;
  /** Default thirty seconds without a byte. */
  idleMs?: number;
}>;

const DEFAULT_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_IDLE_MS = 30_000;
const PATH = /^\/[A-Za-z0-9._/-]{1,300}$/;

function releaseOrigin(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new BootstrapError("DOWNLOAD_ORIGIN_INVALID");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
    url.username !== "" || url.password !== "" ||
    (url.pathname !== "/" && url.pathname !== "") || url.search !== "" ||
    url.hash !== ""
  ) throw new BootstrapError("DOWNLOAD_ORIGIN_INVALID");
  return url.origin;
}

function releasePath(path: string): string {
  if (!PATH.test(path) || path.includes("..") || path.includes("//")) {
    throw new BootstrapError("DOWNLOAD_PATH_INVALID");
  }
  return path;
}

async function readWithin(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleMs: number,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) throw new BootstrapError("ARTIFACT_DOWNLOAD_INTERRUPTED");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new BootstrapError("ARTIFACT_DOWNLOAD_INTERRUPTED")),
      idleMs,
    );
  });
  try {
    return await Promise.race([reader.read(), stalled]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Prepares a download of one file from the fixed origin. Nothing is requested
 * until the returned function is called and its iterable is read; the request
 * carries no credentials, asks for no encoding, and follows no redirect off the
 * origin.
 */
export function boundedDownload(
  options: DownloadOptions,
): () => AsyncIterable<Uint8Array> {
  const origin = releaseOrigin(options.origin);
  const path = releasePath(options.path);
  if (
    !Number.isInteger(options.expectedBytes) || options.expectedBytes < 0
  ) throw new BootstrapError("ARTIFACT_SIZE_MISMATCH");
  const maxRedirects = options.maxRedirects ?? DEFAULT_REDIRECTS;
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;

  return () =>
    (async function* () {
      const signal = AbortSignal.timeout(
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      let url = `${origin}${path}`;
      let response: Response | undefined;
      for (let hops = 0; hops <= maxRedirects; hops += 1) {
        let answer: Response;
        try {
          answer = await options.fetch(url, {
            method: "GET",
            headers: {
              accept: "application/octet-stream",
              "accept-encoding": "identity",
            },
            credentials: "omit",
            redirect: "manual",
            signal,
          });
        } catch (error) {
          throw new BootstrapError("ARTIFACT_DOWNLOAD_INTERRUPTED", {
            cause: error,
          });
        }
        if (answer.status >= 300 && answer.status < 400) {
          await answer.body?.cancel().catch(() => undefined);
          const location = answer.headers.get("location");
          let next: URL;
          try {
            next = new URL(location ?? "", url);
          } catch {
            throw new BootstrapError("DOWNLOAD_REDIRECT_REFUSED");
          }
          if (
            location === null || location === "" || location.includes("..") ||
            next.origin !== origin ||
            next.username !== "" ||
            next.password !== "" || next.search !== "" || next.hash !== "" ||
            !PATH.test(next.pathname) || next.pathname.includes("..")
          ) throw new BootstrapError("DOWNLOAD_REDIRECT_REFUSED");
          url = `${origin}${next.pathname}`;
          continue;
        }
        response = answer;
        break;
      }
      if (response === undefined) {
        throw new BootstrapError("DOWNLOAD_REDIRECT_REFUSED");
      }
      // Only a whole file: not a range, not an empty answer, not an error page.
      if (response.status !== 200 || response.body === null) {
        await response.body?.cancel().catch(() => undefined);
        throw new BootstrapError("ARTIFACT_DOWNLOAD_INTERRUPTED");
      }
      const encoding = (response.headers.get("content-encoding") ?? "identity")
        .trim().toLowerCase();
      if (encoding !== "identity") {
        await response.body.cancel().catch(() => undefined);
        throw new BootstrapError("DOWNLOAD_ENCODING_REFUSED");
      }
      const declared = response.headers.get("content-length");
      if (
        declared !== null &&
        (!/^[0-9]{1,15}$/.test(declared) ||
          Number(declared) !== options.expectedBytes)
      ) {
        await response.body.cancel().catch(() => undefined);
        throw new BootstrapError("ARTIFACT_SIZE_MISMATCH");
      }

      const reader = response.body.getReader();
      let total = 0;
      try {
        for (;;) {
          const { done, value } = await readWithin(reader, idleMs, signal);
          if (done) break;
          total += value.byteLength;
          // Never hand on, or keep reading, past the signed size.
          if (total > options.expectedBytes) {
            throw new BootstrapError("ARTIFACT_SIZE_MISMATCH");
          }
          yield value;
        }
      } catch (error) {
        if (error instanceof BootstrapError) throw error;
        throw new BootstrapError("ARTIFACT_DOWNLOAD_INTERRUPTED", {
          cause: error,
        });
      } finally {
        await reader.cancel().catch(() => undefined);
      }
    })();
}
