import { join } from "node:path";

const created: string[] = [];
let cleanupRegistered = false;

function registerCleanup(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  globalThis.addEventListener("unload", () => {
    for (const path of created) {
      try {
        Deno.removeSync(path, { recursive: true });
      } catch {
        // Already removed by the test.
      }
    }
  });
}

/**
 * Creates a synthetic harness credential source directory holding one auth
 * file (`auth.json` for Codex and Pi, `.credentials.json` for Claude) and
 * returns its path. Removed when the test process exits. The bytes are
 * synthetic; a test may pass its own to track a secret.
 */
export function syntheticAuthSource(
  file: "auth.json" | ".credentials.json",
  contents = `{"synthetic-auth":"${crypto.randomUUID()}"}`,
): string {
  registerCleanup();
  const dir = Deno.makeTempDirSync({ prefix: "bakery-synthetic-auth-" });
  created.push(dir);
  Deno.chmodSync(dir, 0o700);
  Deno.writeTextFileSync(join(dir, file), contents);
  return dir;
}

/**
 * Shell prelude every fake `claude` starts with: the adapter probes
 * `claude --version` before it resumes or runs anything.
 */
export const FAKE_CLAUDE_VERSION_PRELUDE =
  `if [ "\${1:-}" = "--version" ]; then echo '2.1.0 (Claude Code)'; exit 0; fi`;

/** Synthetic Claude OAuth credentials (valid JSON, like the real file). */
export const SYNTHETIC_CLAUDE_CREDENTIALS = JSON.stringify({
  claudeAiOauth: {
    accessToken: "sk-ant-oat01-SYNTHETIC-access-0123456789abcdef",
    refreshToken: "sk-ant-ort01-SYNTHETIC-refresh-0123456789abcdef",
    expiresAt: 1,
    scopes: ["user:inference"],
  },
});

/** Synthetic Pi `auth.json` (valid JSON, like the real file). */
export const SYNTHETIC_PI_AUTH = JSON.stringify({
  anthropic: {
    type: "oauth",
    access: "pi-SYNTHETIC-access-0123456789abcdef",
    refresh: "pi-SYNTHETIC-refresh-0123456789abcdef",
  },
});
