/**
 * The compute family (chapter 25 section 8, extension point E8, O22).
 *
 * An execution-environment provider's whole job is to make a worker exist
 * somewhere for one attempt. The engine knows only the worker protocol, so this
 * port carries what the engine hands over and takes back, and nothing about any
 * vendor. No provider is built in v1: `COMPUTE_PROVIDERS` is empty and a rail
 * keeps it that way until an owner decision changes it.
 */

/** The pinned repository state an environment prepares, per declared workspace. */
export type ComputeWorkspacePin = {
  /** The workspace's name as the run declares it. */
  workspace: string;
  /** The revision to check out; never a branch name and never a warm clone. */
  commitSha: string;
};

/** What the engine asks an environment to provision for one attempt. */
export type ComputeProvisionRequest = {
  attemptId: string;
  /** The run's placement requirements, already merged with the job's own. */
  requirements: { capabilities: readonly string[]; platform?: string };
  /** The run's affinity key, when it recorded one. */
  affinityKey?: string;
  workspaces: readonly ComputeWorkspacePin[];
};

/** A provisioned environment, opaque to the engine apart from its identity. */
export type ComputeEnvironment = {
  /** The provider's own identifier, used only to tear the environment down. */
  environmentId: string;
};

/**
 * What the worker running inside an environment is given. The context directory
 * and the output directory are a step's only file contract, and the credential
 * is scoped to this one attempt.
 */
export type ComputeRunRequest = {
  environment: ComputeEnvironment;
  attemptId: string;
  /** Mounted read-only. */
  contextDirectory: string;
  outputDirectory: string;
  attemptCredential: string;
};

/** What an attempt gives back: artifacts and run refs, collected before teardown. */
export type ComputeOutputs = {
  artifacts: readonly { name: string; digest: string; bytes: number }[];
  runRefs: readonly string[];
};

/**
 * The cost of an environment's time, reported to the usage ledger as the
 * `compute` kind beside model usage.
 */
export type ComputeCostReport = {
  environmentId: string;
  costUsd: number;
  /** How the provider knows the figure, in the ledger's own words. */
  measurement: "reported" | "estimated" | "unknown";
  startedAt: Date;
  endedAt: Date;
};

/** The usage ledger's record kinds. A compute record has no model and no provider call. */
export const USAGE_RECORD_KINDS = ["model", "compute"] as const;
export type UsageRecordKind = (typeof USAGE_RECORD_KINDS)[number];

/**
 * An execution-environment provider. Its steps are exactly the six the design
 * names: provision, prepare the repository at the pin, run the worker, collect
 * outputs, tear down and report cost.
 */
export type ComputePort = {
  provision(request: ComputeProvisionRequest): Promise<ComputeEnvironment>;
  prepare(
    environment: ComputeEnvironment,
    workspaces: readonly ComputeWorkspacePin[],
  ): Promise<void>;
  run(request: ComputeRunRequest): Promise<void>;
  collect(environment: ComputeEnvironment): Promise<ComputeOutputs>;
  teardown(environment: ComputeEnvironment): Promise<void>;
  cost(environment: ComputeEnvironment): Promise<ComputeCostReport>;
};

/** A provider of the compute family, named for the owner's subprocessor list. */
export type ComputeProvider = {
  id: string;
  port: ComputePort;
};

/** No provider is built in v1 (O22). */
export const COMPUTE_PROVIDERS: readonly ComputeProvider[] = [];
