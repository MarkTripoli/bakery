import { assert, assertEquals } from "@std/assert";
import {
  defaultProviderKey,
  DESTINATION_PROVIDERS,
  destinationProvider,
  otlpProvider,
} from "../../apps/server/src/platform/telemetry-destinations/index.ts";

Deno.test("every provider has a unique key and plain words, and delivers through a kind the server has", () => {
  const keys = DESTINATION_PROVIDERS.map((p) => p.key);
  assertEquals(new Set(keys).size, keys.length);
  for (const entry of DESTINATION_PROVIDERS) {
    assert(entry.name.length > 0 && entry.description.length > 0, entry.key);
    assert(entry.description.endsWith("."), `${entry.key} is a sentence`);
    assertEquals(entry.kind, otlpProvider.descriptor.kind, entry.key);
    // A prefill names fields of its kind, so the chooser never fills a field
    // the form does not have.
    const fields = otlpProvider.descriptor.fields.map((f) => f.name);
    for (const field of Object.keys(entry.prefill)) {
      assert(fields.includes(field), `${entry.key} prefills ${field}`);
    }
    assertEquals(destinationProvider(entry.key), entry);
  }
});

Deno.test("a kind's default provider is its first, and an unknown key is not a provider", () => {
  assertEquals(defaultProviderKey("otlp"), "opentelemetry");
  assertEquals(defaultProviderKey("someday"), "someday");
  assertEquals(destinationProvider("splunk"), undefined);
  assertEquals(destinationProvider(""), undefined);
});
