import { z } from "zod";
import { defineAction, defineIntegration } from "@bakery/integration-sdk";

const COMMENT_REF = { id: "github.issue.comment.create", version: 1 } as const;
const UPDATE_REF = { id: "github.issue.comment.update", version: 1 } as const;

/** The action that writes Bakery's status note on an issue (#69): the comment action. */
export const TICKET_NOTE_ACTION = COMMENT_REF;
/** The action that rewrites Bakery's status note in place (#69). */
export const TICKET_NOTE_UPDATE_ACTION = UPDATE_REF;
const LIST_REF = { id: "github.issue.comments.list", version: 1 } as const;
const CREATE_ISSUE_REF = { id: "github.issue.create", version: 1 } as const;
const ISSUES_LIST_REF = { id: "github.issues.list", version: 1 } as const;
const LABELS_ADD_REF = { id: "github.issue.labels.add", version: 1 } as const;
const LABEL_REMOVE_REF = {
  id: "github.issue.label.remove",
  version: 1,
} as const;
const LABELS_LIST_REF = { id: "github.issue.labels.list", version: 1 } as const;

/** The action that creates an issue (#32): one remote ticket, found again by its effect marker. */
export const TICKET_CREATE_ACTION = CREATE_ISSUE_REF;
/** The action that adds Bakery-owned labels to an issue without touching the others (#32). */
export const TICKET_LABELS_ADD_ACTION = LABELS_ADD_REF;
/** The action that removes one Bakery-owned label from an issue without touching the others (#32). */
export const TICKET_LABEL_REMOVE_ACTION = LABEL_REMOVE_REF;
const MAX_PAGES = 20;
const PAGE_SIZE = 100;

const issueNumber = (description: string) =>
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER).describe(
    description,
  );

const commentInput = z.strictObject({
  issueNumber: issueNumber(
    "Positive issue number within the already-authorized repository; not a global GitHub issue id.",
  ),
  body: z.string().min(1).max(16_000).refine(
    (body) => !/<!--\s*bakery-effect:/i.test(body),
    "Reserved effect marker",
  ).describe(
    "Comment Markdown to publish, 1 to 16000 characters; Bakery effect markers are reserved for the executor.",
  ),
}).describe(
  "Authorized issue-comment write arguments; repository identity and effect authority come from trusted context.",
);

const commentReceipt = z.strictObject({
  remoteId: z.string().regex(/^[1-9][0-9]*$/).describe(
    "Confirmed GitHub comment id as a decimal string for later reconciliation.",
  ),
}).describe(
  "Safe comment write receipt exposing only the confirmed provider identity.",
);

const orNull = <T extends z.ZodType>(inner: T, description: string) =>
  z.union([
    inner,
    z.null().describe("Null when the provider omitted the value."),
  ]).describe(description);

const providerComment = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).describe(
    "GitHub comment id used to confirm the provider effect.",
  ),
  body: orNull(
    z.string().describe(
      "Provider-returned comment text inspected for the exact effect marker.",
    ),
    "Provider-returned comment text, or null when unavailable; null can never prove a marker match.",
  ),
  user: orNull(
    z.object({
      id: z.number().int().describe(
        "GitHub author user id compared with the configured installation bot identity.",
      ),
      type: z.string().describe(
        "GitHub account type; recovery requires the exact value Bot.",
      ),
    }).describe(
      "Provider-reported author identity used to verify Bakery authored the comment.",
    ),
    "Provider-reported author, or null when unavailable; null can never prove Bakery authorship.",
  ),
}).describe(
  "Provider comment projection used for effect verification; unrelated provider fields are discarded.",
);

const commentPage = z.array(providerComment).max(PAGE_SIZE).describe(
  "One provider page of comments inspected for the effect marker and bot author.",
);

const marker = (effectId: string) =>
  `<!-- bakery-effect:${
    z.uuid().describe(
      "Durable Bakery effect uuid embedded in a comment for duplicate-safe recovery.",
    ).parse(effectId)
  } -->`;

const createComment = defineAction({
  id: COMMENT_REF.id,
  version: COMMENT_REF.version,
  input: commentInput,
  output: commentReceipt,
  effect: "reconcile",
  resourceKind: "github.repository",
  requests: [COMMENT_REF],
  reconcileRequests: [LIST_REF],
  providerPermissions: { issues: "write" },
  resourceProjection: ["botUserId"],
  async execute(ctx, input) {
    const raw = await ctx.provider.request(COMMENT_REF, {
      issue_number: input.issueNumber,
      body: `${input.body}\n\n${marker(ctx.effect.id)}`,
    });
    const comment = providerComment.parse(raw);
    return { remoteId: String(comment.id) };
  },
  async reconcile(ctx) {
    const botUserId = ctx.resource.botUserId;
    if (typeof botUserId !== "number") return { status: "uncertain" };
    const wanted = marker(ctx.effect.id);
    const matches = new Set<string>();
    for (let page = 1; page <= MAX_PAGES; page++) {
      const items = commentPage.parse(
        await ctx.provider.request(LIST_REF, {
          issue_number: ctx.input.issueNumber,
          per_page: PAGE_SIZE,
          page,
        }),
      );
      for (const item of items) {
        if (
          item.user?.id === botUserId && item.user.type === "Bot" &&
          item.body?.split("\n").includes(wanted)
        ) matches.add(String(item.id));
      }
      if (items.length < PAGE_SIZE) {
        const [only] = [...matches];
        return matches.size === 1 && only
          ? { status: "confirmed", result: { remoteId: only } }
          : { status: "uncertain" };
      }
    }
    // Truncation, absence or several matches cannot prove the POST never happened.
    return { status: "uncertain" };
  },
});

/** True only when every page of the issue's comments was read and none has the id. */
async function commentAbsent(
  ctx: {
    provider: {
      request(ref: typeof LIST_REF, input: unknown): Promise<unknown>;
    };
  },
  issue: number,
  id: string,
): Promise<boolean> {
  for (let page = 1; page <= MAX_PAGES; page++) {
    const items = commentPage.parse(
      await ctx.provider.request(LIST_REF, {
        issue_number: issue,
        per_page: PAGE_SIZE,
        page,
      }),
    );
    if (items.some((item) => String(item.id) === id)) return false;
    if (items.length < PAGE_SIZE) return true;
  }
  // Truncated: absence is not proven.
  return false;
}

const updateReceipt = z.union([
  commentReceipt,
  z.strictObject({
    missing: z.literal(true).describe(
      "The rewrite was refused and a full read of the issue's comments shows the comment no longer exists.",
    ),
  }).describe("Receipt for a note comment confirmed deleted on the provider."),
]).describe(
  "Comment rewrite receipt: the confirmed comment id, or a confirmed absence.",
);

const commentId = z.string().regex(/^[1-9][0-9]{0,19}$/).describe(
  "GitHub comment id as a decimal string, as an earlier create receipt returned it.",
);

const updateInput = z.strictObject({
  issueNumber: issueNumber(
    "Issue the comment belongs to, read to confirm the comment is gone when the rewrite is refused.",
  ),
  commentId,
  body: z.string().min(1).max(16_000).refine(
    (body) => !/<!--\s*bakery-effect:/i.test(body),
    "Reserved effect marker",
  ).describe(
    "Replacement comment Markdown, 1 to 16000 characters; Bakery effect markers are reserved for the executor.",
  ),
}).describe(
  "Authorized comment rewrite arguments: which comment of the bound repository and its new text.",
);

const updateComment = defineAction({
  id: UPDATE_REF.id,
  version: UPDATE_REF.version,
  input: updateInput,
  output: updateReceipt,
  // The ledger settles every write by reading, so an update names how: the
  // comment carrying the new text confirms it, a full read without the comment
  // confirms it gone, and anything else stays uncertain.
  effect: "reconcile",
  resourceKind: "github.repository",
  requests: [UPDATE_REF, LIST_REF],
  reconcileRequests: [LIST_REF],
  providerPermissions: { issues: "write" },
  resourceProjection: [],
  async reconcile(ctx) {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const items = commentPage.parse(
        await ctx.provider.request(LIST_REF, {
          issue_number: ctx.input.issueNumber,
          per_page: PAGE_SIZE,
          page,
        }),
      );
      const found = items.find((item) =>
        String(item.id) === ctx.input.commentId
      );
      if (found) {
        return found.body === ctx.input.body
          ? {
            status: "confirmed",
            result: { remoteId: ctx.input.commentId },
          }
          : { status: "uncertain" };
      }
      if (items.length < PAGE_SIZE) {
        return { status: "confirmed", result: { missing: true as const } };
      }
    }
    return { status: "uncertain" };
  },
  async execute(ctx, input) {
    let raw: unknown;
    try {
      raw = await ctx.provider.request(UPDATE_REF, {
        comment_id: input.commentId,
        body: input.body,
      });
    } catch (error) {
      // The broker hides the status of a refusal, so a 404 and a 403 look
      // alike. Only a full read of the issue's comments that lacks the id
      // proves the comment is gone; anything else keeps the refusal.
      if (await commentAbsent(ctx, input.issueNumber, input.commentId)) {
        return { missing: true as const };
      }
      throw error;
    }
    const comment = providerComment.parse(raw);
    return { remoteId: String(comment.id) };
  },
});

const labelName = z.string().min(1).max(50).refine(
  // Well-formed text only: an unpaired surrogate cannot be sent to GitHub and
  // would fail late with an unclassified error instead of a refusal here.
  (name) =>
    name.isWellFormed() &&
    [...name].every((char) => {
      const code = char.codePointAt(0)!;
      return code >= 0x20 && code !== 0x7f;
    }),
  "A label name is well-formed text with no control characters",
).describe(
  "GitHub label name, 1 to 50 characters of well-formed text with no control characters; matched exactly and case-sensitively.",
);

/**
 * An optional list of at most 20 labels. The text is stated once and set on
 * both schema nodes: the activation audit requires a description on the array
 * and on its optional wrapper.
 */
const optionalLabels = (description: string) =>
  z.array(labelName).max(20).describe(description).optional().describe(
    description,
  );

const createIssueInput = z.strictObject({
  title: z.string().min(1).max(256).describe(
    "Issue title, 1 to 256 characters.",
  ),
  body: z.string().min(1).max(16_000).refine(
    (body) => !/<!--\s*bakery-effect:/i.test(body),
    "Reserved effect marker",
  ).describe(
    "Issue Markdown, 1 to 16000 characters; Bakery effect markers are reserved for the executor.",
  ),
  labels: optionalLabels(
    "Labels to put on the new issue, at most 20; labels the repository does not have are created by GitHub.",
  ),
}).describe(
  "Authorized issue creation arguments; repository identity and effect authority come from trusted context.",
);

const createIssueReceipt = z.strictObject({
  remoteId: z.string().regex(/^[1-9][0-9]*$/).describe(
    "Issue number inside the bound repository as a decimal string.",
  ),
  issueId: z.string().regex(/^[1-9][0-9]*$/).describe(
    "GitHub's immutable issue id as a decimal string, the identity that survives a transfer or a rename.",
  ),
}).describe(
  "Safe issue creation receipt exposing only the confirmed provider identity.",
);

const providerIssue = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).describe(
    "GitHub's immutable issue id.",
  ),
  number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).describe(
    "Issue number inside its repository.",
  ),
  body: orNull(
    z.string().describe(
      "Provider-returned issue text inspected for the exact effect marker.",
    ),
    "Provider-returned issue text, or null when unavailable; null can never prove a marker match.",
  ),
  user: orNull(
    z.object({
      id: z.number().int().describe(
        "GitHub author user id compared with the configured installation bot identity.",
      ),
      type: z.string().describe(
        "GitHub account type; recovery requires the exact value Bot.",
      ),
    }).describe(
      "Provider-reported author identity used to verify Bakery authored the issue.",
    ),
    "Provider-reported author, or null when unavailable; null can never prove Bakery authorship.",
  ),
}).describe(
  "Provider issue projection used for effect verification; unrelated provider fields are discarded.",
);

const issuePage = z.array(providerIssue).max(PAGE_SIZE).describe(
  "One provider page of issues inspected for the effect marker and bot author.",
);

const createIssue = defineAction({
  id: CREATE_ISSUE_REF.id,
  version: CREATE_ISSUE_REF.version,
  input: createIssueInput,
  output: createIssueReceipt,
  effect: "reconcile",
  resourceKind: "github.repository",
  requests: [CREATE_ISSUE_REF],
  reconcileRequests: [ISSUES_LIST_REF],
  providerPermissions: { issues: "write" },
  resourceProjection: ["botUserId"],
  async execute(ctx, input) {
    const raw = await ctx.provider.request(CREATE_ISSUE_REF, {
      title: input.title,
      body: `${input.body}\n\n${marker(ctx.effect.id)}`,
      ...(input.labels === undefined ? {} : { labels: input.labels }),
    });
    const issue = providerIssue.parse(raw);
    return { remoteId: String(issue.number), issueId: String(issue.id) };
  },
  /**
   * A lost response is settled by reading the repository's newest issues for the
   * effect marker written by the installation's bot. Exactly one match confirms
   * it; none, several or a truncated read leave it uncertain, so absence never
   * authorizes a second POST.
   */
  async reconcile(ctx) {
    const botUserId = ctx.resource.botUserId;
    if (typeof botUserId !== "number") return { status: "uncertain" };
    const wanted = marker(ctx.effect.id);
    const matches = new Map<string, string>();
    for (let page = 1; page <= MAX_PAGES; page++) {
      const items = issuePage.parse(
        await ctx.provider.request(ISSUES_LIST_REF, {
          state: "all",
          sort: "created",
          direction: "desc",
          per_page: PAGE_SIZE,
          page,
        }),
      );
      for (const item of items) {
        if (
          item.user?.id === botUserId && item.user.type === "Bot" &&
          item.body?.split("\n").includes(wanted)
        ) matches.set(String(item.number), String(item.id));
      }
      if (items.length < PAGE_SIZE) {
        const [only] = [...matches];
        return matches.size === 1 && only
          ? {
            status: "confirmed",
            result: { remoteId: only[0], issueId: only[1] },
          }
          : { status: "uncertain" };
      }
    }
    return { status: "uncertain" };
  },
});

const labelsInput = z.strictObject({
  issueNumber: issueNumber(
    "Positive issue number within the already-authorized repository; not a global GitHub issue id.",
  ),
  labels: z.array(labelName).min(1).max(20).describe(
    "Labels to add, 1 to 20; labels already on the issue stay and are not duplicated.",
  ),
}).describe(
  "Authorized label addition arguments: which issue of the bound repository and the labels to add.",
);

const labelRemoveInput = z.strictObject({
  issueNumber: issueNumber(
    "Positive issue number within the already-authorized repository; not a global GitHub issue id.",
  ),
  label: labelName,
}).describe(
  "Authorized label removal arguments: which issue of the bound repository and the one label to remove.",
);

const labelsReceipt = z.strictObject({
  labels: z.array(labelName).max(100).describe(
    "Names of the labels the issue carries after the change, at most 100.",
  ),
}).describe(
  "Safe label change receipt exposing only the label names now on the issue.",
);

const providerLabels = z.array(
  z.object({ name: labelName }).describe(
    "Provider label projection; only the name is read.",
  ),
).max(PAGE_SIZE).describe(
  "Labels GitHub reports on the issue, at most one page of 100.",
);

const labelNames = (raw: unknown): string[] =>
  providerLabels.parse(raw).map((label) => label.name);

const addLabels = defineAction({
  id: LABELS_ADD_REF.id,
  version: LABELS_ADD_REF.version,
  input: labelsInput,
  output: labelsReceipt,
  // Adding a label the issue already carries changes nothing, and the other
  // labels are never named, so a person's labels stay. A lost response is
  // settled by reading: every requested label on the issue confirms it.
  effect: "reconcile",
  resourceKind: "github.repository",
  requests: [LABELS_ADD_REF],
  reconcileRequests: [LABELS_LIST_REF],
  providerPermissions: { issues: "write" },
  resourceProjection: [],
  async reconcile(ctx) {
    const names = labelNames(
      await ctx.provider.request(LABELS_LIST_REF, {
        issue_number: ctx.input.issueNumber,
        per_page: PAGE_SIZE,
      }),
    );
    // A full page may hide the label on the next one: not proof of anything.
    if (names.length >= PAGE_SIZE) return { status: "uncertain" };
    return ctx.input.labels.every((label) => names.includes(label))
      ? { status: "confirmed", result: { labels: names } }
      : { status: "uncertain" };
  },
  async execute(ctx, input) {
    const raw = await ctx.provider.request(LABELS_ADD_REF, {
      issue_number: input.issueNumber,
      labels: input.labels,
    });
    return { labels: labelNames(raw) };
  },
});

const removeLabel = defineAction({
  id: LABEL_REMOVE_REF.id,
  version: LABEL_REMOVE_REF.version,
  input: labelRemoveInput,
  output: labelsReceipt,
  // A lost response is settled by reading: the label no longer on the issue
  // confirms the removal.
  effect: "reconcile",
  resourceKind: "github.repository",
  requests: [LABEL_REMOVE_REF, LABELS_LIST_REF],
  reconcileRequests: [LABELS_LIST_REF],
  providerPermissions: { issues: "write" },
  resourceProjection: [],
  async reconcile(ctx) {
    const names = labelNames(
      await ctx.provider.request(LABELS_LIST_REF, {
        issue_number: ctx.input.issueNumber,
        per_page: PAGE_SIZE,
      }),
    );
    if (names.length >= PAGE_SIZE) return { status: "uncertain" };
    return names.includes(ctx.input.label)
      ? { status: "uncertain" }
      : { status: "confirmed", result: { labels: names } };
  },
  async execute(ctx, input) {
    try {
      const raw = await ctx.provider.request(LABEL_REMOVE_REF, {
        issue_number: input.issueNumber,
        name: input.label,
      });
      return { labels: labelNames(raw) };
    } catch (error) {
      // GitHub refuses removing a label the issue does not carry, and the
      // broker hides the status of a refusal. Only a read that shows the label
      // absent makes this a repeat of a removal already done.
      const raw = await ctx.provider.request(LABELS_LIST_REF, {
        issue_number: input.issueNumber,
        per_page: PAGE_SIZE,
      });
      const names = labelNames(raw);
      if (names.length < PAGE_SIZE && !names.includes(input.label)) {
        return { labels: names };
      }
      throw error;
    }
  },
});

const updateRequestInput = z.strictObject({
  comment_id: commentId,
  body: z.string().min(1).max(16_000).describe(
    "Replacement comment Markdown sent as the JSON body.",
  ),
}).describe("Comment rewrite request input: comment id and its new text.");

const updateBody = z.strictObject({
  body: z.string().min(1).max(16_000).describe(
    "Replacement comment Markdown sent as the JSON body of the rewrite request.",
  ),
}).describe("JSON body of the comment rewrite request.");

const createRequestInput = z.strictObject({
  issue_number: issueNumber(
    "Issue number placed in the request path; the host fills owner and repository from the bound resource.",
  ),
  body: z.string().min(1).max(16_100).describe(
    "Comment Markdown including the Bakery effect marker appended by the action.",
  ),
}).describe("Comment creation request input: issue number and comment text.");

const listRequestInput = z.strictObject({
  issue_number: issueNumber(
    "Issue number placed in the request path; the host fills owner and repository from the bound resource.",
  ),
  per_page: z.number().int().min(1).max(PAGE_SIZE).describe(
    "Number of comments per provider page, between 1 and 100.",
  ),
  page: z.number().int().min(1).max(MAX_PAGES).describe(
    "One-based provider page number, capped at the recovery scan limit.",
  ),
}).describe("Comment listing request input: issue number and paging.");

const commentBody = z.strictObject({
  body: z.string().min(1).max(16_100).describe(
    "Comment Markdown sent as the JSON body of the creation request.",
  ),
}).describe("JSON body of the comment creation request.");

const createIssueRequestInput = z.strictObject({
  title: z.string().min(1).max(256).describe(
    "Issue title sent in the JSON body.",
  ),
  body: z.string().min(1).max(16_100).describe(
    "Issue Markdown including the Bakery effect marker appended by the action.",
  ),
  labels: optionalLabels("Labels sent in the JSON body, at most 20."),
}).describe("Issue creation request input: title, text and optional labels.");

const issuesListRequestInput = z.strictObject({
  state: z.literal("all").describe(
    "Issue state filter; recovery reads every state so a closed issue is found too.",
  ),
  sort: z.literal("created").describe(
    "Sort key; newest created first, where a lost creation is found.",
  ),
  direction: z.literal("desc").describe("Sort direction, newest first."),
  per_page: z.number().int().min(1).max(PAGE_SIZE).describe(
    "Number of issues per provider page, between 1 and 100.",
  ),
  page: z.number().int().min(1).max(MAX_PAGES).describe(
    "One-based provider page number, capped at the recovery scan limit.",
  ),
}).describe("Issue listing request input: filter, order and paging.");

const labelsAddRequestInput = z.strictObject({
  issue_number: issueNumber(
    "Issue number placed in the request path; the host fills owner and repository from the bound resource.",
  ),
  labels: z.array(labelName).min(1).max(20).describe(
    "Labels to add, sent as the JSON body.",
  ),
}).describe("Label addition request input: issue number and labels.");

const labelsAddBody = z.strictObject({
  labels: z.array(labelName).min(1).max(20).describe(
    "Labels to add; existing labels on the issue stay.",
  ),
}).describe("JSON body of the label addition request.");

const labelRemoveRequestInput = z.strictObject({
  issue_number: issueNumber(
    "Issue number placed in the request path; the host fills owner and repository from the bound resource.",
  ),
  name: labelName,
}).describe("Label removal request input: issue number and the label name.");

const labelsListRequestInput = z.strictObject({
  issue_number: issueNumber(
    "Issue number placed in the request path; the host fills owner and repository from the bound resource.",
  ),
  per_page: z.number().int().min(1).max(PAGE_SIZE).describe(
    "Number of labels per provider page, between 1 and 100.",
  ),
}).describe("Issue label listing request input: issue number and page size.");

/** Promoted native GitHub integration. The effect ledger and executor exist (modules/effects); it stays unrunnable until credentials are supplied and the consumers wire it. */
export const githubIntegration = defineIntegration({
  sdkVersion: 1,
  id: "bakery.github",
  version: "1.0.0",
  authenticationProfile: "github-app",
  bakery: { required: [], optional: [] },
  actions: [
    { ...COMMENT_REF },
    { ...UPDATE_REF },
    { ...CREATE_ISSUE_REF },
    { ...LABELS_ADD_REF },
    { ...LABEL_REMOVE_REF },
  ],
  resourceKinds: ["github.repository"],
  requests: [
    {
      ...COMMENT_REF,
      method: "POST",
      effect: "write",
      idempotent: false,
      resourceKind: "github.repository",
      pathTemplate: "/repos/{owner}/{repo}/issues/{issue_number}/comments",
      pathParams: {
        owner: "binding:owner",
        repo: "binding:repo",
        issue_number: "input",
      },
      input: createRequestInput,
      query: [],
      body: commentBody,
      response: providerComment,
      maxResponseBytes: 524_288,
      providerPermissions: { issues: "write" },
    },
    {
      ...LIST_REF,
      method: "GET",
      effect: "read",
      idempotent: true,
      resourceKind: "github.repository",
      pathTemplate: "/repos/{owner}/{repo}/issues/{issue_number}/comments",
      pathParams: {
        owner: "binding:owner",
        repo: "binding:repo",
        issue_number: "input",
      },
      input: listRequestInput,
      query: ["per_page", "page"],
      response: commentPage,
      maxResponseBytes: 8_388_608,
      providerPermissions: { issues: "read" },
    },
    {
      ...UPDATE_REF,
      method: "PATCH",
      effect: "write",
      idempotent: true,
      resourceKind: "github.repository",
      pathTemplate: "/repos/{owner}/{repo}/issues/comments/{comment_id}",
      pathParams: {
        owner: "binding:owner",
        repo: "binding:repo",
        comment_id: "input",
      },
      input: updateRequestInput,
      query: [],
      body: updateBody,
      response: providerComment,
      maxResponseBytes: 524_288,
      providerPermissions: { issues: "write" },
    },
    {
      ...CREATE_ISSUE_REF,
      method: "POST",
      effect: "write",
      idempotent: false,
      resourceKind: "github.repository",
      pathTemplate: "/repos/{owner}/{repo}/issues",
      pathParams: { owner: "binding:owner", repo: "binding:repo" },
      input: createIssueRequestInput,
      query: [],
      body: createIssueRequestInput,
      response: providerIssue,
      maxResponseBytes: 524_288,
      providerPermissions: { issues: "write" },
    },
    {
      ...ISSUES_LIST_REF,
      method: "GET",
      effect: "read",
      idempotent: true,
      resourceKind: "github.repository",
      pathTemplate: "/repos/{owner}/{repo}/issues",
      pathParams: { owner: "binding:owner", repo: "binding:repo" },
      input: issuesListRequestInput,
      query: ["state", "sort", "direction", "per_page", "page"],
      response: issuePage,
      maxResponseBytes: 8_388_608,
      providerPermissions: { issues: "read" },
    },
    {
      ...LABELS_ADD_REF,
      method: "POST",
      effect: "write",
      idempotent: true,
      resourceKind: "github.repository",
      pathTemplate: "/repos/{owner}/{repo}/issues/{issue_number}/labels",
      pathParams: {
        owner: "binding:owner",
        repo: "binding:repo",
        issue_number: "input",
      },
      input: labelsAddRequestInput,
      query: [],
      body: labelsAddBody,
      response: providerLabels,
      maxResponseBytes: 524_288,
      providerPermissions: { issues: "write" },
    },
    {
      ...LABEL_REMOVE_REF,
      method: "DELETE",
      effect: "write",
      idempotent: true,
      resourceKind: "github.repository",
      pathTemplate: "/repos/{owner}/{repo}/issues/{issue_number}/labels/{name}",
      pathParams: {
        owner: "binding:owner",
        repo: "binding:repo",
        issue_number: "input",
        name: "input-text",
      },
      input: labelRemoveRequestInput,
      query: [],
      response: providerLabels,
      maxResponseBytes: 524_288,
      providerPermissions: { issues: "write" },
    },
    {
      ...LABELS_LIST_REF,
      method: "GET",
      effect: "read",
      idempotent: true,
      resourceKind: "github.repository",
      pathTemplate: "/repos/{owner}/{repo}/issues/{issue_number}/labels",
      pathParams: {
        owner: "binding:owner",
        repo: "binding:repo",
        issue_number: "input",
      },
      input: labelsListRequestInput,
      query: ["per_page"],
      response: providerLabels,
      maxResponseBytes: 524_288,
      providerPermissions: { issues: "read" },
    },
  ],
  optionalFeatures: [],
  subscriptions: [],
}, {
  [`${COMMENT_REF.id}@${COMMENT_REF.version}`]: createComment,
  [`${UPDATE_REF.id}@${UPDATE_REF.version}`]: updateComment,
  [`${CREATE_ISSUE_REF.id}@${CREATE_ISSUE_REF.version}`]: createIssue,
  [`${LABELS_ADD_REF.id}@${LABELS_ADD_REF.version}`]: addLabels,
  [`${LABEL_REMOVE_REF.id}@${LABEL_REMOVE_REF.version}`]: removeLabel,
});
