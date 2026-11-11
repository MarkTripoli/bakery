export type EvidenceInput = {
  readonly lane: string;
  readonly command: string;
  readonly testCases: string;
  readonly status: string;
  readonly candidate: string;
  readonly base: string;
  readonly workflow: string;
  readonly runId: string;
  readonly runAttempt: string;
  readonly artifacts: string;
};

export function evidenceInputFrom(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): EvidenceInput | null {
  const [lane, command, testCases, artifactPaths] = args;
  const input: EvidenceInput = {
    lane,
    command,
    testCases,
    status: environment.JOB_STATUS ?? "failure",
    candidate: environment.CANDIDATE_SHA ?? "",
    base: environment.BASE_SHA ?? "",
    workflow: environment.WORKFLOW_SHA ?? "",
    runId: environment.RUN_ID ?? "",
    runAttempt: environment.RUN_ATTEMPT ?? "",
    artifacts: artifactPaths ?? "none",
  };
  return Object.values(input).some((value) => !value) ? null : input;
}

/**
 * Declares `path:sha256` for every artifact path (`path:missing` when absent).
 * With `handOffDir`, each present artifact is also copied to
 * `${handOffDir}/${path}` so the aggregate can hash the exact bytes declared
 * here after downloading the run artifact.
 */
export async function digestArtifacts(
  paths: readonly string[],
  handOffDir?: string,
): Promise<string> {
  const entries = await Promise.all(paths.map(async (path) => {
    const bytes = await Deno.readFile(path).catch(() => null);
    if (!bytes) return `${path}:missing`;
    if (handOffDir) {
      const target = `${handOffDir}/${path}`;
      await Deno.mkdir(target.slice(0, target.lastIndexOf("/")), {
        recursive: true,
      });
      await Deno.writeFile(target, bytes);
    }
    const digest = await crypto.subtle.digest("SHA-256", bytes.slice());
    const hex = Array.from(new Uint8Array(digest)).map((byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("");
    return `${path}:${hex}`;
  }));
  return entries.join(",");
}

export async function writeEvidence(
  input: EvidenceInput,
  directory = "evidence",
): Promise<void> {
  const exitCode = input.status === "success" ? "0" : "1";
  await Deno.mkdir(directory, { recursive: true });
  await Deno.writeTextFile(
    `${directory}/${input.lane}.txt`,
    [
      `lane=${input.lane}`,
      `candidate_sha=${input.candidate}`,
      `base_sha=${input.base}`,
      `workflow_sha=${input.workflow}`,
      `run_id=${input.runId}`,
      `run_attempt=${input.runAttempt}`,
      "dependencies=deno:2.9.1,node:22.22.0,pnpm:10.33.0",
      `command=${input.command}`,
      `exit_code=${exitCode}`,
      `test_cases=${input.testCases}`,
      "coverage=not-collected",
      `artifacts=${input.artifacts}`,
      "redacted=true",
      "",
    ].join("\n"),
  );
}

if (import.meta.main) {
  const input = evidenceInputFrom(Deno.args, Deno.env.toObject());
  if (!input) {
    console.error(
      "Evidence requires lane, command, test cases, candidate SHA, base SHA, workflow SHA, run ID, and run attempt",
    );
    Deno.exit(2);
  }
  const artifactPaths = Deno.args[3];
  const finalInput = artifactPaths
    ? {
      ...input,
      artifacts: await digestArtifacts(
        artifactPaths.split(","),
        Deno.env.get("ARTIFACT_DIR"),
      ),
    }
    : input;
  await writeEvidence(finalInput, Deno.env.get("EVIDENCE_DIR"));
}
