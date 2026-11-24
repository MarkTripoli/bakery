import { BootstrapError } from "./errors.ts";
import {
  hasUnsafeCharacter,
  hasVisibleCharacter,
  normalizeServerOrigin,
  type PairingBinding,
  readPairingBinding,
  recordLink,
} from "./pairing.ts";

/**
 * `link`: add this machine to Bakery with one pasted command (#70).
 *
 * With `--code` the command carries a ten-minute, one-use link code: the
 * terminal asks Bakery what the code would do, prints it, asks one yes or no,
 * then installs, records the link and starts the service. Without a code it
 * asks Bakery for a short code to show an Administrator and waits for the
 * approval, which hands it a link code. The worker's long-lived credential
 * is never typed, printed or passed in a flag: the worker makes its own when
 * it registers with the link code. The text printed is the design's
 * (issue #70, "UX design: adding a machine with one command").
 */

export type LinkCommand = Readonly<{
  server: string;
  /** The link code from the command; null asks for one an Admin approves. */
  code: string | null;
  root: string;
}>;

const TOKEN_ENVIRONMENT = [
  "BAKERY_WORKER_ENROLLMENT_TOKEN",
  "BAKERY_ENROLLMENT_TOKEN",
];

/** Reads `link --server URL [--code CODE] [--root DIR]`, or refuses. Pure. */
export function parseLinkCommand(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  defaults: Readonly<{ root: string }>,
): LinkCommand {
  const [name, ...rest] = argv;
  if (name !== "link") throw new BootstrapError("COMMAND_UNKNOWN");
  const values = new Map<string, string>();
  for (let at = 0; at < rest.length; at += 1) {
    const word = rest[at]!;
    if (word === "--token" || word.startsWith("--token")) {
      throw new BootstrapError("COMMAND_LINK_TOKEN_SHORTCUT");
    }
    if (!["--server", "--code", "--root"].includes(word) || values.has(word)) {
      throw new BootstrapError("COMMAND_UNKNOWN");
    }
    const value = rest[at + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new BootstrapError("COMMAND_UNKNOWN");
    }
    values.set(word, value);
    at += 1;
  }
  for (const key of TOKEN_ENVIRONMENT) {
    if ((environment[key] ?? "") !== "") {
      throw new BootstrapError("COMMAND_LINK_TOKEN_SHORTCUT");
    }
  }
  const server = values.get("--server");
  if (server === undefined) throw new BootstrapError("COMMAND_UNKNOWN");
  return {
    server,
    code: values.get("--code") ?? null,
    root: values.get("--root") ?? defaults.root,
  };
}

/** What this computer is, as the machine reports it to Bakery. */
export type ThisMachine = Readonly<{
  /** `process.platform`: linux or darwin. */
  platform: string;
  /** `process.arch`: arm64 or x64. */
  arch: string;
  hostname: string;
}>;

/** A step that failed on this machine: what failed and where its log is. */
export class LinkStepFailed extends Error {
  readonly log: string;
  constructor(what: string, log: string) {
    super(what);
    this.name = "LinkStepFailed";
    this.log = log;
  }
}

export type LinkIo = Readonly<{
  /** Whether a person can answer here: a script or a pipe cannot. */
  isTerminal: boolean;
  ask: (question: string) => Promise<string>;
  /** Resolves when the person presses Enter. */
  waitForEnter: () => Promise<void>;
  write: (text: string) => void;
  fetch: typeof fetch;
  now: () => Date;
  sleep: (milliseconds: number) => Promise<void>;
  machine: ThisMachine;
  /** Installs the verified worker into the root; throws LinkStepFailed. */
  install: (root: string) => Promise<void>;
  /** Writes the settings, adds the service and starts it; throws LinkStepFailed. */
  startService: (binding: PairingBinding) => Promise<void>;
}>;

const AGENT_NAMES: Readonly<Record<string, string>> = {
  claude: "Claude Code",
  "claude-code": "Claude Code",
  codex: "Codex",
  pi: "Pi",
};

function systemName(platform: string): string {
  if (platform === "linux") return "Linux";
  if (platform === "darwin") return "macOS";
  return platform;
}

function processorName(arch: string): string {
  return arch === "x64" ? "x86_64" : arch;
}

function storedOs(platform: string): "linux" | "macos" | null {
  if (platform === "linux") return "linux";
  if (platform === "darwin") return "macos";
  return null;
}

type Inspection = Readonly<{
  organizationName: string;
  name: string;
  slots: number;
  capabilities: readonly string[];
  supported: boolean;
  supportedSystems: readonly { os: string; architecture: string }[];
  expiresAt: string;
}>;

/** A line Bakery supplied, refused if it could forge or erase what is shown. */
function shownText(value: unknown, max: number): string {
  if (
    typeof value !== "string" || value.length > max ||
    !hasVisibleCharacter(value) || hasUnsafeCharacter(value)
  ) throw new BootstrapError("PAIRING_INSPECTION_MALFORMED");
  return value;
}

function parseInspection(value: unknown): Inspection {
  if (typeof value !== "object" || value === null) {
    throw new BootstrapError("PAIRING_INSPECTION_MALFORMED");
  }
  const body = value as Record<string, unknown>;
  const slots = body.slots;
  if (
    typeof slots !== "number" || !Number.isInteger(slots) || slots < 1 ||
    slots > 100 || typeof body.supported !== "boolean" ||
    !Array.isArray(body.capabilities) || !Array.isArray(body.supportedSystems)
  ) throw new BootstrapError("PAIRING_INSPECTION_MALFORMED");
  return {
    organizationName: shownText(body.organizationName, 200),
    name: shownText(body.name, 200),
    slots,
    capabilities: body.capabilities.map((entry) => shownText(entry, 200)),
    supported: body.supported,
    supportedSystems: body.supportedSystems.map((entry) => {
      const system = entry as Record<string, unknown>;
      return {
        os: shownText(system?.os, 50),
        architecture: shownText(system?.architecture, 100),
      };
    }),
    expiresAt: shownText(body.expiresAt, 40),
  };
}

/** Why Bakery refused, as the terminal says it. Unknown refusals say only that. */
type Refusal = "not_found" | "expired" | "used" | "declined" | "rate_limited";

class Refused extends Error {
  constructor(readonly reason: Refusal | "other") {
    super(reason);
  }
}

async function post(
  io: LinkIo,
  origin: string,
  path: string,
  body: unknown,
): Promise<unknown> {
  let response: Response;
  try {
    response = await io.fetch(`${origin}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "cache-control": "no-store",
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new BootstrapError("PAIRING_INSPECTION_FAILED", { cause: error });
  }
  const text = await response.text().catch(() => "");
  if (text.length > 64 * 1024) {
    throw new BootstrapError("PAIRING_INSPECTION_MALFORMED");
  }
  let parsed: unknown = null;
  try {
    parsed = text === "" ? null : JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (response.ok) return parsed;
  const reason = (parsed as { reason?: unknown } | null)?.reason;
  if (response.status === 429) throw new Refused("rate_limited");
  if (response.status === 404) throw new Refused("not_found");
  if (
    response.status === 409 &&
    (reason === "expired" || reason === "used" || reason === "declined")
  ) throw new Refused(reason);
  throw new Refused("other");
}

function minutesLeft(expiresAt: string, now: Date): number {
  return Math.max(
    0,
    Math.floor((Date.parse(expiresAt) - now.getTime()) / 60_000),
  );
}

function minutes(count: number): string {
  return count === 1 ? "1 minute" : `${count} minutes`;
}

function refusalText(reason: Refusal | "other", origin: string): string {
  switch (reason) {
    case "expired":
      return `This command expired. They work for 10 minutes. Get a new one: ${origin}/machines/new`;
    case "not_found":
      return "Bakery does not know this code. Copy the command again from Add a machine.";
    case "used":
      return "This command was already used. Each one works once.";
    case "declined":
      return "An administrator declined. Nothing was installed.";
    case "rate_limited":
      return "Too many tries. Wait a minute, then try again.";
    default:
      return "Bakery could not check this command. Nothing was installed.";
  }
}

function describeLink(inspection: Inspection, machine: ThisMachine): string {
  const agents = [
    ...new Set(
      inspection.capabilities.flatMap((entry) => {
        const agent = AGENT_NAMES[entry.trim().toLowerCase()];
        return agent === undefined ? [] : [agent];
      }),
    ),
  ];
  const rows: [string, string][] = [
    ["Organization", inspection.organizationName],
    ["Machine", inspection.name],
    ["Tasks at once", String(inspection.slots)],
    ...(agents.length === 0
      ? []
      : [["Coding agent", agents.join(", ")] as [string, string]]),
    [
      "This computer",
      `${systemName(machine.platform)} ${processorName(machine.arch)}`,
    ],
  ];
  return rows.map(([label, value]) => `  ${label.padEnd(15)}${value}`).join(
    "\n",
  );
}

function agentOf(inspection: Inspection): string | null {
  for (const entry of inspection.capabilities) {
    const agent = AGENT_NAMES[entry.trim().toLowerCase()];
    if (agent !== undefined) return agent;
  }
  return null;
}

function supportedList(
  inspection: Pick<Inspection, "supportedSystems">,
): string {
  return inspection.supportedSystems.map((system) =>
    `${system.os === "macos" ? "macOS" : systemName(system.os)} ${
      processorName(system.architecture)
    }`
  ).join(", ");
}

const SERVICE_NOTICE =
  "This installs the worker, adds the service bakery-worker\n" +
  "(asks for your password once) and starts it.\n\n";
const CONNECTION_CHECKS = 8;
const CONNECTION_CHECK_MS = 5_000;

/** Links with a code: inspect, show, ask once, install, record, start, wait. */
async function linkWithCode(
  command: LinkCommand,
  origin: string,
  code: string,
  io: LinkIo,
): Promise<number> {
  const report = {
    linkCode: code,
    os: io.machine.platform === "darwin" ? "macos" : io.machine.platform,
    architecture: io.machine.arch,
    hostname: io.machine.hostname,
  };
  let inspection: Inspection;
  try {
    inspection = parseInspection(
      await post(io, origin, "/v1/worker/link-code-inspection", report),
    );
  } catch (error) {
    if (error instanceof Refused) {
      io.write(`${refusalText(error.reason, origin)}\n`);
      return 2;
    }
    throw error;
  }
  if (!inspection.supported) {
    io.write(
      `Bakery does not support ${systemName(io.machine.platform)} ${
        processorName(io.machine.arch)
      } yet. Nothing was installed. Supported today: ${
        supportedList(inspection)
      }.\n`,
    );
    return 2;
  }
  io.write(`Bakery worker · link this machine\n\n`);
  io.write(`${describeLink(inspection, io.machine)}\n\n`);
  io.write(SERVICE_NOTICE);
  const answer = await io.ask("Link this machine? [y/N] ");
  if (!/^y(es)?$/i.test(answer.trim())) {
    io.write(
      `Nothing was installed. The command still works for ${
        minutes(minutesLeft(inspection.expiresAt, io.now()))
      }.\n`,
    );
    return 1;
  }
  io.write("\n");
  const os = storedOs(io.machine.platform);
  if (os === null) throw new BootstrapError("SERVICE_SYSTEM_MISMATCH");
  try {
    await io.install(command.root);
    io.write("✓ Installed\n");
    const binding = await recordLink(command.root, {
      serverOrigin: origin,
      organizationName: inspection.organizationName,
      name: inspection.name,
      os,
      architecture: io.machine.arch === "x64" ? "x64" : io.machine.arch,
      slots: inspection.slots,
      capabilities: inspection.capabilities,
      boundAt: io.now().toISOString(),
    }, code);
    await io.startService(binding);
    io.write("✓ Service started\n");
  } catch (error) {
    if (error instanceof LinkStepFailed) {
      io.write(
        `${error.message}\nNothing else was changed.\nThe log is in ${error.log}.\nFix it, then run the same command again.\n`,
      );
      return 2;
    }
    throw error;
  }
  // The worker uses the code up when it registers; until then the code still
  // inspects. A used code is the machine having connected.
  for (let check = 0; check < CONNECTION_CHECKS; check += 1) {
    await io.sleep(CONNECTION_CHECK_MS);
    try {
      await post(io, origin, "/v1/worker/link-code-inspection", report);
    } catch (error) {
      if (error instanceof Refused && error.reason === "used") {
        io.write("✓ Connected to Bakery\n\n");
        const agent = agentOf(inspection);
        io.write(
          agent === null
            ? `${inspection.name} is linked.\n`
            : `${inspection.name} is linked. One thing left, in Bakery: sign in to ${agent}.\n`,
        );
        return 0;
      }
      if (!(error instanceof Refused)) throw error;
    }
  }
  io.write(
    "The service started, but Bakery has not seen this machine yet. Check it with: bakery-worker status\n",
  );
  return 1;
}

type Created = Readonly<{
  requestId: string;
  userCode: string;
  deviceSecret: string;
  expiresAt: string;
  pollIntervalSeconds: number;
  supported?: boolean;
  supportedSystems?: readonly { os: string; architecture: string }[];
}>;

function parseCreated(value: unknown): Created {
  const body = (value ?? {}) as Record<string, unknown>;
  if (
    typeof body.requestId !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(body.requestId) ||
    typeof body.userCode !== "string" ||
    !/^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/.test(body.userCode) ||
    typeof body.deviceSecret !== "string" || body.deviceSecret.length > 200 ||
    typeof body.expiresAt !== "string" ||
    typeof body.pollIntervalSeconds !== "number" ||
    !Number.isInteger(body.pollIntervalSeconds) ||
    body.pollIntervalSeconds < 1 || body.pollIntervalSeconds > 60
  ) throw new BootstrapError("PAIRING_INSPECTION_MALFORMED");
  return body as unknown as Created;
}

/** Links without a code: a code to approve in the browser, then as above. */
async function linkByApproval(
  command: LinkCommand,
  origin: string,
  io: LinkIo,
): Promise<number> {
  for (;;) {
    let created: Created;
    try {
      created = parseCreated(
        await post(io, origin, "/v1/worker/link-requests", {
          os: io.machine.platform === "darwin" ? "macos" : io.machine.platform,
          architecture: io.machine.arch,
          hostname: io.machine.hostname,
        }),
      );
    } catch (error) {
      if (error instanceof Refused) {
        io.write(`${refusalText(error.reason, origin)}\n`);
        return 2;
      }
      throw error;
    }
    if (created.supported === false) {
      const supported = created.supportedSystems ?? [];
      io.write(
        `Bakery does not support ${systemName(io.machine.platform)} ${
          processorName(io.machine.arch)
        } yet. Nothing was installed.${
          supported.length > 0
            ? ` Supported today: ${
              supportedList({ supportedSystems: supported })
            }.`
            : ""
        }\n`,
      );
      return 2;
    }
    io.write(
      `Nothing is installed yet. Ask a Bakery administrator to approve this code:\n\n  ${created.userCode}\n\n  ${origin}/machines/link   (opens on any device)\n\nWaiting for approval… ${
        minutes(minutesLeft(created.expiresAt, io.now()))
      } left.\n`,
    );
    for (;;) {
      await io.sleep(created.pollIntervalSeconds * 1000);
      let state: { state?: unknown; linkCode?: unknown };
      try {
        state = (await post(
          io,
          origin,
          `/v1/worker/link-requests/${created.requestId}/polls`,
          { deviceSecret: created.deviceSecret },
        ) ?? {}) as typeof state;
      } catch (error) {
        if (error instanceof Refused && error.reason === "rate_limited") {
          continue;
        }
        if (error instanceof Refused) {
          io.write(`${refusalText(error.reason, origin)}\n`);
          return 2;
        }
        throw error;
      }
      if (state.state === "pending") continue;
      if (state.state === "declined") {
        io.write(`${refusalText("declined", origin)}\n`);
        return 1;
      }
      if (state.state === "approved" && typeof state.linkCode === "string") {
        io.write("\n");
        return await linkWithCode(command, origin, state.linkCode, io);
      }
      // Expired, or approved but past its time: a new code on Enter.
      io.write(
        `The code ${created.userCode} expired. Codes work for 10 minutes. Nothing was installed. Press Enter for a new code.\n`,
      );
      await io.waitForEnter();
      break;
    }
  }
}

/** Runs `link`. Returns a process exit code. */
export async function runLink(
  command: LinkCommand,
  io: LinkIo,
): Promise<number> {
  try {
    const origin = normalizeServerOrigin(command.server);
    if (!io.isTerminal) {
      io.write("Run this in a terminal: it asks one question.\n");
      return 2;
    }
    const existing = await readPairingBinding(command.root);
    if (existing !== null) {
      io.write(
        `This computer is already linked to ${existing.organizationName} as ${existing.name}. Nothing was changed.\n`,
      );
      return 0;
    }
    return command.code === null
      ? await linkByApproval(command, origin, io)
      : await linkWithCode(command, origin, command.code, io);
  } catch (error) {
    io.write(
      `${
        error instanceof BootstrapError
          ? error.message
          : "Linking could not complete. Nothing else was changed."
      }\n`,
    );
    return 2;
  }
}
