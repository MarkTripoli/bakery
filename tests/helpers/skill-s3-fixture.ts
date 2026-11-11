import { createSkillS3Client } from "../../apps/server/src/modules/catalog/storage-backend.ts";
import type { S3Client } from "@aws-sdk/client-s3";
import { S3SkillObjectStore } from "../../apps/server/src/modules/catalog/s3-store.ts";

export async function openSkillS3Fixture() {
  if (!Deno.env.get("DOCKER_HOST")) throw new Error("DOCKER_HOST_REQUIRED");
  const project = `e05-r2-${crypto.randomUUID().slice(0, 8)}`;
  const compose = async (...args: string[]) => {
    const result = await new Deno.Command("docker", {
      args: [
        "compose",
        "-f",
        "infra/compose.yaml",
        "-p",
        project,
        "--profile",
        "s3-fixture",
        ...args,
      ],
      env: { BETTER_AUTH_SECRET: "e05-r2-test-only-not-production-secret" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!result.success) {
      throw new Error(`S3_FIXTURE_COMPOSE_FAILED_${result.code}`);
    }
    return new TextDecoder().decode(result.stdout).trim();
  };
  let client: S3Client | undefined;
  try {
    await compose("up", "-d", "s3-fixture");
    const address = await compose("port", "s3-fixture", "9090");
    const endpoint = `http://${address}`;
    let ready = false;
    for (let attempt = 0; attempt < 90; attempt++) {
      try {
        const response = await fetch(endpoint, {
          signal: AbortSignal.timeout(1000),
        });
        await response.body?.cancel();
        ready = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    if (!ready) throw new Error("S3_FIXTURE_START_TIMEOUT");
    client = createSkillS3Client({ endpoint }, {
      accessKeyId: "fixture-only",
      secretAccessKey: "fixture-only-secret",
    });
    const bucket = "bakery-skill-fixture";
    return {
      client,
      bucket,
      endpoint,
      store: new S3SkillObjectStore(client, bucket),
      async close() {
        client?.destroy();
        await compose("down", "-v", "--remove-orphans");
      },
    };
  } catch (error) {
    client?.destroy();
    await compose("down", "-v", "--remove-orphans");
    throw error;
  }
}
