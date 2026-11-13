import type { OpenAPIHono } from "@hono/zod-openapi";
import { Effect } from "effect";
import type { Env } from "hono";
import { HTTPException } from "hono/http-exception";
import { routes } from "../contract/api-contract";
import type { Register } from "../contract/route";
import { accessOf, noServices } from "../shared/runner";
import { ExecutionRepository } from "../bot-store/execution-repository";
import type { BotsAccess } from "../bots/bots";
import { chatEventStream } from "../bots/chat-api";
import type { AgentRuntime } from "../bots/runtime";
import type { Execution } from "../shared/domain";
import { Conflict, NotFound } from "../shared/errors";
import { streamEvents } from "../shared/event-stream";
import {
  outsideCallRequest,
  parseRequestId,
  voiceRequest,
} from "../shared/request-ids";
import { VoiceGateway } from "./voice-gateway";

export const VOICE_GATEWAY_PREFIX = "/v1/voice/";

/** The host copies the voice gateway's bearer here; it deletes the header from every incoming request first. */
export const VOICE_GATEWAY_TOKEN_HEADER = "x-crumble-voice-gateway-token";

/** The host and the account refuse alike, so a refusal does not reveal which account IDs exist. */
export const voiceGatewayRefusal = () =>
  Response.json(
    { error: "Voice gateway token required" },
    { status: 401, headers: { "Cache-Control": "no-store" } },
  );

type VoiceGatewayRoutesOptions = {
  app: OpenAPIHono;
  register: Register<Env, VoiceGateway | ExecutionRepository>;
  voiceGateway: VoiceGateway["Service"];
  service: BotsAccess;
  runtime: AgentRuntime;
};

// The token was revoked or replaced after the middleware matched it.
const tokenChanged = () =>
  new HTTPException(401, { res: voiceGatewayRefusal() });

function registerOwnerRoutes(options: VoiceGatewayRoutesOptions) {
  const { register } = options;

  register(routes.voiceGateway, function* (c) {
    const gateway = yield* VoiceGateway;

    return c.json(yield* gateway.describe, 200);
  });
  register(routes.updateVoiceGateway, function* (c) {
    const gateway = yield* VoiceGateway;

    return c.json(yield* gateway.update(c.req.valid("json")), 200);
  });
  register(routes.issueVoiceGatewayToken, function* (c) {
    const gateway = yield* VoiceGateway;

    return c.json(yield* gateway.issueToken, 201);
  });
  register(routes.revokeVoiceGatewayToken, function* (c) {
    const gateway = yield* VoiceGateway;

    yield* gateway.revokeToken;

    return c.body(null, 204);
  });
}

function registerGatewayRoutes(options: VoiceGatewayRoutesOptions) {
  const { app, register, voiceGateway, service, runtime } = options;
  const gatewayAccess = accessOf(voiceGateway, noServices);
  const matched = new WeakMap<Request, string>();
  const hash = (request: Request) => matched.get(request)!;

  // A callee's message is read only on its line's active outside call, from that call's conversation.
  const spokenOn = Effect.fnUntraced(function* (
    username: string,
    execution: Execution,
    current: string,
  ) {
    const request = parseRequestId(execution.requestId);

    if (request.kind === "voice") return;

    if (request.kind !== "outside-call")
      return yield* Effect.fail(
        new NotFound({ message: "Spoken message not found" }),
      );

    const gateway = yield* VoiceGateway;
    const line = yield* gateway.route(username, current, request.callId);

    if (!line) return yield* Effect.die(tokenChanged());

    if (line.outside?.conversationId !== execution.conversationId)
      return yield* Effect.fail(
        new Conflict({ message: "The outside call is not active" }),
      );
  });

  app.use(`${VOICE_GATEWAY_PREFIX}*`, async (c, next) => {
    const token = c.req.header(VOICE_GATEWAY_TOKEN_HEADER);
    const current = token ? voiceGateway.matchToken(token) : null;

    if (!current) return voiceGatewayRefusal();
    matched.set(c.req.raw, current);

    return next();
  });

  register.plain(routes.voiceGatewayEvents, (c) =>
    streamEvents(c, async ({ stream, close, onClose }) => {
      const cleanup = await gatewayAccess.openEvents({
        hash: hash(c.req.raw),
        calls: c.req.valid("query").calls ?? false,
        close,
        send: ({ event, data }) => {
          void stream
            .writeSSE({ event, data: JSON.stringify(data) })
            .catch(close);
        },
      });

      if (!cleanup) return close();
      onClose(cleanup);
    }),
  );
  register(routes.sendSpokenMessage, function* (c) {
    const { callId, requestId, content } = c.req.valid("json");
    const gateway = yield* VoiceGateway;

    const line = yield* gateway.speak(
      c.req.valid("param").username,
      callId,
      hash(c.req.raw),
    );

    if (!line) return yield* Effect.die(tokenChanged());

    // A callee's words reach only the call's conversation, never the bot chat.
    return c.json(
      yield* Effect.promise(() =>
        line.outside
          ? service.send(
              line.outside.conversationId,
              content,
              outsideCallRequest(callId, requestId),
            )
          : service.sendChat(
              line.botId,
              content,
              voiceRequest(callId, requestId),
            ),
      ),
      202,
    );
  });
  register(routes.voiceLineEvents, function* (c) {
    const { username } = c.req.valid("param");
    const { callId, ...snapshot } = c.req.valid("query");
    const gateway = yield* VoiceGateway;

    const line = yield* gateway.route(username, hash(c.req.raw), callId);

    if (!line) return yield* Effect.die(tokenChanged());

    return yield* Effect.promise(() =>
      chatEventStream(c, service, {
        agentId: line.botId,
        conversationId: line.outside?.conversationId,
        snapshot: line.outside ? { ...snapshot, own: true } : snapshot,
        opened: (close) =>
          gatewayAccess.openLine({
            hash: hash(c.req.raw),
            username,
            generation: line.generation,
            close,
          }),
      }),
    );
  });
  register(routes.spokenExecution, function* (c) {
    const { username, executionId } = c.req.valid("param");
    const gateway = yield* VoiceGateway;
    const line = yield* gateway.line(username, hash(c.req.raw));

    if (!line) return yield* Effect.die(tokenChanged());

    const executions = yield* ExecutionRepository;
    const execution = yield* executions.get(executionId);

    if (!execution || execution.agentId !== line.botId)
      return yield* Effect.fail(
        new NotFound({ message: "Spoken message not found" }),
      );
    yield* spokenOn(username, execution, hash(c.req.raw));

    const replyOf = async () => {
      if (execution.status !== "done") return null;

      if (!execution.submissionId) return [];

      return runtime.response(
        service.agent(line.botId),
        execution.conversationId,
        execution.submissionId,
      );
    };

    const reply = yield* Effect.promise(replyOf);
    const hangUp = yield* gateway.hangingUp(username);

    return c.json({ execution, reply, hangUp }, 200);
  });
  register(routes.startVoiceCall, function* (c) {
    const { username, callId } = c.req.valid("param");
    const gateway = yield* VoiceGateway;

    if (!(yield* gateway.startCall(username, callId, hash(c.req.raw))))
      return yield* Effect.die(tokenChanged());

    return c.body(null, 204);
  });
  register(routes.reportVoiceCall, function* (c) {
    const gateway = yield* VoiceGateway;

    const reported = yield* gateway.reportCall(
      c.req.valid("param").callId,
      c.req.valid("json"),
      hash(c.req.raw),
    );

    if (!reported) return yield* Effect.die(tokenChanged());

    return c.body(null, 204);
  });
  register(routes.reportVoiceLines, function* (c) {
    const gateway = yield* VoiceGateway;

    yield* gateway.reportLines(hash(c.req.raw), c.req.valid("json").lines);

    return c.body(null, 204);
  });
}

export function registerVoiceGatewayRoutes(options: VoiceGatewayRoutesOptions) {
  registerOwnerRoutes(options);
  registerGatewayRoutes(options);
}
