/**
 * pnpm verify:backend (#50 AC1): runs every required local backend check in
 * order, fail-fast, and writes a revision manifest that names exactly what was
 * checked. It refuses to start when cloud credentials are in the environment,
 * because the local proof must not be able to reach a hosted account.
 *
 *   pnpm verify:backend [--lanes typecheck,rails,unit] [--out path.json]
 */
import { z } from "zod";
import { BAKERY_MIGRATION_SOURCES } from "../apps/server/src/migration-sources.ts";
import { loadMigrations } from "../apps/server/src/platform/migration-definition.ts";

/** Every step, in the order it runs. "typecheck" is pnpm typecheck; the rest are scripts/run-tests.ts lanes. */
export const VERIFY_BACKEND_STEPS = [
  "typecheck",
  "rails",
  "unit",
  "contract",
  "integration",
  "security",
  "recovery",
  "e2e",
] as const;
export type VerifyBackendStep = (typeof VERIFY_BACKEND_STEPS)[number];

/**
 * Cloud credentials the repository's code or tooling reads. Exact names come
 * from the code (GITHUB_TOKEN, GH_TOKEN, SENTRY_AUTH_TOKEN, RAILWAY_TOKEN,
 * OPENAI_API_KEY, CODEX_HOME, CLAUDE_CONFIG_DIR) and from the SDKs it bundles
 * (the AWS SDK for S3, Anthropic, Google and Azure credential chains). A
 * prefix refuses every variable that starts with it.
 */
export const CLOUD_CREDENTIAL_ENVIRONMENT = Object.freeze({
  exact: Object.freeze(
    [
      "GOOGLE_APPLICATION_CREDENTIALS",
      "RAILWAY_TOKEN",
      "RAILWAY_API_TOKEN",
      "SENTRY_AUTH_TOKEN",
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "GH_ENTERPRISE_TOKEN",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "CODEX_HOME",
      "CLAUDE_CONFIG_DIR",
    ] as const,
  ),
  prefixes: Object.freeze(["AWS_", "AZURE_"] as const),
});

/** Names of the cloud credential variables set (non-empty) in the environment, sorted. */
export function cloudCredentialsPresent(
  environment: Readonly<Record<string, string | undefined>>,
): string[] {
  const exact = new Set<string>(CLOUD_CREDENTIAL_ENVIRONMENT.exact);
  return Object.entries(environment)
    .filter(([name, value]) =>
      (value ?? "").length > 0 &&
      (exact.has(name) ||
        CLOUD_CREDENTIAL_ENVIRONMENT.prefixes.some((prefix) =>
          name.startsWith(prefix)
        ))
    )
    .map(([name]) => name)
    .sort();
}

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/).describe(
  "Lowercase hex SHA-256 digest.",
);

export const VerifyBackendStepResultSchema = z.object({
  step: z.enum(VERIFY_BACKEND_STEPS).describe(
    "The check that ran: pnpm typecheck or a scripts/run-tests.ts lane.",
  ),
  command: z.array(z.string().describe("One program name or argument."))
    .min(1).describe(
      "The exact command and arguments that ran, program first.",
    ),
  exitCode: z.number().int().describe(
    "Exit code of the command; 0 means the check passed.",
  ),
  durationMs: z.number().nonnegative().describe(
    "Wall-clock time the command took, in milliseconds.",
  ),
}).strict().describe("One check verify:backend ran and how it ended.");

export const VerifyBackendManifestSchema = z.object({
  schema: z.literal("bakery.verify-backend/v1").describe(
    "Manifest format identifier.",
  ),
  startedAt: z.string().datetime().describe(
    "When the run started, as an ISO-8601 UTC timestamp.",
  ),
  outcome: z.enum(["passed", "failed"]).describe(
    "passed only when every requested step ran and exited 0.",
  ),
  revision: z.object({
    gitSha: z.string().regex(/^[0-9a-f]{40}$/).describe(
      "git HEAD commit the checks ran against.",
    ),
    dirty: z.boolean().describe(
      "True when the working tree had uncommitted or untracked changes, so the SHA alone does not name the code.",
    ),
    pnpmLockSha256: Sha256.describe("SHA-256 of pnpm-lock.yaml."),
    denoLockSha256: Sha256.describe("SHA-256 of deno.lock."),
    images: z.array(
      z.string().regex(/@sha256:[0-9a-f]{64}$/).describe(
        "A container image reference pinned by digest.",
      ),
    ).min(1).describe(
      "Every distinct image reference in infra/compose.yaml, sorted; each carries its digest.",
    ),
    migrations: z.object({
      count: z.number().int().positive().describe(
        "Number of SQL migrations across every registered migration source.",
      ),
      checksum: Sha256.describe(
        "SHA-256 over owner:version:checksum lines of every migration, sorted, using the same per-file checksum the migrator records.",
      ),
    }).strict().describe("Checksum over the migration set the stack applies."),
  }).strict().describe(
    "What exactly was checked: code, dependencies, images and schema.",
  ),
  toolchain: z.object({
    deno: z.string().min(1).describe("Deno version that ran verify:backend."),
    node: z.string().min(1).nullable().describe(
      "node --version output, or null when node is not on PATH.",
    ),
  }).strict().describe("Runtime versions on the host that ran the checks."),
  requestedSteps: z.array(
    z.enum(VERIFY_BACKEND_STEPS).describe("A step name."),
  ).min(1).describe(
    "Steps asked for (all by default, narrowed with --lanes), in run order.",
  ),
  steps: z.array(VerifyBackendStepResultSchema).describe(
    "Steps that ran, in order; a failure stops the run, so later steps are absent.",
  ),
}).strict().describe(
  "Revision manifest written by pnpm verify:backend: the revision checked and each step's result.",
);
export type VerifyBackendManifest = z.infer<typeof VerifyBackendManifestSchema>;
export type VerifyBackendRevision = VerifyBackendManifest["revision"];
export type VerifyBackendToolchain = VerifyBackendManifest["toolchain"];

/** Runs one step with inherited stdio and resolves its exit code. */
export type VerifyBackendRunner = (
  command: readonly string[],
  options: { readonly cwd: string },
) => Promise<number>;

/** Runs a command and captures stdout (for git and node --version). */
export type VerifyBackendCapture = (
  command: readonly string[],
  options: { readonly cwd: string },
) => Promise<{ readonly code: number; readonly stdout: string }>;

export function stepCommand(step: VerifyBackendStep): string[] {
  if (step === "typecheck") return ["pnpm", "typecheck"];
  return [
    Deno.execPath(),
    "run",
    "--allow-env",
    "--allow-read",
    "--allow-run",
    "scripts/run-tests.ts",
    step,
  ];
}

export function parseVerifyBackendArgs(
  args: readonly string[],
): { lanes: VerifyBackendStep[]; out?: string } {
  let lanes: VerifyBackendStep[] = [...VERIFY_BACKEND_STEPS];
  let out: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--") continue;
    const [flag, inline] = argument.split("=", 2) as [string, string?];
    const value = inline ?? args[++index];
    if (value === undefined || value.length === 0) {
      throw new Error(flag + " needs a value");
    }
    if (flag === "--lanes") {
      const asked = value.split(",").map((lane) => lane.trim());
      const unknown = asked.filter((lane) =>
        !(VERIFY_BACKEND_STEPS as readonly string[]).includes(lane)
      );
      if (unknown.length > 0) {
        throw new Error(
          "Unknown lane " + unknown.join(", ") + "; expected some of " +
            VERIFY_BACKEND_STEPS.join(", "),
        );
      }
      // Run order is fixed whatever order --lanes names them in.
      lanes = VERIFY_BACKEND_STEPS.filter((step) => asked.includes(step));
    } else if (flag === "--out") {
      out = value;
    } else {
      throw new Error("Unknown argument " + flag);
    }
  }
  return { lanes, out };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice());
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

/** Distinct image references in a compose file, sorted. */
export function composeImages(composeText: string): string[] {
  const images = new Set<string>();
  for (const match of composeText.matchAll(/^\s*image:\s*["']?([^\s"'#]+)/gm)) {
    images.add(match[1]!);
  }
  return [...images].sort();
}

export async function migrationSetChecksum(): Promise<
  { count: number; checksum: string }
> {
  const lines: string[] = [];
  for (const source of BAKERY_MIGRATION_SOURCES) {
    for (const migration of await loadMigrations(source)) {
      lines.push(
        migration.owner + ":" + migration.version + ":" + migration.checksum,
      );
    }
  }
  lines.sort();
  return {
    count: lines.length,
    checksum: await sha256Hex(new TextEncoder().encode(lines.join("\n"))),
  };
}

export async function collectRevision(
  root: string,
  capture: VerifyBackendCapture,
): Promise<VerifyBackendRevision> {
  const head = await capture(["git", "rev-parse", "HEAD"], { cwd: root });
  const status = await capture(["git", "status", "--porcelain"], {
    cwd: root,
  });
  if (head.code !== 0 || status.code !== 0) {
    throw new Error("git could not name the revision in " + root);
  }
  const read = (path: string) => Deno.readFile(root + "/" + path);
  return {
    gitSha: head.stdout.trim(),
    dirty: status.stdout.trim().length > 0,
    pnpmLockSha256: await sha256Hex(await read("pnpm-lock.yaml")),
    denoLockSha256: await sha256Hex(await read("deno.lock")),
    images: composeImages(
      await Deno.readTextFile(root + "/infra/compose.yaml"),
    ),
    migrations: await migrationSetChecksum(),
  };
}

export async function collectToolchain(
  root: string,
  capture: VerifyBackendCapture,
): Promise<VerifyBackendToolchain> {
  const node = await capture(["node", "--version"], { cwd: root }).catch(
    () => null,
  );
  return {
    deno: Deno.version.deno,
    node: node && node.code === 0 && node.stdout.trim()
      ? node.stdout.trim()
      : null,
  };
}

export type VerifyBackendOptions = {
  readonly root: string;
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly runner: VerifyBackendRunner;
  readonly capture: VerifyBackendCapture;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  readonly writeManifest?: (path: string, text: string) => Promise<void>;
  /** Overrides revision/toolchain collection (tests). */
  readonly revision?: () => Promise<VerifyBackendRevision>;
  readonly toolchain?: () => Promise<VerifyBackendToolchain>;
};

export type VerifyBackendResult = {
  readonly exitCode: number;
  readonly manifestPath?: string;
  readonly manifest?: VerifyBackendManifest;
};

export const CREDENTIAL_REFUSAL_EXIT = 3;

export async function runVerifyBackend(
  options: VerifyBackendOptions,
): Promise<VerifyBackendResult> {
  const log = options.log ?? ((line: string) => console.error(line));
  const now = options.now ?? Date.now;
  const present = cloudCredentialsPresent(options.environment);
  if (present.length > 0) {
    log(
      "verify:backend refuses to run with cloud credentials in the environment: " +
        present.join(", ") +
        ". Unset them; the backend proof is local only and must not reach a hosted account.",
    );
    return { exitCode: CREDENTIAL_REFUSAL_EXIT };
  }
  let parsed;
  try {
    parsed = parseVerifyBackendArgs(options.args);
  } catch (error) {
    log("verify:backend: " + (error as Error).message);
    return { exitCode: 2 };
  }
  const startedAt = new Date(now()).toISOString();
  const revision = await (options.revision ??
    (() => collectRevision(options.root, options.capture)))();
  const toolchain = await (options.toolchain ??
    (() => collectToolchain(options.root, options.capture)))();
  const steps: VerifyBackendManifest["steps"] = [];
  for (const step of parsed.lanes) {
    const command = stepCommand(step);
    log("verify:backend: " + step + " -> " + command.join(" "));
    const started = now();
    const exitCode = await options.runner(command, { cwd: options.root });
    steps.push({
      step,
      command,
      exitCode,
      durationMs: Math.max(0, now() - started),
    });
    if (exitCode !== 0) {
      log("verify:backend: " + step + " failed with exit " + exitCode);
      break;
    }
  }
  const failed = steps.some((step) => step.exitCode !== 0);
  const manifest = VerifyBackendManifestSchema.parse({
    schema: "bakery.verify-backend/v1",
    startedAt,
    outcome: failed ? "failed" : "passed",
    revision,
    toolchain,
    requestedSteps: parsed.lanes,
    steps,
  });
  const manifestPath = parsed.out ??
    options.root + "/.scratch/verify-backend/" + revision.gitSha.slice(0, 12) +
      "-" + startedAt.replaceAll(":", "") + ".json";
  const write = options.writeManifest ??
    (async (path: string, text: string) => {
      await Deno.mkdir(path.slice(0, path.lastIndexOf("/")) || ".", {
        recursive: true,
      });
      await Deno.writeTextFile(path, text);
    });
  await write(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  log("verify:backend: manifest " + manifestPath);
  if (failed) return { exitCode: 1, manifestPath, manifest };
  log("verify:backend: all " + steps.length + " steps passed");
  return { exitCode: 0, manifestPath, manifest };
}

const inheritRunner: VerifyBackendRunner = async (command, { cwd }) => {
  const [program, ...args] = command;
  const status = await new Deno.Command(program!, {
    args,
    cwd,
    stdin: "null",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  return status.code;
};

const pipedCapture: VerifyBackendCapture = async (command, { cwd }) => {
  const [program, ...args] = command;
  const output = await new Deno.Command(program!, {
    args,
    cwd,
    stdin: "null",
    stdout: "piped",
    stderr: "null",
  }).output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
  };
};

if (import.meta.main) {
  const result = await runVerifyBackend({
    root: new URL("..", import.meta.url).pathname.replace(/\/$/, ""),
    args: Deno.args,
    environment: Deno.env.toObject(),
    runner: inheritRunner,
    capture: pipedCapture,
  });
  Deno.exit(result.exitCode);
}
