import { useRef, useState } from "react";
import { useUnsavedChanges } from "../app/unsaved-changes.tsx";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { SECURITY_SETTINGS_PATH } from "../app/auth-paths.ts";
import { useBakeryApi } from "../api/context.tsx";
import type { UserProfile, UserProfileUpdate } from "../api/client.ts";
import { userProfileQueryOptions } from "../api/query.ts";
import {
  asyncKindForConnectivity,
  asyncKindForError,
  isConflictFailure,
} from "../app/async-state.ts";
import { useConnectivity } from "../app/connectivity.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useSingleFlightSubmit } from "../app/auth-form.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import {
  PROFILE_FIELD_IDS,
  type ProfileDraft,
  type ProfileField,
  ProfileScreen,
} from "../screens/ProfileScreen.tsx";
import type { SecurityAsyncKind } from "../screens/security-async.tsx";

/** Limits the server enforces on `PATCH /v1/me/profile`. */
const LIMITS = {
  name: 200,
  firstName: 100,
  lastName: 100,
  title: 120,
  image: 2048,
};

const FIELDS: readonly ProfileField[] = [
  "name",
  "firstName",
  "lastName",
  "title",
  "image",
];

const savedDraft = (profile: UserProfile): ProfileDraft => ({
  name: profile.name,
  firstName: profile.firstName ?? "",
  lastName: profile.lastName ?? "",
  title: profile.title ?? "",
  image: profile.image ?? "",
});

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * `/settings/profile`. The profile is one read; saving sends only the
 * fields that changed with the version the page last read as `If-Match`, so a
 * concurrent edit surfaces as a `conflict` with the draft kept. An empty
 * optional field clears it. The email is read-only here.
 */
export function ProfilePage() {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const { translate } = useI18n();
  const navigate = useNavigate();
  const profile = useQuery(userProfileQueryOptions(api, scope));
  const connectivity = useConnectivity({
    refetch: profile.refetch,
    refetching: profile.isFetching,
    dataUpdatedAt: profile.dataUpdatedAt,
  });
  const [edits, setEdits] = useState<Partial<ProfileDraft>>({});
  const [errors, setErrors] = useState<
    Readonly<Partial<Record<ProfileField, string>>>
  >({});
  const [saved, setSaved] = useState(false);
  const [saveState, setSaveState] = useState<
    "idle" | "conflict" | "forbidden" | "offline" | "failed"
  >("idle");
  // A retry after a transport failure resends the same request; any edit or
  // newer version starts a new one.
  const intent = useRef<{ key: string; version: number; body: string } | null>(
    null,
  );

  const current = profile.data;
  const base = current === undefined ? null : savedDraft(current);
  const draft: ProfileDraft = { ...(base ?? emptyDraft), ...edits };
  const changed = base === null
    ? []
    : FIELDS.filter((field) => draft[field] !== base[field]);

  useUnsavedChanges(changed.length > 0);

  const validate = (): Partial<Record<ProfileField, string>> => {
    const found: Partial<Record<ProfileField, string>> = {};
    if (draft.name.trim() === "") {
      found.name = translate("profile.errors.nameRequired");
    }
    for (const field of FIELDS) {
      if (draft[field].length > LIMITS[field]) {
        found[field] = translate("profile.errors.tooLong", {
          limit: LIMITS[field],
        });
      }
    }
    if (
      draft.image !== "" && found.image === undefined &&
      !isHttpsUrl(draft.image)
    ) {
      found.image = translate("profile.errors.imageInvalid");
    }
    return found;
  };

  const submit = async () => {
    if (current === undefined || base === null) return;
    const found = validate();
    setErrors(found);
    const first = FIELDS.find((field) => found[field] !== undefined);
    if (first !== undefined) {
      document.getElementById(PROFILE_FIELD_IDS[first])?.focus();
      return;
    }
    const input: Record<string, string | null> = {};
    for (const field of changed) {
      const value = draft[field].trim();
      input[field] = field === "name" ? value : value === "" ? null : value;
    }
    const body = JSON.stringify(input);
    if (
      intent.current === null || intent.current.version !== current.version ||
      intent.current.body !== body
    ) {
      intent.current = {
        key: crypto.randomUUID(),
        version: current.version,
        body,
      };
    }
    setSaved(false);
    setSaveState("idle");
    const result = await api.profile.update({
      input: input as UserProfileUpdate,
      version: current.version,
      idempotencyKey: intent.current.key,
    });
    if (result.ok) {
      intent.current = null;
      queryClient.setQueryData(
        userProfileQueryOptions(api, scope).queryKey,
        result.data,
      );
      setEdits({});
      setSaved(true);
      return;
    }
    const kind = asyncKindForError(result.error);
    if (isConflictFailure(result.error)) setSaveState("conflict");
    else if (kind === "forbidden") setSaveState("forbidden");
    else if (kind === "offline") setSaveState("offline");
    else setSaveState("failed");
    if (kind !== "offline") intent.current = null;
  };
  const [pending, runSubmit] = useSingleFlightSubmit(submit);

  const reload = () => {
    setSaveState("idle");
    setSaved(false);
    setErrors({});
    setEdits({});
    intent.current = null;
    void profile.refetch();
  };

  const async: SecurityAsyncKind | null = profile.isPending
    ? "loading"
    : profile.isError
    ? asyncKindForError(profile.error)
    : saveState === "forbidden"
    ? "forbidden"
    : saveState === "conflict"
    ? "conflict"
    : saveState === "offline"
    ? "offline"
    : asyncKindForConnectivity(connectivity);

  return (
    <ProfileScreen
      async={async}
      dirty={changed.length > 0}
      displayName={current?.name ?? ""}
      draft={draft}
      email={current?.email ?? ""}
      emailVerified={current?.emailVerified === true}
      image={current?.image ?? ""}
      errors={errors}
      onChange={(field, value) => {
        setSaved(false);
        setSaveState((state) => state === "conflict" ? state : "idle");
        setErrors((existing) => ({ ...existing, [field]: undefined }));
        setEdits((existing) => ({ ...existing, [field]: value }));
      }}
      onChangeEmail={() => void navigate({ to: SECURITY_SETTINGS_PATH })}
      onRefresh={reload}
      onReload={reload}
      onRetry={reload}
      onSave={() => void runSubmit()}
      pending={pending}
      saveFailed={saveState === "failed"}
      saved={saved}
    />
  );
}

const emptyDraft: ProfileDraft = {
  name: "",
  firstName: "",
  lastName: "",
  title: "",
  image: "",
};
