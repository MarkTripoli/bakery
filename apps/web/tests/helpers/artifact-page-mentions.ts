import { expect, type Page, type Route, test } from "@playwright/test";
import {
  ARTIFACT_ID,
  COMMENT_ID,
  json,
  openComments,
  PATH,
  problem,
  ROOT,
  stubArtifactPage,
  TASK_ID,
  VERSION_ID,
} from "./artifact-page-fixture.ts";
import { MOCK_ORGANIZATION_ID } from "./mock-session.ts";
import { still } from "./stills.ts";

/** Mentions in the document comment box: give access and post (#73, UX revision 3). */
const ANA = "00000000-0000-4000-8000-0000000000a1";
const DANA = "00000000-0000-4000-8000-0000000000a2";
const SAMIR = "00000000-0000-4000-8000-0000000000a3";
const stamp = "2026-01-05T00:00:00.000Z";

const SAMIR_GRANT = {
  id: "00000000-0000-4000-8000-0000000000c1",
  artifactId: ARTIFACT_ID,
  principalId: SAMIR,
  displayName: "Samir Okafor",
  level: "read_comment",
  grantedById: ANA,
  grantedByName: "Ana Ruiz",
  sourceCommentId: COMMENT_ID,
  grantedAt: stamp,
  revokedAt: null,
  version: 4,
};

type World = {
  /** The writer may give access: people without it carry `gainsAccessOnSend`. */
  mayShare: boolean;
  /** The writer's role holds artifact:share: the People added link is theirs. */
  canShare: boolean;
  sharers: { principalId: string; displayName: string }[];
  grants: (typeof SAMIR_GRANT)[];
  /** What a revoke answers. */
  revokeStatus: number;
  /** What the comment POST answers: 200, or a status that carries refusals. */
  postStatus: number;
  postIssues: { path: string; code: string; message: string }[];
  posts: Record<string, unknown>[];
  revokes: { principalId: string; ifMatch: string | undefined }[];
};

function world(overrides: Partial<World> = {}): World {
  return {
    mayShare: true,
    canShare: false,
    sharers: [{ principalId: DANA, displayName: "Dana Lee" }],
    grants: [],
    revokeStatus: 200,
    postStatus: 200,
    postIssues: [],
    posts: [],
    revokes: [],
    ...overrides,
  };
}

const commentBox = (page: Page) => page.getByLabel("Comment", { exact: true });
const post = (page: Page, name = "Post comment") =>
  page.getByRole("button", { name, exact: true });

async function open(page: Page, state: World = world()) {
  const searches: string[] = [];
  await stubArtifactPage(page);
  // Routes added later win, so these sit over the fixture's own.
  await page.route(
    "**/v1/organizations/*/effective-access",
    (route) =>
      route.fulfill(json({
        organizationId: MOCK_ORGANIZATION_ID,
        role: "developer",
        capabilities: state.canShare ? ["artifact:share"] : [],
      })),
  );
  await page.route(
    (url) =>
      url.pathname === `/v1/artifact-versions/${VERSION_ID}/mention-candidates`,
    (route) => {
      const url = new URL(route.request().url());
      const text = (url.searchParams.get("query") ?? "").toLowerCase();
      searches.push(text);
      const people = [
        { principalId: ANA, displayName: "Ana Ruiz", hasAccess: true },
        { principalId: SAMIR, displayName: "Samir Okafor", hasAccess: false },
      ].map((person) => ({
        ...person,
        gainsAccessOnSend: !person.hasAccess && state.mayShare,
      }));
      return route.fulfill(json({
        items: people.filter((person) =>
          person.displayName.toLowerCase().includes(text)
        ),
        nextCursor: null,
      }));
    },
  );
  await page.route(
    (url) => url.pathname === `/v1/artifacts/${ARTIFACT_ID}/access/sharers`,
    (route) => route.fulfill(json({ items: state.sharers })),
  );
  await page.route(
    (url) => url.pathname === `/v1/artifacts/${ARTIFACT_ID}/access`,
    (route) => route.fulfill(json({ items: state.grants, nextCursor: null })),
  );
  await page.route(
    (url) => url.pathname === `/v1/artifacts/${ARTIFACT_ID}/access/revoke`,
    (route) => {
      const body = route.request().postDataJSON() as { principalId: string };
      state.revokes.push({
        principalId: body.principalId,
        ifMatch: route.request().headers()["if-match"],
      });
      if (state.revokeStatus !== 200) {
        return route.fulfill(problem(state.revokeStatus, "UNAVAILABLE"));
      }
      const gone = state.grants.find((grant) =>
        grant.principalId === body.principalId
      );
      state.grants = state.grants.filter((grant) => grant !== gone);
      return route.fulfill(
        json({ ...(gone ?? SAMIR_GRANT), revokedAt: stamp }),
      );
    },
  );
  await page.route(
    `**/v1/artifact-versions/${VERSION_ID}/comments`,
    (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      state.posts.push(body);
      return answerPost(route, state, body);
    },
  );
  await page.goto(PATH);
  await openComments(page);
  return { state, searches };
}

function answerPost(route: Route, state: World, body: Record<string, unknown>) {
  if (state.postStatus === 200) {
    // A post that gave access leaves the grant behind, as the server does.
    if (body.accessLevel === "read_comment") state.grants = [SAMIR_GRANT];
    return route.fulfill(json({ ...ROOT, body: body.body }));
  }
  if (state.postStatus === 422) {
    return route.fulfill({
      status: 422,
      contentType: "application/problem+json",
      body: JSON.stringify({
        type: "https://bakery.example/problems/unprocessable",
        title: "UNPROCESSABLE",
        detail: "Stubbed UNPROCESSABLE.",
        status: 422,
        code: "UNPROCESSABLE",
        requestId: TASK_ID,
        traceId: TASK_ID,
        retryable: false,
        issues: state.postIssues,
      }),
    });
  }
  return route.fulfill(problem(state.postStatus, "UNAVAILABLE"));
}

const refusal = (code: string) => [{
  path: "/mentions/0",
  code,
  message: code.replaceAll("_", " "),
}];

async function chooseSamir(page: Page) {
  await commentBox(page).fill("Please look @sam");
  await page.getByRole("option", { name: "Samir Okafor, no access yet" })
    .click();
}

test("typing @ in the comment box offers people: a quiet row, and one badge for anyone without access", async ({ page }) => {
  await open(page);
  await commentBox(page).fill("@");
  const list = page.getByRole("listbox", { name: "People you can mention" });
  await expect(list).toBeVisible();
  await expect(list.getByRole("option", { name: "Ana Ruiz", exact: true }))
    .toBeVisible();
  // Anyone can be chosen: the person without access is not muted.
  const samir = list.getByRole("option", {
    name: "Samir Okafor, no access yet",
  });
  await expect(samir).toBeVisible();
  await expect(samir).not.toHaveAttribute("aria-disabled", "true");
  await expect(list.getByText("No access yet")).toHaveCount(1);
  await expect(page.getByText("You can give access when you post."))
    .toBeVisible();
  await page.mouse.move(700, 100);
  await still(page, "comment-mentions-picker");
});

test("someone who can already read: the comment carries the mention and nothing is given", async ({ page }) => {
  const { state, searches } = await open(page);
  const box = commentBox(page);
  await box.fill("Looks right @an");
  await expect.poll(() => searches).toContain("an");
  await page.getByRole("option", { name: "Ana Ruiz", exact: true }).click();
  await expect(box).toHaveValue("Looks right @Ana Ruiz ");
  await expect(page.getByText("Will be notified")).toBeVisible();
  await expect(page.locator('[data-ui-component="accessOffer"]')).toHaveCount(
    0,
  );
  await page.mouse.move(700, 100);
  await still(page, "comment-mentions-ready");
  await post(page).click();
  await expect.poll(() => state.posts.length).toBe(1);
  // No access level goes with it: nobody needed one.
  expect(state.posts[0]).toEqual({
    body: "Looks right @Ana Ruiz",
    mentions: [ANA],
  });
  await expect(box).toHaveValue("");
});

test("someone without access: the offer, Post is the yes, then the line and Undo access", async ({ page }) => {
  const { state } = await open(page);
  await chooseSamir(page);
  const offer = page.locator('[data-ui-component="accessOffer"]');
  await expect(offer).toContainText(
    "Samir Okafor can't see this document. Give them access?",
  );
  await expect(offer).toContainText(
    "They will be able to read this document and comment on it. Nothing else is shared.",
  );
  await expect(page.getByText("Samir Okafor · no access yet")).toBeVisible();
  await expect(post(page, "Give access and post")).toBeEnabled();
  await expect(post(page)).toHaveCount(0);
  await page.mouse.move(700, 100);
  await still(page, "comment-mentions-offer");
  await post(page, "Give access and post").click();
  await expect.poll(() => state.posts.length).toBe(1);
  expect(state.posts[0]).toEqual({
    body: "Please look @Samir Okafor",
    mentions: [SAMIR],
    accessLevel: "read_comment",
  });
  const line = page.getByText(
    "Posted. Samir Okafor can now read and comment on this document.",
  );
  await expect(line).toBeVisible();
  await expect(offer).toHaveAttribute("data-tone", "success");
  await page.mouse.move(700, 100);
  await still(page, "comment-mentions-posted");
  // The undo fails first: the line stays, with what happened.
  state.revokeStatus = 503;
  await page.getByRole("button", { name: "Undo access" }).click();
  await expect(
    page.getByText("Access was not removed. Nothing changed. Try again."),
  ).toBeVisible();
  await expect(line).toBeVisible();
  await expect(offer).toHaveAttribute("data-tone", "warning");
  state.revokeStatus = 200;
  await page.getByRole("button", { name: "Undo access" }).click();
  await expect(
    page.getByText(
      "Access removed. Samir Okafor can no longer open this document. Your comment stays.",
    ),
  ).toBeVisible();
  expect(state.revokes.at(-1)).toEqual({ principalId: SAMIR, ifMatch: '"v4"' });
  await page.mouse.move(700, 100);
  await still(page, "comment-mentions-undone");
});

test("Don't mention keeps the name as words and closes the offer", async ({ page }) => {
  await open(page);
  await chooseSamir(page);
  await page.getByRole("button", { name: "Don't mention Samir Okafor" })
    .click();
  await expect(commentBox(page)).toHaveValue("Please look Samir Okafor ");
  await expect(page.locator('[data-ui-component="accessOffer"]')).toHaveCount(
    0,
  );
  await expect(post(page)).toBeEnabled();
});

test("a writer who may not share: the block names who can, Ask swaps the mention, Post waits", async ({ page }) => {
  const { state } = await open(page, world({ mayShare: false }));
  await chooseSamir(page);
  const block = page.locator('[data-ui-component="accessOffer"]');
  await expect(block).toContainText(
    "Samir Okafor can't see this document, and you can't give access to it.",
  );
  await expect(block).toContainText(
    "Dana Lee can. Ask one of them here, or post without the mention.",
  );
  await expect(post(page)).toBeDisabled();
  await expect(
    page.getByText("Ask Dana Lee or remove the mention to post."),
  ).toBeVisible();
  await page.mouse.move(700, 100);
  await still(page, "comment-mentions-cannot-share");
  await page.getByRole("button", { name: "Ask Dana Lee" }).click();
  await expect(commentBox(page)).toHaveValue(
    "Please look Samir Okafor \n@Dana Lee can you give Samir Okafor access to this?",
  );
  await expect(post(page)).toBeEnabled();
  await post(page).click();
  await expect.poll(() => state.posts.length).toBe(1);
  expect(state.posts[0]).toMatchObject({ mentions: [DANA] });
  expect(state.posts[0]).not.toHaveProperty("accessLevel");
});

test("nobody can share: the block says so and offers only the way out", async ({ page }) => {
  await open(page, world({ mayShare: false, sharers: [] }));
  await chooseSamir(page);
  await expect(
    page.locator('[data-ui-component="accessOffer"]'),
  ).toContainText(
    /No one in .+ can give access to this document\. Remove the mention to post\./,
  );
  await expect(post(page)).toBeDisabled();
  await expect(page.getByText("Remove the mention to post.").first())
    .toBeVisible();
});

test("the server says the person has no access after all: the offer comes back, starting Not posted", async ({ page }) => {
  // The writer thought Samir could read; a role change says otherwise.
  const state = world({
    postStatus: 422,
    postIssues: refusal("mention_no_thread_access"),
  });
  await open(page, state);
  await chooseSamir(page);
  await post(page, "Give access and post").click();
  await expect(
    page.locator('[data-ui-component="accessOffer"]'),
  ).toContainText(
    "Not posted. Samir Okafor can't see this document. Give them access?",
  );
  // The draft stays and the same button still gives access and posts.
  await expect(commentBox(page)).toHaveValue("Please look @Samir Okafor ");
  state.postStatus = 200;
  await post(page, "Give access and post").click();
  await expect.poll(() => state.posts.length).toBe(2);
  expect(state.posts[1]).toMatchObject({ accessLevel: "read_comment" });
});

test("the server says the writer may no longer share: the block, starting Not posted", async ({ page }) => {
  const state = world({
    postStatus: 422,
    postIssues: refusal("mention_share_forbidden"),
  });
  await open(page, state);
  await chooseSamir(page);
  await post(page, "Give access and post").click();
  await expect(
    page.locator('[data-ui-component="accessOffer"]'),
  ).toContainText(
    "Not posted. Samir Okafor can't see this document, and you can no longer give access to it.",
  );
  await expect(post(page)).toBeDisabled();
  await page.mouse.move(700, 100);
  await still(page, "comment-mentions-not-posted");
});

test("a mention of someone who left is refused in red: the draft stays and Post waits until it is removed", async ({ page }) => {
  await open(
    page,
    world({ postStatus: 422, postIssues: refusal("mention_not_member") }),
  );
  await commentBox(page).fill("Hi @an");
  await page.getByRole("option", { name: "Ana Ruiz", exact: true }).click();
  await post(page).click();
  await expect(page.getByRole("alert").filter({ hasText: "Not posted." }))
    .toContainText(
      /Not posted\. Ana Ruiz is no longer a member of .+\. Remove the mention\./,
    );
  await expect(commentBox(page)).toHaveValue("Hi @Ana Ruiz ");
  await expect(post(page)).toBeDisabled();
  await page.getByRole("button", { name: "Remove mention of Ana Ruiz" })
    .click();
  await expect(post(page)).toBeEnabled();
});

test("when the server fails while giving access, nothing is lost and the button tries again", async ({ page }) => {
  const state = world({ postStatus: 503 });
  await open(page, state);
  await chooseSamir(page);
  await post(page, "Give access and post").click();
  await expect(
    page.getByText(
      "Not posted, and no access was given. Something went wrong on our side. Your comment is still here. Samir Okafor still can't see this document.",
    ),
  ).toBeVisible();
  await expect(commentBox(page)).toHaveValue("Please look @Samir Okafor ");
  await page.mouse.move(700, 100);
  await still(page, "comment-mentions-failed");
  state.postStatus = 200;
  await post(page, "Try again: give access and post").click();
  await expect(
    page.getByText(
      "Posted. Samir Okafor can now read and comment on this document.",
    ),
  ).toBeVisible();
});

test("people a mention added: the link, the list, Show comment, and taking access back", async ({ page }) => {
  const { state } = await open(
    page,
    world({ canShare: true, grants: [SAMIR_GRANT] }),
  );
  await page.getByRole("button", { name: "1 person was added by a mention" })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "People added to this document",
  });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText(
      "They were mentioned in comments. They can read this document and comment on it only.",
    ),
  ).toBeVisible();
  await expect(dialog.getByText("Samir Okafor", { exact: true })).toBeVisible();
  await expect(dialog.getByText(/Mentioned by Ana Ruiz on /)).toBeVisible();
  await page.mouse.move(700, 100);
  await still(page, "comment-mentions-added");
  // Show comment closes the list and lands on the comment.
  await dialog.getByRole("button", { name: "Show comment" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(`#comment-${COMMENT_ID}`)).toBeFocused();
  await page.getByRole("button", { name: "1 person was added by a mention" })
    .click();
  await dialog.getByRole("button", { name: "Remove access for Samir Okafor" })
    .click();
  const confirm = page.getByRole("alertdialog");
  await expect(
    confirm.getByText("Remove Samir Okafor's access to this document?"),
  ).toBeVisible();
  await expect(
    confirm.getByText(
      "Samir Okafor will no longer be able to open this document. Their comments stay.",
    ),
  ).toBeVisible();
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await confirm.getByRole("button", { name: "Remove access" }).click();
  await expect.poll(() => state.revokes.length).toBe(1);
  expect(state.revokes[0]).toEqual({ principalId: SAMIR, ifMatch: '"v4"' });
  await expect(page.getByText("Removed Samir Okafor's access.")).toBeVisible();
  await expect(dialog.getByText("No one was added by a mention."))
    .toBeVisible();
});

test("the People added link is for someone who may share the document", async ({ page }) => {
  await open(page, world({ canShare: false, grants: [SAMIR_GRANT] }));
  await expect(page.getByRole("button", { name: /added by a mention/ }))
    .toHaveCount(0);
});
