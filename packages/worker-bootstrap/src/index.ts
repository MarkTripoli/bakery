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
export {
  type Check,
  type CheckStatus,
  describeChecks,
  describeStatus,
  doctor,
  doctorExitCode,
  type InstallationState,
  installationStatus,
  type Operation,
  type OperationIo,
  type PairingState,
  parseOperation,
  planDrain,
  type Probes,
  runOperation,
  type ServiceState,
  type StatusReport,
} from "./operations.ts";
export {
  type FileSystemStats,
  linuxServiceState,
  macServiceState,
  type Spawn,
  type Spawned,
  spawnProgram,
  spawnWithTimeout,
  systemProbes,
} from "./probes.ts";
export {
  installFromOrigin,
  type InstallFromOriginOptions,
  type ReleaseConfig,
} from "./bootstrap.ts";
export { type BootstrapIo, runBootstrap } from "./main.ts";
export { isExactRelease } from "./manifest.ts";
export { readPairingBinding } from "./pairing.ts";
