import { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ArtifactViewer, Stack } from "@bakery/ui";
import { artifactMarkdown } from "../fixtures/artifact.tsx";
const meta = {
  title: "Bakery/Organisms/ArtifactViewer",
  parameters: { catalogId: "ui.artifactViewer", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;
export const Contract: StoryObj = {
  render: () => {
    const [src, setSrc] = useState("");
    useEffect(() => {
      const bytes = Uint8Array.from(
        atob(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a23sAAAAASUVORK5CYII=",
        ),
        (character) => character.charCodeAt(0),
      );
      const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
      setSrc(url);
      return () => URL.revokeObjectURL(url);
    }, []);
    return (
      <Stack>
        <ArtifactViewer
          label="Preview · Markdown"
          content={{ kind: "markdown", text: artifactMarkdown }}
        />
        <ArtifactViewer
          label="Preview · Text"
          content={{
            kind: "text",
            text: "<script>globalThis.artifactExecuted = true</script>",
          }}
        />
        <ArtifactViewer
          label="Preview · Patch"
          content={{
            kind: "patch",
            text: "--- a/evidence.ts\n+++ b/evidence.ts\n-volatile\n+durable",
          }}
        />
        <ArtifactViewer
          label="Preview · Log"
          content={{
            kind: "log",
            text: "12:00:00 worker started\n12:00:01 revision published",
          }}
        />
        <ArtifactViewer
          label="Preview · Image"
          content={{
            kind: "image",
            src,
            alt: "Verified PNG fixture",
            unavailableLabel: "Image unavailable",
          }}
        />
        <ArtifactViewer
          label="Download only"
          content={{
            kind: "unsupported",
            message: "This media type cannot be previewed.",
          }}
        />
        <ArtifactViewer
          label="Loading preview"
          content={{
            kind: "text",
            text: "Must not render before verification",
          }}
          state="loading"
        />
        <ArtifactViewer
          label="Digest verification failed"
          content={{
            kind: "text",
            text: "Must not render after verification failure",
          }}
          state="error"
        />
        <ArtifactViewer
          label="Untrusted Markdown"
          content={{
            kind: "markdown",
            text:
              '# Safe heading\n\n<script>globalThis.artifactExecuted = true</script>\n\n<img src=x onerror="globalThis.artifactExecuted=true">\n\n[Unsafe](javascript:alert%281%29)\n\n[Encoded](java&#x73;cript:alert%281%29)\n\n![Remote](https://example.test/tracker.png)\n\n[Safe link](https://example.test/docs)\n\n**Bold text** and `inline code`',
          }}
        />
      </Stack>
    );
  },
};
