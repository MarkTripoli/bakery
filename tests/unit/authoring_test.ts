import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  fields,
  relatedIssue,
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
  "## Evidence\n\n| check | result |\n|---|---|\n| `deno test tests/unit/authoring_test.ts` | passed |",
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
  assertEquals(
    has(
      pr.replace(/\| `deno[^\n]*/, "|  |  |"),
      "at least one filled check row",
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
  const labelled = "```mermaid\n" + Array(80).fill("  A[word word word] --> B")
    .join("\n") +
    "\n```";
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

Deno.test("Evidence None. is accepted when it says why there is nothing to show", () => {
  // Owner rule: Evidence is UI evidence and new tests only, so a PR with
  // neither states None. and why — it does not pad the table with CI checks.
  const withEvidence = (evidence: string) =>
    pr.replace(/## Evidence[\s\S]*$/, "## Evidence\n\n" + evidence);
  assertEquals(
    validateDescription(
      "pr",
      withEvidence(
        "- None. Backend-only refactor: no visible UI, and the existing lane\n" +
          "  already covers the changed branch.",
      ),
    ),
    [],
  );
  assert(
    validateDescription("pr", withEvidence("- None.")).some((e) =>
      e.includes("needs one line saying why")
    ),
  );
  // A bare None. with no reason is refused, so it is not a free pass.
  assertEquals(
    validateDescription("pr", withEvidence("None.")).some((e) =>
      e.includes("needs one line saying why")
    ),
    true,
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
