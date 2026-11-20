import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  buildPrBody,
  carryVerification,
  exampleSpec,
  parseArgs,
  type PrBodySpec,
  setVerification,
  specErrors,
  type VerifyItem,
  verifyItems,
} from "../../scripts/authoring/pr-body.ts";
import { validateDescription } from "../../scripts/authoring/validate.ts";

const items = Object.keys(verifyItems) as VerifyItem[];
const spec = (change: Partial<PrBodySpec> = {}): PrBodySpec => ({
  ...structuredClone(exampleSpec),
  ...change,
});
const differing = (a: string, b: string): number => {
  const left = a.split("\n");
  const right = b.split("\n");
  return left.filter((line, index) => line !== right[index]).length +
    Math.abs(left.length - right.length);
};

Deno.test("the example spec renders a body the real validator accepts", () => {
  const built = buildPrBody(exampleSpec);
  assertEquals(built.errors, []);
  // Only the three open boxes are pending: ui is marked N/A in the example.
  assertEquals(built.pending.length, 3);
  assert(built.body.includes("Closes #123"));
});

Deno.test("a fully signed-off body passes with no errors at all", () => {
  let body = buildPrBody(exampleSpec).body;
  for (const item of items) {
    if (item === "ui") continue;
    body = setVerification(body, item, {
      state: "tick",
      sha: "0123abc",
      claim: "checked at head, no findings",
    });
  }
  assertEquals(validateDescription("pr", body), []);
});

Deno.test("each limit the validator enforces is reported by the build", () => {
  const long = Array.from({ length: 45 }, (_, i) => `word${i}`).join(" ");
  const cases: [Partial<PrBodySpec>, RegExp][] = [
    [{ purpose: long }, /purpose prose must be at most 40 words/],
    [
      { evidence: { items: ["lint and typecheck pass"] } },
      /drop routine checks/,
    ],
    [
      { notes: [long] },
      /each special things to note bullet/,
    ],
  ];
  for (const [change, expected] of cases) {
    const { errors } = buildPrBody(spec(change));
    assert(
      errors.some((error) => expected.test(error)),
      `expected ${expected} in ${JSON.stringify(errors)}`,
    );
  }
});

Deno.test("shape errors name the field to fix", () => {
  assertEquals(specErrors(exampleSpec), []);
  const broken = specErrors({
    ticket: 0,
    purpose: "",
    risk: { level: "Severe", bullets: [] },
    outline: {},
    notApplicable: { ui: "Not yet reviewed.", database: "x" },
  });
  for (
    const field of [
      "ticket:",
      "purpose:",
      "risk.level:",
      "risk.bullets:",
      "outline:",
      "notApplicable.ui:",
      "notApplicable.database:",
    ]
  ) {
    assert(broken.some((error) => error.startsWith(field)), field);
  }
  assertEquals(buildPrBody({ ticket: 0 }).body, "");
});

Deno.test("five images are refused before any body is built", () => {
  const images = Array.from({ length: 5 }, (_, i) => ({
    alt: `state ${i}`,
    url: `https://example.test/${i}.png`,
  }));
  const { errors } = buildPrBody(spec({ evidence: { images } }));
  assert(errors.some((error) => error.includes("at most four")));
});

Deno.test("evidence with only images does not print a stray None", () => {
  const image = {
    alt: "work list, desktop",
    url: "https://example.test/a.png",
  };
  const { body, errors } = buildPrBody(spec({ evidence: { images: [image] } }));
  assertEquals(errors, []);
  const section = body.split("## Evidence")[1].split("## Verification")[0];
  assert(section.includes("![work list, desktop]"));
  assert(!section.includes("None"));
});

Deno.test("closes:false writes Refs so a slice cannot close the issue", () => {
  const { body } = buildPrBody(spec({ closes: false }));
  assert(body.includes("Refs #123"));
  assert(!/closes/i.test(body));
});

Deno.test("verify edits exactly one line and no other", () => {
  const body = buildPrBody(exampleSpec).body;
  const ticked = setVerification(body, "backend", {
    state: "tick",
    sha: "0123abcdef",
    claim: "permissions and errors match the ticket",
  });
  assertEquals(differing(body, ticked), 1);
  assert(
    ticked.includes(
      "- [x] Backend verified (reviewer) @ 0123abcd: permissions and errors match the ticket",
    ),
  );
  const errors = validateDescription("pr", ticked);
  assert(!errors.some((error) => error.includes('"backend verified"')));
  assert(errors.some((error) => error.includes('"implementation clean"')));
  assertEquals(
    differing(ticked, setVerification(ticked, "backend", { state: "pending" })),
    1,
  );
});

Deno.test("verify refuses an empty claim, a bad sha and a not-yet N/A", () => {
  const body = buildPrBody(exampleSpec).body;
  assertThrows(() =>
    setVerification(body, "tests", {
      state: "tick",
      sha: "0123abc",
      claim: " ",
    })
  );
  assertThrows(() =>
    setVerification(body, "tests", { state: "tick", sha: "head", claim: "ok" })
  );
  assertThrows(() =>
    setVerification(body, "tests", { state: "na", reason: "awaiting QA" })
  );
});

Deno.test("verify fails loudly when the checklist line is missing or doubled", () => {
  const body = buildPrBody(exampleSpec).body;
  const doubled = body.replace(
    "- [ ] Tests cover",
    "- [ ] Tests cover the change (qa): x\n- [ ] Tests cover",
  );
  assertThrows(() => setVerification(doubled, "tests", { state: "pending" }));
  assertThrows(() =>
    setVerification("## Purpose\n\nx", "tests", { state: "pending" })
  );
});

Deno.test("re-publishing keeps sign-offs and refreshes open boxes", () => {
  const first = buildPrBody(spec({ notApplicable: {} })).body;
  const live = setVerification(first, "ui", {
    state: "tick",
    sha: "0123abc",
    claim: "desktop and phone, light and dark",
  });
  const next = buildPrBody(
    spec({ purpose: "Admins see why a run was refused.", notApplicable: {} }),
  ).body;
  const merged = carryVerification(next, live, "0123abc" + "0".repeat(33));
  assert(merged.includes("- [x] UI verified (design-ux) @ 0123abc"));
  assert(merged.includes("Admins see why a run was refused."));
  assertEquals(differing(next, merged), 1);
  // The branch moved on: the tick names code that is gone, so it is not carried.
  const later = carryVerification(next, live, "f".repeat(40));
  assertEquals(later, next);
  // N/A lines are not about a commit and always carry.
  const na = buildPrBody(spec()).body;
  assertEquals(carryVerification(na, na, "f".repeat(40)), na);
});

Deno.test("a lone dash after a switch is the stdin marker, not its value", () => {
  const parsed = parseArgs(["backend", "--reset", "-"]);
  assertEquals(parsed.positional, ["backend", "-"]);
  assertEquals(parsed.options.get("reset"), "true");
  const tick = parseArgs([
    "ui",
    "--tick",
    "--sha",
    "0123abc",
    "--claim",
    "looks right",
    "--pr",
    "7",
  ]);
  assertEquals(tick.positional, ["ui"]);
  assertEquals(tick.options.get("claim"), "looks right");
  assertEquals(tick.options.get("pr"), "7");
});

Deno.test("CRLF bodies keep their line endings through a verify edit", () => {
  const body = buildPrBody(exampleSpec).body.replace(/\n/g, "\r\n");
  const ticked = setVerification(body, "backend", {
    state: "tick",
    sha: "0123abc",
    claim: "checked",
  });
  assert(!/[^\r]\n/.test(ticked));
});

/**
 * #780 AC1: publish refuses a body with a format error before anything is sent.
 * The real CLI runs with a fake `gh` first on PATH that records every call; a
 * refused spec must make none.
 */
async function publishWithFakeGh(spec: unknown, ...args: string[]) {
  const dir = await Deno.makeTempDir();
  try {
    const calls = dir + "/calls.txt";
    await Deno.writeTextFile(
      dir + "/gh",
      '#!/bin/sh\necho "$@" >> ' + calls + "\nexit 1\n",
    );
    await Deno.chmod(dir + "/gh", 0o755);
    await Deno.writeTextFile(dir + "/spec.json", JSON.stringify(spec));
    const out = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "scripts/authoring/pr-body.ts",
        "publish",
        dir + "/spec.json",
        ...args,
      ],
      env: { PATH: dir + ":" + Deno.env.get("PATH") },
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      code: out.code,
      text: new TextDecoder().decode(out.stderr) +
        new TextDecoder().decode(out.stdout),
      calls: await Deno.readTextFile(calls).catch(() => ""),
    };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("publish --pr refuses a live body whose carried line is a format error", async () => {
  // The fake gh answers `pr view` with a live body whose tick has no claim, so
  // the merged body has a real error: exit 1, and no `pr edit` is sent.
  const dir = await Deno.makeTempDir();
  try {
    const live = buildPrBody(spec({ notApplicable: {} })).body.replace(
      /^- \[ \] UI verified.*$/m,
      "- [x] UI verified (design-ux) @ " + "a".repeat(8) + ":",
    );
    await Deno.writeTextFile(
      dir + "/view.json",
      JSON.stringify({ body: live, headRefOid: "a".repeat(40) }),
    );
    await Deno.writeTextFile(
      dir + "/gh",
      '#!/bin/sh\necho "$@" >> ' + dir + '/calls.txt\n[ "$2" = view ] && cat ' +
        dir +
        "/view.json\nexit 0\n",
    );
    await Deno.chmod(dir + "/gh", 0o755);
    await Deno.writeTextFile(
      dir + "/spec.json",
      JSON.stringify(spec({ notApplicable: {} })),
    );
    const out = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "scripts/authoring/pr-body.ts",
        "publish",
        dir + "/spec.json",
        "--pr",
        "9",
      ],
      env: { PATH: dir + ":" + Deno.env.get("PATH") },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const calls = await Deno.readTextFile(dir + "/calls.txt");
    assertEquals(out.code, 1, new TextDecoder().decode(out.stderr));
    assert(!calls.includes("edit"), calls);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

const overlongPurpose = Array.from({ length: 45 }, (_, n) => "word" + n)
  .join(" ");

for (const args of [["--pr", "123"], ["--create", "--title", "t"]]) {
  Deno.test(`publish ${args[0]} refuses a body with a format error and calls gh zero times`, async () => {
    const result = await publishWithFakeGh(
      spec({ purpose: overlongPurpose }),
      ...args,
    );
    assertEquals(result.code, 1, result.text);
    assert(
      result.text.includes("purpose prose must be at most 40 words"),
      result.text,
    );
    assertEquals(result.calls, "", "gh must not be called");
  });
}
