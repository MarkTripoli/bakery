/**
 * #50 AC1/AC2: one complete headless factory scenario on one real stack. The
 * scenario itself is the child (it needs a delegated cgroup for the production
 * worker, so it runs inside its own systemd scope, as the fixed coding preset
 * journey does). This parent relays the child's output and fails unless the
 * child printed every required case, in order (tests/helpers/full-acceptance/cases.ts).
 */
import { assertEquals } from "@std/assert";
import {
  assertFullAcceptanceCases,
  parseFullAcceptanceCases,
} from "../helpers/full-acceptance/cases.ts";

const CHILD_TIMEOUT_MS = 2_400_000;
const CHILD_KILL_GRACE_MS = 5_000;
const SCRIPTED_COORDINATOR_DIR =
  "/workspace/tests/fixtures/scripted-coordinator";
const SECRETS_KEY_FILE = "/workspace/tests/fixtures/secret-identity-key.bin";
const SECRETS_KEY_ID = "ticket-e2e-key-v1";

/** Streams a child pipe to this process's stdout and keeps a copy. */
async function relay(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) {
    await Deno.stdout.write(chunk);
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

Deno.test(
  "a fresh checkout delivers through REST, MCP, a worker, a question, a signed GitHub event and forced restarts, exactly once (#50)",
  async () => {
    const temporaryDirectory = Deno.env.get("TMPDIR")?.trim() || "/tmp";
    const dockerHost = Deno.env.get("DOCKER_HOST")?.trim();
    const childPath = new URL(
      "./prove-full-headless-factory-delivery-and-recovery-from-a-fresh-checkout.child.ts",
      import.meta.url,
    ).pathname;
    const ownerUnit = `bakery-full-acceptance-${crypto.randomUUID()}.scope`;
    const child = new Deno.Command("systemd-run", {
      args: [
        "--user",
        "--scope",
        "--quiet",
        "--property=Delegate=yes",
        `--unit=${ownerUnit}`,
        ...(dockerHost ? [`--setenv=DOCKER_HOST=${dockerHost}`] : []),
        `--setenv=BAKERY_E2E_OWNER_UNIT=${ownerUnit}`,
        // Read by the compose stack at boot, so every later restart keeps them.
        // The scripted coordinator is a test-only executor.
        "--setenv=BAKERY_ENV=test",
        `--setenv=BAKERY_SCRIPTED_COORDINATOR_DIR=${SCRIPTED_COORDINATOR_DIR}`,
        `--setenv=BAKERY_SECRETS_KEY_FILE=${SECRETS_KEY_FILE}`,
        `--setenv=BAKERY_SECRETS_KEY_ID=${SECRETS_KEY_ID}`,
        Deno.execPath(),
        "test",
        "--allow-read",
        "--allow-env",
        `--allow-write=${temporaryDirectory},tests/fixtures/scripted-coordinator`,
        "--allow-run",
        "--allow-net",
        "--allow-sys",
        childPath,
      ],
      stdout: "piped",
      stderr: "inherit",
    }).spawn();
    let killTimer: ReturnType<typeof setTimeout> | undefined;
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
      const [status, output] = await Promise.all([
        child.status,
        relay(child.stdout),
      ]);
      assertEquals(
        status.success,
        true,
        `FULL_ACCEPTANCE_CHILD_FAILED:${status.code}`,
      );
      assertFullAcceptanceCases(parseFullAcceptanceCases(output));
    } finally {
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
    }
  },
);
