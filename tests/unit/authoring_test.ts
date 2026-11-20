import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  fields,
  relatedIssue,
  splitMessages,
  staleVerification,
  validateDescription,
  validateReview,
} from "../../scripts/authoring/validate.ts";
import { checkLive } from "../../scripts/authoring/github.ts";

const work = [
  [
    "Description",
    "Keep GitHub issue and PR authoring consistent without changing Bakery features.",
  ],
  ["Execution classification", "AFK"],
  ["Dependencies", "#24 — workspace bootstrap is complete."],
  ["Checklist", "- [ ] Add native templates and a shared metadata validator."],
  [
    "Technical details",
    "Reuse Deno and GitHub metadata events; never execute candidate code with write credentials.",
  ],
  [
    "Acceptance criteria",
    "Given an incomplete description, when it is checked, then missing fields are reported.",
  ],
  [
    "Design and UX",
    "No product UI changes; the form gives authors field-level guidance.",
  ],
  [
    "Verification and closure",
    "Run focused unit checks and obtain independent review before merging.",
  ],
  [
    "Sources",
    "Requested by the repository owner; linked foundation issue #162.",
  ],
].map(([name, value]) => "## " + name + "\n\n" + value).join("\n\n");
const epic = [
  ["Description", "Establish reusable full-stack authoring rails."],
  ["Child issues", "- #169 — issue and PR authoring"],
  ["Acceptance criteria", "All child work is delivered with passing evidence."],
  ["Dependencies", "None."],
  ["Sources", "Repository owner's request for consistent issue structure."],
].map(([name, value]) => "### " + name + "\n\n" + value).join("\n\n");
const pr = [
  "Ticket: [#169](https://github.com/MarkTripoli/bakery/issues/169) | Task: [authoring-rails](https://github.com/MarkTripoli/bakery/issues/169) | Walkthrough: not requested",
  "## Purpose\n\nKeep issue and PR authoring consistent across humans and agents.",
  "## Risk\n\nLevel: Low\n\n- Only description checks change; revert the commit to roll back.",
  "## Special things to note\n\n- Activation requires landing the trusted workflow on main.",
  "## Change outline\n\n```text\nTemplates -> authoring skill -> shared validator -> GitHub feedback/status\n```",
  "## Decisions\n\n- None.",
  "## Evidence\n\n- New test `authoring_test.ts`: rejects a PR body over 300 words.",
  "## Verification\n\n- [x] Backend verified (reviewer) @ aaaaaaaa: ok.\n- [x] UI verified (design-ux) @ aaaaaaaa: ok.\n- [x] Implementation clean (reviewer) @ aaaaaaaa: ok.\n- [ ] Tests cover the change (qa) N/A: docs-only change.",
].join("\n\n");
const head = "a".repeat(40);
const base = "b".repeat(40);

Deno.test("authoring accepts canonical forms, established inline fields and focused show-me views", () => {
  assertEquals(validateDescription("issue", work), []);
  assertEquals(
    validateDescription("issue", work.replaceAll("## ", "### ")),
    [],
  );
  const inline = work.replace(
    "## Execution classification\n\n",
    "**Execution classification:** ",
  )
    .replace("## Dependencies\n\n", "**Dependencies:** ");
  assertEquals(validateDescription("issue", inline), []);
  assertEquals(validateDescription("epic", epic), []);
  assertEquals(validateDescription("pr", pr), []);
  assertEquals(relatedIssue(pr.replace("#169", "Closes #169")), 169);
  assertEquals(
    validateDescription(
      "pr",
      pr.replace(
        /```text[\s\S]+```/,
        "No structural change: Corrects a spelling error in one existing help sentence.",
      ).replace(
        "Walkthrough: not requested",
        "Walkthrough: https://github.com/MarkTripoli/bakery/issues/169",
      ),
    ),
    [],
  );
});

Deno.test("authoring rejects missing, duplicated, reordered and hidden fields", () => {
  for (const field of fields.issue) {
    const without = work.replace("## " + field, "## Unrelated section");
    assert(
      validateDescription("issue", without).some((error) =>
        error.includes(field)
      ),
      field,
    );
  }
  for (
    const fake of [
      "<!--\n" + work + "\n-->",
      "```md\n" + work + "\n```",
      work.split("\n").map((line) => "> " + line).join("\n"),
      work.split("\n").map((line) => "    " + line).join("\n"),
    ]
  ) assert(validateDescription("issue", fake).length >= fields.issue.length);
  assert(
    validateDescription("issue", work + "\n## Description\nDuplicated").some((
      e,
    ) => e.includes("Duplicate")),
  );
  assert(
    validateDescription(
      "issue",
      work.replace("## Description", "## Sources")
        .replace("## Sources\n\nRequested", "## Description\n\nRequested"),
    ).some((e) => e.includes("order")),
  );
  assert(
    validateDescription("pr", pr + "\n```").some((e) =>
      e.includes("unfinished")
    ),
  );
  assert(
    validateDescription("issue", work.replace("AFK", "<!-- AFK -->")).length >
      0,
  );
});

Deno.test("authoring rejects empty scaffold and checks concrete content shape", () => {
  for (
    const value of [
      "",
      "TODO",
      "_No response_",
      "N/A",
      "{Describe the outcome}",
      "<!-- description -->",
    ]
  ) {
    assert(
      validateDescription(
        "issue",
        work.replace(
          "Keep GitHub issue and PR authoring consistent without changing Bakery features.",
          value,
        ),
      ).some((e) => e.includes("Description")),
      value,
    );
  }
  assert(
    validateDescription("issue", work.replace("AFK", "automatic")).some((e) =>
      e.includes("AFK")
    ),
  );
  assert(
    validateDescription(
      "issue",
      work.replace(
        "- [ ] Add native templates and a shared metadata validator.",
        "- [ ] TODO",
      ),
    )
      .some((e) => e.includes("checkbox")),
  );
  assert(
    validateDescription(
      "issue",
      work.replace(
        "Given an incomplete description, when it is checked, then missing fields are reported.",
        "It should work.",
      ),
    ).some((e) => e.includes("Given")),
  );
  assert(
    validateDescription(
      "issue",
      work.replace("#24 — workspace bootstrap is complete.", "Later"),
    )
      .some((e) => e.includes("Dependencies")),
  );
  assert(
    validateDescription(
      "pr",
      pr.replace(
        /^Ticket:.*$/m,
        "Ticket: not available | Task: [authoring-rails](https://github.com/MarkTripoli/bakery/issues/169) | Walkthrough: not requested",
      ),
    ).some((e) => e.includes("Ticket")),
  );
  assert(
    validateDescription(
      "pr",
      pr.replace(/```text[\s\S]+```/, "Added templates."),
    )
      .some((e) => e.includes("show-me")),
  );
  assert(
    validateDescription(
      "pr",
      pr.replace(
        /^Ticket:.*$/m,
        "Ticket: [#169](https://github.com/MarkTripoli/bakery/issues/169) | Task: TODO | Walkthrough: not requested",
      ),
    ).some((e) => e.includes("Task")),
  );
  assert(
    validateDescription(
      "pr",
      pr.replace(
        "Walkthrough: not requested",
        "Walkthrough: requested",
      ),
    ).some((e) => e.includes("Walkthrough")),
  );
  assert(
    validateDescription(
      "pr",
      pr.replace(
        "- Activation requires landing the trusted workflow on main.",
        "- one\n- two\n- three\n- four\n- five",
      ),
    )
      .some((e) => e.includes("four bullets")),
  );
});

Deno.test("authoring preserves literal code delimiters and ignores raw HTML code blocks", () => {
  assertEquals(
    validateDescription(
      "issue",
      work.replace(
        "Keep GitHub issue and PR authoring consistent without changing Bakery features.",
        "<strong>Keep GitHub issue and PR authoring consistent.</strong>",
      ),
    ),
    [],
  );
  assertEquals(
    validateDescription("issue", "<pre><!-- literal code\n</pre>\n\n" + work),
    [],
  );
  for (const tag of ["pre", "script", "style", "textarea"]) {
    assert(
      validateDescription(
        "issue",
        "<" + tag + ">\n" + work + "\n</" + tag + ">",
      ).length > 0,
    );
  }
  const outlineStart = pr.indexOf("```text");
  const prefix = pr.slice(0, outlineStart);
  const suffix = pr.slice(pr.indexOf("\n\n## Decisions"));
  for (
    const outline of [
      '```json\n{"operation": "createIssue", "requiresApproval": true}\n```',
      "```tsx\n<AppShell><SectionNavigation /><Main /></AppShell>\n```",
      '```ts\nrender("<!--");\n```',
      '```ts\nrender("<!--");\n````',
      '~~~ts\nrender("<!--");\n~~~~',
    ]
  ) assertEquals(validateDescription("pr", prefix + outline + suffix), []);
  assertEquals(
    validateDescription(
      "pr",
      pr.replace(
        "Keep issue and PR authoring consistent across humans and agents.",
        "Document the `<!--` delimiter used by the shared feedback comment.",
      ),
    ),
    [],
  );
  assert(
    validateDescription(
      "pr",
      prefix + "```text\n{Focused diff or complete target shape.}\n```",
    )
      .some((error) => error.includes("show-me")),
  );
  assert(
    validateDescription("issue", "<!-- hidden\n" + work + "\n-->").length > 0,
  );
  assertEquals(
    validateDescription("issue", "<!-- helpful note -->\n" + work),
    [],
  );
});

// A fake read boundary verifies that policy checks never mutate GitHub state.
function fixture() {
  const writes: {
    method: string;
    path: string;
    body: Record<string, unknown>;
  }[] = [];
  const data = {
    work: {
      title: "Authoring rails",
      body: work,
      labels: [{ name: "ci" }],
    },
    pull: {
      title: "feat(ci): authoring rails",
      body: pr,
      head: { sha: head },
      base: { sha: base, ref: "main" },
    },
    reads: 0,
    onRead: (_path: string) => {},
  };
  const api = (
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> => {
    if (method === "GET") {
      data.reads++;
      data.onRead(path);
      if (path === "/issues/169") {
        return Promise.resolve(structuredClone(data.work));
      }
      if (path === "/pulls/170") {
        return Promise.resolve(structuredClone(data.pull));
      }
      throw new Error("Unexpected read: " + path);
    }
    writes.push({
      method,
      path,
      body: (body ?? {}) as Record<string, unknown>,
    });
    return Promise.resolve({});
  };
  return { data, api, writes };
}

Deno.test("live admission check is read-only and rejects concurrent metadata changes", async () => {
  const f = fixture();
  const checked = await checkLive(f.api, "pr", 170);
  assertEquals(checked.ok, true);
  assertEquals(checked.fingerprint.length, 64);
  assertEquals(f.writes, []);
  f.data.onRead = (path) => {
    if (path === "/issues/169") f.data.work.title += " changed";
  };
  const stale = await checkLive(f.api, "pr", 170);
  assertEquals(stale.ok, false);
  assert(stale.errors.some((error) => error.includes("changed")));
  assertEquals(f.writes, []);
});

Deno.test("read-only policy refuses invalid issue, moved PR head, and missing owner", async () => {
  const f = fixture();
  f.data.work.body = "TODO";
  assertEquals((await checkLive(f.api, "issue", 169)).ok, false);
  assertEquals((await checkLive(f.api, "pr", 170)).ok, false);
  assertEquals(f.writes, []);

  f.data.work.body = work;
  let pullReads = 0;
  f.data.onRead = (path) => {
    if (path === "/pulls/170" && ++pullReads === 2) {
      f.data.pull.head.sha = "c".repeat(40);
    }
  };
  const moved = await checkLive(f.api, "pr", 170);
  assertEquals(moved.ok, false);
  assert(moved.errors.some((error) => error.includes("changed")));
  assertEquals(f.writes, []);

  f.data.onRead = (path) => {
    if (path === "/issues/169") throw new Error("HTTP 404");
  };
  await assertRejects(() => checkLive(f.api, "pr", 170), Error, "404");
  assertEquals(f.writes, []);
});

Deno.test("authoring keeps PR descriptions short and asks for risk, decisions and evidence", () => {
  const has = (body: string, text: string) =>
    validateDescription("pr", body).some((e) => e.includes(text));
  assertEquals(
    validateDescription("pr", pr.replace("Level: Low", "Level: Medium")),
    [],
  );
  assertEquals(
    has(pr.replace("Level: Low", "Level: Some"), "Level: Low, Medium or High"),
    true,
  );
  assertEquals(
    has(
      pr.replace(/## Risk[\s\S]*?(?=## Special)/, ""),
      "Complete section: Risk",
    ),
    true,
  );
  assertEquals(
    has(
      pr.replace("- None.", "- Chose A over B because C.\n- D.\n- E.\n- F."),
      "one to three bullets",
    ),
    true,
  );
  const evidence = (text: string) =>
    pr.replace(/## Evidence\n\n[^\n]*/, "## Evidence\n\n" + text);
  assertEquals(validateDescription("pr", evidence("- None.")), []);
  assertEquals(
    validateDescription(
      "pr",
      evidence("![list](https://example.com/list.png)"),
    ),
    [],
  );
  assertEquals(
    has(evidence("- `pnpm typecheck` passed"), "routine checks"),
    true,
  );
  assertEquals(
    has(
      evidence("| check | result |\n|---|---|\n| lint | clean |"),
      "routine checks",
    ),
    true,
  );
  const long = Array(41).fill("word").join(" ");
  assertEquals(
    has(
      pr.replace(
        "Keep issue and PR authoring consistent across humans and agents.",
        long,
      ),
      "purpose prose",
    ),
    true,
  );
  assertEquals(
    has(
      pr.replace(
        "- Activation requires",
        "- " + Array(26).fill("x").join(" ") + " Activation requires",
      ),
      "bullet must be at most 25",
    ),
    true,
  );
  // The Change outline is the PR's core: one to three views, 80 lines in all.
  // 79 lines passes, 81 fails — the boundary, not a round number either side.
  const viewOf = (lines: number) =>
    "```text\n" + Array(lines).fill("a -> b").join("\n") + "\n```";
  assertEquals(
    has(pr.replace(/```text[\s\S]*?```/, viewOf(79)), "at most 80 lines"),
    false,
  );
  assertEquals(
    has(pr.replace(/```text[\s\S]*?```/, viewOf(80)), "at most 80 lines"),
    false,
  );
  assertEquals(
    has(pr.replace(/```text[\s\S]*?```/, viewOf(81)), "at most 80 lines"),
    true,
  );
  // Four views is one too many; three is the cap.
  const views = (count: number) =>
    Array(count).fill("```text\na -> b\n```").join("\n");
  assertEquals(
    has(pr.replace(/```text[\s\S]*?```/, views(3)), "at most three"),
    false,
  );
  assertEquals(
    has(pr.replace(/```text[\s\S]*?```/, views(4)), "at most three"),
    true,
  );
  // A view's labels are the view's budget, not prose: a long diagram must not
  // push the 40-word Change outline prose cap over.
  const labelled = "```mermaid\n" +
    Array(80).fill("  A[word word word] --> B").join("\n") + "\n```";
  assertEquals(
    has(pr.replace(/```text[\s\S]*?```/, labelled), "words of prose"),
    false,
  );
  const shots = Array(5).fill("![s](https://example.com/s.png)").join(" ");
  assertEquals(has(pr + "\n\n" + shots, "at most four"), true);
  const filler = "\n\n## Notes\n\n" + Array(300).fill("filler").join(" ");
  assertEquals(has(pr + filler, "whole description must be at most 300"), true);
  assertEquals(
    validateDescription(
      "pr",
      pr.replace("## Evidence", "## Evidence @ abc1234"),
    ),
    [],
  );
});

Deno.test("review verdicts are short: verdict, head, severity-tagged findings", () => {
  const review = [
    "Verdict: Changes requested",
    "Head: `90b2092d`",
    "",
    "- [High] Save ignores a 412 and overwrites a newer policy (`IssueSettingsPage.tsx`).",
    "- [Low] Phone layout clips the label error.",
    "",
    "| check | result |",
    "|---|---|",
    "| `pnpm test:unit` | passed |",
  ].join("\n");
  assertEquals(validateReview(review), []);
  assert(
    validateReview(review.replace("Verdict: Changes requested", "Looks good"))
      .length > 0,
  );
  assert(validateReview(review.replace("Head: `90b2092d`", "")).length > 0);
  assert(
    validateReview(review.replace("[Low]", "")).some((e) =>
      e.includes("severity")
    ),
  );
  assert(
    validateReview(review + "\n\n" + Array(160).fill("filler").join(" ")).some((
      e,
    ) => e.includes("at most 150")),
  );
});

Deno.test("Evidence refuses routine checks but accepts a test file named format", () => {
  // Owner rule: Evidence is UI screenshots or recordings and the new tests.
  // Routine checks belong to CI, so a table of green ticks proves nothing.
  const withEvidence = (evidence: string) =>
    pr.replace(
      /## Evidence[\s\S]*?(?=\n\n## Verification|$)/,
      "## Evidence\n\n" + evidence,
    );
  const table = (row: string) =>
    ["| check | result |", "|---|---|", row].join("\n");
  const refused = (row: string) =>
    validateDescription("pr", withEvidence(table(row))).some((e) =>
      e.includes("drop routine checks")
    );
  for (const check of ["fmt", "lint", "typecheck"]) {
    assertEquals(refused(`\`pnpm ${check}\` | passed`), true, check);
  }
  // A real test file carrying "format" in its name is evidence, not a routine
  // check. Refusing it stopped a PR from citing the test it added.
  assertEquals(
    refused("`packages/ui/tests/contracts-module-format.node.mjs` | 12 passed"),
    false,
  );
  // Evidence that shows something still passes.
  assertEquals(
    validateDescription(
      "pr",
      withEvidence(table("reduced-motion skeleton | still, no animation")),
    ),
    [],
  );
});

Deno.test("a bullet inside a fenced block is quoted code, not a finding", () => {
  // The reviewer's repro: a block pasted to show the bug, whose lines start
  // with "- " and carry no severity tag. Counting them as findings failed the
  // severity and 25-word rules on lines that were never findings.
  const review = [
    "Verdict: Changes requested",
    "Head: `90b2092d`",
    "",
    "- [Low] Findings scan counts bullets inside fences.",
    "",
    "```",
    "- some quoted list item that is not a finding at all and is long enough to",
    "  blow past any word budget the rule might apply to a real finding line",
    "- a second quoted bullet",
    "```",
  ].join("\n");
  assertEquals(validateReview(review), []);
});

Deno.test("the verification checklist gates the merge until every box is resolved", () => {
  const errs = (body: string) => validateDescription("pr", body).join(" ");
  assertEquals(validateDescription("pr", pr), []);
  assert(
    errs(pr.replace("- [x] UI verified", "- [ ] UI verified")).includes(
      'Verification pending: "ui verified"',
    ),
  );
  assert(
    errs(pr.replace(/- \[x\] Backend verified[^\n]*\n/, "")).includes(
      'missing the "backend verified" item',
    ),
  );
  assert(
    errs(pr.replace(/## Verification[\s\S]*$/, "")).includes("Verification"),
  );
});

Deno.test("one ticked verification line cannot satisfy every item", () => {
  const errs = (body: string) => validateDescription("pr", body).join(" ");
  // All four phrases stuffed into the Backend line, the other three lines
  // removed: the stuffed line resolves only its own item.
  const stuffed = pr
    .replace(/^- \[x\] UI verified[^\n]*\n/mg, "")
    .replace(/^- \[x\] Implementation clean[^\n]*\n/mg, "")
    .replace(/^- \[.\] Tests cover[^\n]*(?:\n|$)/mg, "")
    .replace(
      /^- \[x\] Backend verified.*$/m,
      "- [x] Backend verified: also covers ui verified, implementation clean, and tests cover.",
    );
  const joined = errs(stuffed);
  assert(joined.includes('missing the "ui verified" item'));
  assert(joined.includes('missing the "implementation clean" item'));
  assert(joined.includes('missing the "tests cover" item'));
  assert(!joined.includes('"backend verified"'));
  // The legitimate forms still resolve: a ticked line, and an explicit
  // N/A with a reason on the item's own line.
  assertEquals(
    validateDescription(
      "pr",
      pr.replace(
        /^- \[x\] UI verified.*$/m,
        "- [ ] UI verified (design-ux): N/A: no UI change.",
      ),
    ),
    [],
  );
});

// The three shapes qa-qa probed on the merged #536 validator. Each passed
// when it should have failed: the gate said "resolved" for a line that had
// not decided anything. They are kept as the red-proofs for the hardening.
Deno.test("a ticked box and an N/A on the same line is not a resolution", () => {
  const errs = (body: string) => validateDescription("pr", body).join(" ");
  // Both answers at once: the reviewer has not decided, and the old check
  // accepted it because it tested "ticked OR N/A" instead of exactly one.
  const both = pr.replace(
    /^- \[x\] UI verified.*$/m,
    "- [x] UI verified (design-ux): N/A: no UI change.",
  );
  assert(
    errs(both).includes('"ui verified" is both ticked and marked N/A'),
    errs(both),
  );
  // Each answer alone still resolves, so the XOR did not break the gate.
  assertEquals(
    validateDescription(
      "pr",
      pr.replace(
        /^- \[x\] UI verified.*$/m,
        "- [ ] UI verified: N/A: no UI change.",
      ),
    ),
    [],
  );
  assertEquals(validateDescription("pr", pr), []);
});

Deno.test("a ticked box with no claim is not a resolution", () => {
  const errs = (body: string) => validateDescription("pr", body).join(" ");
  // A bare tick claims nothing. The old check only asked whether the box was
  // ticked, so an empty claim gated the merge.
  const bare = pr.replace(
    /^- \[x\] Implementation clean.*$/m,
    "- [x] Implementation clean (reviewer):",
  );
  assert(
    errs(bare).includes('"implementation clean" is ticked with no claim'),
    errs(bare),
  );
  // A tick with a claim, and an N/A with a reason, both still resolve.
  assertEquals(validateDescription("pr", pr), []);
  assertEquals(
    validateDescription(
      "pr",
      pr.replace(
        /^- \[x\] Implementation clean.*$/m,
        "- [ ] Implementation clean: N/A: no code change.",
      ),
    ),
    [],
  );
});

Deno.test("a duplicated verification item is an unresolved edit", () => {
  const errs = (body: string) => validateDescription("pr", body).join(" ");
  // Two lines for one item: the reader cannot tell which is the answer, and
  // a ticked duplicate beside an open one would gate on the tick.
  const duplicated = pr.replace(
    /^- \[.\] Tests cover.*$/m,
    "- [ ] Tests cover the change (qa): not yet.\n- [x] Tests cover the change (qa): ok.",
  );
  assert(
    errs(duplicated).includes('"tests cover" appears on 2 lines'),
    errs(duplicated),
  );
  // One line per item is still the accepted form.
  assertEquals(validateDescription("pr", pr), []);
});

Deno.test("N/A cannot stand in for work that has not happened yet", () => {
  const body = pr.replace(
    /- \[x\] UI verified[^\n]*/,
    "- [ ] UI verified (design-ux): N/A: not yet signed off.",
  );
  assert(
    validateDescription("pr", body).some((e) =>
      e.includes("means not done yet")
    ),
  );
  const fine = pr.replace(
    /- \[x\] UI verified[^\n]*/,
    "- [ ] UI verified (design-ux) N/A: no UI change.",
  );
  assertEquals(
    validateDescription("pr", fine).filter((e) => e.includes("ui verified")),
    [],
  );
});

/** #780: a verification line nobody has ticked is pending, never a failed check. */
Deno.test("an unticked verification line passes the check and is reported as pending", async () => {
  const f = fixture();
  f.data.pull.body = pr.replace("- [x] UI verified", "- [ ] UI verified");
  const checked = await checkLive(f.api, "pr", 170);
  assertEquals(checked.ok, true, checked.errors.join(" "));
  assertEquals(checked.errors, []);
  assertEquals(checked.pending.length, 1);
  assert(checked.pending[0].includes('"ui verified"'));
  assertEquals(f.writes, [], "the check itself writes nothing");
});

Deno.test("every line ticked or N/A at the head leaves nothing open, and a new head opens the old ticks again", async () => {
  const f = fixture();
  const checked = await checkLive(f.api, "pr", 170);
  // The workflow runs the `verification` job only when this list is empty.
  assertEquals([checked.ok, checked.pending], [true, []]);
  assertEquals(f.writes, []);
  // A push moves the head: the ticks name an older one, whatever the body says.
  f.data.pull.head = { sha: "d".repeat(40) };
  const moved = await checkLive(f.api, "pr", 170);
  assertEquals(moved.ok, true, moved.errors.join(" "));
  assertEquals(moved.pending.length, 3);
});

Deno.test("a broken body still fails the check with the message the validator prints", async () => {
  const f = fixture();
  const broken = pr.replace(
    "- New test `authoring_test.ts`: rejects a PR body over 300 words.",
    "- `pnpm lint` passed and `pnpm fmt` is clean.",
  );
  f.data.pull.body = broken;
  const checked = await checkLive(f.api, "pr", 170);
  const direct = splitMessages(validateDescription("pr", broken));
  assertEquals(checked.ok, false);
  assert(direct.errors.length > 0, "the body really has a format error");
  assertEquals(checked.errors, direct.errors, "the same messages as the tool");
  assertEquals(checked.pending, direct.pending);
});

Deno.test("a Head: line under the metadata line is not part of the Walkthrough", () => {
  const withHead = pr.replace(
    "Walkthrough: not requested\n",
    "Walkthrough: not requested\nHead: `" + head + "`\n",
  );
  assert(withHead !== pr, "the fixture really gained a Head line");
  assertEquals(
    validateDescription("pr", withHead),
    validateDescription("pr", pr),
  );
  const bold = pr.replace(
    "Walkthrough: not requested\n",
    "Walkthrough: not requested\n**Head:** " + head.slice(0, 8) + "\n",
  );
  assertEquals(validateDescription("pr", bold), validateDescription("pr", pr));
  // Anything else under the metadata line is still the Walkthrough value.
  const stray = pr.replace(
    "Walkthrough: not requested\n",
    "Walkthrough: not requested\nHead: soon\n",
  );
  assert(
    validateDescription("pr", stray).some((e) =>
      e.startsWith("Walkthrough must")
    ),
  );
});

Deno.test("a tick at an older head is pending again, so a later edit cannot turn verification green", async () => {
  // Ticked at the head: nothing stale.
  assertEquals(staleVerification(pr, head), []);
  // The branch moved on: every tick now names code that is gone.
  const moved = "c".repeat(40);
  const stale = staleVerification(pr, moved);
  assertEquals(stale.length, 3);
  assert(
    stale[0].includes('"backend verified"') && stale[0].includes("aaaaaaaa"),
  );
  // A tick with no commit at all says nothing about the code either.
  assertEquals(
    staleVerification(
      pr.replaceAll("(reviewer) @ aaaaaaaa: ok.", "(reviewer): ok."),
      head,
    )
      .length,
    2,
  );
  // N/A is about whether the item applies, not a commit.
  assert(!stale.some((m) => m.includes("tests cover")));

  // End to end: an edit after a push (headChanged false) must stay pending.
  const f = fixture();
  f.data.pull.head = { sha: moved };
  const checked = await checkLive(f.api, "pr", 170);
  assertEquals(checked.ok, true, checked.errors.join(" "));
  assertEquals(checked.pending.length, 3);
});

Deno.test("format errors and pending lines are split by one rule", () => {
  const split = splitMessages([
    'Verification pending: "backend verified" is not ticked or marked N/A: <reason>.',
    "The description is too long.",
    `Verification pending: "ui verified" says N/A but means not done yet.`,
  ]);
  assertEquals(split.errors, ["The description is too long."]);
  assertEquals(split.pending.length, 2);
});
