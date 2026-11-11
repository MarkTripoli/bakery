import { assertEquals } from "@std/assert";
import {
  operationFor,
  reportsFailure,
} from "../../apps/web/src/app/failure-attribution.ts";
import {
  createReportedQueryClient,
  QueryObserver,
  type ReportedFailure,
} from "../../apps/web/src/app/query-client.ts";

function recorder() {
  const failures: ReportedFailure[] = [];
  return {
    failures,
    client: createReportedQueryClient((failure) => failures.push(failure)),
  };
}

const failing = { kind: "network" };
const protectedKey = ["protected", 1, "org-1", "tasks.list", { page: 2 }];

Deno.test("a query key yields its operation and never an input", () => {
  assertEquals(operationFor(protectedKey), "tasks.list");
  assertEquals(operationFor(["public", "health", "ready"]), "health");
  assertEquals(
    operationFor(["connectedClients.revoke"]),
    "connectedClients.revoke",
  );
  assertEquals(
    operationFor(["public", "installation-capabilities"]),
    "installation-capabilities",
  );
  assertEquals(
    operationFor(["artifact", "private-title"]),
    "artifact",
    "an unrecognised shape reads its first segment, never a later input",
  );
});

Deno.test("an unnamed or implausible operation stays unknown", () => {
  assertEquals(operationFor(["protected", 7, "org-1"]), "unknown");
  assertEquals(
    operationFor(["protected", 7, "org-1", "Tasks.List"]),
    "unknown",
  );
  assertEquals(operationFor(["protected", 7, "org-1", "task:read"]), "unknown");
  assertEquals(operationFor(["public", 42]), "unknown");
});

Deno.test("an expected failure opts out of the report", () => {
  assertEquals(reportsFailure(undefined), true);
  assertEquals(reportsFailure({}), true);
  assertEquals(reportsFailure({ report: true }), true);
  assertEquals(reportsFailure({ report: false }), false);
  assertEquals(reportsFailure("report: false"), true);
});

Deno.test("a failed protected query is reported once with its operation", async () => {
  const { client, failures } = recorder();
  await client.fetchQuery({
    queryKey: protectedKey,
    queryFn: () => Promise.reject(failing),
    retry: false,
  }).catch(() => {});
  assertEquals(failures, [{
    source: "query",
    operation: "tasks.list",
    error: failing,
  }]);
});

Deno.test("a mutation reports the key it declares", async () => {
  const { client, failures } = recorder();
  const mutation = client.getMutationCache().build(client, {
    mutationKey: ["connectedClients.revoke"],
    mutationFn: () => Promise.reject(failing),
  });
  await mutation.execute(undefined).catch(() => {});
  assertEquals(failures, [{
    source: "mutation",
    operation: "connectedClients.revoke",
    error: failing,
  }]);
});

Deno.test("an opt-out holds for queries and mutations", async () => {
  const { client, failures } = recorder();
  await client.fetchQuery({
    queryKey: protectedKey,
    queryFn: () => Promise.reject(failing),
    meta: { report: false },
    retry: false,
  }).catch(() => {});
  const mutation = client.getMutationCache().build(client, {
    mutationKey: ["connectedClients.revoke"],
    mutationFn: () => Promise.reject(failing),
    meta: { report: false },
  });
  await mutation.execute(undefined).catch(() => {});
  assertEquals(failures, []);
});

Deno.test("an observer that declines the error still reports from the cache", async () => {
  const { client, failures } = recorder();
  const observer = new QueryObserver(client, {
    queryKey: protectedKey,
    queryFn: () => Promise.reject(failing),
    retry: false,
    throwOnError: () => false,
  });
  observer.subscribe(() => {});
  await client.fetchQuery({
    queryKey: protectedKey,
    queryFn: () => Promise.reject(failing),
    retry: false,
  }).catch(() => {});
  assertEquals(failures.length, 1);
  assertEquals(failures[0]?.operation, "tasks.list");
});

Deno.test("an observer that rethrows keeps the single channel", async () => {
  const { client, failures } = recorder();
  const observer = new QueryObserver(client, {
    queryKey: protectedKey,
    queryFn: () => Promise.reject(failing),
    retry: false,
    throwOnError: () => true,
  });
  observer.subscribe(() => {});
  await client.fetchQuery({
    queryKey: protectedKey,
    queryFn: () => Promise.reject(failing),
    retry: false,
  }).catch(() => {});
  assertEquals(failures, []);
});

// A mutation without a key reports `operation: "unknown"`, which is how the
// report stops naming what broke. Five of the application's mutations were
// keyless this way. Reading the sources keeps a new one from reintroducing it:
// the query-client tests above cannot see a hook that never declares a key.
const webSource = new URL("../../apps/web/src/", import.meta.url);

async function* typescriptSources(
  directory: URL,
): AsyncGenerator<{ path: string; source: string }> {
  for await (const entry of Deno.readDir(directory)) {
    const child = new URL(
      `${entry.name}${entry.isDirectory ? "/" : ""}`,
      directory,
    );
    if (entry.isDirectory) {
      yield* typescriptSources(child);
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      yield {
        path: child.pathname.slice(webSource.pathname.length),
        source: await Deno.readTextFile(child),
      };
    }
  }
}

/**
 * The options object literal passed to each `useMutation(` call, found by
 * balancing parentheses from the call so a nested object cannot end it early.
 */
function mutationCallBodies(source: string): string[] {
  const bodies: string[] = [];
  for (
    const match of source.matchAll(/\buseMutation\s*(?:<[\s\S]*?>)?\s*\(/g)
  ) {
    let depth = 0;
    for (
      let index = match.index + match[0].length - 1;
      index < source.length;
      index += 1
    ) {
      const character = source[index];
      if (character === "(") depth += 1;
      else if (character === ")") {
        depth -= 1;
        if (depth === 0) {
          bodies.push(source.slice(match.index, index + 1));
          break;
        }
      }
    }
  }
  return bodies;
}

Deno.test("every application mutation declares the operation it reports", async () => {
  const unnamed: string[] = [];
  let checked = 0;
  for await (const { path, source } of typescriptSources(webSource)) {
    for (const body of mutationCallBodies(source)) {
      checked += 1;
      // Either it names itself, or it opts out of reporting altogether.
      const named = /\bmutationKey\s*:/.test(body);
      const optedOut = /\bmeta\s*:\s*\{[^}]*\breport\s*:\s*false/.test(body);
      if (!named && !optedOut) unnamed.push(path);
    }
  }
  assertEquals(
    unnamed,
    [],
    'these useMutation calls would report operation "unknown"',
  );
  // Guards the scan itself: a regex that silently matched nothing would pass.
  assertEquals(checked > 0, true, "found no useMutation calls to check");
});

Deno.test("the mutation scan rejects a keyless hook and reads real options", () => {
  assertEquals(
    mutationCallBodies("const a = useMutation({ mutationFn: f });").length,
    1,
  );
  assertEquals(
    /\bmutationKey\s*:/.test(
      mutationCallBodies("useMutation({ mutationFn: f })")[0],
    ),
    false,
  );
  // A generic argument and a nested object must not truncate the body.
  const generic = mutationCallBodies(
    "useMutation<void, ApiFailure>({ meta: { report: false }, mutationFn: (x) => g(x) });",
  );
  assertEquals(generic.length, 1);
  assertEquals(
    /\bmeta\s*:\s*\{[^}]*\breport\s*:\s*false/.test(generic[0]),
    true,
  );
  assertEquals(
    /\bmutationKey\s*:/.test(
      mutationCallBodies(
        'useMutation({ mutationKey: ["a.b"], mutationFn: f })',
      )[0],
    ),
    true,
  );
});
