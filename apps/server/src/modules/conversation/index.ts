import { Hono, type MiddlewareHandler } from "hono";
import type { CommandRunner } from "@bakery/contracts/action-registry";
import { createApiRouter, StandardError } from "@bakery/contracts/http";
import { createConversationActionRegistry } from "../../conversation-actions.ts";
import { createPostgresCommandRunner } from "../../platform/command-replay.ts";
import type { PgDatabase } from "../../platform/database.ts";
import { PostgresAuthorityRunner } from "../auth/adapters/authority-postgres.ts";
import { type AuthVariables, createActionContext } from "../auth/middleware.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import { createMessage, lockConversationScope } from "./postgres.ts";
import {
  cancelConversationTurn,
  createConversation,
  createConversationsListHandler,
  getConversation,
  getConversationTurn,
  updateConversation,
} from "./conversations.ts";
import { createConversationQueryHandlers } from "./queries.ts";
import {
  answerQuestion,
  createQuestionsListHandler,
  getQuestion,
} from "./questions.ts";

function createConversationCommandRunner(): CommandRunner {
  const commands = createPostgresCommandRunner();
  return {
    async run(request) {
      const { transaction, organizationId } = requireWorkTransaction(
        request.context,
      );
      // Only message admission is bound to an unarchived conversation scope;
      // conversation edits may unarchive and turn commands carry a turn id.
      if (request.action.name !== "messages.create") {
        return await commands.run(request);
      }
      const conversationId = request.context.params.id;
      if (!conversationId) {
        throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
      }
      // This resource preflight deliberately precedes the shared HTTP replay
      // lookup. A stored response never bypasses current conversation scope.
      await lockConversationScope(
        transaction,
        organizationId,
        conversationId,
        "update",
      );
      return await commands.run(request);
    },
  };
}

/** The conversation action registry; built once and shared by REST and MCP. */
export function createConversationRegistry(options: {
  database: PgDatabase;
  cursorSecret: string;
}) {
  const queries = createConversationQueryHandlers(options.cursorSecret);
  return createConversationActionRegistry(
    {
      messagesList: queries.messagesList,
      messagesCreate: createMessage,
      turnsList: queries.turnsList,
      participantsList: queries.participantsList,
      conversationsList: createConversationsListHandler(options.cursorSecret),
      conversationsGet: getConversation,
      conversationsCreate: createConversation,
      conversationsUpdate: updateConversation,
      questionsList: createQuestionsListHandler(options.cursorSecret),
      questionsGet: getQuestion,
      questionsAnswer: answerQuestion,
      turnsGet: getConversationTurn,
      turnsCancel: cancelConversationTurn,
    },
    {
      authorityRunner: new PostgresAuthorityRunner(options.database),
      commandRunner: createConversationCommandRunner(),
    },
  );
}

export function createConversationRoutes(options: {
  database: PgDatabase;
  browserSession: MiddlewareHandler<{ Variables: AuthVariables }>;
  publicBaseUrl: string;
  cursorSecret: string;
  /** A registry already shared with MCP; omitted, the routes build their own. */
  registry?: ReturnType<typeof createConversationRegistry>;
}) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("/v1/conversations", options.browserSession);
  app.use("/v1/conversations/*", options.browserSession);
  app.use("/v1/conversation-turns/*", options.browserSession);
  app.use("/v1/questions", options.browserSession);
  app.use("/v1/questions/*", options.browserSession);
  app.route(
    "/",
    createApiRouter({
      registry: options.registry ?? createConversationRegistry(options),
      publicBaseUrl: options.publicBaseUrl,
      createContext: createActionContext,
    }),
  );
  return app;
}
