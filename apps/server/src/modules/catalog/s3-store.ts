import { createHash } from "node:crypto";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import {
  assertSkillObjectKey,
  SkillFileStoreError,
  type SkillObject,
  type SkillObjectStore,
} from "./storage-port.ts";

export function mapSkillS3Error(error: unknown): SkillFileStoreError {
  if (error instanceof SkillFileStoreError) return error;
  if (
    error instanceof S3ServiceException &&
    error.$metadata.httpStatusCode === 404
  ) {
    return new SkillFileStoreError("SKILL_FILE_NOT_FOUND");
  }
  // Provider errors can contain credentials, signed requests or endpoint details.
  return new SkillFileStoreError("SKILL_FILE_DEPENDENCY_UNAVAILABLE");
}

export class S3SkillObjectStore implements SkillObjectStore {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async putIfAbsent(
    key: string,
    content: Uint8Array,
    expectedSha256: string,
  ): Promise<void> {
    assertSkillObjectKey(key);
    const hash = createHash("sha256").update(content);
    const digest = hash.digest("hex");
    if (digest !== expectedSha256 || key.slice(-64) !== expectedSha256) {
      throw new SkillFileStoreError("SKILL_CONTENT_INTEGRITY_FAILED");
    }
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: content,
          IfNoneMatch: "*",
          ChecksumSHA256: createHash("sha256").update(content).digest("base64"),
        }),
      );
    } catch (error) {
      if (
        error instanceof S3ServiceException &&
        (error.$metadata.httpStatusCode === 412 ||
          (error.$metadata.httpStatusCode === 409 &&
            error.name === "ConditionalRequestConflict"))
      ) {
        try {
          await this.read(key, expectedSha256, content.byteLength);
        } catch (readError) {
          if (
            readError instanceof SkillFileStoreError &&
            readError.code === "SKILL_CONTENT_INTEGRITY_FAILED"
          ) {
            throw new SkillFileStoreError("SKILL_OBJECT_DIGEST_CONFLICT");
          }
          if (
            readError instanceof SkillFileStoreError &&
            readError.code === "SKILL_FILE_NOT_FOUND"
          ) {
            throw new SkillFileStoreError("SKILL_FILE_DEPENDENCY_UNAVAILABLE");
          }
          throw mapSkillS3Error(readError);
        }
        return;
      }
      // A lost successful response is recovered on the next deterministic retry.
      throw mapSkillS3Error(error);
    }
  }

  async read(
    key: string,
    expectedSha256: string,
    expectedSize: number,
  ): Promise<Uint8Array> {
    assertSkillObjectKey(key);
    try {
      const result = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
          ChecksumMode: "ENABLED",
        }),
      );
      if (!result.Body) {
        throw new SkillFileStoreError("SKILL_CONTENT_INTEGRITY_FAILED");
      }
      const bytes = await result.Body.transformToByteArray();
      const hash = createHash("sha256").update(bytes).digest("hex");
      const checksum = createHash("sha256").update(bytes).digest("base64");
      if (
        bytes.length !== expectedSize || hash !== expectedSha256 ||
        (result.ChecksumSHA256 !== undefined &&
          result.ChecksumSHA256 !== checksum)
      ) {
        throw new SkillFileStoreError("SKILL_CONTENT_INTEGRITY_FAILED");
      }
      return bytes;
    } catch (error) {
      throw mapSkillS3Error(error);
    }
  }

  async recover(key: string, digest: string, size: number): Promise<void> {
    await this.read(key, digest, size);
  }

  async *list(): AsyncIterable<SkillObject> {
    let token: string | undefined;
    do {
      try {
        const page = await this.client.send(
          new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: "organizations/",
            ContinuationToken: token,
          }),
        );
        for (const item of page.Contents ?? []) {
          if (!item.Key || item.Size === undefined) {
            throw new SkillFileStoreError("SKILL_CONTENT_INTEGRITY_FAILED");
          }
          assertSkillObjectKey(item.Key);
          yield {
            objectKey: item.Key,
            sha256: item.Key.slice(-64),
            sizeBytes: item.Size,
          };
        }
        if (
          page.IsTruncated &&
          (!page.NextContinuationToken || page.NextContinuationToken === token)
        ) {
          throw new SkillFileStoreError("SKILL_FILE_DEPENDENCY_UNAVAILABLE");
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } catch (error) {
        throw mapSkillS3Error(error);
      }
    } while (token);
  }
}
