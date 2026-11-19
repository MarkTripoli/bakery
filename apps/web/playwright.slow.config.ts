// Local only (not committed): the same config with waits sized for a host that
// is busy with other jobs.
import base from "./playwright.config.ts";

export default {
  ...base,
  workers: 1,
  expect: { timeout: 45_000 },
};
