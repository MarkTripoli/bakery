export type RetentionClass = "transient" | "evidence";
export type PublicationSource = "import" | "worker" | "archive";

export function publicationRetention(
  source: PublicationSource,
  artifactType: string,
): RetentionClass {
  switch (source) {
    case "import":
      return "evidence";
    case "archive":
      return "transient";
    case "worker":
      return artifactType === "log" || artifactType === "other"
        ? "transient"
        : "evidence";
  }
}

export function retentionExpiry(
  retentionClass: RetentionClass,
  createdAt: Date,
): Date {
  return new Date(
    createdAt.getTime() +
      (retentionClass === "transient" ? 30 : 180) * 86400000,
  );
}

export function isTerminalTask(status: string): boolean {
  return status === "completed" || status === "failed" || status === "canceled";
}
