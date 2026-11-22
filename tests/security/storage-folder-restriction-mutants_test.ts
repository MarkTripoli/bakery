/**
 * #449: mutation checks for the folder access rules. The rules decide who can
 * see a restricted folder, so a quiet bug in them is a leak. Each mutant is a
 * copy of folder-access.ts with one deliberate bug; the checks below must
 * catch every one, and must pass on the real file. A mutant that survives
 * means a check stopped guarding something.
 */

import { assertEquals } from "@std/assert";

const ROOT = new URL(
  "../../apps/server/src/modules/knowledge/",
  import.meta.url,
);

type Rules =
  typeof import("../../apps/server/src/modules/knowledge/folder-access.ts");

const node = (
  id: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  policy: "working",
  systemKey: null,
  restricted: false,
  ...extra,
});
const grant = (folderId: string, principalId: string, level: string) => ({
  folderId,
  principalId,
  level,
});

/** The names of the guarantees this build of the rules breaks. */
function broken(rules: Rules): string[] {
  const failures: string[] = [];
  const check = (name: string, ok: () => boolean) => {
    try {
      if (!ok()) failures.push(name);
    } catch {
      failures.push(name);
    }
  };
  const access = (
    chain: unknown[],
    grants: unknown[],
    who: string,
    admin = false,
  ) => rules.folderAccess(chain as never, grants as never, who, admin);

  check("a restricted folder is hidden from a member with no grant", () => {
    const a = access(
      [node("s"), node("r", { restricted: true })],
      [grant("s", "bob", "manage")],
      "bob",
    );
    return !rules.mayView(a) && !rules.mayEdit(a);
  });
  check("the nearest restriction cuts off a grant above it", () => {
    const a = access(
      [
        node("s"),
        node("outer", { restricted: true }),
        node("inner", { restricted: true }),
        node("leaf"),
      ],
      [grant("outer", "bob", "manage")],
      "bob",
    );
    return a.level === null && !rules.mayView(a);
  });
  check("a grant on the restricted folder reaches its children", () => {
    const a = access(
      [node("r", { restricted: true }), node("c")],
      [grant("r", "bob", "view")],
      "bob",
    );
    return a.level === "view" && rules.mayView(a);
  });
  check("a grant elsewhere does not open a restricted folder", () => {
    const a = access(
      [node("s"), node("r", { restricted: true })],
      [grant("other", "bob", "manage")],
      "bob",
    );
    return a.level === null;
  });
  check("another person's grant does not count", () => {
    const a = access(
      [node("r", { restricted: true })],
      [grant("r", "alice", "manage")],
      "bob",
    );
    return a.level === null;
  });
  check("view cannot write", () => {
    const a = access(
      [node("r", { restricted: true })],
      [grant("r", "bob", "view")],
      "bob",
    );
    return !rules.mayEdit(a) && !rules.mayManage(a, true);
  });
  check("edit cannot manage", () => {
    const a = access(
      [node("r", { restricted: true })],
      [grant("r", "bob", "edit")],
      "bob",
    );
    return rules.mayEdit(a) && !rules.mayManage(a, true);
  });
  check("an unrestricted folder is untouched", () => {
    const a = access([node("s"), node("c")], [], "bob");
    return !a.restricted && rules.mayView(a) && rules.mayEdit(a);
  });
  check(
    "personal and record areas take no grants",
    () =>
      rules.grantRefusal([node("u", { policy: "personal" })] as never) !==
        undefined &&
      rules.grantRefusal([node("p", { policy: "record" })] as never) !==
        undefined &&
      rules.grantRefusal([
          node("t", { policy: "record", systemKey: "task:1" }),
          node("a", { systemKey: "task:1:attachments" }),
        ] as never) === "artifact_area",
  );
  return failures;
}

const MUTANTS: readonly {
  name: string;
  from: string;
  to: string;
}[] = [
  {
    name: "restriction ignored",
    from: "if (node.restricted) cut = index;",
    to: "if (false as boolean) cut = index;",
  },
  {
    name: "outermost restriction instead of the nearest",
    from: "if (node.restricted) cut = index;",
    to: "if (node.restricted && cut < 0) cut = index;",
  },
  {
    name: "every grant counts, wherever it is",
    from: "!inside.has(grant.folderId)",
    to: "false",
  },
  {
    name: "any member's grant counts",
    from: "grant.principalId !== principalId ||",
    to: "false ||",
  },
  {
    name: "a restricted folder is visible to everyone",
    from: "return !access.restricted || access.level !== null;",
    to: "return true;",
  },
  {
    name: "view may write",
    from: "(access.level !== null && RANK[access.level] >= RANK.edit)",
    to: "access.level !== null",
  },
  {
    name: "edit may manage",
    from: "return access.level !== null && RANK[access.level] >= RANK.manage;",
    to: "return access.level !== null && RANK[access.level] >= RANK.edit;",
  },
  {
    name: "personal folders take grants",
    from:
      'if (!folder || folder.policy !== "working") return "not_a_working_area";',
    to: 'if (!folder) return "not_a_working_area";',
  },
];

async function load(source: string): Promise<Rules> {
  const dir = await Deno.makeTempDir({ prefix: "bakery-mutant-" });
  try {
    const file = `${dir}/folder-access.ts`;
    await Deno.writeTextFile(file, source);
    return await import(`file://${file}`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("the access rules pass every guarantee as written", async () => {
  const rules = await load(
    await Deno.readTextFile(new URL("folder-access.ts", ROOT)),
  );
  assertEquals(broken(rules), []);
});

for (const mutant of MUTANTS) {
  Deno.test(`mutant is caught: ${mutant.name}`, async () => {
    const source = await Deno.readTextFile(new URL("folder-access.ts", ROOT));
    assertEquals(
      source.includes(mutant.from),
      true,
      `the mutation target is gone from folder-access.ts: ${mutant.from}`,
    );
    const rules = await load(source.replace(mutant.from, mutant.to));
    const caught = broken(rules);
    assertEquals(
      caught.length > 0,
      true,
      `the mutant "${mutant.name}" survived: no guarantee failed`,
    );
  });
}

Deno.test("the store answers 'not found', never a refusal, once the view check fails", async () => {
  // The refusal that would confirm a path must not exist on this branch: after
  // a failed view check each entry point says "not found" and nothing else.
  for (const file of ["storage-working-areas.ts", "storage-reads.ts"]) {
    const source = await Deno.readTextFile(new URL(file, ROOT));
    const checks = [...source.matchAll(/!\(\s*await mayViewAt\(/g)];
    assertEquals(checks.length > 0, true, `${file} no longer checks mayViewAt`);
    for (const check of checks) {
      const after = source.slice(check.index, check.index + 260);
      const answer = /notFound\(\);|return undefined;|refuse\(|conflict\(/
        .exec(after)?.[0];
      assertEquals(
        answer === "notFound();" || answer === "return undefined;",
        true,
        `${file}: a failed view check must answer not found, not ${answer}`,
      );
    }
  }
});
