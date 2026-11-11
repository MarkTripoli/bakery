import { useState } from "react";
import { ArtifactDiscussion, Button } from "@bakery/ui";

export const artifactMarkdown =
  "# Durable artifact delivery\n\nArtifacts survive worker restarts. Each revision keeps its content digest, run provenance, and review discussion.\n\n## Verification\n\n- Immutable revisions retain their SHA-256.\n- Downloads verify bytes before saving.\n- Comments remain linked to their original revision.\n\n## Retention\n\nPin revisions that must remain available. Expired content keeps its provenance and discussion.";

export function ArtifactDiscussionExample() {
  const [resolved, setResolved] = useState(false);
  const [reply, setReply] = useState("");
  const [replies, setReplies] = useState([{
    id: "reply-1",
    author: "Sam Rivera · reply",
    body: "Yes. Revision 3 is the audit reference.",
  }]);
  return (
    <ArtifactDiscussion
      title="Discussion"
      count={replies.length + 1}
      location="Revision 3 / Retention"
      author="Alex Lee"
      initials="AL"
      timestamp="5 min ago"
      body="Can we keep the release evidence pinned until the audit is complete?"
      state={resolved ? "resolved" : "open"}
      replies={replies}
      actions={
        <Button
          variant="secondary"
          onClick={() => setResolved(!resolved)}
        >
          {resolved ? "Reopen" : "Resolve"}
        </Button>
      }
      composer={
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!reply.trim()) return;
            setReplies([...replies, {
              id: `reply-${replies.length + 1}`,
              author: "You · reply",
              body: reply,
            }]);
            setReply("");
          }}
        >
          <textarea
            aria-label="Reply to discussion"
            placeholder="Write a reply…"
            value={reply}
            onChange={(event) => setReply(event.currentTarget.value)}
          />
          <Button type="submit" disabled={!reply.trim()}>Send reply</Button>
        </form>
      }
    />
  );
}
