import { assert, assertEquals } from "@std/assert";

/**
 * The write paths in the plugin-install store must read the install row with a
 * locking read.
 *
 * Why a source rail rather than a behavioural test: the decision these paths
 * make -- keep the status or change it, and whether to re-derive grants -- is
 * taken from the row between the read and the UPDATE. That window cannot be
 * observed from outside the function, and probing the row after the function
 * returns proves nothing, because the UPDATE takes the row lock itself. A
 * `build()`/`resume()` pairing cannot detect it, and adding a production seam
 * only to make a test possible would be a worse trade than pinning the mechanism
 * here and saying so.
 *
 * So this rail asserts what is actually true and checkable: the read on a write
 * path passes `forUpdate`, and the read-only paths do not. It is not evidence
 * that the lock prevents a lost update at runtime; it is evidence that the code
 * still asks for the lock, which is the thing a refactor would quietly drop.
 */

const store = new URL(
  "../../apps/server/src/modules/catalog/plugin-install-postgres.ts",
  import.meta.url,
).pathname;

/**
 * The exported functions that write, and therefore must take the lock, paired
 * with the ones that only read.
 */
const WRITE_PATHS = ["updatePluginInstall", "putPluginState"] as const;
const READ_PATHS = [
  "getPluginInstall",
  "listPluginInstalls",
  "listPluginState",
] as const;

/** The body of one exported async function, up to the next top-level export. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  assert(start >= 0, `${name} must exist`);
  const next = source.indexOf("\nexport ", start + 1);
  return next < 0 ? source.slice(start) : source.slice(start, next);
}

/** True when this function passes `forUpdate` as true to `loadInstall`. */
export function takesTheRowLock(body: string): boolean {
  return /loadInstall\(\s*[^)]*\{\s*forUpdate:\s*true\s*,?\s*\}\s*,?\s*\)/s
    .test(body);
}

Deno.test("records of the install row: every write path takes the lock", async () => {
  const source = await Deno.readTextFile(store);
  for (const name of WRITE_PATHS) {
    assertEquals(
      takesTheRowLock(functionBody(source, name)),
      true,
      `${name} decides on the install row and must read it for update`,
    );
  }
});

Deno.test("records of the install row: read paths do not take the lock", async () => {
  const source = await Deno.readTextFile(store);
  for (const name of READ_PATHS) {
    assertEquals(
      takesTheRowLock(functionBody(source, name)),
      false,
      `${name} only reads and must not take the row lock`,
    );
  }
});

Deno.test("records of the install row: the detector sees a removed lock", () => {
  // The rail is only worth its place if it fails when the lock goes away, so
  // the detector is exercised on both shapes rather than trusted.
  assertEquals(
    takesTheRowLock(`loadInstall(transaction, organizationId, installId, {
      forUpdate: true,
    })`),
    true,
  );
  assertEquals(
    takesTheRowLock(`loadInstall(transaction, organizationId, installId, {
      forUpdate: false,
    })`),
    false,
  );
  assertEquals(
    takesTheRowLock("loadInstall(transaction, organizationId, installId)"),
    false,
  );
});
