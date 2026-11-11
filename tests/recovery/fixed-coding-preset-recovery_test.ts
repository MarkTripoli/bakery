import { assertEquals } from "@std/assert";

const CHILD_TIMEOUT_MS = 600_000;
const CHILD_KILL_GRACE_MS = 5_000;
type ChildTimer = number | NodeJS.Timeout;

async function runBounded(command: Deno.Command): Promise<Deno.CommandStatus> {
  const child = command.spawn();
  let killTimer: ChildTimer | undefined;
  const timeoutTimer = setTimeout(() => {
    try {
      child.kill("SIGTERM");
    } catch {
      // The delegated child already exited.
    }
    killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The delegated child exited during its cleanup grace.
      }
    }, CHILD_KILL_GRACE_MS);
  }, CHILD_TIMEOUT_MS);
  try {
    return await child.status;
  } finally {
    clearTimeout(timeoutTimer);
    clearTimeout(killTimer);
  }
}

Deno.test(
  "a killed worker held implement step is recovered once by the restarted worker",
  async () => {
    const dockerHost = Deno.env.get("DOCKER_HOST")?.trim();
    if (!dockerHost) throw new Error("DOCKER_HOST_REQUIRED");
    const temporaryDirectory = Deno.env.get("TMPDIR")?.trim() || "/tmp";
    const childPath = new URL(
      "./fixed-coding-preset-recovery.child.ts",
      import.meta.url,
    ).pathname;
    const ownerUnit = `bakery-preset-recovery-${crypto.randomUUID()}.scope`;
    const status = await runBounded(
      new Deno.Command("systemd-run", {
        args: [
          "--user",
          "--scope",
          "--quiet",
          "--property=Delegate=yes",
          `--unit=${ownerUnit}`,
          `--setenv=DOCKER_HOST=${dockerHost}`,
          `--setenv=BAKERY_E2E_OWNER_UNIT=${ownerUnit}`,
          Deno.execPath(),
          "test",
          "--allow-read",
          "--allow-env",
          `--allow-write=${temporaryDirectory}`,
          "--allow-run",
          "--allow-net",
          childPath,
        ],
        stdout: "inherit",
        stderr: "inherit",
      }),
    );
    assertEquals(
      status.success,
      true,
      `DELEGATED_FULL_STACK_FAILED:${status.code}`,
    );
  },
);
