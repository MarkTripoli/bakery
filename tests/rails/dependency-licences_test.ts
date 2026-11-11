import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  checkReport,
  type Entry,
  loadPolicy,
  loadReport,
  type Locked,
  type Policy,
  type Report,
  summarize,
} from "../../scripts/licences/audit.ts";

const root = decodeURIComponent(new URL("../../", import.meta.url).pathname);

const emailPattern =
  /(?<![@\w/.-])[\w.+-]+@[\w-]+(\.[\w-]+)*\.[A-Za-z]{2,}(?![\w./-])/;

const basePolicy: Policy = {
  allow: ["MIT"],
  exceptions: [],
  pendingOwnerDecision: [],
  families: [],
  npmOverrides: [],
  jsrOverrides: [],
};

const entry = (
  name: string,
  licence: string,
  status: Entry["status"],
  version = "1.0.0",
): Entry => ({
  ecosystem: "pnpm",
  name,
  version,
  licence,
  resolution: "package.json",
  status,
});

const reportOf = (entries: Entry[]): Report => ({
  format: "bakery-dependency-licences/1",
  lockfileSha256: {
    "pnpm-lock.yaml": "0".repeat(64),
    "deno.lock": "0".repeat(64),
  },
  summary: summarize(entries),
  entries,
});

const lockedOf = (entries: Entry[]): Locked[] =>
  entries.map(({ ecosystem, name, version }) => ({ ecosystem, name, version }));

const gate = (entries: Entry[], policy: Policy, extra: Locked[] = []) =>
  checkReport({
    report: reportOf(entries),
    locked: [...lockedOf(entries), ...extra],
    policy,
    rescan: null,
  });

Deno.test("committed report passes the offline gate (set parity and policy)", async () => {
  const lockText = await Deno.readTextFile(`${root}pnpm-lock.yaml`);
  const denoText = await Deno.readTextFile(`${root}deno.lock`);
  const { parseDenoLock, parsePnpmLock } = await import(
    "../../scripts/licences/audit.ts"
  );
  const result = checkReport({
    report: await loadReport(),
    locked: [...parsePnpmLock(lockText), ...parseDenoLock(denoText)],
    policy: await loadPolicy(),
    rescan: null,
  });
  assertEquals(result.failures, []);
  assert(result.ok);
  // Job log says plainly that the re-scan did not run here.
  assertStringIncludes(result.notes.join("\n"), "re-scan skipped");
});

Deno.test("report holds no home path, absolute path or email address", async () => {
  const report = await loadReport();
  const text = JSON.stringify(report);
  assert(!text.includes("/home/"), "report contains /home/");
  const strings: Array<{ key: string; value: string }> = [];
  const walk = (value: unknown, key: string) => {
    if (typeof value === "string") strings.push({ key, value });
    else if (Array.isArray(value)) value.forEach((item) => walk(item, key));
    else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) walk(v, k);
    }
  };
  walk(report, "");
  for (const { key, value } of strings) {
    assert(
      !/^\/|^[A-Za-z]:\\|\/(home|Users|root)\//.test(value),
      `absolute path in ${key}: ${value}`,
    );
    if (key === "name" || key === "version" || key === "licence") continue;
    assert(!emailPattern.test(value), `email-like value in ${key}: ${value}`);
  }
  for (const item of report.entries) {
    assert(
      !emailPattern.test(item.licence),
      `email in licence of ${item.name}`,
    );
  }
});

Deno.test("email pattern ignores package specs but catches addresses", () => {
  assert(!emailPattern.test("@scope/name@1.2.3"));
  assert(!emailPattern.test("name@1.2.3"));
  assert(emailPattern.test("a@b.example"));
});

Deno.test("allowed entry passes silently", () => {
  const result = gate([entry("ok", "MIT", "allowed")], basePolicy);
  assert(result.ok);
  assertEquals(result.pending, []);
});

Deno.test("OR passes with one allowed option, AND needs every term", () => {
  assert(gate([entry("a", "(MIT OR GPL-3.0-only)", "allowed")], basePolicy).ok);
  assert(
    !gate([entry("b", "(MIT AND GPL-3.0-only)", "allowed")], basePolicy).ok,
  );
});

Deno.test("exception entry passes silently", () => {
  const policy: Policy = {
    ...basePolicy,
    exceptions: [{
      name: "ex",
      versions: ["1.0.0"],
      licence: "MPL-2.0",
      reason: "owner approved",
    }],
  };
  const result = gate([entry("ex", "MPL-2.0", "exception")], policy);
  assert(result.ok);
  assertEquals(result.pending, []);
});

Deno.test("pendingOwnerDecision entry passes and is printed", () => {
  const policy: Policy = {
    ...basePolicy,
    pendingOwnerDecision: [{
      name: "pend",
      versions: ["1.0.0"],
      licence: "MPL-2.0",
      reason: "used unmodified",
    }],
  };
  const result = gate(
    [entry("pend", "MPL-2.0", "pendingOwnerDecision")],
    policy,
  );
  assert(result.ok);
  assertEquals(result.pending, [
    "PENDING OWNER DECISION: pend@1.0.0 MPL-2.0 (used unmodified)",
  ]);
});

Deno.test("unlisted non-allowed licence fails and names policy.json", () => {
  const result = gate([entry("bad", "GPL-3.0-only", "unresolved")], basePolicy);
  assert(!result.ok);
  assertStringIncludes(result.failures.join("\n"), "policy.json");
});

Deno.test("a different version of a pending package is not covered", () => {
  const policy: Policy = {
    ...basePolicy,
    pendingOwnerDecision: [{
      name: "pend",
      versions: ["1.0.0"],
      licence: "MPL-2.0",
      reason: "used unmodified",
    }],
  };
  const result = gate(
    [entry("pend", "MPL-2.0", "unresolved", "2.0.0")],
    policy,
  );
  assert(!result.ok);
});

Deno.test("extra lockfile name@version fails and names pnpm licences:audit", () => {
  const result = gate([entry("ok", "MIT", "allowed")], basePolicy, [
    { ecosystem: "pnpm", name: "new-dep", version: "9.9.9" },
  ]);
  assert(!result.ok);
  assertStringIncludes(result.failures.join("\n"), "pnpm licences:audit");
  assertStringIncludes(result.failures.join("\n"), "new-dep@9.9.9");
});

Deno.test("same name@version set with different lockfile bytes passes", async () => {
  const { parsePnpmLock } = await import("../../scripts/licences/audit.ts");
  const text = await Deno.readTextFile(`${root}pnpm-lock.yaml`);
  const changed = text.replace(
    "lockfileVersion: '9.0'",
    "lockfileVersion: '9.0'\n# bytes differ, name@version set does not",
  );
  assert(changed !== text);
  assertEquals(parsePnpmLock(changed), parsePnpmLock(text));
});

Deno.test("a package key that does not parse fails instead of being skipped", async () => {
  const { parsePnpmLock } = await import("../../scripts/licences/audit.ts");
  const lock = [
    "lockfileVersion: '9.0'",
    "",
    "packages:",
    "",
    "  'left-pad@1.3.0':",
    "    resolution: {integrity: sha512-x}",
    "",
    "  'odd@https://example.test/odd.tgz':",
    "    resolution: {tarball: https://example.test/odd.tgz}",
    "",
    "snapshots:",
    "",
  ].join("\n");
  let message = "";
  try {
    parsePnpmLock(lock);
  } catch (error) {
    message = String(error);
  }
  assertStringIncludes(message, "unparsable package key");
});
