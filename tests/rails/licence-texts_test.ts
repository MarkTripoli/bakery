import { assert, assertEquals } from "@std/assert";

const root = decodeURIComponent(new URL("../../", import.meta.url).pathname);

const apacheSha256 =
  "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30";

const sha256Hex = async (path: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await Deno.readFile(path),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
};

const exists = async (path: string): Promise<boolean> => {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
};

Deno.test("root LICENSE is the verbatim Apache-2.0 text", async () => {
  assertEquals(await sha256Hex(`${root}LICENSE`), apacheSha256);
});

Deno.test("the repository carries one licence file", async () => {
  for (const path of ["LICENSE.md", "COPYING", "LICENCE"]) {
    assert(!await exists(`${root}${path}`), `${path} must not exist`);
  }
});

Deno.test("NOTICE names the root licence", async () => {
  const notice = await Deno.readTextFile(`${root}NOTICE`);
  assert(notice.includes('"LICENSE"'), "NOTICE must name the root LICENSE");
  assert(notice.includes("Apache License, Version 2.0"));
  assert(
    !notice.includes("Elastic"),
    "NOTICE must not name the Elastic licence",
  );
});
