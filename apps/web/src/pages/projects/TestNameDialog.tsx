import { useRef, useState } from "react";
import * as UI from "@bakery/ui";
import type {
  RepositoryBindingResolution,
  RepositoryResponse,
} from "../../api/client.ts";
import { useBakeryApi } from "../../api/context.tsx";
import { repositoryQueryOptions } from "../../api/query.ts";
import { asyncKindForError } from "../../app/async-state.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { useQueryClient } from "@tanstack/react-query";
import { useI18n } from "../../i18n/I18nProvider.tsx";

/** What testing a name found, as the sentence key and its values. */
type Found =
  | { readonly kind: "resolved"; readonly repository: string }
  | { readonly kind: "none" | "archived" | "notFound" | "foreign" }
  | { readonly kind: "ambiguous"; readonly count: number }
  | { readonly kind: "failed" };

/**
 * Test a name (design-ux, #65): type a name and see which repository agents
 * would get for it, in this repository's application. Nothing is changed.
 */
export function TestNameDialog(
  { repository, onClose }: Readonly<{
    repository: RepositoryResponse;
    onClose: () => void;
  }>,
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const { translate } = useI18n();
  const [name, setName] = useState("");
  const [found, setFound] = useState<Found | null>(null);
  const [tried, setTried] = useState(false);
  const [pending, setPending] = useState(false);
  // An answer that arrives after the person typed something else is dropped.
  const generation = useRef(0);

  const resolve = async () => {
    setTried(true);
    const wanted = name.trim();
    if (wanted === "" || wanted.length > 200) return;
    generation.current += 1;
    const mine = generation.current;
    setPending(true);
    setFound(null);
    const result = await api.resolveRepositoryRole({
      organizationId: scope.organizationId as string,
      applicationId: repository.applicationId,
      input: { role: wanted },
    });
    let next: Found;
    if (!result.ok) {
      next = asyncKindForError(result.error) === "offline" ||
          result.error.kind !== "problem" || result.error.problem.status !== 404
        ? { kind: "failed" }
        : { kind: "foreign" };
    } else {
      next = await describe(result.data);
    }
    if (mine !== generation.current) return;
    setFound(next);
    setPending(false);
  };

  const describe = async (
    resolution: RepositoryBindingResolution,
  ): Promise<Found> => {
    switch (resolution.status) {
      case "resolved": {
        if (resolution.binding.repositoryId === repository.id) {
          return {
            kind: "resolved",
            repository: translate(
              "projects.repository.test.thisRepository" as never,
            ),
          };
        }
        try {
          const other = await queryClient.fetchQuery(
            repositoryQueryOptions(
              api,
              scope,
              resolution.binding.repositoryId,
            ),
          );
          return {
            kind: "resolved",
            repository: `${other.owner}/${other.name}`,
          };
        } catch {
          return { kind: "failed" };
        }
      }
      case "unavailable":
        return {
          kind: resolution.reason === "repository_archived"
            ? "archived"
            : resolution.reason === "repository_not_found"
            ? "notFound"
            : "none",
        };
      case "ambiguous":
        return { kind: "ambiguous", count: resolution.candidates.length };
      default:
        return { kind: "foreign" };
    }
  };

  const message = found === null
    ? null
    : found.kind === "resolved"
    ? translate("projects.repository.test.resolved" as never, {
      name: name.trim(),
      repository: found.repository,
    })
    : found.kind === "ambiguous"
    ? translate("projects.repository.test.ambiguous" as never, {
      count: found.count,
    })
    : translate(`projects.repository.test.${found.kind}` as never);

  return (
    <UI.Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      state={pending ? "submitting" : "open"}
      title={translate("projects.repository.test.title" as never)}
      variant="form"
    >
      <form
        noValidate
        data-testid="test-name-form"
        onSubmit={(event) => {
          event.preventDefault();
          void resolve();
        }}
      >
        <UI.Stack gap="standard">
          <UI.Text variant="muted">
            {translate("projects.repository.test.intro" as never)}
          </UI.Text>
          <UI.Field
            label={translate("projects.repository.test.name" as never)}
            htmlFor="test-name"
            required
            error={tried && (name.trim() === "" || name.trim().length > 200)
              ? translate("projects.repository.test.empty" as never)
              : undefined}
          >
            <UI.TextInput
              type="text"
              id="test-name"
              name="name"
              autoComplete="off"
              invalid={tried && name.trim() === ""}
              value={name}
              onChange={(next) => {
                generation.current += 1;
                setPending(false);
                setFound(null);
                setName(next);
              }}
            />
          </UI.Field>
          <div role="status" aria-live="polite" data-testid="test-name-result">
            {message === null ? null : (
              <UI.InlineNotice
                tone={found?.kind === "resolved"
                  ? "success"
                  : found?.kind === "failed"
                  ? "error"
                  : "information"}
              >
                {message}
              </UI.InlineNotice>
            )}
          </div>
          <UI.Inline gap="compact">
            <UI.Button type="submit" variant="primary" loading={pending}>
              {pending
                ? translate("projects.repository.test.running" as never)
                : translate("projects.repository.test.run" as never)}
            </UI.Button>
            <UI.Button variant="secondary" onClick={onClose}>
              {translate("projects.repository.test.close" as never)}
            </UI.Button>
          </UI.Inline>
        </UI.Stack>
      </form>
    </UI.Dialog>
  );
}
