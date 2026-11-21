import { assertEquals } from "@std/assert";
import {
  cookieAttributeName,
  safeSetCookies,
} from "../../apps/server/src/modules/knowledge/previews/running-host.ts";

function through(...cookies: string[]): string[] {
  const headers = new Headers();
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return safeSetCookies(headers);
}

Deno.test("an attribute's name is what a browser reads: before the first =, trimmed of space and tabs, lower-cased", () => {
  assertEquals(cookieAttributeName("Domain=x"), "domain");
  assertEquals(cookieAttributeName(" Domain =x"), "domain");
  assertEquals(cookieAttributeName("  domain= x"), "domain");
  assertEquals(cookieAttributeName("DOMAIN\t=x"), "domain");
  assertEquals(cookieAttributeName("\tDomain\t"), "domain");
  assertEquals(cookieAttributeName("Domain"), "domain");
  assertEquals(cookieAttributeName("Max-Age=5=6"), "max-age");
  assertEquals(cookieAttributeName("Domainx=1"), "domainx");
  assertEquals(cookieAttributeName("Subdomain=1"), "subdomain");
});

Deno.test("a cookie that names a Domain, in any spelling, never leaves the preview's own origin", () => {
  const dropped = [
    "a=1; Domain=localhost",
    "a=1; Domain =localhost",
    "a=1;  domain= x",
    "a=1; DOMAIN\t=x",
    "a=1;\tDomain\t=\tx",
    "a=1; Domain",
    "a=1; DOMAIN;",
    "a=1;domain=x",
    "a=1; Path=/; DOMAIN=localhost; Secure",
    "a=1; HttpOnly; Domain =.example.test; SameSite=Lax",
  ];
  for (const cookie of dropped) assertEquals(through(cookie), [], cookie);
  // One bad cookie does not take its neighbours with it.
  assertEquals(through("keep=1; Path=/", "a=1; Domain =x", "also=2"), [
    "keep=1; Path=/",
    "also=2",
  ]);
});

Deno.test("every other cookie and attribute passes through exactly as the app sent it", () => {
  const kept = [
    "mine=1; Path=/; HttpOnly; Secure; SameSite=Lax",
    "a=b; path=/x; max-age=5",
    "a=b; Expires=Wed, 21 Oct 2026 07:28:00 GMT; SameSite=None; Secure",
    // A cookie whose NAME is domain is a cookie, not an attribute.
    "domain=notanattribute",
    "a=b; Domainx=1",
    "a=b; Subdomain=1",
    "a=b; Partitioned",
  ];
  assertEquals(through(...kept), kept);
  assertEquals(through(), []);
});
