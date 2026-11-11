import type { JSX } from "react";
import { ProfileScreen } from "../../screens/ProfileScreen.tsx";
import type { SecurityAsyncKind } from "../../screens/security-async.tsx";
import { asyncKindFor, useAsyncHost } from "./security-suite.ts";

const LONG_NAME =
  "Alexandria Montgomery-Featherstonehaugh of the Northstar Platform Engineering Group";

/**
 * `?photo=<url>` gives the specimen a saved photo, so the avatar's load and
 * load-failure paths are exercisable without the API.
 */
function ProfileHost(
  { async: initial, long = false }: {
    readonly async: SecurityAsyncKind | null;
    readonly long?: boolean;
  },
) {
  const photo = new URLSearchParams(globalThis.location.search).get("photo");
  const { async, settle } = useAsyncHost(initial);
  return (
    <ProfileScreen
      async={async}
      dirty
      displayName={long ? LONG_NAME : "Mark Tripoli"}
      draft={{
        name: long ? LONG_NAME : "Mark Tripoli",
        firstName: long ? "Alexandria Montgomery-Featherstonehaugh" : "Mark",
        lastName: long
          ? "of the Northstar Platform Engineering Group"
          : "Tripoli",
        title: long
          ? "Principal staff platform reliability and developer experience engineer"
          : "",
        image: "",
      }}
      email={long
        ? "alexandria.montgomery-featherstonehaugh@platform-engineering.northstar.example.com"
        : "me@marktripoli.com"}
      emailVerified
      image={photo ?? ""}
      errors={{}}
      onChange={() => {}}
      onChangeEmail={() => {}}
      onRefresh={settle}
      onReload={settle}
      onRetry={settle}
      onSave={() => {}}
      pending={false}
      saved={false}
      saveFailed={false}
    />
  );
}

/**
 * Paper O-0 Profile sample (frames HJE-0 desktop, IG3-0 phone): the real
 * presenter with inert callbacks. The Verified badge appears here because
 * the mock shows it; production passes the server's `emailVerified`.
 */
export const profileSpecimens: Readonly<Record<string, () => JSX.Element>> = {
  default: () => <ProfileHost async={null} />,
  ...Object.fromEntries(
    [
      "loading",
      "empty",
      "error",
      "forbidden",
      "conflict",
      "stale",
      "offline",
      "reconnecting",
    ]
      .map((
        token,
      ) => [token, () => <ProfileHost async={asyncKindFor(token)} />]),
  ),
  "long-copy": () => <ProfileHost async={null} long />,
};
