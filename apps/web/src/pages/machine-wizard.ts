import { type CodingAgent, codingAgents } from "./machine-state.ts";

/**
 * What the add-a-machine wizard asks and what it sends (#70). The wizard holds
 * the answers until the last step, where the one enrollment is made: a machine
 * that is never installed leaves nothing behind but a setup it can cancel.
 */

export const WIZARD_STEPS = ["system", "agent", "install"] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

export type MachineSystem = "linux" | "macos";

export const PROCESSORS = ["x86_64", "arm64"] as const;
export type Processor = (typeof PROCESSORS)[number];

export type WizardAnswers = Readonly<{
  name: string;
  os: MachineSystem;
  architecture: string;
  slots: string;
  agent: CodingAgent | null;
}>;

/** The processor a system most often has; the person can change it. */
export function suggestedProcessor(os: MachineSystem): Processor {
  return os === "macos" ? "arm64" : "x86_64";
}

export function initialAnswers(): WizardAnswers {
  return {
    name: "",
    os: "linux",
    architecture: suggestedProcessor("linux"),
    slots: "1",
    agent: null,
  };
}

export const NAME_MAX = 200;
export const SLOTS_MAX = 100;

export type SystemProblem = "nameRequired" | "nameTooLong" | "slotsInvalid";

/** What is wrong with the first step's answers, in the order the fields are shown. */
export function systemProblems(answers: WizardAnswers): SystemProblem[] {
  const problems: SystemProblem[] = [];
  const name = answers.name.trim();
  if (name.length === 0) problems.push("nameRequired");
  else if (name.length > NAME_MAX) problems.push("nameTooLong");
  if (parsedSlots(answers.slots) === null) problems.push("slotsInvalid");
  return problems;
}

/** A whole number of slots from 1 to 100, or null: nothing is rounded or defaulted. */
export function parsedSlots(text: string): number | null {
  if (!/^[0-9]{1,3}$/.test(text.trim())) return null;
  const value = Number(text.trim());
  return value >= 1 && value <= SLOTS_MAX ? value : null;
}

/**
 * The capability ceiling of a machine that runs coding agents: what a coding
 * job asks of the machine (a working copy, a shell, the web and a model), and
 * the agent the person chose. The worker may later ask for any subset.
 */
const CODING_CAPABILITIES = ["git", "shell", "web", "model"] as const;

export type EnrollmentInput = Readonly<{
  name: string;
  os: MachineSystem;
  architecture: string;
  capabilities: string[];
  slots: number;
}>;

/** The enrollment the answers ask for, or null while a step is unanswered. */
export function enrollmentInput(
  answers: WizardAnswers,
): EnrollmentInput | null {
  const slots = parsedSlots(answers.slots);
  if (
    systemProblems(answers).length > 0 || slots === null ||
    answers.agent === null || answers.architecture.trim().length === 0
  ) return null;
  return {
    name: answers.name.trim(),
    os: answers.os,
    architecture: answers.architecture.trim(),
    capabilities: [...CODING_CAPABILITIES, answers.agent],
    slots,
  };
}

/** Where the worker looks for the setup code and keeps its state: the production layout. */
export const WORKER_STATE_DIR = "/var/lib/bakery/worker";
export const SETUP_CODE_FILE = `${WORKER_STATE_DIR}/enrollment-token`;
/** The environment file and service of a Linux worker (`infra/production`). */
export const WORKER_ENVIRONMENT_FILE = "/etc/bakery/worker.env";
export const WORKER_SERVICE = "bakery-worker";

/** The setting-name prefix and program name of each coding agent. */
const HARNESS: Readonly<
  Record<CodingAgent, { prefix: string; program: string }>
> = {
  claude: { prefix: "CLAUDE", program: "claude" },
  codex: { prefix: "CODEX", program: "codex" },
  pi: { prefix: "PI", program: "pi" },
};

/**
 * The settings the worker is started with: the exact values, in the order the
 * install step shows them. The setup code itself is never in them: the worker
 * reads it from the file the person saves it in. Only the chosen agent's
 * settings are present, because a worker refuses to start with two enabled.
 */
export function workerEnvironment(options: {
  serverUrl: string;
  input: EnrollmentInput;
  agent: CodingAgent;
}): string {
  const { input } = options;
  const { prefix, program } = HARNESS[options.agent];
  return [
    `BAKERY_SERVER_URL=${options.serverUrl}`,
    `BAKERY_WORKER_STATE_DIR=${WORKER_STATE_DIR}`,
    `BAKERY_WORKER_ENROLLMENT_TOKEN_FILE=${SETUP_CODE_FILE}`,
    `BAKERY_WORKER_NAME=${input.name}`,
    `BAKERY_WORKER_SLOTS=${input.slots}`,
    `BAKERY_WORKER_CAPABILITIES=${input.capabilities.join(",")}`,
    `BAKERY_${prefix}_HARNESS=1`,
    `BAKERY_${prefix}_HARNESS_REPOSITORY=/workspace/repository`,
    `BAKERY_${prefix}_HARNESS_TIME_LIMIT_MS=120000`,
    `BAKERY_${prefix}_HARNESS_EXECUTABLE=${program}`,
  ].join("\n");
}

/**
 * Saves a pasted setup code to the file the worker reads, readable by its
 * owner only (the worker refuses a file that others can read). The code is
 * typed into the terminal, never part of the command.
 */
export function saveSetupCodeCommand(): string {
  return [
    `mkdir -p ${WORKER_STATE_DIR}`,
    "umask 077",
    `cat > ${SETUP_CODE_FILE}`,
  ].join("\n");
}

/** The command that starts a Linux worker as its service; none is known for macOS. */
export function startWorkerCommand(os: MachineSystem): string | null {
  return os === "linux"
    ? `sudo systemctl enable --now ${WORKER_SERVICE}`
    : null;
}

/** The coding agent an existing enrollment's capabilities name, if any. */
export function agentOfCapabilities(capabilities: unknown): CodingAgent | null {
  return codingAgents(capabilities as never)[0] ?? null;
}

/** Whole minutes left until `expiresAt`, never below zero. */
export function minutesLeft(expiresAt: string, now: number): number {
  const left = Date.parse(expiresAt) - now;
  return Number.isFinite(left) ? Math.max(0, Math.ceil(left / 60_000)) : 0;
}

/** Where the install step stands, from the enrollment's state and the clock. */
export type InstallState = "waiting" | "connected" | "expired" | "canceled";

export function installState(
  enrollment: { state: string; expiresAt: string },
  now: number,
): InstallState {
  if (enrollment.state === "consumed") return "connected";
  if (enrollment.state === "canceled") return "canceled";
  if (enrollment.state === "expired") return "expired";
  return Date.parse(enrollment.expiresAt) <= now ? "expired" : "waiting";
}
