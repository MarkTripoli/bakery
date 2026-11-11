import type { ReactNode } from "react";
import "../artifacts.css";

export type ArtifactDiscussionProps = {
  readonly id?: string;
  readonly title: ReactNode;
  readonly count?: ReactNode;
  readonly location: ReactNode;
  readonly author: ReactNode;
  readonly initials: string;
  readonly timestamp: ReactNode;
  readonly body: ReactNode;
  readonly replies?: readonly {
    readonly id: string;
    readonly author: ReactNode;
    readonly body: ReactNode;
  }[];
  readonly actions?: ReactNode;
  readonly composer?: ReactNode;
  readonly notice?: ReactNode;
  readonly state?: "open" | "resolved" | "outdated" | "deleted";
};
export function ArtifactDiscussion(
  {
    id,
    title,
    count,
    location,
    author,
    initials,
    timestamp,
    body,
    replies = [],
    actions,
    composer,
    notice,
    state = "open",
  }: ArtifactDiscussionProps,
) {
  return (
    <article
      id={id}
      className="ui-artifact-discussion"
      data-ui-component="artifactDiscussion"
      data-state={state}
      data-variant="thread"
    >
      <header className="ui-artifact-discussion__heading">
        <h2>{title}</h2>
        {count !== undefined
          ? <span className="ui-artifact-chip">{count}</span>
          : null}
      </header>
      <div className="ui-artifact-caption">{location}</div>
      {notice ? <div role="status">{notice}</div> : null}
      <div className="ui-artifact-actions">
        <span className="ui-artifact-chip" aria-hidden="true">{initials}</span>
        <h2>{author}</h2>
        <span className="ui-artifact-caption">{timestamp}</span>
      </div>
      <div>{body}</div>
      {actions ? <div className="ui-artifact-actions">{actions}</div> : null}
      {replies.map((reply) => (
        <article className="ui-artifact-discussion__reply" key={reply.id}>
          <h2>{reply.author}</h2>
          <div className="ui-artifact-caption">{reply.body}</div>
        </article>
      ))}
      {composer}
    </article>
  );
}
