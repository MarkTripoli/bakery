import {
  createSupervisorPhaseTracker,
  supervisorChildTimeoutMessage,
} from "../helpers/supervisor-e2e-phase.ts";

const CHILD_TIMEOUT_MS = 180_000;
const CHILD_KILL_GRACE_MS = 5_000;
type ChildTimer = number | NodeJS.Timeout;

type BoundedChildResult = {
  readonly success: boolean;
  readonly code: number;
  readonly timeout?: string;
};

async function runBoundedChild(
  command: Deno.Command,
): Promise<BoundedChildResult> {
  const child = command.spawn();
  const startedAt = performance.now();
  const phases = createSupervisorPhaseTracker();
  // The child's output still reaches this process's; the phase lines it prints
  // are remembered so a timeout can name where the child was.
  const forward = async (
    stream: ReadableStream<Uint8Array>,
    sink: WritableStream<Uint8Array>,
  ): Promise<void> => {
    const [forwarded, observed] = stream.tee();
    const decoder = new TextDecoder();
    await Promise.all([
      forwarded.pipeTo(sink, { preventClose: true }),
      (async () => {
        for await (const chunk of observed) {
          phases.push(decoder.decode(chunk, { stream: true }));
        }
      })(),
    ]);
  };
  let timeout: string | undefined;
  let killTimer: ChildTimer | undefined;
  const timeoutTimer = setTimeout(() => {
    timeout = supervisorChildTimeoutMessage(
      CHILD_TIMEOUT_MS,
      performance.now() - startedAt,
      phases.last(),
    );
    try {
      child.kill("SIGTERM");
    } catch {
      // The child may have exited between the timer and kill.
    }
    killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The child may have exited after the graceful kill.
      }
    }, CHILD_KILL_GRACE_MS);
  }, CHILD_TIMEOUT_MS);
  try {
    const [status] = await Promise.all([
      child.status,
      forward(child.stdout, Deno.stdout.writable),
      forward(child.stderr, Deno.stderr.writable),
    ]);
    return { success: status.success, code: status.code, timeout };
  } finally {
    clearTimeout(timeoutTimer);
    clearTimeout(killTimer);
  }
}

async function fileDigest(path: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await Deno.readFile(path),
  );
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

Deno.test("permissioned child runs the persisted public supervisor e2e", async () => {
  const lockBefore = await fileDigest("deno.lock");
  const testPath = new URL(
    "./supervisor-real-stack.child.ts",
    import.meta.url,
  ).pathname;
  const temporaryDirectory = Deno.env.get("TMPDIR") ??
    Deno.env.get("TMP") ??
    Deno.env.get("TEMP") ??
    "/tmp";
  const result = await runBoundedChild(
    new Deno.Command(Deno.execPath(), {
      args: [
        "test",
        "--frozen",
        "--allow-env",
        "--allow-net=127.0.0.1,localhost",
        `--allow-read=.,${temporaryDirectory}`,
        `--allow-write=${temporaryDirectory}`,
        "--allow-run=docker",
        testPath,
      ],
      env: { ...Deno.env.toObject(), TMPDIR: temporaryDirectory },
      stdout: "piped",
      stderr: "piped",
    }),
  );
  const lockAfter = await fileDigest("deno.lock");
  // Defense-in-depth: keep this guard if child invocation arguments regress.
  if (lockAfter !== lockBefore) {
    throw new Error(
      `DENO_LOCK_MUTATED:${lockBefore}:${lockAfter}`,
    );
  }
  if (!result.success) {
    throw new Error(
      result.timeout ?? `permissioned e2e child failed with ${result.code}`,
    );
  }
});
