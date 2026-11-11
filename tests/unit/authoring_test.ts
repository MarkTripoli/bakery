import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  fields,
  relatedIssue,
  validateDescription,
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
  "## Special things to note\n\n- Activation requires landing the trusted workflow on main.",
  "## Change outline\n\n```text\nTemplates -> authoring skill -> shared validator -> GitHub feedback/status\n```",
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
  for (
    const outline of [
      '```json\n{"operation": "createIssue", "requiresApproval": true}\n```',
      "```tsx\n<AppShell><SectionNavigation /><Main /></AppShell>\n```",
      '```ts\nrender("<!--");\n```',
      '```ts\nrender("<!--");\n````',
      '~~~ts\nrender("<!--");\n~~~~',
    ]
  ) assertEquals(validateDescription("pr", prefix + outline), []);
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
