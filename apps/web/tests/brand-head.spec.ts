import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

const FAVICON_DIR = new URL("../../../assets/brand/favicon/", import.meta.url);
const THEME_CSS = new URL(
  "../../../packages/ui/src/foundations/theme.css",
  import.meta.url,
);

const FILES = [
  { name: "favicon.ico", types: ["image/x-icon", "image/vnd.microsoft.icon"] },
  { name: "favicon.svg", types: ["image/svg+xml"] },
  { name: "apple-touch-icon.png", types: ["image/png"] },
  { name: "icon-192.png", types: ["image/png"] },
  { name: "icon-512.png", types: ["image/png"] },
  { name: "icon-maskable-512.png", types: ["image/png"] },
  {
    name: "site.webmanifest",
    types: ["application/manifest+json", "application/json"],
  },
] as const;

const PNG_SIZES: Readonly<Record<string, number>> = {
  "apple-touch-icon.png": 180,
  "icon-192.png": 192,
  "icon-512.png": 512,
  "icon-maskable-512.png": 512,
};

// The first `--color-canvas` after the selector opens its rule block.
function canvasToken(css: string, selector: string): string {
  const block = css.slice(css.indexOf(selector));
  const match = block.match(/--color-canvas:\s*(#[0-9A-Fa-f]{6})/);
  if (match === null) throw new Error(`no --color-canvas under ${selector}`);
  return match[1].toLowerCase();
}

function pngSize(bytes: Buffer): { width: number; height: number } {
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test.describe("brand head and favicon set", () => {
  test("links the favicon set and theme-color from the canvas tokens", async ({ page }) => {
    const css = await readFile(THEME_CSS, "utf8");
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const head = await page.evaluate(() => ({
      icons: [...document.querySelectorAll("link[rel='icon']")].map((link) => ({
        href: link.getAttribute("href"),
        type: link.getAttribute("type"),
        sizes: link.getAttribute("sizes"),
      })),
      apple: document.querySelector("link[rel='apple-touch-icon']")
        ?.getAttribute("href"),
      manifest: document.querySelector("link[rel='manifest']")
        ?.getAttribute("href"),
      themeColors: [...document.querySelectorAll("meta[name='theme-color']")]
        .map((meta) => ({
          media: meta.getAttribute("media"),
          content: meta.getAttribute("content")?.toLowerCase(),
        })),
    }));
    expect(head.icons).toContainEqual({
      href: "/favicon.ico",
      type: null,
      sizes: "32x32",
    });
    expect(head.icons).toContainEqual({
      href: "/favicon.svg",
      type: "image/svg+xml",
      sizes: null,
    });
    expect(head.apple).toBe("/apple-touch-icon.png");
    expect(head.manifest).toBe("/site.webmanifest");
    expect(head.themeColors).toEqual([
      {
        media: "(prefers-color-scheme: light)",
        content: canvasToken(css, ':root,\n[data-theme="light"]'),
      },
      {
        media: "(prefers-color-scheme: dark)",
        content: canvasToken(css, '[data-theme="dark"]'),
      },
    ]);
  });

  for (const { name, types } of FILES) {
    test(`serves ${name} byte-identical to assets/brand/favicon`, async ({ request }) => {
      const response = await request.get(`/${name}`);
      expect(response.status()).toBe(200);
      const contentType = response.headers()["content-type"] ?? "";
      expect(types.some((type) => contentType.startsWith(type))).toBe(true);
      const served = await response.body();
      const source = await readFile(new URL(name, FAVICON_DIR));
      expect(served.equals(source)).toBe(true);
    });
  }

  test("favicon.svg has a prefers-color-scheme dark block", async ({ request }) => {
    const svg = await (await request.get("/favicon.svg")).text();
    expect(svg).toMatch(/@media\s*\(prefers-color-scheme:\s*dark\)/);
  });

  test("PNG icons have the declared pixel sizes", async ({ request }) => {
    for (const [name, size] of Object.entries(PNG_SIZES)) {
      const bytes = await (await request.get(`/${name}`)).body();
      expect(pngSize(bytes), name).toEqual({ width: size, height: size });
    }
  });

  test("manifest icons resolve", async ({ request }) => {
    const manifest = await (await request.get("/site.webmanifest")).json() as {
      icons: { src: string; sizes: string; type: string }[];
    };
    expect(manifest.icons.length).toBeGreaterThan(0);
    for (const icon of manifest.icons) {
      const response = await request.get(
        new URL(icon.src, "http://manifest.invalid/").pathname,
      );
      expect(response.status(), icon.src).toBe(200);
      const { width } = pngSize(await response.body());
      expect(icon.sizes).toBe(`${width}x${width}`);
    }
  });
});
