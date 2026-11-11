import { assertEquals, assertStringIncludes } from "@std/assert";
import { workerRuntimeReadPaths } from "../../apps/worker/src/config.ts";
import {
  boundedNativeDiagnostic,
  NativeExecutorError,
  nativeSandboxArguments,
} from "../../apps/worker/src/executor.ts";

Deno.test("native executor diagnostic stays single-line printable and length-capped", () => {
  const raw = new TextEncoder().encode(
    `bwrap: setting up uid map: Permission denied\n\u0000\u001b[31m${
      "x".repeat(2000)
    }`,
  );
  const text = boundedNativeDiagnostic(raw);
  assertStringIncludes(text, "bwrap: setting up uid map: Permission denied");
  assertEquals(/[^\x20-\x7e]/.test(text), false);
  assertEquals(text.length <= 403, true);
  assertEquals(text.endsWith("..."), true);
});

Deno.test("native executor error keeps the stable code as message and carries bounded diagnostic", () => {
  const error = new NativeExecutorError(
    "NATIVE_SANDBOX_UNAVAILABLE",
    false,
    "bwrap exit=1: no permissions\ncreating new namespace",
  );
  assertEquals(error.message, "NATIVE_SANDBOX_UNAVAILABLE");
  assertEquals(
    error.diagnostic,
    "bwrap exit=1: no permissions creating new namespace",
  );
  assertEquals(
    new NativeExecutorError("NATIVE_SANDBOX_UNAVAILABLE").diagnostic,
    undefined,
  );
});

Deno.test("native sandbox creates every symlink target before mounting the loader under /lib64", () => {
  const args = nativeSandboxArguments({
    executable: "/usr/bin/true",
    args: [],
    runtimePaths: [{
      path: "/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2",
      target: "/lib64/ld-linux-x86-64.so.2",
      identity: "1:1",
      directory: false,
    }],
    readOnlyPaths: [],
    environment: {},
    forwardStdin: false,
  });
  const dirs = args.flatMap((arg, index) =>
    args[index - 1] === "--dir" ? [arg] : []
  );
  for (const target of ["/usr/bin", "/usr/lib", "/usr/lib64"]) {
    assertEquals(dirs.includes(target), true, target);
  }
  const symlinkIndex = args.indexOf("/lib64");
  const loaderBind = args.indexOf("/lib64/ld-linux-x86-64.so.2");
  assertEquals(symlinkIndex > -1 && loaderBind > symlinkIndex, true);
  assertEquals(args.lastIndexOf("/usr/lib64") < loaderBind, true);
});

Deno.test("worker launch read grants cover the merged-usr loader spellings ldd reports", () => {
  const reads = workerRuntimeReadPaths("/opt/deno/bin/deno");
  for (
    const path of [
      "/lib",
      "/lib64",
      "/usr/lib",
      "/usr/lib64",
      "/usr/bin/dash",
      "/usr/bin/gnutrue",
    ]
  ) {
    assertEquals(reads.includes(path), true, path);
  }
});
