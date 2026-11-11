import { relatedIssue, validateDescription } from "./validate.ts";

type Request = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<unknown>;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("GitHub returned malformed metadata.");
  }
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("GitHub returned missing text metadata.");
  }
  return value;
}

function sha(value: unknown): string {
  const result = string(value);
  if (!/^[a-f0-9]{40}$/.test(result)) {
    throw new Error("GitHub returned an invalid commit SHA.");
  }
  return result;
}

function number(value: string): number {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error("Expected a positive issue or PR number.");
  }
  return Number(value);
}

export function githubRequest(repository: string, token: string): Request {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !token) {
    throw new Error("Set GITHUB_REPOSITORY and GH_TOKEN or GITHUB_TOKEN.");
  }
  return async (method, path, body) => {
    const response = await fetch(
      "https://api.github.com/repos/" + repository + path,
      {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
        redirect: "error",
      },
    );
    if (!response.ok) {
      throw new Error("GitHub " + method + " failed: HTTP " + response.status);
    }
    return response.status === 204 ? null : await response.json();
  };
}

async function issue(api: Request, id: number) {
  const data = object(await api("GET", "/issues/" + id));
  if (data.pull_request) {
    throw new Error("The owning work item must be an issue, not a PR.");
  }
  if (!Array.isArray(data.labels)) {
    throw new Error("GitHub returned missing labels.");
  }
  const labels = data.labels.map((label) => string(object(label).name)).sort();
  return {
    number: id,
    title: string(data.title),
    body: data.body === null ? "" : string(data.body),
    labels,
    kind: labels.includes("epic") ? "epic" as const : "issue" as const,
  };
}

async function pull(api: Request, id: number) {
  const data = object(await api("GET", "/pulls/" + id));
  const base = object(data.base);
  return {
    number: id,
    title: string(data.title),
    body: data.body === null ? "" : string(data.body),
    head: sha(object(data.head).sha),
    base: sha(base.sha),
    baseRef: string(base.ref),
  };
}

async function fingerprint(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function inspect(api: Request, kind: "issue" | "pr", id: number) {
  if (kind === "issue") {
    const item = await issue(api, id);
    return { item, errors: validateDescription(item.kind, item.body) };
  }
  const item = await pull(api, id);
  const errors = validateDescription("pr", item.body);
  const owner = relatedIssue(item.body);
  const linked = owner ? await issue(api, owner) : undefined;
  if (linked) {
    if (linked.kind === "epic") {
      errors.push("Link an executable work item, not its epic.");
    }
    errors.push(
      ...validateDescription(linked.kind, linked.body).map((error) =>
        "Ticket #" + owner + ": " + error
      ),
    );
  }
  return { item, linked, errors };
}

// Metadata checks do not grant execution or merge authority. Call from trusted
// intake/merge code immediately before acting; retain these inspected identities.
export async function checkLive(
  api: Request,
  kind: "issue" | "pr",
  id: number,
) {
  const first = await inspect(api, kind, id);
  const second = await inspect(api, kind, id);
  const digest = await fingerprint(first);
  if (digest !== await fingerprint(second)) {
    first.errors.push(
      "Metadata changed during validation; recheck before action.",
    );
  }
  return { ...first, fingerprint: digest, ok: first.errors.length === 0 };
}

if (import.meta.main) {
  const [command, kind, rawId] = Deno.args;
  const api = githubRequest(
    Deno.env.get("GITHUB_REPOSITORY") ?? "",
    Deno.env.get("GITHUB_TOKEN") ?? Deno.env.get("GH_TOKEN") ?? "",
  );
  if (
    command !== "check" || (kind !== "issue" && kind !== "pr") ||
    Deno.args.length !== 3
  ) {
    throw new Error("Usage: github.ts check issue|pr <number>");
  }
  const result = await checkLive(api, kind, number(rawId));
  // Do not print API-supplied bodies/titles or credentials into Actions logs.
  console.log(JSON.stringify(
    {
      ok: result.ok,
      number: result.item.number,
      head: "head" in result.item ? result.item.head : undefined,
      base: "base" in result.item ? result.item.base : undefined,
      fingerprint: result.fingerprint,
      errors: result.errors,
    },
    null,
    2,
  ));
  if (!result.ok) Deno.exit(1);
}
