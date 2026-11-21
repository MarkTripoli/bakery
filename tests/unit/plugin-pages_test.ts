import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  parsePluginManifest,
  parsePluginPages,
  PLUGIN_PAGE_LIMITS,
  PluginManifestError,
} from "../../packages/contracts/src/plugin-sdk.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";
import {
  assertVersionPagesInBundle,
  PLUGIN_PAGE_CONTENT_SECURITY_POLICY,
  pluginPageDocumentHeaders,
  storedManifestPages,
} from "../../apps/server/src/modules/catalog/plugin-pages.ts";
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../../apps/server/src/platform/cursor.ts";
import {
  createUstarArchive,
  gzipFixture,
} from "../fixtures/remote-skill-source.ts";

/**
 * A plugin's own pages (#76, FS24): the manifest's page list is validated
 * strictly, a version cannot name a file its bundle lacks, and the document is
 * always served sealed.
 */

const encoder = new TextEncoder();
const page = {
  id: "release-checklist",
  title: "Release checklist",
  file: "pages/checklist.html",
};

function refusal(fn: () => unknown): string {
  const error = assertThrows(fn, PluginManifestError);
  return (error as PluginManifestError).code;
}

Deno.test("a manifest names its pages and the parsed manifest carries them", () => {
  const manifest = parsePluginManifest({
    name: "release-helper",
    requestedCapabilities: ["ui.page"],
    pages: [page],
  });
  assertEquals(manifest.pages, [page]);
  assertEquals(
    parsePluginManifest({ name: "release-helper", requestedCapabilities: [] })
      .pages,
    [],
  );
});

Deno.test("pages without ui.page are refused, as is a non-list", () => {
  assertEquals(
    refusal(() => parsePluginPages([page], [])),
    "PAGES_WITHOUT_UI_PAGE",
  );
  assertEquals(
    refusal(() => parsePluginPages({}, ["ui.page"])),
    "PAGES_NOT_A_LIST",
  );
  assertEquals(parsePluginPages([], []), []);
});

Deno.test("a page file cannot leave the bundle or be anything but html", () => {
  for (
    const file of [
      "../secret.html",
      "pages/../../x.html",
      "/etc/passwd.html",
      "./index.html",
      "pages//index.html",
      "pages\\index.html",
      "index.js",
      "manifest.json",
      ".hidden.html",
      "",
      "a".repeat(PLUGIN_PAGE_LIMITS.fileMaxLength) + ".html",
    ]
  ) {
    assertEquals(
      refusal(() => parsePluginPages([{ ...page, file }], ["ui.page"])),
      "PAGE_INVALID",
      file,
    );
  }
});

Deno.test("page ids, titles, keys and counts are bounded", () => {
  const caps = ["ui.page"];
  assertEquals(
    refusal(() => parsePluginPages([{ ...page, id: "Bad Id" }], caps)),
    "PAGE_INVALID",
  );
  assertEquals(
    refusal(() => parsePluginPages([{ ...page, id: "x".repeat(65) }], caps)),
    "PAGE_INVALID",
  );
  assertEquals(
    refusal(() => parsePluginPages([page, page], caps)),
    "PAGE_ID_DUPLICATE",
  );
  assertEquals(
    refusal(() => parsePluginPages([{ ...page, title: " padded" }], caps)),
    "PAGE_INVALID",
  );
  assertEquals(
    refusal(() => parsePluginPages([{ ...page, title: "x".repeat(81) }], caps)),
    "PAGE_INVALID",
  );
  // A bidirectional override would reorder the strip Bakery draws around it.
  assertEquals(
    refusal(() => parsePluginPages([{ ...page, title: "abc\u202Edef" }], caps)),
    "PAGE_INVALID",
  );
  assertEquals(
    refusal(() => parsePluginPages([{ ...page, script: "x" }], caps)),
    "PAGE_INVALID",
  );
  const many = Array.from(
    { length: PLUGIN_PAGE_LIMITS.maxPages + 1 },
    (_, n) => ({ ...page, id: `p${n}` }),
  );
  assertEquals(refusal(() => parsePluginPages(many, caps)), "PAGES_TOO_MANY");
});

Deno.test("a stored manifest with bad pages reads as no pages, not a failure", () => {
  assertEquals(storedManifestPages(null), []);
  assertEquals(storedManifestPages({ pages: [page] }), []);
  assertEquals(
    storedManifestPages({ requestedCapabilities: ["ui.page"], pages: "x" }),
    [],
  );
  assertEquals(
    storedManifestPages({ requestedCapabilities: ["ui.page"], pages: [page] }),
    [page],
  );
});

async function bundle(entries: Record<string, string>) {
  return await gzipFixture(createUstarArchive(
    Object.entries(entries).map(([path, text]) => ({
      path,
      content: encoder.encode(text),
    })),
  ));
}

Deno.test("publication refuses a page whose file the bundle does not carry", async () => {
  const manifest = { requestedCapabilities: ["ui.page"], pages: [page] };
  await assertVersionPagesInBundle(
    manifest,
    await bundle({ "pages/checklist.html": "<p>hi</p>" }),
  );
  const error = await assertRejects(
    async () =>
      assertVersionPagesInBundle(
        manifest,
        await bundle({ "pages/other.html": "x" }),
      ),
    StandardError,
  );
  assertEquals(
    (error as StandardError).params?.reason,
    "plugin_page_file_missing",
  );
  const notArchive = await assertRejects(
    () => assertVersionPagesInBundle(manifest, encoder.encode("not a tarball")),
    StandardError,
  );
  assertEquals(
    (notArchive as StandardError).params?.reason,
    "plugin_bundle_not_an_archive",
  );
  const badPages = await assertRejects(
    () => assertVersionPagesInBundle({ pages: [page] }, encoder.encode("x")),
    StandardError,
  );
  assertEquals(
    (badPages as StandardError).params?.reason,
    "plugin_manifest_pages_without_ui_page",
  );
  // A version that names no pages keeps its bundle opaque.
  await assertVersionPagesInBundle(
    { requestedCapabilities: [] },
    encoder.encode("opaque"),
  );
});

Deno.test("a page document is always served sealed", () => {
  const headers = pluginPageDocumentHeaders({
    locale: "ar-EG",
    length: 3,
    digest: "abc",
  });
  const csp = headers.get("Content-Security-Policy") ?? "";
  assertEquals(csp, PLUGIN_PAGE_CONTENT_SECURITY_POLICY);
  const directives = csp.split(";").map((part) => part.trim());
  assert(directives.includes("sandbox allow-scripts"));
  assert(directives.includes("default-src 'none'"));
  for (
    const token of [
      "allow-same-origin",
      "allow-top-navigation",
      "allow-forms",
      "allow-popups",
      "connect-src",
    ]
  ) {
    assert(!csp.includes(token), token);
  }
  assertEquals(headers.get("Content-Language"), "ar-EG");
  assertEquals(headers.get("Cache-Control"), "no-store");
  assertEquals(headers.get("X-Content-Type-Options"), "nosniff");
});

Deno.test("the pages cursor keeps the install time, id and page position", async () => {
  const secret = "x".repeat(48);
  const binding: CursorBinding = {
    action: "pluginPages.list",
    principalId: crypto.randomUUID(),
    organizationId: crypto.randomUUID(),
    ordering: "createdAt:asc,id:asc,position:asc",
    filters: "{}",
    schemaVersion: 1,
  };
  const position = {
    createdAt: "2026-11-20T10:00:00.123456Z",
    id: crypto.randomUUID(),
    position: 2,
  };
  const cursor = await encodeCursor(secret, binding, position);
  assertEquals(await decodeCursor(secret, cursor, binding), position);
  await assertRejects(() =>
    decodeCursor(secret, cursor, {
      ...binding,
      principalId: crypto.randomUUID(),
    })
  );
});
