import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useBakeryApi } from "../api/context.tsx";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import type { LandingSearch } from "./landing.ts";

/**
 * What happens once the page a notification opened has rendered: the
 * notification is marked read (so a landing that fails leaves it unread), the
 * arrival is announced once in a polite status, and the read marker leaves the
 * address so a reload or a shared link carries only where to land.
 *
 * `ready` is true when the destination is on screen. Returns the sentence for
 * the page's polite status, empty until then.
 */
export function useLandingArrival(
  { search, ready, strip }: {
    search: LandingSearch;
    ready: boolean;
    /** Removes `n` and `r` from the address, in place. */
    strip: () => void;
  },
): string {
  const client = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const { translate } = useI18n();
  const opened = search.at !== undefined || search.gone === true ||
    search.n !== undefined;
  const [announcement, setAnnouncement] = useState("");
  const settled = useRef(false);
  const organizationId = scope.organizationId;

  useEffect(() => {
    if (!ready || !opened || settled.current) return;
    settled.current = true;
    setAnnouncement(translate("notifications.landing.arrived"));
    if (search.n === undefined) return;
    const id = search.n;
    const revision = search.r;
    void (async () => {
      if (revision !== undefined && organizationId !== null) {
        // A stale revision or a failure leaves the row unread: nothing to undo.
        await client.setNotificationRead({
          organizationId,
          id,
          read: true,
          expectedCasVersion: revision,
          idempotencyKey: `read-${id}-${revision}-true`,
        });
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["notifications.list"] }),
          queryClient.invalidateQueries({ queryKey: ["notifications.count"] }),
        ]);
      }
      strip();
    })();
  }, [
    client,
    opened,
    organizationId,
    queryClient,
    ready,
    search,
    strip,
    translate,
  ]);

  return announcement;
}
