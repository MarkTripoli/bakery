import { z } from "zod";
import { defineAction, defineIntegration } from "@bakery/integration-sdk";

const COMMENT_REF = { id: "github.issue.comment.create", version: 1 } as const;
const LIST_REF = { id: "github.issue.comments.list", version: 1 } as const;
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

/** Promoted native GitHub integration. The effect ledger and executor exist (modules/effects); it stays unrunnable until credentials are supplied and the consumers wire it. */
export const githubIntegration = defineIntegration({
  sdkVersion: 1,
  id: "bakery.github",
  version: "1.0.0",
  authenticationProfile: "github-app",
  bakery: { required: [], optional: [] },
  actions: [{ ...COMMENT_REF }],
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
  ],
  optionalFeatures: [],
  subscriptions: [],
}, {
  [`${COMMENT_REF.id}@${COMMENT_REF.version}`]: createComment,
});
