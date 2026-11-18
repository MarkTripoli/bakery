import { type ReactNode, useRef, useState } from "react";
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
import { useNavigate } from "@tanstack/react-router";
import { useI18n } from "../../i18n/I18nProvider.tsx";

/** What testing a name found, as the sentence key and its values. */
type Found =
  | { readonly kind: "resolved"; readonly repository: null }
  | {
    readonly kind: "resolved";
    readonly repository: string;
    readonly repositoryId: string;
  }
  | { readonly kind: "none" | "archived" | "notFound" | "foreign" }
  | { readonly kind: "ambiguous"; readonly list: string | null }
  | { readonly kind: "failed" };

/** Marks where a linked repository goes inside a translated sentence. */
const LINK_MARK = "\u2063";

/** A translated sentence with the repository as a link where the mark stands. */
function linked(
  sentence: string,
  repository: string,
  repositoryId: string,
  open: (repositoryId: string) => void,
): ReactNode {
  const [before, after = ""] = sentence.split(LINK_MARK);
  return (
    <>
      {before}
      <UI.Link
        href={`/projects/repositories/${repositoryId}`}
        onClick={(event) => {
          event.preventDefault();
          open(repositoryId);
        }}
      >
        {repository}
      </UI.Link>
      {after}
    </>
  );
}

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
  const navigate = useNavigate();
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
          return { kind: "resolved", repository: null };
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
            repositoryId: other.id,
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
      case "ambiguous": {
        // The repositories that share the name, by their GitHub names; if any
        // cannot be read the sentence says so without the list.
        const names = await Promise.all(
          resolution.candidates.map((candidate) =>
            queryClient.fetchQuery(
              repositoryQueryOptions(api, scope, candidate.repositoryId),
            ).then((other) => `${other.owner}/${other.name}`, () => null)
          ),
        );
        return {
          kind: "ambiguous",
          list: names.every((entry) => entry !== null)
            ? names.join(", ")
            : null,
        };
      }
      default:
        return { kind: "foreign" };
    }
  };

  const wanted = name.trim();
  const message: ReactNode = found === null
    ? null
    : found.kind === "resolved"
    ? found.repository === null
      ? translate("projects.repository.test.resolvedHere" as never, {
        name: wanted,
      })
      : linked(
        translate("projects.repository.test.resolved" as never, {
          name: wanted,
          repository: LINK_MARK,
        }),
        found.repository,
        found.repositoryId,
        (id) => {
          onClose();
          void navigate({
            to: "/projects/repositories/$repositoryId",
            params: { repositoryId: id },
            search: { check: undefined },
          });
        },
      )
    : found.kind === "ambiguous"
    ? found.list === null
      ? translate("projects.repository.test.ambiguousBare" as never, {
        name: wanted,
      })
      : translate("projects.repository.test.ambiguous" as never, {
        name: wanted,
        list: found.list,
      })
    : found.kind === "none"
    ? translate("projects.repository.test.none" as never, { name: wanted })
    : translate(`projects.repository.test.${found.kind}` as never);

  return (
    <UI.AlertDialog
      open
      onOpenChange={(next) => !next && onClose()}
      state={pending ? "confirming" : "open"}
      title={translate("projects.repository.test.title" as never)}
      cancelAction={
        <UI.Button variant="secondary" onClick={onClose}>
          {translate("projects.repository.test.close" as never)}
        </UI.Button>
      }
      confirmAction={
        <UI.Button
          variant="primary"
          loading={pending}
          onClick={() => void resolve()}
        >
          {pending
            ? translate("projects.repository.test.running" as never)
            : translate("projects.repository.test.run" as never)}
        </UI.Button>
      }
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
        </UI.Stack>
      </form>
    </UI.AlertDialog>
  );
}
