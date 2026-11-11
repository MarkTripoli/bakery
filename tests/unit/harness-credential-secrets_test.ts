import { assert, assertEquals, assertFalse, assertRejects } from "@std/assert";
import { join } from "node:path";
import { harnessCredentialSecrets } from "../../apps/worker/src/harness-common.ts";

const TOKEN_A = "sk-ant-oat01-SYNTHETIC-aaaaaaaaaaaaaaaaaaaa";
const TOKEN_B = "sk-ant-ort01-SYNTHETIC-bbbbbbbbbbbbbbbbbbbb";

async function withDirectory(
  body: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await Deno.makeTempDir({
    prefix: "bakery-credential-secrets-",
  });
  try {
    await body(directory);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}

Deno.test("a missing credential file yields no secrets and does not throw (#430)", async () => {
  await withDirectory(async (directory) => {
    assertEquals(
      await harnessCredentialSecrets(join(directory, "absent.json")),
      [],
    );
  });
});

Deno.test("nested tokens are collected; short, whitespace and non-string values are skipped (#430)", async () => {
  await withDirectory(async (directory) => {
    const file = join(directory, "creds.json");
    await Deno.writeTextFile(
      file,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: TOKEN_A,
          refreshToken: TOKEN_B,
          expiresAt: 1760000000000,
          scopes: [
            "user:inference",
            "a-scope-name-that-is-long-but has spaces",
          ],
          subscriptionType: "max",
        },
        mcpOAuth: { server: { accessToken: TOKEN_A } },
        note: "fifteen chars!!",
        flag: true,
      }),
    );
    const secrets = await harnessCredentialSecrets(file);
    assertEquals([...secrets].sort(), [TOKEN_A, TOKEN_B].sort());
  });
});

Deno.test("an unreadable credential file fails closed without leaking a value (#430)", async () => {
  await withDirectory(async (directory) => {
    const real = join(directory, "real.json");
    await Deno.writeTextFile(real, JSON.stringify({ token: TOKEN_A }));
    const cases: Array<[string, () => Promise<string>]> = [
      ["symlink", async () => {
        const link = join(directory, "link.json");
        await Deno.symlink(real, link);
        return link;
      }],
      ["directory", async () => {
        const dir = join(directory, "dir.json");
        await Deno.mkdir(dir);
        return dir;
      }],
      ["oversized", async () => {
        const big = join(directory, "big.json");
        await Deno.writeTextFile(
          big,
          JSON.stringify({ token: TOKEN_A, pad: "p".repeat(70 * 1024) }),
        );
        return big;
      }],
      ["malformed", async () => {
        const bad = join(directory, "bad.json");
        await Deno.writeTextFile(bad, `not json ${TOKEN_A}`);
        return bad;
      }],
      ["too deep", async () => {
        const deep = join(directory, "deep.json");
        await Deno.writeTextFile(
          deep,
          JSON.stringify({
            a: { b: { c: { d: { e: { f: { t: TOKEN_A } } } } } },
          }),
        );
        return deep;
      }],
      ["too many leaves", async () => {
        const many = join(directory, "many.json");
        await Deno.writeTextFile(
          many,
          JSON.stringify({
            token: TOKEN_A,
            rest: Array.from({ length: 70 }, (_, i) => `v${i}`),
          }),
        );
        return many;
      }],
    ];
    for (const [label, make] of cases) {
      const error = await assertRejects(
        async () => await harnessCredentialSecrets(await make()),
        Error,
        "HARNESS_CREDENTIAL_FILE_INVALID",
        label,
      );
      assertFalse(error.message.includes(TOKEN_A), `${label} leaked a value`);
    }
  });
});

Deno.test("more than 4 KiB of secrets fails closed (#430)", async () => {
  await withDirectory(async (directory) => {
    const file = join(directory, "creds.json");
    await Deno.writeTextFile(
      file,
      JSON.stringify({ a: "a".repeat(2_500), b: "b".repeat(2_500) }),
    );
    const error = await assertRejects(
      async () => await harnessCredentialSecrets(file),
      Error,
      "HARNESS_CREDENTIAL_SECRETS_TOO_LARGE",
    );
    assert(!error.message.includes("aaaa"));
  });
});
