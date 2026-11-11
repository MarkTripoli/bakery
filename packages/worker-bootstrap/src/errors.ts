/**
 * Every refusal the bootstrap can make, with a fixed message. A message never
 * carries a value the manifest, the network or the filesystem supplied: the
 * code names the refusal and the text names the next action.
 */
export const BOOTSTRAP_ERRORS = {
  MANIFEST_MALFORMED:
    "The release manifest is not in the expected form. Nothing was installed.",
  MANIFEST_KEY_UNKNOWN:
    "The release manifest was signed by a key this bootstrap does not trust. Nothing was installed.",
  MANIFEST_SIGNATURE_INVALID:
    "The release manifest signature does not verify. Nothing was installed.",
  MANIFEST_EXPIRED:
    "The release manifest has expired. Fetch a current setup command from Bakery.",
  MANIFEST_NOT_YET_VALID:
    "The release manifest is dated in the future. Check this machine's clock.",
  MANIFEST_RELEASE_MISMATCH:
    "The release manifest is for a different release than the one requested.",
  MANIFEST_TARGET_UNSUPPORTED:
    "The release manifest has no build for this operating system and architecture.",
  MANIFEST_PROTOCOL_INCOMPATIBLE:
    "This release does not support the worker protocol version this server speaks.",
  MANIFEST_STATE_FORMAT_INCOMPATIBLE:
    "This release does not read the worker state format already on this machine.",
  RELEASE_NOT_EXACT:
    "A release must be an exact version such as 1.2.3, never a tag or a range.",
  ARTIFACT_DOWNLOAD_INTERRUPTED:
    "The download was interrupted. The existing installation was not changed.",
  ARTIFACT_SIZE_MISMATCH:
    "The downloaded file is not the size the signed manifest declares. The existing installation was not changed.",
  ARTIFACT_DIGEST_MISMATCH:
    "The downloaded file does not match the signed digest. The existing installation was not changed.",
  INSTALL_REFUSED_ROOT:
    "Run setup as an ordinary user, not as root. A narrow privilege step is requested separately for the service.",
  INSTALL_ROOT_INVALID: "The install root must be an absolute path.",
  INSTALL_PERMISSION_DENIED:
    "This user may not write to the install root. The existing installation was not changed.",
  INSTALL_LOCKED:
    "Another setup holds the install lock. If none is running, remove the lock directory named in the install guide.",
  INSTALL_VERSION_DIFFERS:
    "A different release is installed. Re-run with an explicit upgrade to change it.",
  INSTALL_CORRUPT:
    "The installed worker does not match its recorded digest. It was not used or replaced.",
  INSTALL_PATH_COLLISION:
    "A path in the install root is not what setup expects, so nothing was written.",
  INSTALL_IO_FAILED:
    "The install could not complete. The existing installation was not changed.",
} as const;

export type BootstrapErrorCode = keyof typeof BOOTSTRAP_ERRORS;

export class BootstrapError extends Error {
  readonly code: BootstrapErrorCode;

  constructor(code: BootstrapErrorCode, options?: { cause?: unknown }) {
    super(BOOTSTRAP_ERRORS[code]);
    this.name = "BootstrapError";
    this.code = code;
    // The cause stays for diagnostics in memory only; it never reaches the
    // message, and JSON of the error does not include it.
    if (options?.cause !== undefined) {
      Object.defineProperty(this, "cause", {
        value: options.cause,
        enumerable: false,
      });
    }
  }
}
