import { assertEquals } from "@std/assert";
import {
  checksPassed,
  decideMerge,
  type MergeObservation,
  type MergeRequest,
} from "../../apps/server/src/modules/delivery/merge-candidate.ts";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const MOVED = "1111111111111111111111111111111111111111";
const BASE = "2222222222222222222222222222222222222222";
const MERGED = "3333333333333333333333333333333333333333";

const request: MergeRequest = {
  expectedHeadSha: HEAD,
  expectedBaseSha: BASE,
  mergeMethod: "squash",
};

const observed = (
  overrides: Partial<MergeObservation> = {},
): MergeObservation => ({
  headSha: HEAD,
  baseSha: BASE,
  state: "open",
  merged: false,
  mergedSha: null,
  checksPassed: true,
  ...overrides,
});

Deno.test("the exact candidate the caller verified is the one that dispatches", () => {
  assertEquals(decideMerge(request, observed()), {
    kind: "dispatch",
    headSha: HEAD,
    baseSha: BASE,
  });
});

Deno.test("a head that moved since the caller verified refuses the merge", () => {
  assertEquals(decideMerge(request, observed({ headSha: MOVED })), {
    kind: "refused",
    reason: "head_moved",
  });
  // A merge sent for the named head is never sent for another one, even when
  // the caller verified no base.
  assertEquals(
    decideMerge(
      { ...request, expectedBaseSha: null },
      observed({
        headSha: MOVED,
      }),
    ),
    { kind: "refused", reason: "head_moved" },
  );
});

Deno.test("a base that moved refuses it too, because the checks belong to the old base", () => {
  assertEquals(
    decideMerge(request, observed({ baseSha: MOVED })),
    { kind: "refused", reason: "base_moved" },
  );
  // A caller that verified no base cannot be refused for one it never named.
  assertEquals(
    decideMerge(
      { ...request, expectedBaseSha: null },
      observed({
        baseSha: MOVED,
      }),
    ),
    { kind: "dispatch", headSha: HEAD, baseSha: MOVED },
  );
});

Deno.test("an already merged pull request answers with GitHub's merge instead of sending another", () => {
  assertEquals(
    decideMerge(
      request,
      observed({ merged: true, state: "closed", mergedSha: MERGED }),
    ),
    { kind: "already_merged", mergedSha: MERGED },
  );
  // GitHub merged it but reported no commit: still a merge, not a new request.
  assertEquals(
    decideMerge(request, observed({ merged: true, state: "closed" })),
    { kind: "already_merged", mergedSha: null },
  );
});

Deno.test("a closed or missing pull request is never merged", () => {
  assertEquals(
    decideMerge(request, observed({ state: "closed" })),
    { kind: "refused", reason: "not_open" },
  );
});

Deno.test("a check that has not passed refuses it, including no checks at all", () => {
  assertEquals(
    decideMerge(request, observed({ checksPassed: false })),
    { kind: "refused", reason: "checks_not_passed" },
  );
  assertEquals(checksPassed([]), false);
  assertEquals(
    checksPassed([{ status: "completed", conclusion: "success" }]),
    true,
  );
  for (
    const conclusion of [
      "failure",
      "cancelled",
      "timed_out",
      "action_required",
      "stale",
      "startup_failure",
      "a_conclusion_from_a_later_build",
      null,
    ]
  ) {
    assertEquals(checksPassed([{ status: "completed", conclusion }]), false);
  }
  // GitHub's own merge box counts a skipped or neutral check as satisfied.
  assertEquals(
    checksPassed([{ status: "completed", conclusion: "skipped" }]),
    true,
  );
  assertEquals(
    checksPassed([{ status: "completed", conclusion: "neutral" }]),
    true,
  );
  assertEquals(
    checksPassed([{ status: "in_progress", conclusion: null }]),
    false,
  );
  // One failing run among passing ones still refuses.
  assertEquals(
    checksPassed([
      { status: "completed", conclusion: "success" },
      { status: "completed", conclusion: "failure" },
    ]),
    false,
  );
});
