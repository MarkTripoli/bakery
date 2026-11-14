import { BootstrapError } from "./errors.ts";
import { boundedDownload } from "./download.ts";
import { installRelease, type InstallResult } from "./install.ts";
import {
  detectTarget,
  isExactRelease,
  type TrustedKey,
  verifySignedManifest,
} from "./manifest.ts";

/**
 * Installing from the release origin (#18, last slice): fetch the signed
 * manifest for the one release the setup command names, verify it against the
 * trust root this bootstrap was built with, then download exactly the signed
 * file and let `installRelease` stage, verify and activate it. Every step before
 * `installRelease` changes nothing on disk, and `installRelease` leaves a prior
 * working install intact on any failure, so a bad network, a bad signature, an
 * unsupported target or a refused permission never costs the machine what it
 * already runs.
 *
 * What is fixed at build time is the origin and the trust root, never anything
 * the person or the network can supply. The layout under the origin is
 * `/releases/<release>/manifest.json` and `/releases/<release>/<file>`.
 */

export type ReleaseConfig = Readonly<{
  /** The fixed release origin: https, or loopback http for local test releases. */
  origin: string;
  /** Public keys the bootstrap trusts; a manifest signed by any other is refused. */
  trustRoot: readonly TrustedKey[];
  /** The worker protocol version this bootstrap pairs for. */
  protocol: number;
  /** The state format this bootstrap writes. */
  stateFormat: number;
}>;

/** More than any real manifest needs; the verifier's own envelope limit is the same. */
const MAX_MANIFEST_BYTES = 128 * 1024;

export type InstallFromOriginOptions = Readonly<{
  root: string;
  /** The exact release the setup command names: never a range or `latest`. */
  release: string;
  config: ReleaseConfig;
  fetch: typeof fetch;
  now: Date;
  /** `process.platform` and `process.arch`, or what the machine reports. */
  platform: string;
  arch: string;
  /** Explicit consent to replace a different installed release. */
  upgrade?: boolean;
}>;

async function readAll(
  stream: AsyncIterable<Uint8Array>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.byteLength;
    chunks.push(chunk);
  }
  const whole = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    whole.set(chunk, at);
    at += chunk.byteLength;
  }
  return whole;
}

export async function installFromOrigin(
  options: InstallFromOriginOptions,
): Promise<InstallResult> {
  if (!isExactRelease(options.release)) {
    throw new BootstrapError("RELEASE_NOT_EXACT");
  }
  const target = detectTarget(options.platform, options.arch);
  if (target === null) throw new BootstrapError("MANIFEST_TARGET_UNSUPPORTED");
  const base = `/releases/${options.release}`;

  const bytes = await readAll(
    boundedDownload({
      origin: options.config.origin,
      path: `${base}/manifest.json`,
      expectedBytes: MAX_MANIFEST_BYTES,
      atMost: true,
      fetch: options.fetch,
    })(),
  );
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new BootstrapError("MANIFEST_MALFORMED");
  }
  const manifest = verifySignedManifest(text, {
    trustRoot: options.config.trustRoot,
    release: options.release,
    target,
    now: options.now,
    protocol: options.config.protocol,
    stateFormat: options.config.stateFormat,
  });
  return await installRelease({
    root: options.root,
    manifest,
    download: boundedDownload({
      origin: options.config.origin,
      path: `${base}/${manifest.file}`,
      expectedBytes: manifest.size,
      fetch: options.fetch,
    }),
    now: options.now,
    upgrade: options.upgrade,
  });
}
