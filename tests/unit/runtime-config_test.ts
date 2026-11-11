import { assertEquals, assertThrows } from "@std/assert";
import { readSkillFileRootConfig } from "@bakery/config";

const safeDirectory = {
  isDirectory: true,
  isSymlink: false,
  mode: 0o40700,
  uid: 1000,
};

Deno.test("skill file root is optional and accepts a private owned Linux directory", () => {
  assertEquals(readSkillFileRootConfig(undefined), undefined);
  assertEquals(
    readSkillFileRootConfig("/srv/bakery/skills", {
      platform: "linux",
      uid: 1000,
      lstat: () => safeDirectory,
    }),
    { root: "/srv/bakery/skills" },
  );
});

Deno.test("skill file root rejects malformed and unsupported paths", () => {
  for (
    const root of ["relative/root", "/tmp/bad\u0000root", "/tmp/bad\u007froot"]
  ) {
    assertThrows(
      () =>
        readSkillFileRootConfig(root, {
          platform: "linux",
          uid: 1000,
          lstat: () => safeDirectory,
        }),
      Error,
      "SKILL_FILE_ROOT_INVALID",
    );
  }
  assertThrows(
    () =>
      readSkillFileRootConfig("/srv/bakery/skills", {
        platform: "darwin",
        uid: 1000,
        lstat: () => safeDirectory,
      }),
    Error,
    "SKILL_FILE_STORE_UNSUPPORTED",
  );
});

Deno.test("skill file root rejects links, foreign owners, and unsafe modes", () => {
  for (
    const stat of [
      { ...safeDirectory, isDirectory: false },
      { ...safeDirectory, isSymlink: true },
      { ...safeDirectory, uid: 1001 },
      { ...safeDirectory, mode: 0o40750 },
    ]
  ) {
    assertThrows(
      () =>
        readSkillFileRootConfig("/srv/bakery/skills", {
          platform: "linux",
          uid: 1000,
          lstat: () => stat,
        }),
      Error,
      "SKILL_FILE_ROOT_UNSAFE",
    );
  }
});
