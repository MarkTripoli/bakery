export {
  BOOTSTRAP_ERRORS,
  BootstrapError,
  type BootstrapErrorCode,
} from "./errors.ts";
export {
  detectTarget,
  KNOWN_TARGETS,
  type ReleaseTarget,
  SUPPORTED_TARGETS,
  type TrustedKey,
  type VerifiedManifest,
  type VerifyOptions,
  verifySignedManifest,
} from "./manifest.ts";
export {
  type InstallOptions,
  installRelease,
  type InstallResult,
  type ProcessInfo,
  type ProcessProbe,
  type StagedFile,
} from "./install.ts";
export {
  type EnrollmentPreview,
  hasUnsafeCharacter,
  hasVisibleCharacter,
  inspectEnrollment,
  normalizeServerOrigin,
  PAIRING_FILE,
  type PairingBinding,
  pairInstallation,
  type PairOptions,
  type PairResult,
  readHiddenToken,
  readProtectedToken,
  TOKEN_FILE,
} from "./pairing.ts";
export {
  type Command,
  type CommandIo,
  parseCommand,
  runCommand,
} from "./cli.ts";
export type { HiddenInputStream } from "./pairing.ts";
export {
  type ChangeActor,
  describeChanges,
  environmentFilePath,
  environmentFileText,
  LINUX_SERVICE,
  LINUX_UNIT_PATH,
  MACOS_LABEL,
  planLinuxService,
  planMacService,
  renderLaunchAgent,
  renderSystemdUnit,
  type ServiceSpec,
  type SystemChange,
  workerPath,
} from "./service.ts";
export { boundedDownload, type DownloadOptions } from "./download.ts";
