import type { Context } from "hono";
import {
  type ActionContext,
  ActionRegistry,
} from "@bakery/contracts/action-registry";
import type { ContractOutput } from "@bakery/contracts/contracts";
import { ExecutionImplementedAction } from "@bakery/contracts/implemented-actions";
import { toProblem } from "@bakery/contracts/http";
import { createActionContext } from "../auth/middleware.ts";

/** How long the stream waits before asking for items behind the last it sent. */
const POLL_MS = 1_000;
/** Comment interval that keeps an idle proxy from closing a quiet stream. */
const HEARTBEAT_MS = 15_000;

type FeedPage = ContractOutput<"SessionFeed">;
type FeedItem = FeedPage["items"][number];

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Server-sent events for one session's feed.
 *
 * The stream reads through the `sessions.feed` action on the same registry the
 * JSON route uses, so authorization, tenant scoping and cursor binding are the
 * read route's, never a second implementation. It pages forward from the last
 * sequence it emitted, so a reconnect with `Last-Event-ID` resumes exactly where
 * it stopped with no gap and no duplicate.
 *
 * Each item is one `event: feed` whose `id:` is the item sequence, because a
 * watcher renders items one at a time and `EventSource` replays `id:` back as
 * `Last-Event-ID`.
 */
export function openSessionFeedStream(
  options: {
    registry: ActionRegistry;
    context: Context;
    publicBaseUrl: string;
  },
): Promise<Response> | Response {
  const encoder = new TextEncoder();
  const params = options.context.req.param();
  const request = options.context.req.raw;
  const signal = request.signal;
  // The registry expects the context the JSON router builds: the action seed
  // plus the request, its params, its abort signal and the request/trace ids.
  const baseContext = {
    request,
    params,
    requestId: request.headers.get("x-request-id") ?? crypto.randomUUID(),
    traceId: crypto.randomUUID(),
    signal,
    ...createActionContext(options.context),
  } as ActionContext;

  const read = (input: unknown) =>
    options.registry.execute(
      ExecutionImplementedAction.SessionsFeed,
      { ...baseContext, params },
      input,
    ) as Promise<FeedPage>;

  // The opening read decides the response: a refusal is the read route's own
  // problem response with its real status, not a 200 carrying an error frame.
  // The action's input carries the session id as a path field, exactly as the
  // JSON router merges it, so the registry validates the same input here.
  const opening = read({ id: params.id });
  return opening.then(
    (page) => stream(opening, page),
    (error) => problemFor(error, options.context, options.publicBaseUrl),
  );

  function problemFor(
    error: unknown,
    context: Context,
    publicBaseUrl: string,
  ): Response {
    const problem = toProblem(error, {
      requestId: context.req.header("x-request-id") ?? crypto.randomUUID(),
      traceId: crypto.randomUUID(),
      publicBaseUrl,
    });
    return new Response(JSON.stringify(problem), {
      status: problem.status,
      headers: { "content-type": "application/problem+json" },
    });
  }

  function stream(
    firstPage: Promise<FeedPage>,
    page0: FeedPage,
  ): Response {
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        let lastSequence: string | null =
          options.context.req.header("Last-Event-ID") ?? null;
        let heartbeat = Date.now();
        const send = (chunk: string) => {
          if (!signal.aborted) controller.enqueue(encoder.encode(chunk));
        };
        const emitPage = (page: FeedPage) => {
          let emitted = false;
          for (const item of page.items) {
            if (
              lastSequence !== null &&
              BigInt(item.sequence) <= BigInt(lastSequence)
            ) continue;
            send(
              `id: ${item.sequence}\nevent: feed\ndata: ${
                JSON.stringify(item)
              }\n\n`,
            );
            lastSequence = item.sequence;
            emitted = true;
          }
          return emitted;
        };

        try {
          let page = page0;
          let next = firstPage;
          while (!signal.aborted) {
            const emitted = emitPage(page);
            if (!emitted && Date.now() - heartbeat >= HEARTBEAT_MS) {
              send(": keep-alive\n\n");
              heartbeat = Date.now();
            }
            await sleep(POLL_MS, signal);
            if (signal.aborted) break;
            next = read(
              lastSequence === null
                ? { id: params.id }
                : { id: params.id, sequenceAfter: lastSequence },
            );
            page = await next;
          }
        } catch (error) {
          if (!signal.aborted) {
            const problem = toProblem(error, {
              requestId: crypto.randomUUID(),
              traceId: crypto.randomUUID(),
              publicBaseUrl: options.publicBaseUrl,
            });
            send(
              `event: problem\ndata: ${
                JSON.stringify({ code: problem.code })
              }\n\n`,
            );
          }
        } finally {
          try {
            controller.close();
          } catch {
            // The consumer already went away; closing twice is not an error here.
          }
        }
      },
    });

    return new Response(body, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
      },
    });
  }
}

export const sessionFeedStreamTiming = Object.freeze({
  pollMs: POLL_MS,
  heartbeatMs: HEARTBEAT_MS,
});
