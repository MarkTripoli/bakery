import { assertEquals, assertRejects } from "@std/assert";
import { GitHubReadFailure } from "../../apps/server/src/modules/integrations/github-transport.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";
import { createFetchGitHubAppClient } from "../../apps/server/src/modules/integrations/github-app.ts";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const MERGED = "fedcba9876543210fedcba9876543210fedcba98";
const signal = () => new AbortController().signal;

/** One scripted GitHub answer, and the request it was asked to answer. */
function scripted(respond: (request: Request) => Promise<Response>) {
  const seen: { method: string; url: string; body: unknown }[] = [];
  const client = createFetchGitHubAppClient(async (input, init) => {
    const request = new Request(input, init);
    const text = await request.clone().text();
    seen.push({
      method: request.method,
      url: request.url,
      body: text === "" ? null : JSON.parse(text),
    });
    return await respond(request);
  });
  return {
    client,
    seen,
    merge: () =>
      client.mergePullRequest(
        {
          token: "ghs_fake",
          fullName: "acme/widgets",
          number: 12,
          headSha: HEAD,
          mergeMethod: "squash",
        },
        signal(),
      ),
  };
}

Deno.test("a merge sends the expected head as GitHub's own precondition", async () => {
  const github = scripted(() =>
    Promise.resolve(Response.json({
      merged: true,
      sha: MERGED,
      message: "Pull Request successfully merged",
    }))
  );
  const outcome = await github.merge();
  assertEquals(outcome, { kind: "merged", mergedSha: MERGED });
  assertEquals(github.seen.length, 1);
  assertEquals(github.seen[0].method, "PUT");
  assertEquals(
    github.seen[0].url,
    "https://api.github.com/repos/acme/widgets/pulls/12/merge",
  );
  // The expected head travels as `sha`, so GitHub itself refuses a moved head.
  assertEquals(github.seen[0].body, { sha: HEAD, merge_method: "squash" });
});

Deno.test("GitHub's refusal answers are refusals, not failures to retry", async () => {
  for (
    const [status, label] of [
      [405, "not mergeable"],
      [409, "the head moved"],
      [422, "not mergeable as asked"],
    ] as const
  ) {
    const github = scripted(() =>
      Promise.resolve(
        Response.json({ message: `refused: ${label}` }, { status }),
      )
    );
    assertEquals(await github.merge(), { kind: "refused", status }, label);
    // A refusal is GitHub's answer: exactly one merge request was sent.
    assertEquals(github.seen.length, 1, label);
  }
});

Deno.test("a merge GitHub answers 200 on without merging is still a refusal", async () => {
  const github = scripted(() =>
    Promise.resolve(Response.json({ merged: false, sha: HEAD }))
  );
  assertEquals(await github.merge(), { kind: "refused", status: 200 });
});

Deno.test("a lost answer is unknown, never a silent failure and never a retry", async () => {
  // A dropped connection: the request may have arrived, so nothing here says
  // the merge did not happen.
  const dropped = scripted(() => Promise.reject(new TypeError("network down")));
  assertEquals(await dropped.merge(), { kind: "unknown" });
  assertEquals(dropped.seen.length, 1);

  // This client's own deadline after the request went out is the same fact.
  let sent = 0;
  const hanging = createFetchGitHubAppClient(
    (_input, init) => {
      sent += 1;
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
        );
      });
    },
    { requestTimeoutMs: 25 },
  );
  assertEquals(
    await hanging.mergePullRequest(
      {
        token: "ghs_fake",
        fullName: "acme/widgets",
        number: 12,
        headSha: HEAD,
        mergeMethod: "merge",
      },
      signal(),
    ),
    { kind: "unknown" },
  );
  assertEquals(sent, 1);
});

Deno.test("a refused credential is a failure, not an unknown outcome", async () => {
  const github = scripted(() =>
    Promise.resolve(Response.json({ message: "Bad credentials" }, {
      status: 401,
    }))
  );
  const error = await assertRejects(() => github.merge(), GitHubReadFailure);
  assertEquals(error.kind, "rejected");
});

Deno.test("an unsafe head or method is refused before any request", async () => {
  const github = scripted(() =>
    Promise.resolve(Response.json({ merged: true }))
  );
  for (
    const request of [
      {
        token: "ghs_fake",
        fullName: "acme/widgets",
        number: 12,
        headSha: "not-a-sha",
        mergeMethod: "merge" as const,
      },
      {
        token: "ghs_fake",
        fullName: "acme/widgets",
        number: 12,
        headSha: HEAD,
        mergeMethod: "cherry-pick" as unknown as "merge",
      },
    ]
  ) {
    await assertRejects(
      () => github.client.mergePullRequest(request, signal()),
      StandardError,
    );
  }
  assertEquals(github.seen.length, 0);
});
