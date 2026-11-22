import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";
import {
  LAUNCHER,
  startPointerHealth,
  withLauncherSandbox,
} from "../helpers/recovery-launcher-sandbox.ts";

/**
 * #50 AC3, security: the independent recovery launcher changes nothing without
 * the typed confirmation, never prints a secret in its diagnostic report, and
 * cannot be driven over HTTP. Its database reads run through the compose
 * stand-in against the real test database.
 */

const SECRETS = {
  OWNER_DATABASE_URL:
    "postgres://bakery_owner:owner-db-password-xyz@postgres:5432/bakery",
  REDIS_PASSWORD: "redis-password-shh-123",
  BAKERY_SECRETS_KEY: "secrets-key-0123456789abcdef",
  BETTER_AUTH_SECRET: "better-auth-secret-abcdefgh",
};

Deno.test("rollback and restore change nothing without the target's own name typed (#50 AC3)", async () => {
  await withLauncherSandbox(
    { healthUrl: "http://127.0.0.1:9/health/ready" },
    async (sandbox) => {
      const pointer = JSON.stringify({
        releaseId: "r",
        commitSha: "c".repeat(40),
        deploymentId: "d",
      });
      await Deno.writeTextFile(join(sandbox.target, "current.json"), pointer);
      const set = join(sandbox.dir, "sets", "20261122T000000Z-set");
      await Deno.mkdir(set, { recursive: true });
      const identity = join(sandbox.dir, "identity.txt");
      await Deno.writeTextFile(identity, "AGE-SECRET-KEY-FAKE\n");
      for (
        const [args, code] of [
          [["rollback"], 64],
          [["restore", set, identity], 64],
          [["restore", set, identity, "--confirm", "another-set"], 65],
          [["restore", set, identity, "--confirm", ""], 65],
        ] as const
      ) {
        const result = await sandbox.run([...args]);
        assertEquals(result.code, code, `${args.join(" ")}: ${result.stderr}`);
      }
      // A rollback with a wrong sha is refused before the pointer moves.
      const wrong = await sandbox.run([
        "rollback",
        "--confirm",
        "0".repeat(40),
      ]);
      assert(wrong.code === 65 || wrong.code === 69, `code ${wrong.code}`);
      const calls = await sandbox.calls();
      assertEquals(
        calls.filter((c) => !c.startsWith("docker")),
        [],
        "neither runtime.sh nor restore.sh ran",
      );
      assertEquals(
        await Deno.readTextFile(join(sandbox.target, "current.json")),
        pointer,
      );
    },
  );
});

Deno.test("the diagnostic report never carries a secret from the host env files or a URL password (#50 AC3)", async () => {
  await withLauncherSandbox(
    {
      healthUrl: "http://127.0.0.1:9/health/ready",
      infraEnv:
        Object.entries(SECRETS).map(([k, v]) => `${k}=${v}`).join("\n") + "\n",
      // A service listing that leaks every secret, as a misconfigured label would.
      composeExtra: JSON.stringify({
        Service: `leaky ${Object.values(SECRETS).join(" ")}`,
        State: "exited",
        Health:
          "postgres://someone:inline-pass-999@db/x AGE-SECRET-KEY-1ABCDEF",
      }),
    },
    async (sandbox) => {
      await Deno.writeTextFile(
        join(sandbox.etc, "owner.env"),
        `DATABASE_URL=${SECRETS.OWNER_DATABASE_URL}\n`,
      );
      const health = startPointerHealth(sandbox.target, new Set());
      try {
        const result = await sandbox.run(["diagnose"], {
          BAKERY_RECOVERY_HEALTH_URL: health.url,
        });
        assertEquals(result.code, 0, result.stderr);
        const report = JSON.parse(result.stdout);
        assertEquals(report.format, 1);
        for (
          const value of [
            ...Object.values(SECRETS),
            "infra-postgres-password-not-for-reports",
            "owner-db-password-xyz",
            "inline-pass-999",
            "AGE-SECRET-KEY-1ABCDEF",
          ]
        ) {
          assert(!result.stdout.includes(value), `the report printed ${value}`);
          assert(!result.stderr.includes(value), `stderr printed ${value}`);
        }
        assert(
          result.stdout.includes("[redacted]"),
          "the leaky listing was redacted, not dropped",
        );
      } finally {
        await health.stop();
      }
    },
  );
});

Deno.test("the launcher cannot be driven over HTTP: it refuses a CGI gateway and opens no listener (#50 AC3)", async () => {
  await withLauncherSandbox(
    { healthUrl: "http://127.0.0.1:9/health/ready" },
    async (sandbox) => {
      for (
        const env of <Record<string, string>[]> [{
          GATEWAY_INTERFACE: "CGI/1.1",
        }, {
          REQUEST_METHOD: "POST",
        }, { HTTP_HOST: "bakery.example" }]
      ) {
        const result = await sandbox.run(["diagnose"], env);
        assertEquals(result.code, 77);
        assert(result.stderr.includes("RECOVERY_LAUNCHER_REFUSES_HTTP"));
      }
      assertEquals(await sandbox.calls(), [], "nothing ran before the refusal");
    },
  );
  const source = await Deno.readTextFile(LAUNCHER);
  for (
    const listener of [
      "createServer",
      "Deno.serve",
      ".listen(",
      "nc -l",
      "socat",
      "--listen",
    ]
  ) {
    assert(
      !source.includes(listener),
      `the launcher must not open a listener (${listener})`,
    );
  }
  // Only a root terminal runs it outside the test sandbox.
  const outside = await new Deno.Command("bash", {
    args: [LAUNCHER, "diagnose"],
    clearEnv: true,
    env: {
      PATH: "/usr/bin:/bin",
      BAKERY_BACKUP_SANDBOX: "/nonexistent",
      BAKERY_ENV: "production",
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(outside.code, 64);
});
