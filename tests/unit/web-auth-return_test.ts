import { assertEquals } from "@std/assert";
import {
  AUTH_RETURN_TO_KEY,
  consumeReturnTo,
  postSignInDestination,
  rememberDestination,
  rememberReturnTo,
} from "../../apps/web/src/app/auth-return.ts";

function recordingStorage() {
  const entries = new Map<string, string>();
  return {
    entries,
    setItem(key: string, value: string) {
      entries.set(key, value);
    },
    getItem(key: string): string | null {
      return entries.get(key) ?? null;
    },
    removeItem(key: string) {
      entries.delete(key);
    },
  };
}

Deno.test("return path keeps one same-origin deep link", () => {
  const storage = recordingStorage();
  assertEquals(
    rememberReturnTo(
      {
        pathname: "/settings/appearance",
        search: "?tab=theme",
        hash: "#colors",
      },
      storage,
    ),
    "/settings/appearance?tab=theme#colors",
  );
  assertEquals(
    storage.entries.get(AUTH_RETURN_TO_KEY),
    "/settings/appearance?tab=theme#colors",
  );
});

Deno.test("rememberDestination reassembles a TanStack ParsedLocation into a stored deep link", () => {
  const storage = recordingStorage();
  assertEquals(
    rememberDestination(
      { pathname: "/settings/appearance", searchStr: "?tab=a", hash: "x" },
      storage,
    ),
    "/settings/appearance?tab=a#x",
  );
  assertEquals(
    storage.entries.get(AUTH_RETURN_TO_KEY),
    "/settings/appearance?tab=a#x",
  );

  assertEquals(
    rememberDestination(
      { pathname: "/settings/appearance", searchStr: "", hash: "" },
      storage,
    ),
    "/settings/appearance",
  );
  assertEquals(
    storage.entries.get(AUTH_RETURN_TO_KEY),
    "/settings/appearance",
  );
});

Deno.test("protocol-relative and unavailable storage never store a target", () => {
  const storage = recordingStorage();
  assertEquals(
    rememberReturnTo(
      { pathname: "//evil.example", search: "", hash: "" },
      storage,
    ),
    null,
  );
  assertEquals(
    rememberReturnTo({ pathname: "/a", search: "", hash: "" }, null),
    null,
  );
  assertEquals(storage.entries.size, 0);

  const failing = {
    setItem() {
      throw new DOMException("quota", "QuotaExceededError");
    },
  };
  assertEquals(
    rememberReturnTo({ pathname: "/a", search: "", hash: "" }, failing),
    null,
  );
});

Deno.test("consumeReturnTo reads a stored target exactly once", () => {
  const storage = recordingStorage();
  storage.entries.set(AUTH_RETURN_TO_KEY, "/settings/appearance?tab=theme");
  assertEquals(consumeReturnTo(storage), "/settings/appearance?tab=theme");
  assertEquals(storage.entries.has(AUTH_RETURN_TO_KEY), false);
  assertEquals(consumeReturnTo(storage), null);
});

Deno.test("consumeReturnTo refuses a protocol-relative target and still clears it", () => {
  const storage = recordingStorage();
  storage.entries.set(AUTH_RETURN_TO_KEY, "//evil.example");
  assertEquals(consumeReturnTo(storage), null);
  assertEquals(storage.entries.has(AUTH_RETURN_TO_KEY), false);
});

Deno.test("consumeReturnTo tolerates an empty or unavailable storage", () => {
  const storage = recordingStorage();
  assertEquals(consumeReturnTo(storage), null);
  assertEquals(consumeReturnTo(null), null);

  const failing = {
    getItem() {
      throw new DOMException("unavailable", "SecurityError");
    },
    removeItem() {},
  };
  assertEquals(consumeReturnTo(failing), null);
});

Deno.test("consumeReturnTo refuses an absolute cross-origin target and still clears it", () => {
  const storage = recordingStorage();
  storage.entries.set(AUTH_RETURN_TO_KEY, "https://evil.example/x");
  assertEquals(consumeReturnTo(storage), null);
  assertEquals(storage.entries.has(AUTH_RETURN_TO_KEY), false);
});

Deno.test("the WHATWG backslash-as-slash trick is refused by remember and consume", () => {
  const storage = recordingStorage();
  assertEquals(
    rememberReturnTo(
      { pathname: "/\\evil.example", search: "", hash: "" },
      storage,
    ),
    null,
  );
  assertEquals(storage.entries.size, 0);

  storage.entries.set(AUTH_RETURN_TO_KEY, "/\\evil.example");
  assertEquals(consumeReturnTo(storage), null);
  assertEquals(storage.entries.has(AUTH_RETURN_TO_KEY), false);
});

Deno.test("postSignInDestination lets a public deep link win over the organization chooser", () => {
  const publicReturnTo = recordingStorage();
  publicReturnTo.entries.set(AUTH_RETURN_TO_KEY, "/invitations/abc-123");
  assertEquals(
    postSignInDestination({ outcome: "choose", storage: publicReturnTo }),
    "/invitations/abc-123",
  );
  assertEquals(publicReturnTo.entries.has(AUTH_RETURN_TO_KEY), false);

  const protectedReturnTo = recordingStorage();
  protectedReturnTo.entries.set(
    AUTH_RETURN_TO_KEY,
    "/settings/appearance?tab=theme",
  );
  assertEquals(
    postSignInDestination({ outcome: "choose", storage: protectedReturnTo }),
    "/organizations",
  );
  assertEquals(
    protectedReturnTo.entries.get(AUTH_RETURN_TO_KEY),
    "/settings/appearance?tab=theme",
  );

  const selected = recordingStorage();
  selected.entries.set(AUTH_RETURN_TO_KEY, "/settings/appearance");
  assertEquals(
    postSignInDestination({ outcome: "selected", storage: selected }),
    "/settings/appearance",
  );
  assertEquals(selected.entries.has(AUTH_RETURN_TO_KEY), false);
});
