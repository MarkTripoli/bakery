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
  CLOCK_INVALID:
    "This machine's clock did not give a valid time. Nothing was installed.",
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
  INSTALL_ROOT_INVALID:
    "The install root must be an absolute path to a real directory that only this user can write to.",
  INSTALL_PERMISSION_DENIED:
    "This user may not write to the install root. The existing installation was not changed.",
  INSTALL_LOCKED:
    "Another setup holds the install lock. Wait for it to finish; if none is running, remove the .install.lock directory inside the install root.",
  INSTALL_VERSION_DIFFERS:
    "A different release is installed. Re-run with an explicit upgrade to change it.",
  INSTALL_CORRUPT:
    "The installed worker does not match its recorded digest. It was not used or replaced.",
  INSTALL_PATH_COLLISION:
    "A path in the install root is not what setup expects, so nothing was written.",
  INSTALL_IO_FAILED:
    "The install could not complete. The existing installation was not changed.",
  PAIRING_SERVER_INVALID:
    "The Bakery address must be an https address such as https://bakery.example, with no path, login or query.",
  PAIRING_SERVER_INSECURE:
    "Plain http is only allowed for a Bakery on this machine (localhost). Use the https address.",
  PAIRING_TOKEN_UNREADABLE:
    "The setup code could not be read. Enter it when asked, or point setup at a protected file or descriptor that holds only the code.",
  PAIRING_TOKEN_UNPROTECTED:
    "The setup code file can be read by other users. Make it readable by its owner only (mode 600) and try again.",
  PAIRING_TOKEN_INVALID:
    "The setup code is empty, spans more than one line or is not in the expected form.",
  PAIRING_INSPECTION_FAILED:
    "Bakery did not accept the setup code or could not be reached. Nothing was changed. Check the address and get new settings in Bakery if it expired.",
  PAIRING_INSPECTION_MALFORMED:
    "Bakery answered in a form setup does not recognise. Nothing was changed.",
  PAIRING_NOT_PENDING:
    "This setup code has expired or was canceled. Get new settings in Bakery.",
  PAIRING_DECLINED: "Pairing was not confirmed. Nothing was changed.",
  PAIRING_ORGANIZATION_DIFFERS:
    "This installation is already paired with a different organization. It was not changed.",
  PAIRING_ALREADY_PAIRED:
    "This installation is already paired with this organization under another setup. It was not changed and no second machine was created.",
  PAIRING_BINDING_CORRUPT:
    "The record of this installation's pairing cannot be read. It was not replaced.",
  DOWNLOAD_ORIGIN_INVALID:
    "The release origin must be an https address with no path, login or query. The existing installation was not changed.",
  DOWNLOAD_PATH_INVALID:
    "The release file path is not an allowed path on the release origin. The existing installation was not changed.",
  DOWNLOAD_REDIRECT_REFUSED:
    "The release origin sent the download somewhere it may not go. The existing installation was not changed.",
  DOWNLOAD_ENCODING_REFUSED:
    "The release origin sent the file compressed or re-encoded, which is refused. The existing installation was not changed.",
  SERVICE_SPEC_INVALID:
    "A path or name for the service has characters the service definition does not allow. Nothing was written.",
  SERVICE_SETTING_REFUSED:
    "A setting for the service is not allowed in a service definition: the setup code is never written there.",
  COMMAND_UNKNOWN:
    "Unknown command or option. Use: setup --server URL --release VERSION, pair --server URL (each optionally with --root DIR and --token-file FILE or --token-fd N), status, doctor, drain, or plan (each optionally with --root DIR).",
  COMMAND_TOKEN_SHORTCUT:
    "The setup code is never taken from a flag or the environment. Enter it when asked, or use --token-file or --token-fd with a protected file or descriptor.",
  SERVICE_SYSTEM_MISMATCH:
    "This installation was set up for a different operating system than the one named. Nothing was written.",
  SETUP_NOT_PAIRED:
    "This installation is not paired with an organization yet. Run setup or pair first.",
  SETUP_RELEASE_NOT_CONFIGURED:
    "This build has no release origin to install from. Install the verified release first, then run setup again.",
  SETUP_NOT_INSTALLED:
    "The Bakery worker is not installed in this root yet. Run setup with --release VERSION to install the verified release, then pair.",
  PAIRING_IO_FAILED:
    "Pairing could not be recorded. The existing pairing was not changed.",
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
