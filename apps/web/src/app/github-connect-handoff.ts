/**
 * The two single-use GitHub URLs of one connect attempt, kept between the
 * redirects through github.com. Both carry the attempt's state, so they live
 * only in this tab's session storage, are removed once one is used and never reach
 * a log, the address bar or local storage.
 */
export type GitHubConnectHandoff = {
  readonly organizationId: string;
  readonly expiresAt: string;
  readonly authorizationUrl: string | null;
  readonly installationUrl: string | null;
};

const KEY = "bakery.githubConnect";

function storage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function isUrl(value: unknown): value is string | null {
  return value === null ||
    (typeof value === "string" && value.startsWith("https://github.com/"));
}

function read(): GitHubConnectHandoff | null {
  try {
    const raw = storage()?.getItem(KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<GitHubConnectHandoff>;
    if (
      typeof value.organizationId !== "string" ||
      typeof value.expiresAt !== "string" ||
      !isUrl(value.authorizationUrl) || !isUrl(value.installationUrl)
    ) return null;
    return value as GitHubConnectHandoff;
  } catch {
    return null;
  }
}

/** Keeps a new attempt's URLs; false when this tab cannot store them. */
export function saveGitHubConnectHandoff(value: GitHubConnectHandoff): boolean {
  try {
    const target = storage();
    if (!target) return false;
    target.setItem(KEY, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** Forgets the attempt's URLs, after a final outcome or a fresh start. */
export function clearGitHubConnectHandoff(): void {
  try {
    storage()?.removeItem(KEY);
  } catch {
    // Nothing stored or storage refused: nothing to remove.
  }
}

/**
 * Returns one URL of the organization's live attempt and forgets the whole
 * attempt: a continuation is the attempt's last hop through GitHub, so a
 * reload or the back button never replays either link. Null when none is
 * held, the attempt belongs to another organization or it has expired.
 */
export function takeGitHubConnectUrl(
  organizationId: string,
  step: "authorizationUrl" | "installationUrl",
  now = Date.now(),
): string | null {
  const held = read();
  clearGitHubConnectHandoff();
  if (
    !held || held.organizationId !== organizationId ||
    !(Date.parse(held.expiresAt) > now)
  ) return null;
  return held[step];
}
