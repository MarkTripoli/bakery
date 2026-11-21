import { assert, assertEquals } from "@std/assert";
import type {
  TicketReadFailure,
  TicketSourceHandle,
  TicketSourceReader,
} from "../../apps/server/src/modules/work/ticket-source-reader.ts";
import { ticketRef } from "../../apps/server/src/modules/work/ticket-source-reader.ts";
import { selectTicketSourceReader } from "../../apps/server/src/modules/work/ticket-reader-selection.ts";

/**
 * The seam that keeps one provider's reader off another provider's sources.
 *
 * The failure this guards against is quiet: before it existed, the app built one
 * reader and every source used it, so a source on a second provider had its keys,
 * labels and statuses interpreted by code written for the first. Nothing crashed;
 * the reads answered plausibly about the wrong system.
 */

const handle = (provider: string): TicketSourceHandle => ({
  organizationId: "org-1",
  connectionId: "connection-1",
  resourceId: "resource-1",
  provider,
  repositoryFullName: "acme/widgets",
  externalRepositoryId: "42",
});

const signal = () => new AbortController().signal;

/** Records which reader was asked, and answers something recognisable. */
function recordingReader(name: string): {
  reader: TicketSourceReader;
  calls: string[];
} {
  const calls: string[] = [];
  const note = (method: string) => {
    calls.push(`${name}:${method}`);
  };
  const reader: TicketSourceReader = {
    readIssue: (held) => {
      note(`readIssue:${held.provider}`);
      return Promise.resolve({ kind: "gone" });
    },
    readLinks: (held) => {
      note(`readLinks:${held.provider}`);
      return Promise.resolve({
        kind: "present",
        parent: null,
        subIssuesTotal: 0,
        blockedBy: [],
        blockingTotal: 0,
        truncated: false,
      });
    },
    readPredecessorProof: (held) => {
      note(`readPredecessorProof:${held.provider}`);
      return Promise.resolve({ kind: "open" });
    },
    readLabelProvenance: (held) => {
      note(`readLabelProvenance:${held.provider}`);
      return Promise.resolve({ kind: "absent" });
    },
    readActorRole: (held) => {
      note(`readActorRole:${held.provider}`);
      return Promise.resolve({ kind: "absent" });
    },
    readStatuses: (held) => {
      note(`readStatuses:${held.provider}`);
      return Promise.resolve({ kind: "unsupported" });
    },
    listIssues: (held) => {
      note(`listIssues:${held.provider}`);
      return Promise.resolve({ kind: "present", numbers: [], hasNext: false });
    },
    readLabels: (held) => {
      note(`readLabels:${held.provider}`);
      return Promise.resolve({ kind: "unsupported" });
    },
  };
  return { reader, calls };
}

const failClosed: TicketReadFailure = {
  kind: "unavailable",
  reason: "provider_error",
  retryAfterSeconds: null,
};

Deno.test("a source is read by the reader registered for its provider, not by another", async () => {
  const first = recordingReader("first");
  const second = recordingReader("second");
  const reader = selectTicketSourceReader(
    new Map([["first-provider", first.reader], [
      "second-provider",
      second.reader,
    ]]),
  );

  assertEquals(
    await reader.readIssue(handle("second-provider"), ticketRef(1), signal()),
    {
      kind: "gone",
    },
  );
  assertEquals(first.calls, [], "the other provider's reader was not asked");
  assertEquals(second.calls, ["second:readIssue:second-provider"]);
});

Deno.test("a provider with no reader fails closed on every read, never a plausible answer", async () => {
  const github = recordingReader("github");
  const reader = selectTicketSourceReader(new Map([["github", github.reader]]));
  // The source names a provider this build deploys no reader for: a Linear source
  // in a build that only reads GitHub, or a provider removed since the row was
  // written.
  const linear = handle("linear");

  assertEquals(
    await reader.readIssue(linear, ticketRef(1), signal()),
    failClosed,
  );
  assertEquals(
    await reader.readLinks(linear, ticketRef(1), signal()),
    failClosed,
  );
  assertEquals(
    await reader.readPredecessorProof(linear, {
      id: "1",
      number: 1,
      container: {
        kind: "repository",
        externalId: "42",
        displayName: "acme/widgets",
      },
    }, signal()),
    failClosed,
  );
  assertEquals(
    await reader.readLabelProvenance(
      linear,
      ticketRef(1),
      "bakery:execute",
      signal(),
    ),
    failClosed,
  );
  assertEquals(
    await reader.readActorRole(linear, "someone", signal()),
    failClosed,
  );
  assertEquals(
    await reader.readStatuses(linear, ticketRef(1), signal()),
    failClosed,
  );
  assertEquals(
    await reader.listIssues(linear, { page: 1, since: null }, signal()),
    failClosed,
  );
  assertEquals(
    await reader.readLabels(linear, { page: 1 }, signal()),
    failClosed,
  );

  assertEquals(
    github.calls,
    [],
    "the registered reader must not be used for another provider's source",
  );
});

Deno.test("the provider on the handle decides, even when two handles share a connection", async () => {
  // Two sources on one connection row cannot name different providers today, but
  // the seam must not assume it: it reads the handle's own slug, so a handle
  // built wrongly answers for the provider it claims, not for its neighbour.
  const github = recordingReader("github");
  const linear = recordingReader("linear");
  const reader = selectTicketSourceReader(
    new Map([["github", github.reader], ["linear", linear.reader]]),
  );
  assert(
    (await reader.readIssue(handle("linear"), ticketRef(1), signal())).kind ===
      "gone",
  );
  assertEquals(linear.calls, ["linear:readIssue:linear"]);
  assertEquals(github.calls, []);
});
