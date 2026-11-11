import { useEffect, useState } from "react";
import type { OutputReplay } from "../api/output-replay.ts";

export function useDisplayedOutputDownload(
  batches: OutputReplay["batches"],
  forbidden: boolean,
): string | undefined {
  const [downloadUrl, setDownloadUrl] = useState<string | undefined>();
  useEffect(() => {
    if (batches.length === 0 || forbidden) {
      setDownloadUrl(undefined);
      return;
    }
    const blob = new Blob([
      batches.flatMap((batch) =>
        batch.parts.map((part) => `[${part.channel}] ${part.text}`)
      ).join("\n"),
    ], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    setDownloadUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [batches, forbidden]);
  return downloadUrl;
}
