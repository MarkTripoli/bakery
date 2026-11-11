import {
  readWorkerEnvironment,
  readWorkerLaunchPermissions,
} from "../src/config.ts";

const environment = readWorkerEnvironment();
const root = decodeURIComponent(new URL("../../..", import.meta.url).pathname)
  .replace(/\/$/, "");
const permissions = readWorkerLaunchPermissions(environment, root);
for (
  const grant of [
    permissions.read,
    permissions.write,
    permissions.net,
    permissions.run,
    permissions.sys,
  ]
) {
  console.log(grant.join(","));
}
