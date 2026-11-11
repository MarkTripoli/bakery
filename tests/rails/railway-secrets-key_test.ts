import { assert, assertEquals, assertNotEquals } from "@std/assert";

const root = decodeURIComponent(new URL("../../", import.meta.url).pathname);
const script = `${root}infra/railway/secrets-key.sh`;

/**
 * Runs one materialise_secrets_key case inside bash. The rails lane has no
 * write permission, so bash makes and removes its own scratch directory under
 * $TMPDIR and reports facts on stdout; secrets never appear in the report.
 */
async function scenario(
  environment: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const body = `
set -u
exec 3>&1
dir="$(mktemp -d)"
trap 'rm -rf "$dir"' EXIT
source "${script}"
# A subshell, because a failing call exits the whole shell; the exported state
# is reported from inside it and only exists when the call returned.
(
  materialise_secrets_key "$dir/keys" > "$dir/out" 2> "$dir/err"
  echo "exported_file=\${BAKERY_SECRETS_KEY_FILE+set}" >&3
  echo "b64_after=\${BAKERY_SECRETS_KEY_B64+set}" >&3
)
code=$?
echo "code=$code"
echo "files=$(ls -A "$dir/keys" 2>/dev/null | wc -l)"
if [ -f "$dir/keys/secrets.key" ]; then
  echo "mode=$(stat -c %a "$dir/keys/secrets.key")"
  echo "size=$(stat -c %s "$dir/keys/secrets.key")"
  echo "dirmode=$(stat -c %a "$dir/keys")"
fi
echo "leak_out=$(grep -c -F -- "$LEAK" "$dir/out")"
echo "leak_err=$(grep -c -F -- "$LEAK" "$dir/err")"
echo "err=$(tr '\\n' ' ' < "$dir/err")"
`;
  const command = new Deno.Command("bash", {
    args: ["-c", body],
    clearEnv: true,
    env: {
      PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
      ...(Deno.env.get("TMPDIR") ? { TMPDIR: Deno.env.get("TMPDIR")! } : {}),
      LEAK: environment.BAKERY_SECRETS_KEY_B64 ?? "no-leak-marker",
      ...environment,
    },
  });
  const { code, stdout, stderr } = await command.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

const fact = (stdout: string, name: string): string | undefined =>
  stdout.split("\n").find((line) => line.startsWith(`${name}=`))?.slice(
    name.length + 1,
  );

const b64 = (bytes: number): string => {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return btoa(String.fromCharCode(...data));
};

Deno.test("a valid 32-byte key becomes a 0600 file and the variable is unset", async () => {
  const key = b64(32);
  const result = await scenario({
    BAKERY_SECRETS_KEY_B64: key,
    BAKERY_SECRETS_KEY_ID: "qa-key-1",
  });
  assertEquals(result.code, 0, result.stderr);
  assertEquals(fact(result.stdout, "code"), "0");
  assertEquals(fact(result.stdout, "mode"), "600");
  assertEquals(fact(result.stdout, "size"), "32");
  assertEquals(fact(result.stdout, "dirmode"), "700");
  assertEquals(fact(result.stdout, "files"), "1", "no staging file may remain");
  assertEquals(fact(result.stdout, "exported_file"), "set");
  assertEquals(fact(result.stdout, "b64_after"), "", "base64 must be unset");
  assert(!result.stdout.includes(key) && !result.stderr.includes(key));
});

Deno.test("wrong lengths and non-base64 exit 78 without leaving or echoing anything", async () => {
  for (
    const value of [b64(31), b64(33), "@@@not-base64@@@", btoa("short")]
  ) {
    const result = await scenario({
      BAKERY_SECRETS_KEY_B64: value,
      BAKERY_SECRETS_KEY_ID: "qa-key-1",
    });
    assertEquals(fact(result.stdout, "code"), "78", value.length.toString());
    assertEquals(fact(result.stdout, "files"), "0", "no file may be left");
    assertEquals(fact(result.stdout, "leak_out"), "0");
    assertEquals(fact(result.stdout, "leak_err"), "0");
    assert(fact(result.stdout, "err")?.includes("SECRETS_KEY_INVALID"));
    assert(!result.stdout.includes(value) && !result.stderr.includes(value));
  }
});

Deno.test("a missing or malformed key id fails even for a valid key", async () => {
  for (const id of [undefined, "", "bad id", "a/b"]) {
    const result = await scenario({
      BAKERY_SECRETS_KEY_B64: b64(32),
      ...(id === undefined ? {} : { BAKERY_SECRETS_KEY_ID: id }),
    });
    assertEquals(fact(result.stdout, "code"), "78", String(id));
    assertEquals(fact(result.stdout, "files"), "0");
  }
});

Deno.test("an unset or empty variable writes nothing and exports nothing", async () => {
  const cases: Record<string, string>[] = [{}, { BAKERY_SECRETS_KEY_B64: "" }];
  for (const environment of cases) {
    const result = await scenario({
      ...environment,
      BAKERY_SECRETS_KEY_ID: "qa-key-1",
    });
    assertEquals(fact(result.stdout, "code"), "0");
    assertEquals(fact(result.stdout, "files"), "0");
    assertEquals(fact(result.stdout, "exported_file"), "");
    assertNotEquals(fact(result.stdout, "exported_file"), "set");
  }
});
