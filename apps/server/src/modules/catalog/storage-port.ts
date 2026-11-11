export type SkillObject = Readonly<{
  objectKey: string;
  sha256: string;
  sizeBytes: number;
}>;

export interface SkillObjectStore {
  putIfAbsent(
    objectKey: string,
    content: Uint8Array,
    expectedSha256: string,
  ): Promise<void>;
  read(
    objectKey: string,
    expectedSha256: string,
    expectedSize: number,
  ): Promise<Uint8Array>;
  recover(
    objectKey: string,
    expectedSha256: string,
    expectedSize: number,
  ): Promise<void>;
  list(): AsyncIterable<SkillObject>;
}

export class SkillFileStoreError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SkillFileStoreError";
  }
}

export function assertSkillObjectKey(key: string): void {
  if (
    !/^organizations\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\/skill-versions\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\/sha256\/[0-9a-f]{64}$/
      .test(key)
  ) {
    throw new SkillFileStoreError("SKILL_FILE_KEY_INVALID");
  }
}
