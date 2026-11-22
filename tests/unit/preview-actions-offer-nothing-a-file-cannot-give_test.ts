import { assert, assertEquals } from "@std/assert";
import {
  offersDownload,
  previewActions,
} from "../../apps/web/src/pages/preview-actions.ts";

const retry = { label: "Try again", onClick: () => {} };
const download = { label: "Download", onClick: () => {} };

Deno.test("a file fault earns no button, on a surface with or without Download", () => {
  // The task pane has no Download of its own. Before this rule it passed the
  // retry as the fallback action, so a damaged file offered "Try again" -- the
  // one promise a damaged file cannot keep (#437, UX review).
  for (
    const state of [
      { kind: "unreadable" },
      { kind: "unsupported" },
      { kind: "too-large", limit: 32 },
      { kind: "unchecked" },
      { kind: "mismatch" },
    ] as const
  ) {
    assertEquals(
      previewActions(state, { retry, download: undefined }),
      { action: undefined, secondaryAction: undefined },
    );
    assertEquals(previewActions(state, { retry, download }).action, download);
  }
});

Deno.test("a host that could not check the file earns Try again, and Download too", () => {
  assertEquals(
    previewActions({ kind: "host-unavailable" }, { retry, download }),
    { action: retry, secondaryAction: download },
  );
  // A surface without Download still offers the one thing that can help.
  assertEquals(
    previewActions({ kind: "host-unavailable" }, {
      retry,
      download: undefined,
    }),
    { action: retry, secondaryAction: undefined },
  );
});

Deno.test("a file that does not match its record is never offered", () => {
  assert(!offersDownload({ mismatch: true, contentRemoved: false }));
  assert(!offersDownload({ mismatch: false, contentRemoved: true }));
  assert(offersDownload({ mismatch: false, contentRemoved: false }));
});
