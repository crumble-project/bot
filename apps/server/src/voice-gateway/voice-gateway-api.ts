import type { OpenAPIHono } from "@hono/zod-openapi";
import { Effect } from "effect";
import { HTTPException } from "hono/http-exception";
import { routes } from "../contract/api-contract";
import type { Register } from "../contract/route";
import { ExecutionRepository } from "../bot-store/execution-repository";
import type { BotsAccess } from "../bots/bots";
import { chatEventStream } from "../bots/chat-api";
import type { AgentRuntime } from "../bots/runtime";
import { NotFound } from "../shared/errors";
import { streamEvents } from "../shared/event-stream";
import { parseRequestId, voiceRequest } from "../shared/request-ids";
import type { Runner } from "../shared/runner";
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
  register: Register;
  run: Runner<VoiceGateway | ExecutionRepository>;
  service: BotsAccess;
  runtime: AgentRuntime;
};

// The token was revoked or replaced after the middleware matched it.
const tokenChanged = () =>
  new HTTPException(401, { res: voiceGatewayRefusal() });

function registerOwnerRoutes(options: VoiceGatewayRoutesOptions) {
  const { register, run } = options;

  register(routes.voiceGateway, async (c) =>
    c.json(await run.runPromise(VoiceGateway.use((s) => s.describe)), 200),
  );
  register(routes.updateVoiceGateway, async (c) =>
    c.json(
      await run.runPromise(
        VoiceGateway.use((s) => s.update(c.req.valid("json"))),
      ),
      200,
    ),
  );
  register(routes.issueVoiceGatewayToken, async (c) =>
    c.json(await run.runPromise(VoiceGateway.use((s) => s.issueToken)), 201),
  );
  register(routes.revokeVoiceGatewayToken, async (c) => {
    await run.runPromise(VoiceGateway.use((s) => s.revokeToken));

    return c.body(null, 204);
  });
}

function registerGatewayRoutes(options: VoiceGatewayRoutesOptions) {
  const { app, register, run, service, runtime } = options;
  const gateway = run.runSync(VoiceGateway.use(Effect.succeed));
  const matched = new WeakMap<Request, string>();
  const hash = (request: Request) => matched.get(request)!;

  app.use(`${VOICE_GATEWAY_PREFIX}*`, async (c, next) => {
    const token = c.req.header(VOICE_GATEWAY_TOKEN_HEADER);
    const current = token ? gateway.matchToken(token) : null;

    if (!current) return voiceGatewayRefusal();
    matched.set(c.req.raw, current);

    return next();
  });

  register(routes.voiceGatewayEvents, (c) =>
    streamEvents(c, async ({ stream, close, onClose }) => {
      const cleanup = await run.runPromise(
        gateway.openEvents({
          hash: hash(c.req.raw),
          calls: c.req.valid("query").calls ?? false,
          close,
          send: ({ event, data }) => {
            void stream
              .writeSSE({ event, data: JSON.stringify(data) })
              .catch(close);
          },
        }),
      );

      if (!cleanup) return close();
      onClose(cleanup);
    }),
  );
  register(routes.sendSpokenMessage, async (c) => {
    const { callId, requestId, content } = c.req.valid("json");

    const line = await run.runPromise(
      gateway.speak(c.req.valid("param").username, callId, hash(c.req.raw)),
    );

    if (!line) throw tokenChanged();

    return c.json(
      await service.sendChat(
        line.botId,
        content,
        voiceRequest(callId, requestId),
      ),
      202,
    );
  });
  register(routes.voiceLineEvents, async (c) => {
    const { username } = c.req.valid("param");
    const line = await run.runPromise(gateway.line(username, hash(c.req.raw)));

    if (!line) throw tokenChanged();

    return chatEventStream(c, service, {
      agentId: line.botId,
      snapshot: c.req.valid("query"),
      opened: (close) =>
        run.runPromise(
          gateway.openLine({
            hash: hash(c.req.raw),
            username,
            generation: line.generation,
            close,
          }),
        ),
    });
  });
  register(routes.spokenExecution, async (c) => {
    const { username, executionId } = c.req.valid("param");
    const line = await run.runPromise(gateway.line(username, hash(c.req.raw)));

    if (!line) throw tokenChanged();

    const execution = await run.runPromise(
      ExecutionRepository.use((r) => r.get(executionId)),
    );

    if (
      !execution ||
      execution.agentId !== line.botId ||
      parseRequestId(execution.requestId).kind !== "voice"
    )
      throw new NotFound({ message: "Spoken message not found" });

    const reply =
      execution.status !== "done"
        ? null
        : execution.submissionId
          ? await runtime.response(
              service.agent(line.botId),
              execution.conversationId,
              execution.submissionId,
            )
          : [];

    const hangUp = await run.runPromise(gateway.hangingUp(username));

    return c.json({ execution, reply, hangUp }, 200);
  });
  register(routes.startVoiceCall, async (c) => {
    const { username, callId } = c.req.valid("param");

    if (
      !(await run.runPromise(
        gateway.startCall(username, callId, hash(c.req.raw)),
      ))
    )
      throw tokenChanged();

    return c.body(null, 204);
  });
  register(routes.reportVoiceCall, async (c) => {
    const reported = await run.runPromise(
      gateway.reportCall(
        c.req.valid("param").callId,
        c.req.valid("json"),
        hash(c.req.raw),
      ),
    );

    if (!reported) throw tokenChanged();

    return c.body(null, 204);
  });
  register(routes.reportVoiceLines, async (c) => {
    await run.runPromise(
      gateway.reportLines(hash(c.req.raw), c.req.valid("json").lines),
    );

    return c.body(null, 204);
  });
}

export function registerVoiceGatewayRoutes(options: VoiceGatewayRoutesOptions) {
  registerOwnerRoutes(options);
  registerGatewayRoutes(options);
}
