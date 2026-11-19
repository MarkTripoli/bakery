/** What the server tells everyone about one participant (one tab or session). */
export type Participant = Readonly<{
  participantKey: string;
  principalId: string;
  principalType: "human" | "service" | "worker";
  displayName: string;
  state: Readonly<{
    activity: "active" | "background" | "idle";
    typing: boolean;
    cursor: Readonly<{ anchor: string; head: string }> | null;
  }>;
  receivedAt: string;
}>;

/** One person or agent, however many tabs they have open. */
export type Person = Readonly<{
  principalId: string;
  principalType: Participant["principalType"];
  displayName: string;
  /** typing beats viewing beats away. */
  status: "typing" | "viewing" | "away";
}>;

const RANK = { typing: 3, viewing: 2, away: 1 } as const;

function statusOf(participant: Participant): Person["status"] {
  if (participant.state.typing) return "typing";
  return participant.state.activity === "idle" ? "away" : "viewing";
}

/**
 * Aggregates sessions by principal ("a person with three tabs is one person"),
 * keeping the most active status, in the order each principal first appeared.
 */
export function peopleOf(participants: readonly Participant[]): Person[] {
  const byPrincipal = new Map<string, Person>();
  for (const participant of participants) {
    const status = statusOf(participant);
    const known = byPrincipal.get(participant.principalId);
    if (!known) {
      byPrincipal.set(participant.principalId, {
        principalId: participant.principalId,
        principalType: participant.principalType,
        displayName: participant.displayName,
        status,
      });
    } else if (RANK[status] > RANK[known.status]) {
      byPrincipal.set(participant.principalId, { ...known, status });
    }
  }
  return [...byPrincipal.values()];
}
