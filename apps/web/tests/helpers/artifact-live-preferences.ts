import { contractSchemas } from "@bakery/contracts/contracts";
import { expect, type Page } from "@playwright/test";
import { requestUntilAccepted } from "./api-retry.ts";

export async function setArtifactLocale(
  page: Page,
  organizationId: string,
  origin: string,
  locale: "en" | "ar-XB",
) {
  const headers = { "Bakery-Organization-Id": organizationId };
  const currentResponse = await requestUntilAccepted(() =>
    page.request.get("/v1/user-preferences", { headers })
  );
  expect(currentResponse.ok()).toBe(true);
  const current = contractSchemas.UserPreferences.parse(
    await currentResponse.json(),
  );
  const idempotencyKey = crypto.randomUUID();
  const updatedResponse = await requestUntilAccepted(() =>
    page.request.patch("/v1/user-preferences", {
      headers: {
        ...headers,
        Origin: origin,
        "Idempotency-Key": idempotencyKey,
      },
      data: { locale, expectedCasVersion: current.casVersion },
    })
  );
  expect(updatedResponse.ok()).toBe(true);
  const updated = contractSchemas.UserPreferences.parse(
    await updatedResponse.json(),
  );
  expect(updated.effectiveLocale).toBe(locale);
}
