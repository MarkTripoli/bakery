import { assertEquals } from "@std/assert";
import { verificationLockPath } from "../../scripts/evidence/prove-m1.ts";

// The orchestrator's lock was /run/user/1000/..., which exists for one user only.

const none = () => false;
const exists = (path: string) => path === "/run/user/2003";

Deno.test("an explicit lock path wins over everything", () => {
  assertEquals(
    verificationLockPath(
      {
        BAKERY_VERIFICATION_LOCK: "/srv/locks/proof.lock",
        XDG_RUNTIME_DIR: "/run/user/2003",
      },
      2003,
      exists,
    ),
    "/srv/locks/proof.lock",
  );
});

Deno.test("the lock goes in the user's runtime directory, with a trailing slash ignored", () => {
  assertEquals(
    verificationLockPath({ XDG_RUNTIME_DIR: "/run/user/2003/" }, 2003, none),
    "/run/user/2003/bakery-verification.lock",
  );
});

Deno.test("without a runtime directory variable it uses /run/user/<uid> when that exists", () => {
  assertEquals(
    verificationLockPath({}, 2003, exists),
    "/run/user/2003/bakery-verification.lock",
  );
  assertEquals(
    verificationLockPath({ XDG_RUNTIME_DIR: "  " }, 2003, exists),
    "/run/user/2003/bakery-verification.lock",
  );
});

Deno.test("with no runtime directory at all it falls back to the temporary directory", () => {
  assertEquals(
    verificationLockPath({}, 2003, none),
    "/tmp/bakery-verification.lock",
  );
  assertEquals(
    verificationLockPath({ TMPDIR: "/var/tmp/" }, null, none),
    "/var/tmp/bakery-verification.lock",
  );
});

Deno.test("another user's id never produces the path of user 1000", () => {
  for (const uid of [0, 1001, 2003]) {
    const path = verificationLockPath(
      {},
      uid,
      (dir) => dir === `/run/user/${uid}`,
    );
    assertEquals(path.includes("/run/user/1000/"), false, String(uid));
  }
});
