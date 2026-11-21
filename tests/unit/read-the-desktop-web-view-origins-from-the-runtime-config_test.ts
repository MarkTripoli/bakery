import { assertEquals } from "@std/assert";
import {
  DESKTOP_WEB_VIEW_ORIGINS,
  readRuntimeConfig,
} from "../../packages/config/src/env.ts";

const base = {
  BAKERY_ENV: "test",
  BAKERY_APP_DATABASE_URL: "postgres://u:p@db.test:5432/bakery",
  BAKERY_PUBLIC_BASE_URL: "http://localhost:8000",
  BETTER_AUTH_SECRET: "x".repeat(40),
};

Deno.test("unset allows the three desktop web view origins and nothing else", () => {
  const config = readRuntimeConfig(base, "server");
  assertEquals(config.auth?.desktopOrigins, [
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
  ]);
  assertEquals(config.auth?.desktopOrigins, [...DESKTOP_WEB_VIEW_ORIGINS]);
  assertEquals(config.invalidConfig.includes("BAKERY_DESKTOP_ORIGINS"), false);
});

Deno.test("an empty value turns desktop origins off", () => {
  for (const value of ["", "   "]) {
    const config = readRuntimeConfig(
      { ...base, BAKERY_DESKTOP_ORIGINS: value },
      "server",
    );
    assertEquals(config.auth?.desktopOrigins, []);
    assertEquals(
      config.invalidConfig.includes("BAKERY_DESKTOP_ORIGINS"),
      false,
    );
  }
});

Deno.test("a list can narrow the origins, in any order and without duplicates", () => {
  const config = readRuntimeConfig(
    {
      ...base,
      BAKERY_DESKTOP_ORIGINS:
        " https://tauri.localhost , tauri://localhost,tauri://localhost",
    },
    "server",
  );
  assertEquals(config.auth?.desktopOrigins, [
    "https://tauri.localhost",
    "tauri://localhost",
  ]);
  assertEquals(config.invalidConfig.includes("BAKERY_DESKTOP_ORIGINS"), false);
});

Deno.test("any other origin is invalid, so an operator can never widen the list", () => {
  for (
    const value of [
      "*",
      "https://evil.example",
      "http://localhost:3000",
      "tauri://evil",
      "http://tauri.localhost:8080",
      "tauri://localhost/",
      "tauri://localhost, https://evil.example",
      "file://",
      "null",
    ]
  ) {
    const config = readRuntimeConfig(
      { ...base, BAKERY_DESKTOP_ORIGINS: value },
      "server",
    );
    assertEquals(
      config.invalidConfig.includes("BAKERY_DESKTOP_ORIGINS"),
      true,
      value,
    );
    // An invalid value never grants more than the three fixed origins.
    for (const origin of config.auth?.desktopOrigins ?? []) {
      assertEquals(DESKTOP_WEB_VIEW_ORIGINS.includes(origin), true, value);
    }
  }
});

Deno.test("the desktop origins are separate from the cookie trusted origins", () => {
  const config = readRuntimeConfig(base, "server");
  for (const origin of DESKTOP_WEB_VIEW_ORIGINS) {
    assertEquals(config.auth?.trustedOrigins.includes(origin), false, origin);
  }
});

Deno.test("only the server reads desktop origins", () => {
  assertEquals(readRuntimeConfig(base, "worker").auth, undefined);
});

Deno.test("an origin that only begins with or contains an allowed one is invalid, never accepted", () => {
  for (
    const value of [
      "tauri://localhost.evil.example",
      "tauri://localhost:1420",
      "tauri://localhostx",
      "tauri://local",
      "http://tauri.localhost.evil.example",
      "https://tauri.localhost.evil.example",
      "tauri://localhost,tauri://localhost.evil.example",
      "TAURI://LOCALHOST",
    ]
  ) {
    const config = readRuntimeConfig(
      { ...base, BAKERY_DESKTOP_ORIGINS: value },
      "server",
    );
    assertEquals(
      config.invalidConfig.includes("BAKERY_DESKTOP_ORIGINS"),
      true,
      value,
    );
    for (const origin of config.auth?.desktopOrigins ?? []) {
      assertEquals(DESKTOP_WEB_VIEW_ORIGINS.includes(origin), true, value);
    }
  }
});
