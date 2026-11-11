import { z } from "zod";
import {
  type ActionAuthorityRunner,
  type ActionContext,
  ActionKind,
  ActionRegistry,
  assertRegisteredActions,
  type CommandRunner,
  HttpMethod,
} from "@bakery/contracts/action-registry";
import {
  assertImplementedActionRegistry,
  ConversationImplementedAction,
  conversationImplementedActions,
} from "@bakery/contracts/implemented-actions";
import {
  ActionAccess,
  contractSchemas,
  OrganizationContextPolicy,
} from "@bakery/contracts/contracts";

export type ConversationActionHandlers = {
  conversationsList: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.CursorQuery>,
  ) =>
    | z.output<typeof contractSchemas["Page<Conversation>"]>
    | Promise<z.output<typeof contractSchemas["Page<Conversation>"]>>;
  conversationsGet: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.IdPath>,
  ) =>
    | z.output<typeof contractSchemas.Conversation>
    | Promise<z.output<typeof contractSchemas.Conversation>>;
  conversationsCreate: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.ConversationCreate>,
  ) =>
    | z.output<typeof contractSchemas.Conversation>
    | Promise<z.output<typeof contractSchemas.Conversation>>;
  conversationsUpdate: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.ConversationUpdate>,
  ) =>
    | z.output<typeof contractSchemas.Conversation>
    | Promise<z.output<typeof contractSchemas.Conversation>>;
  turnsGet: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.IdPath>,
  ) =>
    | z.output<typeof contractSchemas.ConversationTurn>
    | Promise<z.output<typeof contractSchemas.ConversationTurn>>;
  turnsCancel: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.ConversationTurnCancel>,
  ) =>
    | z.output<typeof contractSchemas.ConversationTurn>
    | Promise<z.output<typeof contractSchemas.ConversationTurn>>;
  questionsList: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.QuestionQuery>,
  ) =>
    | z.output<typeof contractSchemas["Page<Question>"]>
    | Promise<z.output<typeof contractSchemas["Page<Question>"]>>;
  questionsGet: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.IdPath>,
  ) =>
    | z.output<typeof contractSchemas.Question>
    | Promise<z.output<typeof contractSchemas.Question>>;
  questionsAnswer: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.QuestionAnswer>,
  ) =>
    | z.output<typeof contractSchemas.Question>
    | Promise<z.output<typeof contractSchemas.Question>>;
  messagesList: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.MessageQuery>,
  ) =>
    | z.output<typeof contractSchemas["Page<Message>"]>
    | Promise<z.output<typeof contractSchemas["Page<Message>"]>>;
  messagesCreate: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.MessageCreate>,
  ) =>
    | z.output<typeof contractSchemas.Message>
    | Promise<z.output<typeof contractSchemas.Message>>;
  participantsList: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.CursorQuery>,
  ) =>
    | z.output<typeof contractSchemas["Page<ConversationParticipant>"]>
    | Promise<
      z.output<typeof contractSchemas["Page<ConversationParticipant>"]>
    >;
  turnsList: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.ConversationTurnQuery>,
  ) =>
    | z.output<typeof contractSchemas["Page<ConversationTurn>"]>
    | Promise<z.output<typeof contractSchemas["Page<ConversationTurn>"]>>;
};

export function createConversationActionRegistry(
  handlers: ConversationActionHandlers,
  options: {
    authorityRunner: ActionAuthorityRunner;
    commandRunner: CommandRunner;
  },
): ActionRegistry {
  const registry = new ActionRegistry(
    options.authorityRunner,
    options.commandRunner,
  );
  const queryPolicy = {
    type: ActionKind.Query,
    access: ActionAccess.Developer,
    organizationContext: OrganizationContextPolicy.RequiredAuthenticatedContext,
  } as const;
  registry.register({
    name: ConversationImplementedAction.MessagesList,
    method: HttpMethod.Get,
    path: "/v1/conversations/:id/messages",
    input: contractSchemas.MessageQuery,
    output: contractSchemas["Page<Message>"],
    policy: queryPolicy,
    handler: handlers.messagesList,
  });
  registry.register({
    name: ConversationImplementedAction.MessagesCreate,
    method: HttpMethod.Post,
    path: "/v1/conversations/:id/messages",
    input: contractSchemas.MessageCreate,
    output: contractSchemas.Message,
    policy: { ...queryPolicy, type: ActionKind.Command },
    handler: handlers.messagesCreate,
  });
  registry.register({
    name: ConversationImplementedAction.ConversationTurnsList,
    method: HttpMethod.Get,
    path: "/v1/conversations/:id/turns",
    input: contractSchemas.ConversationTurnQuery,
    output: contractSchemas["Page<ConversationTurn>"],
    policy: queryPolicy,
    handler: handlers.turnsList,
  });
  registry.register({
    name: ConversationImplementedAction.ConversationParticipantsList,
    method: HttpMethod.Get,
    path: "/v1/conversations/:id/participants",
    input: contractSchemas.CursorQuery,
    output: contractSchemas["Page<ConversationParticipant>"],
    policy: queryPolicy,
    handler: handlers.participantsList,
  });
  registry.register({
    name: ConversationImplementedAction.ConversationsList,
    method: HttpMethod.Get,
    path: "/v1/conversations",
    input: contractSchemas.CursorQuery,
    output: contractSchemas["Page<Conversation>"],
    policy: queryPolicy,
    handler: handlers.conversationsList,
  });
  registry.register({
    name: ConversationImplementedAction.ConversationsGet,
    method: HttpMethod.Get,
    path: "/v1/conversations/:id",
    input: contractSchemas.IdPath,
    output: contractSchemas.Conversation,
    policy: queryPolicy,
    handler: handlers.conversationsGet,
  });
  registry.register({
    name: ConversationImplementedAction.ConversationsCreate,
    method: HttpMethod.Post,
    path: "/v1/conversations",
    input: contractSchemas.ConversationCreate,
    output: contractSchemas.Conversation,
    policy: { ...queryPolicy, type: ActionKind.Command },
    handler: handlers.conversationsCreate,
  });
  registry.register({
    name: ConversationImplementedAction.ConversationsUpdate,
    method: HttpMethod.Patch,
    path: "/v1/conversations/:id",
    input: contractSchemas.ConversationUpdate,
    output: contractSchemas.Conversation,
    policy: { ...queryPolicy, type: ActionKind.Command },
    handler: handlers.conversationsUpdate,
  });
  registry.register({
    name: ConversationImplementedAction.ConversationTurnsGet,
    method: HttpMethod.Get,
    path: "/v1/conversation-turns/:id",
    input: contractSchemas.IdPath,
    output: contractSchemas.ConversationTurn,
    policy: queryPolicy,
    handler: handlers.turnsGet,
  });
  registry.register({
    name: ConversationImplementedAction.ConversationTurnsCancel,
    method: HttpMethod.Post,
    path: "/v1/conversation-turns/:id/cancel",
    input: contractSchemas.ConversationTurnCancel,
    output: contractSchemas.ConversationTurn,
    policy: { ...queryPolicy, type: ActionKind.Command },
    explicitIdempotency: "key-and-if-match",
    successStatus: 200,
    handler: handlers.turnsCancel,
  });
  registry.register({
    name: ConversationImplementedAction.QuestionsList,
    method: HttpMethod.Get,
    path: "/v1/questions",
    input: contractSchemas.QuestionQuery,
    output: contractSchemas["Page<Question>"],
    policy: queryPolicy,
    handler: handlers.questionsList,
  });
  registry.register({
    name: ConversationImplementedAction.QuestionsGet,
    method: HttpMethod.Get,
    path: "/v1/questions/:id",
    input: contractSchemas.IdPath,
    output: contractSchemas.Question,
    policy: queryPolicy,
    handler: handlers.questionsGet,
  });
  registry.register({
    name: ConversationImplementedAction.QuestionsAnswer,
    method: HttpMethod.Put,
    path: "/v1/questions/:id/answer",
    input: contractSchemas.QuestionAnswer,
    output: contractSchemas.Question,
    policy: { ...queryPolicy, type: ActionKind.Command },
    successStatus: 200,
    handler: handlers.questionsAnswer,
  });
  assertRegisteredActions(registry);
  assertImplementedActionRegistry(registry, conversationImplementedActions);
  return registry;
}
