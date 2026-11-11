import { createBakeryClient } from "../../packages/contracts/src/client.ts";
import type { WorkerFixture } from "./worker-execution.ts";

export function attemptBrowserClient(fixture: WorkerFixture) {
  return createBakeryClient({
    baseUrl: fixture.config.publicBaseUrl,
    getContext: () => ({ organizationId: fixture.organizationId }),
    fetch: (input, init) =>
      fixture.app.fetch(
        new Request(input, {
          ...init,
          headers: {
            ...Object.fromEntries(new Headers(init?.headers)),
            cookie: fixture.adminCookie,
          },
        }),
      ),
  });
}
